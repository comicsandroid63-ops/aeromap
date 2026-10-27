const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClient } = require('@libsql/client');

// Use /tmp for serverless (Vercel) or public/uploads for local server
const UPLOADS_DIR = process.env.VERCEL
  ? path.join(os.tmpdir(), 'uploads')
  : path.join(__dirname, '..', 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (_) {}
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { user_id, project_id } = req.query || {};
    const prefix = (user_id && project_id) ? `${user_id}/${project_id}` : '';
    const dest = prefix ? path.join(UPLOADS_DIR, prefix) : UPLOADS_DIR;
    if (!fs.existsSync(dest)) {
      try { fs.mkdirSync(dest, { recursive: true }); } catch (_) {}
    }
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  }
});

const upload = multer({ storage }).fields([
  { name: 'file', maxCount: 1 },
  { name: 'wal', maxCount: 1 },
  { name: 'shm', maxCount: 1 }
]);

function parseWkbGeometry(wkb, offset = 0) {
  if (!wkb || offset >= wkb.length) return { geom: null, nextOffset: offset };
  const byteOrder = wkb[offset];
  const isLE = byteOrder === 1;
  const readUInt32 = (o) => isLE ? wkb.readUInt32LE(o) : wkb.readUInt32BE(o);
  const readDouble = (o) => isLE ? wkb.readDoubleLE(o) : wkb.readDoubleBE(o);

  let rawType = readUInt32(offset + 1);
  const hasZ = (rawType >= 1000 && rawType < 2000) || (rawType >= 3000 && rawType < 4000) || (rawType & 0x80000000);
  const hasM = (rawType >= 2000 && rawType < 3000) || (rawType >= 3000 && rawType < 4000) || (rawType & 0x40000000);
  const coordDim = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  const geomType = rawType % 1000;

  let cur = offset + 5;

  function readPoint() {
    const x = readDouble(cur);
    const y = readDouble(cur + 8);
    cur += coordDim * 8;
    return [x, y];
  }

  function readLineString() {
    const numPoints = readUInt32(cur);
    cur += 4;
    const pts = [];
    for (let i = 0; i < numPoints; i++) pts.push(readPoint());
    return pts;
  }

  function readPolygon() {
    const numRings = readUInt32(cur);
    cur += 4;
    const rings = [];
    for (let i = 0; i < numRings; i++) rings.push(readLineString());
    return rings;
  }

  if (geomType === 1) return { geom: { type: 'Point', coordinates: readPoint() }, nextOffset: cur };
  if (geomType === 2) return { geom: { type: 'LineString', coordinates: readLineString() }, nextOffset: cur };
  if (geomType === 3) return { geom: { type: 'Polygon', coordinates: readPolygon() }, nextOffset: cur };
  if (geomType === 4) {
    const num = readUInt32(cur); cur += 4;
    const pts = [];
    for (let i = 0; i < num; i++) {
      const res = parseWkbGeometry(wkb, cur);
      if (res.geom) pts.push(res.geom.coordinates);
      cur = res.nextOffset;
    }
    return { geom: { type: 'MultiPoint', coordinates: pts }, nextOffset: cur };
  }
  if (geomType === 5) {
    const num = readUInt32(cur); cur += 4;
    const lines = [];
    for (let i = 0; i < num; i++) {
      const res = parseWkbGeometry(wkb, cur);
      if (res.geom) lines.push(res.geom.coordinates);
      cur = res.nextOffset;
    }
    return { geom: { type: 'MultiLineString', coordinates: lines }, nextOffset: cur };
  }
  if (geomType === 6) {
    const num = readUInt32(cur); cur += 4;
    const polys = [];
    for (let i = 0; i < num; i++) {
      const res = parseWkbGeometry(wkb, cur);
      if (res.geom) polys.push(res.geom.coordinates);
      cur = res.nextOffset;
    }
    return { geom: { type: 'MultiPolygon', coordinates: polys }, nextOffset: cur };
  }
  return { geom: null, nextOffset: cur };
}

function gpkgBlobToGeoJson(blob) {
  if (!blob) return null;
  const buf = Buffer.from(blob);
  if (buf.length < 8 || buf[0] !== 0x47 || buf[1] !== 0x50) return null;
  const flags = buf[3];
  const envelopeIndicator = (flags >> 1) & 0x07;
  let envelopeSize = 0;
  if (envelopeIndicator === 1) envelopeSize = 32;
  else if (envelopeIndicator === 2 || envelopeIndicator === 3) envelopeSize = 48;
  else if (envelopeIndicator === 4) envelopeSize = 64;

  const wkbOffset = 8 + envelopeSize;
  const { geom } = parseWkbGeometry(buf, wkbOffset);
  return geom;
}

async function convertGpkgToGeoJson(gpkgPath, targetTable = null) {
  const normPath = gpkgPath.replace(/\\/g, '/');
  const client = createClient({ url: `file:${normPath}` });

  // 1. Obtener tablas de geometrías
  let geomCols = [];
  try {
    const res = await client.execute('SELECT table_name, column_name, geometry_type_name, srs_id FROM gpkg_geometry_columns');
    geomCols = res.rows || [];
  } catch (_) {
    // Si no tiene gpkg_geometry_columns, intentar gpkg_contents
    const cRes = await client.execute("SELECT table_name, srs_id FROM gpkg_contents WHERE data_type = 'features'");
    geomCols = (cRes.rows || []).map(r => ({ table_name: r.table_name, column_name: 'geom', srs_id: r.srs_id }));
  }

  if (targetTable) {
    const match = geomCols.filter(gc => gc.table_name.toLowerCase() === targetTable.toLowerCase());
    if (match.length > 0) geomCols = match;
  }

  if (geomCols.length === 0) {
    if (targetTable) return null;
    throw new Error('No se detectaron capas de entidades en el GeoPackage');
  }

  const allFeatures = [];
  let srsId = 4326;

  for (const gc of geomCols) {
    const tableName = gc.table_name;
    const geomCol = gc.column_name || 'geom';
    if (gc.srs_id) srsId = gc.srs_id;

    try {
      const rows = await client.execute(`SELECT * FROM "${tableName}"`);
      for (const row of rows.rows || []) {
        const rawGeom = row[geomCol];
        const geometry = gpkgBlobToGeoJson(rawGeom);
        if (!geometry) continue;

        const props = { ...row };
        delete props[geomCol];
        props.__gpkg_layer = tableName;

        allFeatures.push({
          type: 'Feature',
          geometry,
          properties: props
        });
      }
    } catch (e) {
      console.warn(`[GPKG] Error leyendo tabla ${tableName}:`, e.message);
    }
  }

  if (allFeatures.length === 0) {
    if (targetTable) return null;
    throw new Error('El GeoPackage no contiene entidades válidas');
  }

  return {
    type: 'FeatureCollection',
    crs: srsId ? { type: 'name', properties: { name: `EPSG:${srsId}` } } : undefined,
    features: allFeatures
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  upload(req, res, async (err) => {
    if (err) {
      console.error('[gpkg-geojson] upload error:', err);
      return res.status(500).json({ error: 'Error procesando archivo' });
    }

    const mainFile = req.files && req.files.file && req.files.file[0];
    if (!mainFile) {
      return res.status(400).json({ error: 'No se envió ningún archivo' });
    }

    const file = mainFile;
    try {
      const geojson = await convertGpkgToGeoJson(file.path);
      return res.status(200).json({
        success: true,
        name: file.originalname,
        geojson
      });
    } catch (e) {
      console.error('[gpkg-geojson] conversion failed:', e.message);
      return res.status(500).json({ error: e.message || 'Error convirtiendo GeoPackage' });
    } finally {
      // Limpiar archivo temporal
      try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) {}
    }
  });
};

module.exports.convertGpkgToGeoJson = convertGpkgToGeoJson;

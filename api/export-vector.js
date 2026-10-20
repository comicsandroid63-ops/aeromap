const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Rutas de GDAL en el sistema o fallback de entorno
const GDAL_PATH = process.env.GDAL_PATH || 'C:\\Program Files\\GDAL';
const OGR2OGR_BIN = process.platform === 'win32' 
  ? path.join(GDAL_PATH, 'ogr2ogr.exe')
  : 'ogr2ogr';

const GDAL_ENV = {
  ...process.env,
  PATH: `${GDAL_PATH};${process.env.PATH || ''}`,
  GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'),
  PROJ_LIB: path.join(GDAL_PATH, 'projlib')
};

const CRS_PRJ_WKT = {
  'EPSG:4326': 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
  'EPSG:3857': 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]',
  'EPSG:3116': 'PROJCS["MAGNA-SIRGAS_Colombia_Bogota_Zone",GEOGCS["GCS_MAGNA",DATUM["D_MAGNA",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",1000000.0],PARAMETER["False_Northing",1000000.0],PARAMETER["Central_Meridian",-74.07750791666666],PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",4.596200416666666],UNIT["Meter",1.0]]',
  'EPSG:9377': 'PROJCS["MAGNA-SIRGAS_2018_Origen-Nacional",GEOGCS["GCS_MAGNA",DATUM["D_MAGNA",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",5000000.0],PARAMETER["False_Northing",2000000.0],PARAMETER["Central_Meridian",-73.0],PARAMETER["Scale_Factor",0.9992],PARAMETER["Latitude_Of_Origin",4.0],UNIT["Meter",1.0]]',
  'EPSG:32618': 'PROJCS["WGS_1984_UTM_Zone_18N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-75.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]',
  'EPSG:32619': 'PROJCS["WGS_1984_UTM_Zone_19N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-69.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'
};

// Generador ZIP sin dependencias externas usando Buffer y zlib.deflateRawSync
function createZipBuffer(fileEntries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const entry of fileEntries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const uncompressedData = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const uncompressedSize = uncompressedData.length;
    const crc = zlib.crc32(uncompressedData);
    const compressedData = zlib.deflateRawSync(uncompressedData);
    const compressedSize = compressedData.length;

    // Local file header (30 bytes + nameBuf.length)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4);         // Version needed (2.0)
    localHeader.writeUInt16LE(0, 6);          // General purpose bit flag
    localHeader.writeUInt16LE(8, 8);          // Compression method (8 = Deflate)
    localHeader.writeUInt16LE(0, 10);         // Last mod file time
    localHeader.writeUInt16LE(0, 12);         // Last mod file date
    localHeader.writeUInt32LE(crc, 14);       // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18);   // Compressed size
    localHeader.writeUInt32LE(uncompressedSize, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);   // File name length
    localHeader.writeUInt16LE(0, 28);                // Extra field length
    nameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader, compressedData);

    // Central directory file header (46 bytes + nameBuf.length)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(20, 4);         // Version made by
    centralHeader.writeUInt16LE(20, 6);         // Version needed
    centralHeader.writeUInt16LE(0, 8);          // General purpose bit flag
    centralHeader.writeUInt16LE(8, 10);         // Compression method (8 = Deflate)
    centralHeader.writeUInt16LE(0, 12);         // Last mod file time
    centralHeader.writeUInt16LE(0, 14);         // Last mod file date
    centralHeader.writeUInt32LE(crc, 16);       // CRC-32
    centralHeader.writeUInt32LE(compressedSize, 20);   // Compressed size
    centralHeader.writeUInt32LE(uncompressedSize, 24); // Uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28);   // File name length
    centralHeader.writeUInt16LE(0, 30);                // Extra field length
    centralHeader.writeUInt16LE(0, 32);                // File comment length
    centralHeader.writeUInt16LE(0, 34);                // Disk number start
    centralHeader.writeUInt16LE(0, 36);                // Internal file attributes
    centralHeader.writeUInt32LE(0, 38);                // External file attributes
    centralHeader.writeUInt32LE(offset, 42);           // Relative offset of local header
    nameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    offset += localHeader.length + compressedData.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) centralDirSize += ch.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);                 // EOCD signature
  eocd.writeUInt16LE(0, 4);                          // Number of this disk
  eocd.writeUInt16LE(0, 6);                          // Disk where central directory starts
  eocd.writeUInt16LE(fileEntries.length, 8);         // Number of central directory records on this disk
  eocd.writeUInt16LE(fileEntries.length, 10);        // Total number of central directory records
  eocd.writeUInt32LE(centralDirSize, 12);            // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16);          // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);                         // Comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

// Generador nativo Node.js de ESRI Shapefile (.shp, .shx, .dbf)
function buildShapefileBuffers(geojson) {
  const features = geojson.features || [];
  if (features.length === 0) throw new Error('Capa sin entidades para exportar');

  let geomType = 'Polygon';
  for (const f of features) {
    if (f && f.geometry && f.geometry.type) {
      geomType = f.geometry.type.replace('Multi', '');
      break;
    }
  }

  let shapeType = 5; // Polygon
  if (geomType === 'Point') shapeType = 1;
  else if (geomType === 'LineString') shapeType = 3;

  const propKeys = [];
  const keyMap = new Map();
  for (const f of features) {
    if (f && f.properties) {
      for (const k of Object.keys(f.properties)) {
        if (!keyMap.has(k)) {
          let shortKey = k.substring(0, 10).replace(/[^a-zA-Z0-9_]/g, '_');
          if (propKeys.includes(shortKey)) shortKey = (shortKey.substring(0, 8) + propKeys.length);
          propKeys.push(shortKey);
          keyMap.set(k, shortKey);
        }
      }
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const updateBBox = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  const shpRecords = [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const geom = f ? f.geometry : null;
    let recContent = null;

    if (shapeType === 1) { // Point
      const coords = (geom && geom.coordinates) ? geom.coordinates : [0, 0];
      const x = coords[0] || 0;
      const y = coords[1] || 0;
      updateBBox(x, y);

      recContent = Buffer.alloc(20);
      recContent.writeInt32LE(1, 0);
      recContent.writeDoubleLE(x, 4);
      recContent.writeDoubleLE(y, 12);

    } else if (shapeType === 3 || shapeType === 5) { // LineString or Polygon
      let rings = [];
      if (geom) {
        if (geom.type === 'Polygon') rings = geom.coordinates || [];
        else if (geom.type === 'MultiPolygon') {
          for (const poly of (geom.coordinates || [])) for (const ring of (poly || [])) rings.push(ring);
        } else if (geom.type === 'LineString') rings = [geom.coordinates || []];
        else if (geom.type === 'MultiLineString') rings = geom.coordinates || [];
      }

      let numPoints = 0;
      for (const r of rings) numPoints += r.length;

      let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
      for (const r of rings) {
        for (const pt of r) {
          updateBBox(pt[0], pt[1]);
          if (pt[0] < rMinX) rMinX = pt[0];
          if (pt[1] < rMinY) rMinY = pt[1];
          if (pt[0] > rMaxX) rMaxX = pt[0];
          if (pt[1] > rMaxY) rMaxY = pt[1];
        }
      }

      if (rMinX === Infinity) { rMinX = 0; rMinY = 0; rMaxX = 0; rMaxY = 0; }

      const numParts = rings.length;
      const contentLen = 44 + (4 * numParts) + (16 * numPoints);
      recContent = Buffer.alloc(contentLen);

      recContent.writeInt32LE(shapeType, 0);
      recContent.writeDoubleLE(rMinX, 4);
      recContent.writeDoubleLE(rMinY, 12);
      recContent.writeDoubleLE(rMaxX, 20);
      recContent.writeDoubleLE(rMaxY, 28);
      recContent.writeInt32LE(numParts, 36);
      recContent.writeInt32LE(numPoints, 40);

      let partOffset = 0;
      for (let p = 0; p < numParts; p++) {
        recContent.writeInt32LE(partOffset, 44 + (p * 4));
        partOffset += rings[p].length;
      }

      let ptOffset = 44 + (4 * numParts);
      for (const r of rings) {
        for (const pt of r) {
          recContent.writeDoubleLE(pt[0] || 0, ptOffset);
          recContent.writeDoubleLE(pt[1] || 0, ptOffset + 8);
          ptOffset += 16;
        }
      }
    }

    const recHeader = Buffer.alloc(8);
    recHeader.writeInt32BE(i + 1, 0);
    recHeader.writeInt32BE(recContent.length / 2, 4);
    shpRecords.push(Buffer.concat([recHeader, recContent]));
  }

  if (minX === Infinity) { minX = 0; minY = 0; maxX = 0; maxY = 0; }

  let totalShpLen = 100;
  for (const r of shpRecords) totalShpLen += r.length;

  const shpHeader = Buffer.alloc(100);
  shpHeader.writeInt32BE(9994, 0);
  shpHeader.writeInt32BE(totalShpLen / 2, 24);
  shpHeader.writeInt32LE(1000, 28);
  shpHeader.writeInt32LE(shapeType, 32);
  shpHeader.writeDoubleLE(minX, 36);
  shpHeader.writeDoubleLE(minY, 44);
  shpHeader.writeDoubleLE(maxX, 52);
  shpHeader.writeDoubleLE(maxY, 60);

  const shpBuffer = Buffer.concat([shpHeader, ...shpRecords]);

  const totalShxLen = 100 + (features.length * 8);
  const shxHeader = Buffer.alloc(100);
  shpHeader.copy(shxHeader);
  shxHeader.writeInt32BE(totalShxLen / 2, 24);

  const shxRecordsArr = [];
  let currentOffsetWords = 50;
  for (const r of shpRecords) {
    const recLenWords = (r.length - 8) / 2;
    const shxRec = Buffer.alloc(8);
    shxRec.writeInt32BE(currentOffsetWords, 0);
    shxRec.writeInt32BE(recLenWords, 4);
    shxRecordsArr.push(shxRec);
    currentOffsetWords += r.length / 2;
  }
  const shxBuffer = Buffer.concat([shxHeader, ...shxRecordsArr]);

  const fieldWidth = 60;
  const headerLen = 32 + (propKeys.length * 32) + 1;
  const recordLen = 1 + (propKeys.length * fieldWidth);

  const dbfHeader = Buffer.alloc(headerLen);
  dbfHeader.writeUInt8(0x03, 0);
  const now = new Date();
  dbfHeader.writeUInt8(now.getFullYear() - 1900, 1);
  dbfHeader.writeUInt8(now.getMonth() + 1, 2);
  dbfHeader.writeUInt8(now.getDate(), 3);
  dbfHeader.writeUInt32LE(features.length, 4);
  dbfHeader.writeUInt16LE(headerLen, 8);
  dbfHeader.writeUInt16LE(recordLen, 10);

  for (let k = 0; k < propKeys.length; k++) {
    const fOffset = 32 + (k * 32);
    dbfHeader.write(propKeys[k], fOffset, 11, 'ascii');
    dbfHeader.write('C', fOffset + 11, 1, 'ascii');
    dbfHeader.writeUInt8(fieldWidth, fOffset + 16);
  }
  dbfHeader.writeUInt8(0x0D, headerLen - 1);

  const dbfRecords = [];
  for (let i = 0; i < features.length; i++) {
    const props = features[i].properties || {};
    const recBuf = Buffer.alloc(recordLen, 0x20);
    let colOffset = 1;
    for (const shortKey of propKeys) {
      let origKey = shortKey;
      for (const [ok, sk] of keyMap.entries()) { if (sk === shortKey) { origKey = ok; break; } }
      const val = props[origKey] !== undefined && props[origKey] !== null ? String(props[origKey]) : '';
      const strVal = Buffer.from(val, 'utf8').subarray(0, fieldWidth);
      strVal.copy(recBuf, colOffset);
      colOffset += fieldWidth;
    }
    dbfRecords.push(recBuf);
  }
  const dbfTerminator = Buffer.from([0x1A]);
  const dbfBuffer = Buffer.concat([dbfHeader, ...dbfRecords, dbfTerminator]);

  return { shp: shpBuffer, shx: shxBuffer, dbf: dbfBuffer };
}

function escapeXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function geojsonToKml(geojson, layerName) {
  let kml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  kml += '<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n';
  kml += `  <name>${escapeXml(layerName || 'capa')}</name>\n`;

  const feats = geojson.features || [];
  for (const f of feats) {
    if (!f || !f.geometry) continue;
    kml += '  <Placemark>\n';
    if (f.properties) {
      const name = f.properties.name || f.properties.nombre || f.properties.identificador || f.properties.id || '';
      if (name) kml += `    <name>${escapeXml(String(name))}</name>\n`;
      kml += '    <ExtendedData>\n';
      for (const [k, v] of Object.entries(f.properties)) {
        if (v !== undefined && v !== null) {
          kml += `      <Data name="${escapeXml(k)}"><value>${escapeXml(String(v))}</value></Data>\n`;
        }
      }
      kml += '    </ExtendedData>\n';
    }
    const geom = f.geometry;
    if (geom.type === 'Point') {
      const c = geom.coordinates || [0, 0];
      kml += `    <Point><coordinates>${c[0]},${c[1]},${c[2] || 0}</coordinates></Point>\n`;
    } else if (geom.type === 'LineString') {
      const coordStr = (geom.coordinates || []).map(c => `${c[0]},${c[1]},${c[2] || 0}`).join(' ');
      kml += `    <LineString><coordinates>${coordStr}</coordinates></LineString>\n`;
    } else if (geom.type === 'Polygon') {
      kml += '    <Polygon>\n';
      if (geom.coordinates && geom.coordinates[0]) {
        const extStr = geom.coordinates[0].map(c => `${c[0]},${c[1]},${c[2] || 0}`).join(' ');
        kml += `      <outerBoundaryIs><LinearRing><coordinates>${extStr}</coordinates></LinearRing></outerBoundaryIs>\n`;
      }
      for (let i = 1; i < (geom.coordinates || []).length; i++) {
        const intStr = geom.coordinates[i].map(c => `${c[0]},${c[1]},${c[2] || 0}`).join(' ');
        kml += `      <innerBoundaryIs><LinearRing><coordinates>${intStr}</coordinates></LinearRing></innerBoundaryIs>\n`;
      }
      kml += '    </Polygon>\n';
    }
    kml += '  </Placemark>\n';
  }
  kml += '</Document>\n</kml>';
  return kml;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { format, geojson, filename, crs, layerName } = req.body || {};

  if (!geojson) {
    return res.status(400).json({ error: 'Falta geojson en el cuerpo de la petición' });
  }

  const parsedGeoJson = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
  const exportFormat = (format || 'gpkg').toLowerCase();
  const safeBaseName = (filename || 'capa_exportada').replace(/[^a-zA-Z0-9_\-]/g, '_') || 'capa_exportada';
  const targetLayerName = (layerName || safeBaseName).replace(/[^a-zA-Z0-9_\-]/g, '_') || safeBaseName;
  const targetCrs = crs || 'EPSG:4326';

  // 1. GeoJSON directo
  if (exportFormat === 'geojson') {
    res.setHeader('Content-Type', 'application/geo+json');
    res.setHeader('Content-Disposition', `attachment; filename="${safeBaseName}.geojson"`);
    return res.status(200).send(JSON.stringify(parsedGeoJson, null, 2));
  }

  // 2. KML directo (no requiere GDAL)
  if (exportFormat === 'kml') {
    const kmlContent = geojsonToKml(parsedGeoJson, targetLayerName);
    res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${safeBaseName}.kml"`);
    return res.status(200).send(kmlContent);
  }

  // Comprobar si GDAL está disponible localmente
  const hasGdal = fs.existsSync(OGR2OGR_BIN) || process.platform !== 'win32';

  // Si tenemos GDAL, intentar procesar
  if (hasGdal) {
    const tmpDir = path.join(os.tmpdir(), `export_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      const inputGeoJsonPath = path.join(tmpDir, 'input.geojson');
      fs.writeFileSync(inputGeoJsonPath, JSON.stringify(parsedGeoJson));

      if (exportFormat === 'gpkg') {
        const outGpkgPath = path.join(tmpDir, `${safeBaseName}.gpkg`);
        const args = [
          '-f', 'GPKG',
          outGpkgPath,
          inputGeoJsonPath,
          '-nln', targetLayerName,
          '-s_srs', 'EPSG:4326',
          '-t_srs', targetCrs,
          '-nlt', 'PROMOTE_TO_MULTI',
          '-skipfailures',
          '-overwrite'
        ];

        await execFileAsync(OGR2OGR_BIN, args, { env: GDAL_ENV, timeout: 60000 });

        if (fs.existsSync(outGpkgPath)) {
          const fileBuffer = fs.readFileSync(outGpkgPath);
          res.setHeader('Content-Type', 'application/geopackage+sqlite3');
          res.setHeader('Content-Disposition', `attachment; filename="${safeBaseName}.gpkg"`);
          return res.status(200).send(fileBuffer);
        }
      } else if (exportFormat === 'shp' || exportFormat === 'shapefile') {
        const shpOutDir = path.join(tmpDir, 'shp');
        fs.mkdirSync(shpOutDir, { recursive: true });
        const outShpPath = path.join(shpOutDir, `${safeBaseName}.shp`);

        const args = [
          '-f', 'ESRI Shapefile',
          outShpPath,
          inputGeoJsonPath,
          '-nln', targetLayerName,
          '-s_srs', 'EPSG:4326',
          '-t_srs', targetCrs,
          '-lco', 'ENCODING=UTF-8',
          '-skipfailures',
          '-overwrite'
        ];

        await execFileAsync(OGR2OGR_BIN, args, { env: GDAL_ENV, timeout: 60000 });

        const files = fs.readdirSync(shpOutDir);
        if (files.length > 0) {
          const entries = files.map(f => ({
            name: f,
            data: fs.readFileSync(path.join(shpOutDir, f))
          }));
          const zipBuffer = createZipBuffer(entries);
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', `attachment; filename="${safeBaseName}.zip"`);
          return res.status(200).send(zipBuffer);
        }
      }
    } catch (gdalErr) {
      console.warn('[Export] GDAL conversion warning/fallback:', gdalErr.message);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // Fallback 100% puro en Node para Shapefile (.zip)
  if (exportFormat === 'shp' || exportFormat === 'shapefile') {
    try {
      const shpParts = buildShapefileBuffers(parsedGeoJson);
      const prjWkt = CRS_PRJ_WKT[targetCrs] || CRS_PRJ_WKT['EPSG:4326'];
      const zipBuffer = createZipBuffer([
        { name: `${safeBaseName}.shp`, data: shpParts.shp },
        { name: `${safeBaseName}.shx`, data: shpParts.shx },
        { name: `${safeBaseName}.dbf`, data: shpParts.dbf },
        { name: `${safeBaseName}.prj`, data: Buffer.from(prjWkt, 'utf8') },
        { name: `${safeBaseName}.cpg`, data: Buffer.from('UTF-8', 'utf8') }
      ]);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${safeBaseName}.zip"`);
      return res.status(200).send(zipBuffer);
    } catch(shpErr) {
      console.error('[Export] Pure SHP build failed:', shpErr);
      return res.status(500).json({ error: 'Error generando Shapefile: ' + shpErr.message });
    }
  }

  // Si se solicitó GPKG y GDAL no está disponible en este entorno, devolver señal para que el navegador use GeoPackage.js
  if (exportFormat === 'gpkg') {
    return res.status(200).json({
      fallbackClient: true,
      format: 'gpkg',
      message: 'Generación directa de GeoPackage en cliente'
    });
  }

  return res.status(400).json({ error: `Formato no soportado: ${format}` });
};

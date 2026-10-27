const fs = require('fs');
const path = require('path');
const os = require('os');

const UPLOADS_DIR = process.env.VERCEL
  ? path.join(os.tmpdir(), 'uploads')
  : path.join(__dirname, '..', 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (_) {}
}

// In-memory cache for fast file discovery across multiple layer requests
let _fileIndexCache = null;
let _fileIndexTime = 0;

function getFileIndex(searchDirs) {
  const now = Date.now();
  if (_fileIndexCache && (now - _fileIndexTime < 45000)) {
    return _fileIndexCache;
  }
  const index = new Map();
  function walk(dir, depth = 0) {
    if (depth > 6 || !fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === '$Recycle.Bin') continue;
        const full = path.join(dir, ent.name);
        if (ent.isFile()) {
          const lower = ent.name.toLowerCase();
          if (!index.has(lower)) {
            index.set(lower, full);
          }
        } else if (ent.isDirectory()) {
          walk(full, depth + 1);
        }
      }
    } catch (_) {}
  }
  for (const d of searchDirs) {
    walk(d, 0);
  }
  _fileIndexCache = index;
  _fileIndexTime = now;
  return index;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    let body = req.body;
    if (!body && req.method === 'POST') {
      try {
        const buffers = [];
        for await (const chunk of req) buffers.push(chunk);
        const str = Buffer.concat(buffers).toString('utf-8');
        body = JSON.parse(str);
      } catch (_) {
        body = {};
      }
    }
    body = body || {};

    const { datasource, filename, layerName } = body;
    if (!datasource && !filename && !layerName) {
      return res.status(200).json({ found: false, message: 'datasource, filename or layerName required' });
    }

    const cleanDs = (datasource || '').split('|')[0].replace(/\\/g, '/');
    const targetFile = filename || cleanDs.split('/').pop() || (layerName ? `${layerName}.shp` : '');

    const userHome = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\HOME';
    const searchDirs = [
      path.join(userHome, 'Downloads'),
      path.join(userHome, 'Documents'),
      path.join(userHome, 'Desktop'),
      UPLOADS_DIR
    ];

    let foundPath = null;

    // 1. Direct relative match from datasource in search dirs
    for (const d of searchDirs) {
      if (!fs.existsSync(d)) continue;
      const relClean = cleanDs.replace(/^\.\//, '').replace(/\//g, path.sep);
      const candidate = path.join(d, relClean);
      if (fs.existsSync(candidate)) {
        try {
          if (fs.statSync(candidate).isFile()) {
            foundPath = candidate;
            break;
          }
        } catch (_) {}
      }
      if (targetFile) {
        const candidateDirect = path.join(d, targetFile);
        if (fs.existsSync(candidateDirect)) {
          try {
            if (fs.statSync(candidateDirect).isFile()) {
              foundPath = candidateDirect;
              break;
            }
          } catch (_) {}
        }
      }
    }

    // 2. Fast cached index search if not found directly
    if (!foundPath && targetFile) {
      const idx = getFileIndex(searchDirs);
      const matched = idx.get(targetFile.toLowerCase());
      if (matched && fs.existsSync(matched)) {
        foundPath = matched;
      }
    }

    // 3. Fallback shallow search if still not found
    if (!foundPath && targetFile) {
      function findFile(dir, target, depth = 0) {
        if (depth > 6 || !fs.existsSync(dir)) return null;
        try {
          const files = fs.readdirSync(dir);
          for (const f of files) {
            const full = path.join(dir, f);
            try {
              const stat = fs.statSync(full);
              if (stat.isFile() && f.toLowerCase() === target.toLowerCase()) {
                return full;
              } else if (stat.isDirectory() && !f.startsWith('.') && f !== 'node_modules' && f !== '$Recycle.Bin') {
                const sub = findFile(full, target, depth + 1);
                if (sub) return sub;
              }
            } catch (_) {}
          }
        } catch (_) {}
        return null;
      }

      foundPath = findFile(path.join(userHome, 'Downloads'), targetFile) ||
                  findFile(path.join(userHome, 'Documents'), targetFile);
    }

    if (!foundPath) {
      return res.status(200).json({ found: false, message: 'Archivo no encontrado en rutas locales' });
    }

    const ext = path.extname(foundPath).toLowerCase();
    const foundBase = foundPath.substring(0, foundPath.length - ext.length);
    const baseFileName = path.basename(foundPath);

    if (ext === '.shp') {
      const destShp = path.join(UPLOADS_DIR, baseFileName);
      if (!fs.existsSync(destShp) || fs.statSync(destShp).size !== fs.statSync(foundPath).size) {
        try { fs.copyFileSync(foundPath, destShp); } catch (_) {}
      }

      let dbfUrl = null;
      let dbfBuf = null;
      const dbfPath = foundBase + '.dbf';
      if (fs.existsSync(dbfPath)) {
        const destDbf = path.join(UPLOADS_DIR, path.basename(dbfPath));
        if (!fs.existsSync(destDbf) || fs.statSync(destDbf).size !== fs.statSync(dbfPath).size) {
          try { fs.copyFileSync(dbfPath, destDbf); } catch (_) {}
        }
        dbfUrl = `/uploads/${encodeURIComponent(path.basename(dbfPath))}`;
        try { dbfBuf = fs.readFileSync(dbfPath); } catch (_) {}
      }

      let prjText = null;
      const prjPath = foundBase + '.prj';
      if (fs.existsSync(prjPath)) {
        const destPrj = path.join(UPLOADS_DIR, path.basename(prjPath));
        if (!fs.existsSync(destPrj)) {
          try { fs.copyFileSync(prjPath, destPrj); } catch (_) {}
        }
        try { prjText = fs.readFileSync(prjPath, 'utf-8'); } catch (_) {}
      }

      // Copiar también .shx y .cpg si existen
      ['.shx', '.cpg'].forEach(sExt => {
        const sPath = foundBase + sExt;
        if (fs.existsSync(sPath)) {
          const destS = path.join(UPLOADS_DIR, path.basename(sPath));
          if (!fs.existsSync(destS)) {
            try { fs.copyFileSync(sPath, destS); } catch (_) {}
          }
        }
      });

      const shpStat = fs.statSync(foundPath);
      const isSmall = shpStat.size < 2 * 1024 * 1024;
      let shpBase64 = null;
      let dbfBase64 = null;
      if (isSmall) {
        try {
          shpBase64 = fs.readFileSync(foundPath).toString('base64');
          if (dbfBuf) dbfBase64 = dbfBuf.toString('base64');
        } catch (_) {}
      }

      return res.status(200).json({
        found: true,
        type: 'shapefile',
        fileName: baseFileName,
        shpUrl: `/uploads/${encodeURIComponent(baseFileName)}`,
        dbfUrl: dbfUrl,
        shpBase64: shpBase64,
        dbfBase64: dbfBase64,
        prjText: prjText
      });
    } else if (ext === '.gpkg') {
      const destName = path.basename(foundPath);
      const destPath = path.join(UPLOADS_DIR, destName);
      if (!fs.existsSync(destPath)) {
        try { fs.copyFileSync(foundPath, destPath); } catch (_) {}
      }

      const matchTable = (datasource || '').match(/layername=([^|]+)/i);
      const targetTable = matchTable ? matchTable[1].trim() : (layerName || '');
      let geojson = null;
      try {
        const { convertGpkgToGeoJson } = require('./gpkg-geojson');
        if (typeof convertGpkgToGeoJson === 'function') {
          geojson = await convertGpkgToGeoJson(foundPath, targetTable);
        }
      } catch (errGpkg) {
        console.warn('[qgis resolve GPKG]', errGpkg.message);
      }

      return res.status(200).json({
        found: true,
        type: 'geopackage',
        fileName: destName,
        tableName: targetTable,
        geojson: geojson,
        url: `/uploads/${destName}`
      });
    } else if (ext === '.geojson' || ext === '.json') {
      const destName = baseFileName;
      const destPath = path.join(UPLOADS_DIR, destName);
      if (!fs.existsSync(destPath) || fs.statSync(destPath).size !== fs.statSync(foundPath).size) {
        try { fs.copyFileSync(foundPath, destPath); } catch (_) {}
      }
      let geojson = null;
      try {
        const raw = fs.readFileSync(foundPath, 'utf8');
        geojson = JSON.parse(raw);
      } catch (errGj) {
        console.warn('[qgis resolve GeoJSON parse error]', errGj.message);
      }

      // Aplicar filtro subset si existe en el datasource (|subset=...)
      const subsetMatch = (datasource || '').match(/\|subset=([^|]+)/i);
      if (subsetMatch && subsetMatch[1] && geojson && Array.isArray(geojson.features)) {
        const subsetStr = subsetMatch[1].trim();
        try {
          let expr = subsetStr
            .replace(/([a-zA-Z0-9_]+)\s*=\s*'([^']*)'/g, "p['$1'] === '$2'")
            .replace(/([a-zA-Z0-9_]+)\s*<>\s*'([^']*)'/g, "p['$1'] !== '$2'")
            .replace(/([a-zA-Z0-9_]+)\s*!=\s*'([^']*)'/g, "p['$1'] !== '$2'")
            .replace(/\bOR\b/gi, '||')
            .replace(/\bAND\b/gi, '&&');
          const filterFn = new Function('p', `return Boolean(${expr});`);
          const filtered = geojson.features.filter(f => filterFn(f.properties || {}));
          geojson = { ...geojson, features: filtered };
        } catch (_) {}
      }

      return res.status(200).json({
        found: true,
        type: 'geojson',
        fileName: destName,
        geojson: geojson,
        url: `/uploads/${encodeURIComponent(destName)}`
      });
    } else if (/\.(tiff?|img)$/i.test(ext)) {
      const destName = path.basename(foundPath);
      const destPath = path.join(UPLOADS_DIR, destName);
      if (!fs.existsSync(destPath)) {
        try { fs.copyFileSync(foundPath, destPath); } catch (_) {}
      }
      let tiffBase64 = null;
      try {
        const st = fs.statSync(foundPath);
        if (st.size < 30 * 1024 * 1024) {
          tiffBase64 = fs.readFileSync(foundPath).toString('base64');
        }
      } catch (_) {}
      return res.status(200).json({
        found: true,
        type: 'raster',
        fileName: destName,
        url: `/uploads/${destName}`,
        tiffBase64: tiffBase64
      });
    }

    return res.status(200).json({ found: false, message: 'Tipo de archivo no soportado' });
  } catch (err) {
    console.error('[api/qgis error]', err);
    return res.status(200).json({ found: false, error: err.message });
  }
};

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const os = require('os');
const util = require('util');
const multer = require('multer');
const tiffPreviewRouter = require('./api/tiff-preview');
const dziRouter = require('./api/dzi-generator');

const execFileAsync = util.promisify(execFile);
let GDAL_PATH = 'C:\\Program Files\\GDAL';

// Buscar gdal en PATH del sistema o en rutas comunes
function findGdalBin() {
  const candidates = [
    GDAL_PATH,
    'C:\\OSGeo4W\\bin',
    'C:\\Program Files\\GDAL',
    'C:\\Program Files (x86)\\GDAL',
    'C:\\OSGeo4W64\\bin',
    process.env.GDAL_BIN || '',
    '',
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    const exe = path.join(dir, 'gdalinfo.exe');
    try {
      if (fs.existsSync(exe)) return dir;
    } catch(e) {}
  }
  // Check if gdalinfo is in system PATH already
  return '';
}

function findProjDb() {
  const dirs = [
    process.env.PROJ_LIB,
    path.join(GDAL_PATH, 'projlib'),
    path.join(GDAL_PATH, 'proj', 'share'),
    path.join(GDAL_PATH, 'share', 'proj'),
    path.join(GDAL_PATH, 'projlib', 'SHARE'),
    path.join(GDAL_PATH, 'data', 'proj'),
    'C:\\OSGeo4W\\share\\proj',
    'C:\\OSGeo4W64\\share\\proj',
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const db = path.join(dir, 'proj.db');
    try { if (fs.existsSync(db)) return dir; } catch(e) {}
  }
  return null;
}

function findGdalData() {
  const dirs = [
    process.env.GDAL_DATA,
    path.join(GDAL_PATH, 'gdal-data'),
    path.join(GDAL_PATH, 'share', 'gdal'),
    path.join(GDAL_PATH, 'data'),
    'C:\\OSGeo4W\\share\\gdal',
    'C:\\OSGeo4W64\\share\\gdal',
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    // Check for a known GDAL data file
    for (const test of ['gcs.csv', 'pcs.csv', 'gdalinfo.wkt']) {
      try { if (fs.existsSync(path.join(dir, test))) return dir; } catch(e) {}
    }
  }
  return null;
}

const gdalBinDir = findGdalBin();
const gdalDataDir = findGdalData();
let projLibDir = findProjDb();

// If we found a bin dir, update GDAL_PATH so all existing code paths work
if (gdalBinDir) {
  console.log(`[GDAL] Bin encontrado: ${gdalBinDir}`);
  GDAL_PATH = gdalBinDir;
} else {
  console.log('[GDAL] Usando GDAL del PATH del sistema');
  // Try to find gdalinfo in PATH using where.exe
  try {
    const { stdout } = require('child_process').execSync('where gdalinfo', { encoding: 'utf8' });
    const firstLine = stdout.trim().split('\n')[0].trim();
    if (firstLine) {
      GDAL_PATH = path.dirname(firstLine);
      console.log(`[GDAL] Encontrado via PATH: ${GDAL_PATH}`);
    }
  } catch(e) {
    console.log('[GDAL] gdalinfo no encontrado en PATH, usando ruta por defecto');
  }
}
if (gdalDataDir) console.log(`[GDAL] GDAL_DATA: ${gdalDataDir}`);
if (projLibDir) console.log(`[GDAL] PROJ_LIB: ${projLibDir}`);

const GDAL_ENV = {
  ...process.env,
  GTIFF_SRS_SOURCE: 'EPSG',
  GDAL_NUM_THREADS: 'ALL_CPUS',
};
if (gdalBinDir) {
  GDAL_ENV.PATH = `${gdalBinDir};${process.env.PATH || ''}`;
}
if (gdalDataDir) {
  GDAL_ENV.GDAL_DATA = gdalDataDir;
  process.env.GDAL_DATA = gdalDataDir;
}
if (projLibDir) {
  GDAL_ENV.PROJ_LIB = projLibDir;
  process.env.PROJ_LIB = projLibDir;
} else {
  delete GDAL_ENV.PROJ_LIB;
}

const app = express();
app.use(express.json({ limit: '4gb' }));
app.use(express.urlencoded({ limit: '4gb', extended: true }));
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const bgPool = {};
global.__localTiffPaths = {};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
  next();
});
app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ─── Ruta única de importación TIFF (≤ 2s crítica) ───
app.post('/api/import-tiff', upload.single('tiff'), async (req, res) => {
  const { path: tiffPath, originalname, filename: savedAs, size } = req.file;
  const baseName = originalname.replace(/\.[^.]+$/, '');
  const id = savedAs;
  const isFast = req.query.fast === 'true';

  const MAX_MS = 2000;
  const start = Date.now();

  try {
    // 1) Leer cabecera (timeout 60s para archivos grandes)
    let metadata = { width: 0, height: 0, bands: 1, bounds: null, hasOverviews: false, incomplete: true };
    try {
      const { stdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', tiffPath], { env: GDAL_ENV, timeout: 60000 });
      const info = JSON.parse(stdout);
      const bands = info.bands || [];
      const types = bands.map(b => b.type);
      const mins = bands.map(b => b.minimum);
      const maxs = bands.map(b => b.maximum);
      metadata = {
        width: info.size[0], height: info.size[1],
        bands: bands.length || 1,
        types, mins, maxs,
        hasOverviews: !!(info.overviews && info.overviews.length > 0),
        incomplete: false,
      };

      // bounds - use wgs84Extent if available (already in WGS84), otherwise transform corners
      if (info.wgs84Extent) {
        const coords = info.wgs84Extent.coordinates[0];
        const lons = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        metadata.bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
      } else {
        const corners = info.cornerCoordinates;
        if (corners) {
          try {
            const pts = [`${corners.upperLeft[0]} ${corners.upperLeft[1]}`, `${corners.lowerLeft[0]} ${corners.lowerLeft[1]}`, `${corners.lowerRight[0]} ${corners.lowerRight[1]}`, `${corners.upperRight[0]} ${corners.upperRight[1]}`].join('\n');
            const { stdout: ts } = await execFileAsync(path.join(GDAL_PATH, 'gdaltransform.exe'), ['-t_srs', 'EPSG:4326', tiffPath], { env: GDAL_ENV, input: pts, timeout: 15000 });
            const ln = ts.trim().split('\n');
            const lons = [], lats = [];
            for (const l of ln) { const p = l.trim().split(/\s+/); if (p.length >= 2) { lons.push(parseFloat(p[0])); lats.push(parseFloat(p[1])); } }
            if (lons.length >= 2) metadata.bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
          } catch (e) {}
        }
      }
    } catch (e) {
      console.warn('[Import] Header timeout:', e.message.substring(0, 100));
    }

    // 2) Generate thumbnail for instant display (uses GDAL overviews, < 1s)
    const thumbName = `${baseName}_thumb.jpg`;
    const thumbPath = path.join(UPLOAD_DIR, thumbName);
    await generateThumbnail(tiffPath, thumbPath);
    const thumbnailUrl = fs.existsSync(thumbPath) ? `/uploads/${encodeURIComponent(thumbName)}` : null;

    if (isFast) {
      bgPool[id] = { status: 'running' };
      optimizeTiff(tiffPath, baseName, 85).then(result => {
        bgPool[id] = { status: 'completed', result };
      }).catch(e => {
        bgPool[id] = { status: 'failed', error: e.message };
        console.warn('[Import] Background optimization failed:', e.message.substring(0, 100));
      });

      return res.json({
        status: 'instant',
        id,
        thumbnailUrl,
        metadata: {
          width: metadata.width,
          height: metadata.height,
          bands: metadata.bands,
          bounds: metadata.bounds,
          hasOverviews: metadata.hasOverviews,
        },
      });
    }

    const remaining = MAX_MS - (Date.now() - start);

    // 3) Optimize the TIFF using the same logic as /api/compress-tiff
    let optimized = null;
    try {
      optimized = await optimizeTiff(tiffPath, baseName, 85);
    } catch (e) {
      console.warn('[Import] Optimization failed (non-fatal):', e.message.substring(0, 100));
    }

    res.json({
      status: thumbnailUrl ? 'preview_generated' : 'instant',
      id,
      thumbnailUrl,
      metadata: {
        width: metadata.width,
        height: metadata.height,
        bands: metadata.bands,
        bounds: metadata.bounds,
        hasOverviews: metadata.hasOverviews,
        mins: metadata.mins,
        maxs: metadata.maxs,
      },
      optimized,
    });

  } catch (err) {
    console.error('[Import]', err.message);
    res.json({
      status: 'queued',
      id,
      preview: null,
      metadata: { width: 0, height: 0, bands: 1, bounds: null, hasOverviews: false },
      background_job_id: id,
    });
  }
});

// ─── Status del job ───
app.get('/api/import-status/:id', (req, res) => {
  res.json(bgPool[req.params.id] || { status: 'unknown' });
});

// ─── Upload raw (solo guarda en disco, sin metadatos — para optimizar TIFF) ───
app.post('/api/upload-fast', upload.single('tiff'), async (req, res) => {
  try {
    const { filename: savedAs, size } = req.file;
    res.json({ success: true, id: savedAs, size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Open local (sin upload) ───
app.post('/api/tiff/open-local', express.json(), async (req, res) => {
  try {
    const { path: tiffPath } = req.body;
    if (!tiffPath) return res.status(400).json({ error: 'Ruta requerida' });
    if (!fs.existsSync(tiffPath)) return res.status(404).json({ error: 'No encontrado' });
    const filename = path.basename(tiffPath);
    const { stdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', tiffPath], { env: GDAL_ENV, timeout: 30000 });
    const info = JSON.parse(stdout);
    const bandsArr = info.bands || [];
    const types = bandsArr.map(b => b.type);
    const mins = bandsArr.map(b => b.minimum);
    const maxs = bandsArr.map(b => b.maximum);
    const bandCount = bandsArr.length || 1;

    let bounds = null;
    if (info.wgs84Extent) {
      const coords = info.wgs84Extent.coordinates[0];
      const lons = coords.map(c => c[0]);
      const lats = coords.map(c => c[1]);
      bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
    } else {
      const corners = info.cornerCoordinates;
      if (corners) {
        try {
          const pts = [`${corners.upperLeft[0]} ${corners.upperLeft[1]}`, `${corners.lowerLeft[0]} ${corners.lowerLeft[1]}`, `${corners.lowerRight[0]} ${corners.lowerRight[1]}`, `${corners.upperRight[0]} ${corners.upperRight[1]}`].join('\n');
          const { stdout: ts } = await execFileAsync(path.join(GDAL_PATH, 'gdaltransform.exe'), ['-t_srs', 'EPSG:4326', tiffPath], { env: GDAL_ENV, input: pts, timeout: 15000 });
          const ln = ts.trim().split('\n');
          const lons = [], lats = [];
          for (const l of ln) { const p = l.trim().split(/\s+/); if (p.length >= 2) { lons.push(parseFloat(p[0])); lats.push(parseFloat(p[1])); } }
          if (lons.length >= 2) bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
        } catch(e) {}
      }
    }

    const savedAs = `local-${Date.now()}-${filename}`;
    global.__localTiffPaths[savedAs] = tiffPath;

    res.json({
      filename, savedAs, width: info.size[0], height: info.size[1],
      bands: bandCount, types, mins, maxs, hasOverviews: !!(info.overviews && info.overviews.length > 0),
      bounds, thumbnailUrl: null,
      status: 'instant',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Buscar TIFF por nombre en rutas conocidas ───
app.post('/api/tiff/find-by-name', express.json(), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    const searchPaths = [
      path.join(UPLOAD_DIR, name),
      path.join(PUBLIC_DIR, name),
      path.join(os.homedir(), 'Downloads', name),
      path.join(os.homedir(), 'Desktop', name),
      path.join(os.homedir(), 'Documents', name),
    ];
    let found = null;
    for (const p of searchPaths) {
      try { if (fs.existsSync(p)) { found = p; break; } } catch(e) {}
    }
    if (!found) return res.status(404).json({ error: 'No encontrado en rutas locales' });

    const baseName = path.basename(found);
    const savedAs = `local-${Date.now()}-${baseName}`;
    global.__localTiffPaths[savedAs] = found;
    // Intentar obtener metadata con timeout corto, pero NO fallar si tarda
    let width = 0, height = 0, bands = 1, types = [], mins = [], maxs = [], hasOverviews = false, bounds = null;
    try {
      const { stdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', found], { env: GDAL_ENV, timeout: 30000 });
      const info = JSON.parse(stdout);
      const bandsArr = info.bands || [];
      types = bandsArr.map(b => b.type);
      mins = bandsArr.map(b => b.minimum);
      maxs = bandsArr.map(b => b.maximum);
      width = info.size[0]; height = info.size[1];
      bands = bandsArr.length || 1;
      hasOverviews = !!(info.overviews && info.overviews.length > 0);

      if (info.wgs84Extent) {
        const coords = info.wgs84Extent.coordinates[0];
        const lons = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
      } else {
        const corners = info.cornerCoordinates;
        if (corners) {
          try {
            const pts = [`${corners.upperLeft[0]} ${corners.upperLeft[1]}`, `${corners.lowerLeft[0]} ${corners.lowerLeft[1]}`, `${corners.lowerRight[0]} ${corners.lowerRight[1]}`, `${corners.upperRight[0]} ${corners.upperRight[1]}`].join('\n');
            const { stdout: ts } = await execFileAsync(path.join(GDAL_PATH, 'gdaltransform.exe'), ['-t_srs', 'EPSG:4326', found], { env: GDAL_ENV, input: pts, timeout: 15000 });
            const ln = ts.trim().split('\n');
            const lons = [], lats = [];
            for (const l of ln) { const p = l.trim().split(/\s+/); if (p.length >= 2) { lons.push(parseFloat(p[0])); lats.push(parseFloat(p[1])); } }
            if (lons.length >= 2) bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
          } catch(e) {}
        }
      }
    } catch(e) {
      console.warn('[FindByName] Metadata timeout/incomplete:', e.message.substring(0, 100));
    }

    res.json({ filename: name, savedAs, width, height, bands, types, mins, maxs, hasOverviews, bounds, status: 'found' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── List local TIFF files on server ───
app.get('/api/files/local-tiffs', (req, res) => {
  try {
    const tiffs = [];
    const dirs = [UPLOAD_DIR, PUBLIC_DIR];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (/\.(tiff?|img)$/i.test(entry)) {
          const fullPath = path.join(dir, entry);
          const stat = fs.statSync(fullPath);
          tiffs.push({
            name: entry,
            path: fullPath,
            size: stat.size,
            mtime: stat.mtime,
            dir: path.basename(dir),
          });
        }
      }
    }
    tiffs.sort((a, b) => b.mtime - a.mtime);
    res.json(tiffs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Mount missing API routes ───
const uploadHandler = require('./api/upload');
const filesHandler = require('./api/files');
const layersHandler = require('./api/layers');
const projectsHandler = require('./api/projects');

app.all('/api/upload', (req, res) => uploadHandler(req, res));
app.all('/api/files', (req, res) => filesHandler(req, res));
app.all('/api/layers', (req, res) => layersHandler(req, res));
app.all('/api/projects', (req, res) => projectsHandler(req, res));

// ─── TIFF instant-upload (client-side XHR upload) ───
app.post('/api/tiff/instant-upload', upload.single('tiff'), async (req, res) => {
  try {
    const { path: tiffPath, originalname, size } = req.file;
    const savedAs = req.file.filename;
    const baseName = originalname.replace(/\.[^.]+$/, '');
    let metadata = { width: 0, height: 0, bands: 1, bounds: null, hasOverviews: false };

    try {
      const { stdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', tiffPath], { env: GDAL_ENV, timeout: 30000 });
      const info = JSON.parse(stdout);
      const bands = info.bands || [];
      metadata = {
        width: info.size[0], height: info.size[1],
        bands: bands.length || 1,
        hasOverviews: !!(info.overviews && info.overviews.length > 0),
      };
      if (info.wgs84Extent) {
        const coords = info.wgs84Extent.coordinates[0];
        const lons = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        metadata.bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
      } else {
        const corners = info.cornerCoordinates;
        if (corners) {
          try {
            const pts = [`${corners.upperLeft[0]} ${corners.upperLeft[1]}`, `${corners.lowerLeft[0]} ${corners.lowerLeft[1]}`, `${corners.lowerRight[0]} ${corners.lowerRight[1]}`, `${corners.upperRight[0]} ${corners.upperRight[1]}`].join('\n');
            const { stdout: ts } = await execFileAsync(path.join(GDAL_PATH, 'gdaltransform.exe'), ['-t_srs', 'EPSG:4326', tiffPath], { env: GDAL_ENV, input: pts, timeout: 15000 });
            const ln = ts.trim().split('\n');
            const lons = [], lats = [];
            for (const l of ln) { const p = l.trim().split(/\s+/); if (p.length >= 2) { lons.push(parseFloat(p[0])); lats.push(parseFloat(p[1])); } }
            if (lons.length >= 2) metadata.bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
          } catch (e) {}
        }
      }
    } catch (e) {
      console.warn('[InstantUpload] Metadata timeout:', e.message.substring(0, 100));
    }

    res.json({
      status: 'instant',
      savedAs, width: metadata.width, height: metadata.height,
      bands: metadata.bands, bounds: metadata.bounds,
      hasOverviews: metadata.hasOverviews,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TIFF open-cog ───
app.post('/api/tiff/open-cog', express.json(), async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL requerida' });
    const vsiPath = `/vsicurl/${url}`;
    let metadata = { width: 0, height: 0, bands: 1, bounds: null, hasOverviews: false };

    try {
      const { stdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', vsiPath], { env: GDAL_ENV, timeout: 30000 });
      const info = JSON.parse(stdout);
      const bands = info.bands || [];
      metadata = {
        width: info.size[0], height: info.size[1],
        bands: bands.length || 1,
        hasOverviews: !!(info.overviews && info.overviews.length > 0),
      };
      if (info.wgs84Extent) {
        const coords = info.wgs84Extent.coordinates[0];
        const lons = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        metadata.bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
      } else {
        const corners = info.cornerCoordinates;
        if (corners) {
          try {
            const pts = [`${corners.upperLeft[0]} ${corners.upperLeft[1]}`, `${corners.lowerLeft[0]} ${corners.lowerLeft[1]}`, `${corners.lowerRight[0]} ${corners.lowerRight[1]}`, `${corners.upperRight[0]} ${corners.upperRight[1]}`].join('\n');
            const { stdout: ts } = await execFileAsync(path.join(GDAL_PATH, 'gdaltransform.exe'), ['-i', '-t_srs', 'EPSG:4326', vsiPath], { env: GDAL_ENV, input: pts, timeout: 15000 });
            const ln = ts.trim().split('\n');
            const lons = [], lats = [];
            for (const l of ln) { const p = l.trim().split(/\s+/); if (p.length >= 2) { lons.push(parseFloat(p[0])); lats.push(parseFloat(p[1])); } }
            if (lons.length >= 2) metadata.bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
          } catch (e) {}
        }
      }
    } catch (e) {
      return res.status(400).json({ error: 'No se pudo leer el COG remoto: ' + e.message.substring(0, 200) });
    }

    const filename = url.split('/').pop() || 'remote.tiff';
    const savedAs = `cog-${Date.now()}-${filename}`;
    global.__localTiffPaths[savedAs] = vsiPath;

    res.json({
      filename, savedAs,
      width: metadata.width, height: metadata.height,
      bands: metadata.bands, bounds: metadata.bounds,
      hasOverviews: metadata.hasOverviews,
      fileUrl: url,
      status: 'cog',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Compress / Optimize TIFF for web ───
const COMPRESS_DIR = path.join(__dirname, 'public', 'compressed');
if (!fs.existsSync(COMPRESS_DIR)) fs.mkdirSync(COMPRESS_DIR, { recursive: true });

// ─── Generate quick JPEG thumbnail from a TIFF (uses GDAL overviews, sub-second) ───
async function generateThumbnail(tiffPath, thumbPath, maxPx = 1024) {
  if (fs.existsSync(thumbPath)) return;
  // Try 3-band RGB first, then palette-expanded RGB, then single-band grayscale
  const strategies = [
    ['-of', 'JPEG', '-b', '1', '-b', '2', '-b', '3', '-ot', 'Byte', '-scale', '-outsize', String(maxPx), '0', '-co', 'QUALITY=75'],
    ['-of', 'JPEG', '-b', '1', '-expand', 'rgb', '-outsize', String(maxPx), '0', '-co', 'QUALITY=75'],
    ['-of', 'JPEG', '-b', '1', '-ot', 'Byte', '-scale', '-outsize', String(maxPx), '0', '-co', 'QUALITY=75'],
  ];
  for (const args of strategies) {
    try {
      await execFileAsync(path.join(GDAL_PATH, 'gdal_translate.exe'), [...args, tiffPath, thumbPath], { env: GDAL_ENV, timeout: 15000 });
      if (fs.existsSync(thumbPath)) return;
    } catch (e) {}
  }
}

// ─── Shared TIFF optimization / compression logic ───
// Preserva la resolución original íntegra y solo añade pirámides (overviews) GDAL
// para que el tile server y geotiff.js puedan servir el mapa rápido en cualquier zoom.
// NUNCA hace downsampling — la calidad nativa del dron se conserva al 100%.
async function optimizeTiff(sourcePath, baseName, quality = 85) {
  const ext = path.extname(sourcePath) || '.tif';
  const origSize = fs.statSync(sourcePath).size;

  // 1) Get metadata
  let info;
  const { stdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', sourcePath], { env: GDAL_ENV, timeout: 30000 });
  info = JSON.parse(stdout);

  const width = info.size[0], height = info.size[1];
  const bandsArr = info.bands || [];
  console.log(`[Optimize] ${baseName} (${width}x${height}) — preservando resolución nativa, añadiendo overviews...`);

  // Extract WGS84 bounds
  let wgs84Bounds = null;
  if (info.wgs84Extent) {
    const coords = info.wgs84Extent.coordinates[0];
    const lons = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);
    wgs84Bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
  } else {
    const corners = info.cornerCoordinates;
    if (corners) {
      try {
        const pts = [`${corners.upperLeft[0]} ${corners.upperLeft[1]}`, `${corners.lowerLeft[0]} ${corners.lowerLeft[1]}`, `${corners.lowerRight[0]} ${corners.lowerRight[1]}`, `${corners.upperRight[0]} ${corners.upperRight[1]}`].join('\n');
        const { stdout: ts } = await execFileAsync(path.join(GDAL_PATH, 'gdaltransform.exe'), ['-t_srs', 'EPSG:4326', sourcePath], { env: GDAL_ENV, input: pts, timeout: 15000 });
        const ln = ts.trim().split('\n');
        const lons = [], lats = [];
        for (const l of ln) { const p = l.trim().split(/\s+/); if (p.length >= 2) { lons.push(parseFloat(p[0])); lats.push(parseFloat(p[1])); } }
        if (lons.length >= 2) wgs84Bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
      } catch (e) {}
    }
  }

  // Extract source CRS from original file metadata
  let sourceCRS = null;
  if (info.coordinateSystem?.wkt) {
    const authMatch = [...info.coordinateSystem.wkt.matchAll(/AUTHORITY\["EPSG","(\d+)"\]/g)];
    if (authMatch.length > 0) {
      sourceCRS = `EPSG:${authMatch[authMatch.length - 1][1]}`;
    } else {
      sourceCRS = info.coordinateSystem.wkt;
    }
  } else if (info.geoKeyWords?.ProjectedCSTypeGeoKey) {
    sourceCRS = `EPSG:${info.geoKeyWords.ProjectedCSTypeGeoKey}`;
  }

  // 2) Copiar el original al directorio de compressed SIN reducir resolución
  //    Si ya tiene tiling interno y overviews, lo copiamos; si no, lo retilamos.
  const finalPath = path.join(COMPRESS_DIR, `${baseName}_opt.tif`);
  const compressedName = `${baseName}_opt.tif`;

  const hasTiling = !!(info.metadata && info.metadata[''] && info.metadata['']['LAYOUT'] === 'COG') ||
                    (info.structuralMetadata && info.structuralMetadata.LAYOUT === 'COG');
  const hasExistingOverviews = !!(info.overviews && info.overviews.length > 0);

  // Detectar si la fuente tiene paleta de colores (clasificación)
  const hasPalette = bandsArr.some(b => b.colorTable);
  const isNonTiffSource = !/\.tiff?$/i.test(path.extname(sourcePath));

  if (hasExistingOverviews && fs.existsSync(finalPath) && !isNonTiffSource && !hasPalette) {
    console.log(`[Optimize] Ya existe con overviews, reutilizando: ${compressedName}`);
    // Verificar que el archivo existente tenga CRS
    try {
      const { stdout: checkStdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', finalPath], { env: GDAL_ENV, timeout: 15000 });
      const checkInfo = JSON.parse(checkStdout);
      const hasCRS = checkInfo.coordinateSystem?.wkt || checkInfo.wgs84Extent;
      if (!hasCRS && sourceCRS) {
        console.log(`[Optimize] CRS perdido en archivo existente, reasignando ${sourceCRS}...`);
        await execFileAsync(path.join(GDAL_PATH, 'gdal_translate.exe'), ['-a_srs', sourceCRS, finalPath, finalPath + '.fixed.tif'], { env: GDAL_ENV, timeout: 120000 });
        fs.renameSync(finalPath + '.fixed.tif', finalPath);
      }
    } catch (e) {
      console.warn('[Optimize] Error verificando CRS del archivo existente:', e.message.substring(0, 100));
    }
  } else {
    // For non-TIFF sources (.img, etc.) or palette sources, always regenerate
    if ((isNonTiffSource || hasPalette) && fs.existsSync(finalPath)) {
      console.log(`[Optimize] Fuente no-TIFF o con paleta, regenerando: ${compressedName}`);
      try { fs.unlinkSync(finalPath); } catch(e) {}
      try { fs.unlinkSync(finalPath + '.aux.xml'); } catch(e) {}
    }
    const retileArgs = [
      '-of', 'GTiff',
      '-co', 'TILED=YES',
      '-co', 'BLOCKXSIZE=256',
      '-co', 'BLOCKYSIZE=256',
      '-co', 'COMPRESS=LZW',
    ];
    // Para datos con paleta, expandir a RGB para preservar colores de clasificación
    if (hasPalette) {
      retileArgs.push('-expand', 'rgb');
    } else {
      // PREDICTOR=2 solo para datos continuos (float), no para datos categóricos
      retileArgs.push('-co', 'PREDICTOR=2');
    }
    retileArgs.push(sourcePath, finalPath);
    // Forzar CRS explícitamente para formatos no-TIFF (como .img) que pueden perder CRS al convertir
    if (sourceCRS && path.extname(sourcePath).toLowerCase() !== '.tif' && path.extname(sourcePath).toLowerCase() !== '.tiff') {
      retileArgs.splice(retileArgs.length - 2, 0, '-a_srs', sourceCRS);
    }
    console.log(`[Optimize] Retilando con LZW lossless (sin downsample)...`);
    const startT = Date.now();
    await execFileAsync(path.join(GDAL_PATH, 'gdal_translate.exe'), retileArgs, { env: GDAL_ENV, timeout: 600000 });
    console.log(`[Optimize] Retilado completado en ${((Date.now()-startT)/1000).toFixed(1)}s`);

    // 3) Añadir overviews (pirámides) para que el mapa sea fluido a cualquier zoom
    try {
      const maxDim = Math.max(width, height);
      const ovrLevels = [];
      for (let l = 2; l <= 512; l *= 2) {
        if (maxDim / l >= 64) ovrLevels.push(l);
        else break;
      }
      if (ovrLevels.length > 0) {
        console.log(`[Optimize] Añadiendo overviews: ${ovrLevels.join(',')}`);
        await execFileAsync(path.join(GDAL_PATH, 'gdaladdo.exe'), ['-r', 'average', '--config', 'COMPRESS_OVERVIEW', 'LZW', finalPath, ...ovrLevels.map(String)], { env: GDAL_ENV, timeout: 600000 });
        console.log(`[Optimize] Overviews añadidos OK`);
      }
    } catch (e) {
      console.warn('[Optimize] Error añadiendo overviews (no crítico):', e.message.substring(0, 100));
    }
  }

  const compressedSize = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : origSize;
  const savings = ((1 - compressedSize / origSize) * 100).toFixed(1);
  console.log(`[Optimize] OK: ${compressedName} — ${width}x${height}px preservados (${(compressedSize/1e6).toFixed(1)}MB, ${savings}% LZW)`);

  // 4) Generar thumbnail para visualización instantánea
  const thumbName = `${baseName}_opt_thumb.jpg`;
  const thumbPath = path.join(COMPRESS_DIR, thumbName);
  await generateThumbnail(finalPath, thumbPath);

  // 5) Pre-generación de tiles en background (zoom 0-10 para carga instantánea)
  setImmediate(() => {
    pregenerateTiles(finalPath, compressedName, wgs84Bounds).catch(e =>
      console.warn('[TilePreGen] Error en pre-generación:', e.message)
    );
  });

  return {
    filename: compressedName,
    savedAs: compressedName,
    width,         // resolución ORIGINAL
    height,        // resolución ORIGINAL
    origSize,
    compressedSize,
    savings: parseFloat(savings),
    bounds: wgs84Bounds,
    fileUrl: `/compressed/${encodeURIComponent(compressedName)}`,
    thumbnailUrl: `/compressed/${encodeURIComponent(thumbName)}`,
  };
}


app.post('/api/compress-tiff', express.json(), async (req, res) => {
  try {
    const { filename, quality = 85 } = req.body;
    if (!filename) return res.status(400).json({ error: 'Se requiere filename' });

    const searchPaths = [
      path.join(UPLOAD_DIR, filename),
      path.join(PUBLIC_DIR, filename),
    ];
    if (global.__localTiffPaths && global.__localTiffPaths[filename]) {
      searchPaths.push(global.__localTiffPaths[filename]);
    }
    let sourcePath = null;
    for (const p of searchPaths) {
      if (fs.existsSync(p)) { sourcePath = p; break; }
    }
    if (!sourcePath) return res.status(404).json({ error: 'Archivo no encontrado' });

    const baseName = path.basename(filename, path.extname(filename));

    const result = await optimizeTiff(sourcePath, baseName, quality);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Compress] Error:', err.message);
    if (err.stderr) console.error('[Compress] Stderr:', err.stderr.substring(0, 500));
    if (err.stdout) console.error('[Compress] Stdout:', err.stdout.substring(0, 200));
    res.status(500).json({ error: err.message.substring(0, 200) });
  }
});

app.get('/api/tiff/preview', (req, res) => res.json({ message: 'TIFF Preview API', import: 'POST /api/import-tiff (multipart: tiff)', local: 'POST /api/tiff/open-local', cog: 'POST /api/tiff/open-cog' }));
app.use('/api/tiff/preview', tiffPreviewRouter);
app.use('/api/dzi', dziRouter);

// ─── High-performance raster tile server using GDAL ───
const TILE_CACHE_DIR = path.join(__dirname, 'public', 'tiles');
if (!fs.existsSync(TILE_CACHE_DIR)) fs.mkdirSync(TILE_CACHE_DIR, { recursive: true });

const tiffGeoCache = new Map();
const GEO_CACHE_MAX = 200;

async function getTiffGeoCached(filePath) {
  if (tiffGeoCache.has(filePath)) {
    tiffGeoCache.get(filePath)._lastAccess = Date.now();
    return tiffGeoCache.get(filePath);
  }
  try {
    const { stdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', '-stats', filePath], { env: GDAL_ENV, timeout: 30000 });
    const info = JSON.parse(stdout);
    const w = info.size[0], h = info.size[1];
    const bands = info.bands || [];
    const bandCount = bands.length;
    const isByte = bands.every(b => b.type === 'Byte');
    const mins = bands.map(b => b.minimum);
    const maxs = bands.map(b => b.maximum);
    const hasPalette = bands.some(b => b.colorTable);
    const bandDesc = bands.map(b => b.description);
    let geo = { width: w, height: h, bounds: null, transform: null, bandCount, isByte, _mins: mins, _maxs: maxs, _hasPalette: hasPalette, _bandDesc: bandDesc };
    if (info.wgs84Extent) {
      const coords = info.wgs84Extent.coordinates[0];
      const lons = coords.map(c => c[0]);
      const lats = coords.map(c => c[1]);
      geo.bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
    }
    // Fallback: calcular bounds desde cornerCoordinates si wgs84Extent no está disponible
    if (!geo.bounds && info.cornerCoordinates) {
      const corners = info.cornerCoordinates;
      try {
        const pts = [
          `${corners.upperLeft[0]} ${corners.upperLeft[1]}`,
          `${corners.lowerLeft[0]} ${corners.lowerLeft[1]}`,
          `${corners.lowerRight[0]} ${corners.lowerRight[1]}`,
          `${corners.upperRight[0]} ${corners.upperRight[1]}`
        ].join('\n');
        const { stdout: ts } = await execFileAsync(
          path.join(GDAL_PATH, 'gdaltransform.exe'),
          ['-t_srs', 'EPSG:4326', filePath],
          { env: GDAL_ENV, input: pts, timeout: 15000 }
        );
        const ln = ts.trim().split('\n').filter(l => l.trim());
        if (ln.length >= 4) {
          const lons = [], lats = [];
          for (const l of ln) {
            const p = l.trim().split(/\s+/);
            if (p.length >= 2) { lons.push(parseFloat(p[0])); lats.push(parseFloat(p[1])); }
          }
          if (lons.length >= 2) {
            geo.bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
          }
        }
      } catch (e) {
        console.warn('[TileServer] Fallback bounds transform failed:', e.message.substring(0, 100));
      }
    }
    // Fallback extremo: usar las coordenadas de esquina directamente como WGS84
    if (!geo.bounds && info.cornerCoordinates) {
      const c = info.cornerCoordinates;
      const lons = [c.upperLeft[0], c.lowerLeft[0], c.lowerRight[0], c.upperRight[0]];
      const lats = [c.upperLeft[1], c.lowerLeft[1], c.lowerRight[1], c.upperRight[1]];
      if (lons.every(v => v >= -180 && v <= 180) && lats.every(v => v >= -90 && v <= 90)) {
        geo.bounds = { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
        if (!geo._sourceCRS) geo._sourceCRS = 'EPSG:4326';
      }
    }
    if (info.geoTransform && info.geoTransform.length === 6) {
      geo.transform = info.geoTransform;
    }
    if (info.coordinateSystem?.wkt) {
      const authMatch = [...info.coordinateSystem.wkt.matchAll(/AUTHORITY\["EPSG","(\d+)"\]/g)];
      if (authMatch.length > 0) {
        geo._sourceCRS = `EPSG:${authMatch[authMatch.length - 1][1]}`;
      } else {
        geo._sourceCRS = info.coordinateSystem.wkt;
      }
    } else if (info.geoKeyWords?.ProjectedCSTypeGeoKey) {
      geo._sourceCRS = `EPSG:${info.geoKeyWords.ProjectedCSTypeGeoKey}`;
    }
    // Default CRS si no se pudo detectar
    if (!geo._sourceCRS) {
      geo._sourceCRS = 'EPSG:4326';
    }

    // Detectar si es archivo de clasificación (palette-expanded a RGB)
    // Si el archivo actual no tiene paleta pero es 3-band RGB, verificar si la fuente original tenía paleta
    if (!hasPalette && bandCount === 3 && isByte) {
      const baseName = path.basename(filePath).replace(/\.[^.]+$/, '').replace(/_opt$/, '');
      if (fs.existsSync(UPLOAD_DIR)) {
        const match = fs.readdirSync(UPLOAD_DIR).find(f => {
          const s = f.replace(/^\d+-/, '').replace(/\.[^.]+$/, '');
          return s === baseName;
        });
        if (match) {
          try {
            const srcPath = path.join(UPLOAD_DIR, match);
            const { stdout: srcStdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', srcPath], { env: GDAL_ENV, timeout: 15000 });
            const srcInfo = JSON.parse(srcStdout);
            if ((srcInfo.bands || []).some(b => b.colorTable)) {
              geo._isClassification = true;
              console.log(`[TileServer] Detected classification file (palette-expanded): ${baseName}`);
            }
          } catch(e) {}
        }
      }
    }

    // Detectar clasificación en single-band Byte con rango pequeño (ej. valores 2-3)
    if (!geo._isClassification && isByte && bandCount === 1 && geo._mins && geo._maxs) {
      const range = geo._maxs[0] - geo._mins[0];
      if (range > 0 && range < 10) {
        geo._isClassification = true;
        console.log(`[TileServer] Detected single-band classification (range=${range}): ${path.basename(filePath)}`);
      }
    }

    geo._lastAccess = Date.now();
    if (tiffGeoCache.size >= GEO_CACHE_MAX) {
      let oldest = null;
      for (const [k, v] of tiffGeoCache) {
        if (!oldest || v._lastAccess < oldest._lastAccess) oldest = { key: k, val: v };
      }
      if (oldest) tiffGeoCache.delete(oldest.key);
    }
    tiffGeoCache.set(filePath, geo);
    return geo;
  } catch (e) {
    console.warn('[TileServer] Failed to get geo info:', e.message.substring(0, 100));
    return null;
  }
}

function xyzToBounds(x, y, z) {
  const n = Math.pow(2, z);
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const mercN = Math.PI - 2 * Math.PI * y / n;
  const north = 180 / Math.PI * Math.atan(0.5 * (Math.exp(mercN) - Math.exp(-mercN)));
  const mercS = Math.PI - 2 * Math.PI * (y + 1) / n;
  const south = 180 / Math.PI * Math.atan(0.5 * (Math.exp(mercS) - Math.exp(-mercS)));
  return { west, south, east, north };
}

function srcCRSToPixel(crsX, crsY, geo) {
  const gt = geo.transform;
  if (gt[2] === 0 && gt[4] === 0) {
    const col = (crsX - gt[0]) / gt[1];
    const row = (crsY - gt[3]) / gt[5];
    return { x: col, y: row };
  }
  const det = gt[1] * gt[5] - gt[2] * gt[4];
  if (det === 0) return null;
  const col = ((crsX - gt[0]) * gt[5] - (crsY - gt[3]) * gt[2]) / det;
  const row = ((crsY - gt[3]) * gt[1] - (crsX - gt[0]) * gt[4]) / det;
  return { x: col, y: row };
}

function getSourceCRS(geo) {
  return geo._sourceCRS || 'EPSG:3116';
}

async function wgs84ToPixelAccurate(west, north, east, south, geo) {
  const input = `${west} ${north}\n${east} ${north}\n${east} ${south}\n${west} ${south}`;
  try {
    const { stdout } = await execFileAsync(path.join(GDAL_PATH, 'gdaltransform.exe'), ['-s_srs', 'EPSG:4326', '-t_srs', getSourceCRS(geo)], { env: GDAL_ENV, input, timeout: 10000 });
    const lines = stdout.trim().split('\n').filter(l => l.trim());
    if (lines.length < 4) return null;
    const pts = lines.map(l => { const p = l.trim().split(/\s+/); return { x: parseFloat(p[0]), y: parseFloat(p[1]) }; });
    const minX = Math.min(...pts.map(p => p.x));
    const maxX = Math.max(...pts.map(p => p.x));
    const minY = Math.min(...pts.map(p => p.y));
    const maxY = Math.max(...pts.map(p => p.y));
    const ul = srcCRSToPixel(minX, maxY, geo);
    const lr = srcCRSToPixel(maxX, minY, geo);
    if (!ul || !lr) return null;
    const px = Math.min(ul.x, lr.x);
    const py = Math.min(ul.y, lr.y);
    const pw = Math.abs(lr.x - ul.x);
    const ph = Math.abs(lr.y - ul.y);
    if (pw < 1 || ph < 1) return null;
    return { x: px, y: py, w: pw, h: ph };
  } catch (e) {
    return null;
  }
}

function findTiffPath(savedAs) {
  const searchPaths = [
    path.join(COMPRESS_DIR, savedAs),
    path.join(UPLOAD_DIR, savedAs),
    path.join(PUBLIC_DIR, savedAs),
    path.join(PUBLIC_DIR, 'dzi', savedAs),
  ];
  if (global.__localTiffPaths && global.__localTiffPaths[savedAs]) {
    searchPaths.push(global.__localTiffPaths[savedAs]);
  }
  for (const p of searchPaths) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

function xyzToWebMercator(x, y, z) {
  const earthRadius = 6378137.0;
  const initialResolution = 2 * Math.PI * earthRadius / 256;
  const originShift = 2 * Math.PI * earthRadius / 2.0;

  const res = initialResolution / Math.pow(2, z);
  const minX = (x * 256) * res - originShift;
  const maxY = originShift - (y * 256) * res;
  const maxX = ((x + 1) * 256) * res - originShift;
  const minY = originShift - ((y + 1) * 256) * res;

  return { minX, minY, maxX, maxY };
}

// In-memory lock to prevent concurrent writes to the same tile
const tileLocks = new Map();
const LOCK_TIMEOUT = 60000;

function acquireTileLock(key) {
  if (tileLocks.has(key)) {
    const entry = tileLocks.get(key);
    if (Date.now() - entry > LOCK_TIMEOUT) {
      tileLocks.delete(key);
    } else {
      return false;
    }
  }
  tileLocks.set(key, Date.now());
  return true;
}

function releaseTileLock(key) {
  tileLocks.delete(key);
}

async function warpTileWithGdal(sourcePath, wmBounds, outPath, tileSize, geo, zoom, symbology = {}) {
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const tmpPath = outPath + '.tmp';
  const vrtPath = outPath + '.vrt';
  const vrt2Path = outPath + '.vrt2';

  const isSingleBand = geo && geo.bandCount === 1;
  const hasPalette = geo && geo._hasPalette;
  const isClassification = geo && (geo._isClassification || geo._bandDesc?.some(d => d && /classif|clasif|classification/i.test(d)));
  const isByteClass = isSingleBand && geo && geo.isByte && geo._mins && geo._maxs && (geo._maxs[0] - geo._mins[0]) < 10;
  const resample = (hasPalette || isClassification || isByteClass) ? 'near' : (isSingleBand ? 'bilinear' : 'cubic');
  const useOvr = 'AUTO';

    // Symbology parameters
    const bands = symbology.bands || null;
    const renderer = symbology.renderer || null;
    const colormap = symbology.colormap || null;
    const invert = symbology.invert || false;
    const classes = symbology.classes || 0;

    console.log(`[TileServer] Processing tile with symbology: renderer=${renderer}, colormap=${colormap}, bands=${bands}, invert=${invert}, classes=${classes}`);

  try {
    // 1. Warp source to Web Mercator VRT
    const warpArgs = [
      '-of', 'VRT',
      '-t_srs', 'EPSG:3857',
      '-te', String(wmBounds.minX), String(wmBounds.minY), String(wmBounds.maxX), String(wmBounds.maxY),
      '-ts', String(tileSize), String(tileSize),
      '-r', resample,
      '-ovr', useOvr,
      '-wm', '1024',
      '-multi',
      '-q',
    ];
    if (geo && geo._sourceCRS) {
      warpArgs.push('-s_srs', geo._sourceCRS);
    }
    warpArgs.push(sourcePath, vrtPath);

    await execFileAsync(path.join(GDAL_PATH, 'gdalwarp.exe'), warpArgs, { env: GDAL_ENV, timeout: 120000 });

    // Validate VRT was produced correctly
    if (!fs.existsSync(vrtPath) || fs.statSync(vrtPath).size < 500) {
      console.warn('[TileServer] gdalwarp produced empty/invalid VRT');
      return false;
    }

    // 2. Convert VRT to PNG with symbology applied
    let success = false;
    let currentVrt = vrtPath;

    // Apply band selection if specified
    if (bands && bands.length > 0 && !hasPalette) {
      const bandArgs = [];
      for (const b of bands) {
        bandArgs.push('-b', String(b + 1));
      }
      // For multiband RGB, need 3 bands
      if (renderer === 'multiband' && bands.length === 3) {
        bandArgs.length = 0;
        for (const b of bands) {
          bandArgs.push('-b', String(b + 1));
        }
      } else if (renderer === 'single_gray' || renderer === 'single' || renderer === 'pseudocolor' || bands.length === 1) {
        // Single band mode - just select that band
        bandArgs.length = 0;
        bandArgs.push('-b', String(bands[0] + 1));
      }
      
      if (bandArgs.length > 0) {
        try {
          await execFileAsync(path.join(GDAL_PATH, 'gdal_translate.exe'), ['-of', 'VRT', '-q', ...bandArgs, vrtPath, vrt2Path], { env: GDAL_ENV, timeout: 30000 });
          currentVrt = vrt2Path;
          console.log(`[TileServer] Band selection applied: ${bandArgs.join(' ')}`);
        } catch(e) {
          console.warn('[TileServer] Band selection failed:', e.message.substring(0, 100));
        }
      }
    } else if (renderer === 'pseudocolor' && !hasPalette) {
      // For pseudocolor, force single band (band 1) if no bands specified
      try {
        await execFileAsync(path.join(GDAL_PATH, 'gdal_translate.exe'), ['-of', 'VRT', '-q', '-b', '1', vrtPath, vrt2Path], { env: GDAL_ENV, timeout: 30000 });
        currentVrt = vrt2Path;
        console.log('[TileServer] Forced single band for pseudocolor');
      } catch(e) {
        console.warn('[TileServer] Band selection for pseudocolor failed:', e.message.substring(0, 100));
      }
    }
    
    console.log(`[TileServer] Bands: ${isSingleBand ? 'single' : 'multi'}, VRT: ${currentVrt === vrt2Path ? 'selected' : 'original'}`);

    // 3. Apply renderer-specific processing
    let translateArgs = [];

    if (hasPalette) {
      // Color palette → RGB (preserves original class colors)
      translateArgs = ['-of', 'PNG', '-q', '-co', 'ZLEVEL=1', '-expand', 'rgb', currentVrt, tmpPath];
    } else if (renderer === 'pseudocolor' && colormap) {
      // Apply pseudocolor ramp
      console.log(`[TileServer] Applying pseudocolor: ${colormap}, invert: ${invert}`);
      const colorRamp = getColorRamp(colormap, invert, classes);
      console.log(`[TileServer] Pseudocolor ramp: ${colormap}, invert=${invert}, classes=${classes}, entries=${colorRamp?.split('\n').length}`);
      if (colorRamp) {
        const colorFile = outPath + '.clr';
        const singleBandTiff = outPath + '.singleband.tif';
        const coloredTiff = outPath + '.colored.tif';
        try {
          // Write color ramp file (values 0-255)
          fs.writeFileSync(colorFile, colorRamp);
          console.log(`[TileServer] Color ramp file written: ${colorFile}`);
          
          // First convert to single-band GeoTIFF scaled to 0-255
          if (geo._mins && geo._maxs && geo._mins[0] != null && geo._maxs[0] != null) {
            const mn = geo._mins[0];
            const mx = geo._maxs[0];
            console.log(`[TileServer] Scaling from [${mn}, ${mx}] to [0, 255], range: ${mx - mn}`);
            await execFileAsync(
              path.join(GDAL_PATH, 'gdal_translate.exe'),
              ['-of', 'GTiff', '-q', '-scale', String(mn), String(mx), '0', '255', '-ot', 'Byte', currentVrt, singleBandTiff],
              { env: GDAL_ENV, timeout: 30000 }
            );
          } else {
            console.log(`[TileServer] Auto-scaling (no min/max available)`);
            // Auto-scale
            await execFileAsync(
              path.join(GDAL_PATH, 'gdal_translate.exe'),
              ['-of', 'GTiff', '-q', '-scale', '-ot', 'Byte', currentVrt, singleBandTiff],
              { env: GDAL_ENV, timeout: 30000 }
            );
          }
          
          // Check the actual stats of the single-band TIFF
          try {
            const { stdout: statsOut } = await execFileAsync(
              path.join(GDAL_PATH, 'gdalinfo.exe'),
              ['-stats', '-json', singleBandTiff],
              { env: GDAL_ENV, timeout: 15000 }
            );
            const statsInfo = JSON.parse(statsOut);
            const bandStats = statsInfo.bands?.[0]?.statistics;
            if (bandStats) {
              console.log(`[TileServer] Single band stats - min: ${bandStats.minimum}, max: ${bandStats.maximum}, mean: ${bandStats.mean}`);
            }
          } catch(e) {
            console.warn('[TileServer] Could not get stats:', e.message.substring(0, 100));
          }
          
          console.log(`[TileServer] Single band GeoTIFF created: ${singleBandTiff}`);
          
          // Apply color relief using gdaldem
          const { stdout, stderr } = await execFileAsync(
            path.join(GDAL_PATH, 'gdaldem.exe'), 
            ['color-relief', '-of', 'GTiff', '-q', '-nearest_color_entry', singleBandTiff, colorFile, coloredTiff], 
            { env: GDAL_ENV, timeout: 30000 }
          );
          
          if (stderr) console.log(`[TileServer] gdaldem stderr: ${stderr.substring(0, 200)}`);
          
          // Convert colored GeoTIFF to PNG
          await execFileAsync(
            path.join(GDAL_PATH, 'gdal_translate.exe'),
            ['-of', 'PNG', '-q', '-co', 'ZLEVEL=1', coloredTiff, tmpPath],
            { env: GDAL_ENV, timeout: 30000 }
          );
          
          if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 80) {
            success = true;
            console.log(`[TileServer] Pseudocolor applied successfully`);
          } else {
            console.warn('[TileServer] Pseudocolor output is empty or too small');
          }
        } catch(e) {
          console.warn('[TileServer] Pseudocolor failed:', e.message.substring(0, 200));
          if (e.stderr) console.warn('[TileServer] gdaldem stderr:', e.stderr.substring(0, 200));
        } finally {
          try { fs.unlinkSync(colorFile); } catch(e) {}
          try { fs.unlinkSync(singleBandTiff); } catch(e) {}
          try { fs.unlinkSync(coloredTiff); } catch(e) {}
        }
      }
      if (!success) {
        // Fallback to grayscale
        console.log('[TileServer] Falling back to grayscale');
        translateArgs = ['-of', 'PNG', '-q', '-co', 'ZLEVEL=1', '-scale', currentVrt, tmpPath];
      }
    } else if (renderer === 'multiband' || (bands && bands.length >= 3 && renderer !== 'pseudocolor')) {
      // RGB multiband composite
      translateArgs = ['-of', 'PNG', '-q', '-co', 'ZLEVEL=1', currentVrt, tmpPath];
    } else if (renderer === 'single_gray' || renderer === 'single' || (bands && bands.length === 1 && renderer !== 'pseudocolor')) {
      // Single band grayscale
      if (isSingleBand && geo && geo._mins && geo._maxs && geo._mins[0] != null && geo._maxs[0] != null) {
        const mn = geo._mins[0];
        const mx = geo._maxs[0];
        translateArgs = ['-of', 'PNG', '-q', '-co', 'ZLEVEL=1', '-scale', String(mn), String(mx), '0', '255', currentVrt, tmpPath];
      } else {
        translateArgs = ['-of', 'PNG', '-q', '-co', 'ZLEVEL=1', '-scale', currentVrt, tmpPath];
      }
    } else {
      // Default: auto-detect best strategy
      let tries = [];

      // Single-band Byte classification → scale to visible range
      if (isSingleBand && geo && geo._mins && geo._maxs && geo._mins[0] != null && geo._maxs[0] != null) {
        const mn = geo._mins[0];
        const mx = geo._maxs[0];
        tries.push(['-of', 'PNG', '-q', '-co', 'ZLEVEL=1', '-scale', String(mn), String(mx), '50', '255', currentVrt, tmpPath]);
        tries.push(['-of', 'PNG', '-q', '-co', 'ZLEVEL=1', '-scale', String(mn), String(mx), '0', '255', currentVrt, tmpPath]);
      }
      if (isSingleBand) {
        tries.push(['-of', 'PNG', '-q', '-co', 'ZLEVEL=1', '-scale', currentVrt, tmpPath]);
      }

      // For non-Byte data, scale to full range
      if (!isSingleBand && geo && !geo.isByte) {
        tries.push(['-of', 'PNG', '-q', '-co', 'ZLEVEL=1', '-scale', currentVrt, tmpPath]);
      }

      // Standard copy (works for Byte RGB data)
      tries.push(['-of', 'PNG', '-q', '-co', 'ZLEVEL=1', currentVrt, tmpPath]);

      // Force 3-band with band 1 repeated
      tries.push(['-of', 'PNG', '-q', '-co', 'ZLEVEL=1', '-b', '1', '-b', '1', '-b', '1', currentVrt, tmpPath]);

      for (const args of tries) {
        try {
          await execFileAsync(path.join(GDAL_PATH, 'gdal_translate.exe'), args, { env: GDAL_ENV, timeout: 60000 });
          if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 80) {
            success = true;
            break;
          }
        } catch(e) {
          console.warn(`[TileServer] Strategy failed: ${args.slice(0, 6).join(' ')} - ${(e.stderr || e.message || '').substring(0, 200)}`);
        }
      }
    }

    // Execute the final translate if we have args and haven't succeeded yet
    if (!success && translateArgs.length > 0) {
      try {
        await execFileAsync(path.join(GDAL_PATH, 'gdal_translate.exe'), translateArgs, { env: GDAL_ENV, timeout: 60000 });
        if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 80) {
          success = true;
        }
      } catch(e) {
        console.warn(`[TileServer] Final translate failed: ${translateArgs.slice(0, 6).join(' ')} - ${(e.stderr || e.message || '').substring(0, 200)}`);
      }
    }

    try { fs.unlinkSync(vrtPath); } catch(e) {}
    try { fs.unlinkSync(vrt2Path); } catch(e) {}

    if (success) {
      fs.renameSync(tmpPath, outPath);
      return true;
    }

    try { fs.unlinkSync(tmpPath); } catch(e) {}
    return false;
  } catch (e) {
    try { fs.unlinkSync(vrtPath); } catch(err) {}
    try { fs.unlinkSync(vrt2Path); } catch(err) {}
    try { fs.unlinkSync(tmpPath); } catch(err) {}
    return false;
  }
}

// Color ramp definitions for pseudocolor rendering
// Format: value R G B (gdaldem expects pixel values, not percentages)
function getColorRamp(name, invert = false, numClasses = 0) {
  const ramps = {
    jet: [
      [0, 0, 0, 128], [32, 0, 0, 255], [96, 0, 255, 255], [160, 255, 255, 0], [224, 255, 0, 0], [255, 128, 0, 0]
    ],
    viridis: [
      [0, 68, 1, 84], [64, 59, 82, 139], [128, 33, 145, 140], [192, 94, 201, 98], [255, 253, 231, 37]
    ],
    plasma: [
      [0, 13, 8, 135], [64, 126, 3, 168], [128, 204, 71, 120], [192, 248, 149, 64], [255, 240, 249, 33]
    ],
    inferno: [
      [0, 0, 0, 4], [64, 87, 16, 110], [128, 188, 55, 84], [192, 249, 142, 9], [255, 252, 255, 164]
    ],
    magma: [
      [0, 0, 0, 4], [64, 81, 18, 124], [128, 183, 55, 121], [192, 254, 136, 93], [255, 252, 253, 191]
    ],
    grayscale: [
      [0, 0, 0, 0], [255, 255, 255, 255]
    ],
    rainbow: [
      [0, 255, 0, 0], [43, 255, 255, 0], [85, 0, 255, 0], [128, 0, 255, 255], [170, 0, 0, 255], [213, 255, 0, 255], [255, 255, 0, 0]
    ],
    terrain: [
      [0, 51, 51, 153], [64, 0, 128, 0], [128, 255, 255, 0], [192, 139, 90, 43], [255, 255, 255, 255]
    ],
    rdgy: [
      [0, 103, 0, 31], [64, 253, 174, 97], [128, 247, 247, 247], [192, 153, 153, 153], [255, 26, 26, 26]
    ],
    rdbu: [
      [0, 103, 0, 31], [64, 214, 96, 77], [128, 247, 247, 247], [192, 116, 173, 209], [255, 69, 117, 180]
    ],
    rdylgn: [
      [0, 165, 0, 38], [64, 253, 141, 60], [128, 255, 255, 191], [192, 166, 217, 106], [255, 26, 152, 80]
    ],
    ylgnbu: [
      [0, 255, 255, 217], [64, 254, 217, 118], [128, 254, 178, 76], [192, 41, 121, 185], [255, 8, 29, 88]
    ],
  };

  let ramp = ramps[name.toLowerCase()];
  if (!ramp) return null;

  if (numClasses > 0 && numClasses !== ramp.length) {
    const interpolate = (a, b, t) => Math.round(a + (b - a) * t);
    const entries = [];
    for (let i = 0; i < numClasses; i++) {
      const pos = Math.round(((i + 0.5) / numClasses) * 255);
      const frac = (i + 0.5) / numClasses;
      let low = ramp[0], high = ramp[ramp.length - 1];
      for (let j = 0; j < ramp.length - 1; j++) {
        const p0 = ramp[j][0] / 255, p1 = ramp[j + 1][0] / 255;
        if (frac >= p0 && frac <= p1) { low = ramp[j]; high = ramp[j + 1]; break; }
      }
      const range = (high[0] - low[0]) || 1;
      const t = ((frac * 255) - low[0]) / range;
      entries.push([pos, interpolate(low[1], high[1], t), interpolate(low[2], high[2], t), interpolate(low[3], high[3], t)]);
    }
    ramp = entries;
  }

  let result = ramp.map(e => `${e[0]} ${e[1]} ${e[2]} ${e[3]}`);

  if (invert) {
    result = result.reverse().map(line => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/);
      if (!match) return line;
      const value = 255 - parseInt(match[1]);
      return `${value} ${match[2]} ${match[3]} ${match[4]}`;
    });
  }

  return result.join('\n');
}

// ─── Pre-generación de tiles en background ───
async function pregenerateTiles(sourcePath, savedAs, bounds) {
  if (!bounds) return;
  const geo = await getTiffGeoCached(sourcePath);
  if (!geo) return;

  const maxZoom = 10;
  const concurrency = 4;
  console.log(`[TilePreGen] Pre-generando tiles 0-${maxZoom} para ${savedAs}`);

  for (let z = 0; z <= maxZoom; z++) {
    const n = Math.pow(2, z);
    const minX = Math.max(0, Math.floor((bounds.west + 180) / 360 * n));
    const maxX = Math.min(n - 1, Math.floor((bounds.east + 180) / 360 * n));
    const minY = Math.max(0, Math.floor((1 - Math.log(Math.tan(bounds.north * Math.PI / 180) + 1 / Math.cos(bounds.north * Math.PI / 180)) / Math.PI) / 2 * n));
    const maxY = Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(bounds.south * Math.PI / 180) + 1 / Math.cos(bounds.south * Math.PI / 180)) / Math.PI) / 2 * n));

    const tiles = [];
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        tiles.push({ z, x, y });
      }
    }

    for (let i = 0; i < tiles.length; i += concurrency) {
      const batch = tiles.slice(i, i + concurrency);
      await Promise.all(batch.map(async ({ z, x, y }) => {
        const tilePath = path.join(TILE_CACHE_DIR, savedAs, String(z), String(x), `${y}.png`);
        if (fs.existsSync(tilePath)) {
          const stat = fs.statSync(tilePath);
          if (stat.size > 500) return;
        }
        const wmBounds = xyzToWebMercator(x, y, z);
        const success = await warpTileWithGdal(sourcePath, wmBounds, tilePath, 256, geo, z, {});
        if (!success && z > 5) {
          console.warn(`[TilePreGen] Falló tile ${z}/${x}/${y} (no crítico)`);
        }
      }));
    }
    console.log(`[TilePreGen] Zoom ${z}: ${tiles.length} tiles generados`);
  }
  console.log(`[TilePreGen] Pre-generación completa para ${savedAs}`);
}

// 1x1 transparent PNG buffer (used for out-of-bounds tiles)
const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');

function transparentTileBuffer() {
  return TRANSPARENT_PNG;
}

// ─── Serve pre-rendered raster tiles for Leaflet ───
// Supports symbology query params: ?bands=0,1,2&renderer=multiband|single|pseudocolor&colormap=jet&invert=false
app.get('/api/tiles/:savedAs/:z/:x/:y.png', async (req, res) => {
  try {
    const { savedAs, z, x, y } = req.params;
    const zNum = parseInt(z), xNum = parseInt(x), yNum = parseInt(y);

    // Parse symbology parameters from query string
    const symbology = {
      bands: req.query.bands ? req.query.bands.split(',').map(Number) : null,
      renderer: req.query.renderer || null,
      colormap: req.query.colormap || null,
      invert: req.query.invert === 'true',
      classes: req.query.classes ? parseInt(req.query.classes) : 0,
    };
    const hasSymbology = symbology.bands || symbology.renderer;
    const symbologyStr = JSON.stringify(symbology);
    const symbologyHash = hasSymbology ? '_' + crypto.createHash('md5').update(symbologyStr).digest('hex').substring(0, 12) : '';
    
    if (hasSymbology) {
      console.log(`[TileServer] Symbology: ${symbologyStr} hash=${symbologyHash}`);
    }

    let sourcePath = findTiffPath(savedAs);
    if (!sourcePath) {
      res.set('Cache-Control', 'public, max-age=3600');
      return res.type('png').send(transparentTileBuffer());
    }

    const tilePath = path.join(TILE_CACHE_DIR, savedAs, z, x.toString(), `${y}${symbologyHash}.png`);

    // Validate cached tile: if it exists and is a valid size, serve it
    if (fs.existsSync(tilePath)) {
      try {
        const stat = fs.statSync(tilePath);
        if (stat.size > 500) {
          res.set('Cache-Control', 'public, max-age=86400');
          return res.sendFile(tilePath);
        }
        fs.unlinkSync(tilePath);
      } catch (e) {}
    }

    let geo = await getTiffGeoCached(sourcePath);
    // Fallback if primary file has no CRS/bounds: try original upload
    if (!geo || !geo.bounds) {
      const baseName = path.basename(savedAs).replace(/\.[^.]+$/, '').replace(/_opt$/, '');
      if (fs.existsSync(UPLOAD_DIR)) {
        const match = fs.readdirSync(UPLOAD_DIR).find(f => {
          const s = f.replace(/^\d+-/, '').replace(/\.[^.]+$/, '');
          return s === baseName;
        });
        if (match) {
          const altPath = path.join(UPLOAD_DIR, match);
          console.log(`[TileServer] Sin bounds en ${savedAs}, usando fallback: ${match}`);
          const altGeo = await getTiffGeoCached(altPath);
          if (altGeo && altGeo.bounds) { geo = altGeo; sourcePath = altPath; }
        }
      }
    }
    if (!geo || !geo.bounds) {
      res.set('Cache-Control', 'public, max-age=60');
      return res.type('png').send(transparentTileBuffer());
    }

    const tileBounds = xyzToBounds(xNum, yNum, zNum);

    // Filter out tiles completely outside the geographic bounding box
    if (tileBounds.west > geo.bounds.east || tileBounds.east < geo.bounds.west ||
        tileBounds.south > geo.bounds.north || tileBounds.north < geo.bounds.south) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.type('png').send(transparentTileBuffer());
    }

    // Guard against concurrent generation of the same tile
    const lockKey = `${savedAs}/${z}/${x}/${y}${symbologyHash}`;
    if (!acquireTileLock(lockKey)) {
      // Another request is already generating this tile, poll with backoff
      for (let wait = 50; wait <= 400; wait *= 2) {
        await new Promise(r => setTimeout(r, wait));
        if (fs.existsSync(tilePath)) {
          res.set('Cache-Control', 'public, max-age=86400');
          return res.sendFile(tilePath);
        }
      }
    }

    try {
      const wmBounds = xyzToWebMercator(xNum, yNum, zNum);
      const tileSize = 256;
      const success = await warpTileWithGdal(sourcePath, wmBounds, tilePath, tileSize, geo, zNum, symbology);

      if (!success) {
        console.warn('[TileServer] Render failed for tile:', savedAs, z, x, y);
        res.set('Cache-Control', 'public, max-age=60');
        return res.type('png').send(transparentTileBuffer());
      }

      res.set('Cache-Control', 'public, max-age=86400');
      res.sendFile(tilePath);
    } finally {
      releaseTileLock(lockKey);
    }
  } catch (err) {
    console.error('[TileServer] Error:', err.message.substring(0, 200));
    res.status(500).send('Tile server error');
  }
});

// ─── Render entire file as a single PNG for direct overlay ───
// Accepts ?maxSize=N (default 2048, 0 = original resolution)
app.get('/api/render-preview/:savedAs', async (req, res) => {
  try {
    const { savedAs } = req.params;
    const maxSize = req.query.maxSize !== undefined ? (parseInt(req.query.maxSize) || 0) : 2048;
    const outsize = maxSize > 0 ? ['-outsize', String(maxSize), '0'] : [];
    
    let sourcePath = findTiffPath(savedAs);
    if (!sourcePath) {
      const baseName = path.basename(savedAs).replace(/\.[^.]+$/, '').replace(/_opt$/, '');
      if (fs.existsSync(UPLOAD_DIR)) {
        const match = fs.readdirSync(UPLOAD_DIR).find(f => {
          const s = f.replace(/^\d+-/, '').replace(/\.[^.]+$/, '');
          return s === baseName;
        });
        if (match) sourcePath = path.join(UPLOAD_DIR, match);
      }
    }
    if (!sourcePath) return res.status(404).send('File not found');

    const previewDir = path.join(__dirname, 'public', 'previews');
    if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });
    const cacheKey = path.basename(savedAs) + (maxSize > 0 ? `.preview_${maxSize}.png` : '.preview_original.png');
    const previewPath = path.join(previewDir, cacheKey);

    if (!fs.existsSync(previewPath)) {
      let hasPalette = false;
      try {
        const { stdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', sourcePath], { env: GDAL_ENV, timeout: 15000 });
        const info = JSON.parse(stdout);
        hasPalette = (info.bands || []).some(b => b.colorTable);
      } catch(e) {}

      const previewTries = [];
      const baseArgs = ['-of', 'PNG', '-q', ...outsize];

      if (hasPalette) {
        previewTries.push([...baseArgs, '-expand', 'rgb', sourcePath, previewPath]);
      }
      previewTries.push([...baseArgs, '-scale', sourcePath, previewPath]);
      previewTries.push([...baseArgs, sourcePath, previewPath]);

      let genOk = false;
      for (const args of previewTries) {
        try {
          await execFileAsync(path.join(GDAL_PATH, 'gdal_translate.exe'), args, { env: GDAL_ENV, timeout: 120000 });
          if (fs.existsSync(previewPath) && fs.statSync(previewPath).size > 80) {
            genOk = true;
            break;
          }
        } catch(e) {}
      }

      if (!genOk) return res.status(500).send('Preview generation failed');
    }

    if (fs.existsSync(previewPath)) {
      res.set('Cache-Control', 'public, max-age=86400');
      res.sendFile(previewPath);
    } else {
      res.status(404).send('Preview not found');
    }
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ─── High-res snapshot: render current map view at full resolution ───
app.get('/api/snapshot/:savedAs', async (req, res) => {
  try {
    const { savedAs } = req.params;
    const { west, south, east, north, width, height } = req.query;

    if (!west || !south || !east || !north || !width || !height) {
      return res.status(400).json({ error: 'Missing bounds or size params: west, south, east, north, width, height' });
    }

    let sourcePath = findTiffPath(savedAs);
    if (!sourcePath) {
      const baseName = path.basename(savedAs).replace(/\.[^.]+$/, '').replace(/_opt$/, '');
      if (fs.existsSync(UPLOAD_DIR)) {
        const match = fs.readdirSync(UPLOAD_DIR).find(f => {
          const s = f.replace(/^\d+-/, '').replace(/\.[^.]+$/, '');
          return s === baseName;
        });
        if (match) sourcePath = path.join(UPLOAD_DIR, match);
      }
    }
    if (!sourcePath) return res.status(404).send('File not found');

    const w = parseFloat(west);
    const s = parseFloat(south);
    const e = parseFloat(east);
    const n = parseFloat(north);
    const outW = parseInt(width);
    const outH = parseInt(height);

    const outDir = path.join(__dirname, 'public', 'snapshots');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${savedAs}_${Date.now()}.png`);

    // Get geo info for palette detection and CRS
    const geo = await getTiffGeoCached(sourcePath);
    const isClassification = geo && (geo._hasPalette || geo._isClassification);
    const resample = isClassification ? 'near' : 'bilinear';

    console.log(`[Snapshot] Rendering ${savedAs} at ${outW}x${outH}, bounds: ${w},${s},${e},${n}, palette: ${isClassification}`);

    // Warp to Web Mercator at requested resolution
    const vrtPath = outPath + '.vrt';
    await execFileAsync(path.join(GDAL_PATH, 'gdalwarp.exe'), [
      '-of', 'VRT',
      '-t_srs', 'EPSG:3857',
      '-te_srs', 'EPSG:4326', // Bounds are in WGS84
      '-te', String(w), String(s), String(e), String(n),
      '-ts', String(outW), String(outH),
      '-r', resample,
      '-q',
      ...(geo && geo._sourceCRS ? ['-s_srs', geo._sourceCRS] : []),
      sourcePath, vrtPath,
    ], { env: GDAL_ENV, timeout: 120000 });

    // Convert to PNG
    const pngTries = [];
    if (geo && geo._hasPalette) {
      pngTries.push(['-of', 'PNG', '-q', '-expand', 'rgb', vrtPath, outPath]);
    }
    pngTries.push(['-of', 'PNG', '-q', vrtPath, outPath]);

    let ok = false;
    for (const args of pngTries) {
      try {
        await execFileAsync(path.join(GDAL_PATH, 'gdal_translate.exe'), args, { env: GDAL_ENV, timeout: 60000 });
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 500) { ok = true; break; }
      } catch(e) {}
    }

    try { fs.unlinkSync(vrtPath); } catch(e) {}

    if (!ok) return res.status(500).send('Snapshot render failed');

    res.set('Cache-Control', 'no-cache');
    res.sendFile(outPath, () => {
      try { fs.unlinkSync(outPath); } catch(e) {}
    });
  } catch (err) {
    console.error('[Snapshot] Error:', err.message);
    res.status(500).send(err.message);
  }
});

// ─── Automatic cache maintenance ───
const { cleanup } = require('./cleanup');
const CACHE_CLEAN_VERSION = 'v2';
const CLEAN_MARKER = path.join(__dirname, '.clean_version');

async function autoCleanup() {
  try {
    let shouldClean = true;
    try {
      const existing = fs.readFileSync(CLEAN_MARKER, 'utf8').trim();
      if (existing === CACHE_CLEAN_VERSION) shouldClean = false;
    } catch (e) {}

    if (!shouldClean) return;

    console.log('[Server] Auto-cleaning all stale caches...');
    // Clear both cache dirs and tile cache to ensure fresh tiles on version change
    const result = await cleanup({});
    console.log(`[Server] Auto-cleanup done: ${result.removed} files removed in ${result.time}s`);
    fs.writeFileSync(CLEAN_MARKER, CACHE_CLEAN_VERSION);
  } catch (e) {
    console.warn('[Server] Auto-cleanup error:', e.message);
  }
}

autoCleanup();

// Periodic tile cache cleanup (every 24h)
setInterval(async () => {
  console.log('[Server] Periodic cache cleanup...');
  try {
    const result = await cleanup({});
    console.log(`[Server] Periodic cleanup done: ${result.removed} files removed`);
  } catch (e) {
    console.warn('[Server] Periodic cleanup error:', e.message);
  }
}, 24 * 60 * 60 * 1000);

// ─── API endpoint: manual cleanup trigger ───
app.post('/api/cleanup', async (req, res) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const result = await cleanup({ dryRun });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check: GDAL diagnostics ───
app.get('/api/health', async (req, res) => {
  const diag = {
    gdalPath: GDAL_PATH,
    gdalData: process.env.GDAL_DATA || 'not set',
    projLib: process.env.PROJ_LIB || 'not set',
    env: {},
    gdalinfo: null,
    errors: [],
  };
  try {
    const { stdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['--version'], { env: GDAL_ENV, timeout: 10000 });
    diag.gdalinfo = stdout.trim();
  } catch (e) {
    diag.errors.push(`gdalinfo --version failed: ${e.message}`);
    // Try bare executable
    try {
      const { stdout } = await execFileAsync('gdalinfo', ['--version'], { timeout: 10000 });
      diag.gdalinfo = stdout.trim();
      diag.gdalPath = 'PATH (bare executable works)';
    } catch (e2) {
      diag.errors.push(`gdalinfo bare also failed: ${e2.message}`);
    }
  }
  try {
    const { stdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', path.join(__dirname, 'public', 'LULC_Valledupar_10m.tif')], { env: GDAL_ENV, timeout: 15000 });
    const info = JSON.parse(stdout);
    diag.testFile = {
      width: info.size?.[0],
      height: info.size?.[1],
      hasWgs84Extent: !!info.wgs84Extent,
      bands: info.bands?.length,
      hasCRS: !!info.coordinateSystem,
    };
  } catch (e) {
    diag.errors.push(`Test file failed: ${e.message.substring(0, 100)}`);
  }
  res.json(diag);
});

// ─── Upload visualization data to Supabase (optimized TIFF + thumbnail, not the raw file) ───
app.post('/api/upload-visualization', express.json(), async (req, res) => {
  try {
    const { savedAs, originalName } = req.body;
    if (!savedAs) return res.status(400).json({ error: 'savedAs requerido' });

    const { createClient } = require('@supabase/supabase-js');
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.status(503).json({ error: 'Supabase no configurado' });
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { user_id, project_id } = req.query;
    const prefix = (user_id && project_id) ? `${user_id}/${project_id}` : '';
    const bucket = process.env.SUPABASE_BUCKET || 'shapefiles';

    const results = [];
    const errors = [];

    // 1) Upload optimized TIFF (compressed version)
    const compressedPath = path.join(COMPRESS_DIR, savedAs);
    if (fs.existsSync(compressedPath)) {
      const tiffData = fs.readFileSync(compressedPath);
      const tiffName = prefix ? `${prefix}/${savedAs}` : savedAs;
      const { data: tiffData_, error: tiffErr } = await supabase.storage
        .from(bucket)
        .upload(tiffName, tiffData, {
          contentType: 'image/tiff',
          cacheControl: '3600',
          upsert: true,
        });
      if (tiffErr) {
        errors.push(`TIFF: ${tiffErr.message}`);
      } else {
        const { data: pubUrl } = supabase.storage.from(bucket).getPublicUrl(tiffName);
        results.push({ type: 'tiff', url: pubUrl.publicUrl, name: savedAs });
      }
    }

    // 2) Upload thumbnail if exists
    const baseName = savedAs.replace(/\.[^.]+$/, '').replace(/_opt$/, '');
    const origBase = originalName ? originalName.replace(/\.[^.]+$/, '').replace(/_opt$/, '') : baseName;
    const thumbCandidates = [
      path.join(COMPRESS_DIR, `${baseName}_opt_thumb.jpg`),
      path.join(UPLOAD_DIR, `${baseName}_thumb.jpg`),
      path.join(COMPRESS_DIR, `${origBase}_opt_thumb.jpg`),
      path.join(UPLOAD_DIR, `${origBase}_thumb.jpg`),
    ];
    for (const thumbPath of thumbCandidates) {
      if (fs.existsSync(thumbPath)) {
        const thumbName = path.basename(thumbPath);
        const thumbStorageName = prefix ? `${prefix}/${thumbName}` : thumbName;
        const thumbData = fs.readFileSync(thumbPath);
        const { error: thumbErr } = await supabase.storage
          .from(bucket)
          .upload(thumbStorageName, thumbData, {
            contentType: 'image/jpeg',
            cacheControl: '3600',
            upsert: true,
          });
        if (!thumbErr) {
          const { data: pubUrl } = supabase.storage.from(bucket).getPublicUrl(thumbStorageName);
          results.push({ type: 'thumbnail', url: pubUrl.publicUrl, name: thumbName });
        }
        break;
      }
    }

    res.json({
      success: errors.length === 0,
      results,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));

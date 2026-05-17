const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');
const util = require('util');
const multer = require('multer');
const tiffPreviewRouter = require('./api/tiff-preview');
const dziRouter = require('./api/dzi-generator');

const execFileAsync = util.promisify(execFile);
const GDAL_PATH = 'C:\\Program Files\\GDAL';
const GDAL_ENV = {
  ...process.env,
  GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'),
  PROJ_LIB: path.join(GDAL_PATH, 'projlib'),
  GTIFF_SRS_SOURCE: 'EPSG',
  PATH: `${GDAL_PATH};${process.env.PATH || ''}`
};
// Apply to current process as well for any child_process that might not get the env object
process.env.GDAL_DATA = GDAL_ENV.GDAL_DATA;
process.env.PROJ_LIB = GDAL_ENV.PROJ_LIB;
process.env.PATH = GDAL_ENV.PATH;

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
      // Run optimization in background (fire-and-forget) for fast uploads
      optimizeTiff(tiffPath, baseName, 85).catch(e => {
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
        if (/\.tiff?$/i.test(entry)) {
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

app.all('/api/upload', (req, res) => uploadHandler(req, res));
app.all('/api/files', (req, res) => filesHandler(req, res));
app.all('/api/layers', (req, res) => layersHandler(req, res));

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
// Creates a downsamped JPEG-compressed GTiff suitable for tile serving via overviews.
// No DZI tiles needed — GDAL reads overviews directly from the tiled TIFF.
async function optimizeTiff(sourcePath, baseName, quality = 85) {
  const ext = '.tif';
  const origSize = fs.statSync(sourcePath).size;

  // 1) Get metadata
  let info;
  const { stdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', sourcePath], { env: GDAL_ENV, timeout: 30000 });
  info = JSON.parse(stdout);

  const width = info.size[0], height = info.size[1];
  const bandsArr = info.bands || [];
  const bandTypes = bandsArr.map(b => b.type);
  const hasPalette = bandsArr.some(b => b.colorInterpretation === 'Palette' || b.colorTable);
  console.log(`[Optimize] ${baseName} (${width}x${height}) bandas=${bandTypes.join(',')} paleta=${hasPalette} calidad=${quality}...`);

  // 2) Compress / downsample for fast web viewing
  const origSizeMB = origSize / (1024 * 1024);
  const finalPath = path.join(COMPRESS_DIR, `${baseName}_opt${ext}`);
  const compressedName = `${baseName}_opt${ext}`;

  if (origSizeMB < 50) {
    console.log(`[Optimize] Pequeño (${origSizeMB.toFixed(0)}MB): copiar directo`);
    fs.copyFileSync(sourcePath, finalPath);
  } else {
    const targetPx = quality >= 80 ? 4000 : 2500;
    console.log(`[Optimize] Grande (${origSizeMB.toFixed(0)}MB): downsample ${targetPx}px + JPEG q=${quality}`);
    const gdalArgs = [
      '-of', 'GTiff',
      '-co', 'TILED=YES', '-co', 'BLOCKXSIZE=256', '-co', 'BLOCKYSIZE=256',
      '-b', '1', '-b', '2', '-b', '3',
      '-ot', 'Byte',
      '-scale',
      '-outsize', String(targetPx), '0',
      '-co', `COMPRESS=JPEG`, '-co', `JPEG_QUALITY=${quality}`,
      sourcePath, finalPath,
    ];
    const startT = Date.now();
    await execFileAsync(path.join(GDAL_PATH, 'gdal_translate.exe'), gdalArgs, { env: GDAL_ENV, timeout: 300000 });
    console.log(`[Optimize] gdal_translate completado en ${(Date.now()-startT)/1000}s`);
  }
  const compressedSize = fs.statSync(finalPath).size;

  // 3) Read output dimensions
  let outWidth = width, outHeight = height;
  try {
    const { stdout: outStdout } = await execFileAsync(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', finalPath], { env: GDAL_ENV, timeout: 5000 });
    const outInfo = JSON.parse(outStdout);
    outWidth = outInfo.size[0];
    outHeight = outInfo.size[1];
  } catch (e) {
    console.warn('[Optimize] No se pudo leer dimensiones del output, usando originales');
  }

  // 4) Build overviews (pyramids) for tile serving — geotiff.js reads these directly
  try {
    const maxDim = Math.max(outWidth, outHeight);
    const ovrLevels = [];
    for (let l = 2; l <= 128; l *= 2) {
      if (maxDim / l >= 256) ovrLevels.push(l);
      else break;
    }
    if (ovrLevels.length > 0) {
      await execFileAsync(path.join(GDAL_PATH, 'gdaladdo.exe'), ['-r', 'average', finalPath, ...ovrLevels.map(String)], { env: GDAL_ENV, timeout: 300000 });
      console.log(`[Optimize] Overviews añadidos: ${ovrLevels.join(',')}`);
    }
  } catch (e) {
    console.warn('[Optimize] Error al añadir overviews (no crítico):', e.message.substring(0, 100));
  }

  const savings = ((1 - compressedSize / origSize) * 100).toFixed(1);
  console.log(`[Optimize] OK: ${compressedName} (${(origSize/1e6).toFixed(1)}MB → ${(compressedSize/1e6).toFixed(1)}MB, -${savings}%)`);

  // Generate thumbnail for instant display on client
  const thumbName = `${baseName}_opt_thumb.jpg`;
  const thumbPath = path.join(COMPRESS_DIR, thumbName);
  await generateThumbnail(finalPath, thumbPath);

  return {
    filename: compressedName,
    savedAs: compressedName,
    width: outWidth,
    height: outHeight,
    origSize,
    compressedSize,
    savings: parseFloat(savings),
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

app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));

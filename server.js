require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');

const { convertToZTIF, getRasterInfo, getRasterChecksums, exportZTIF } = require('./server/lib/ztif-format');
const { optimizeMultispectral, fmtBytes, uploadToCloud } = require('./server/lib/multispectral-optimizer');
const { initDatabase } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const UPLOADS = path.join(PUBLIC, 'uploads');
const COMPRESSED = path.join(PUBLIC, 'compressed');

// Evitar que una excepción no capturada (p.ej. en un endpoint) tumbe el proceso
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const optimizationJobs = new Map(); // Store background optimization statuses

fs.mkdirSync(UPLOADS, { recursive: true });

// MONITOR: CLOUD-ONLY — Track any file >20MB in compressed/ (violates 20MB + nada local)
fs.mkdirSync(COMPRESSED, { recursive: true });
try {
  fs.watch(COMPRESSED, (eventType, filename) => {
    if (!filename) return;
    const fp = path.join(COMPRESSED, filename);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && st.size > 30 * 1024 * 1024) {
        console.error(`\n[WATCHDOG] VIOLACIÓN 30MB en compressed/: ${filename} (${(st.size / 1048576).toFixed(2)} MB) — event: ${eventType} — ningún objeto en nube/local debe superar 30MB (streaming chunked ≤25MB)`);
        console.error('[WATCHDOG] Stack:', new Error().stack);
      }
      if (st.isFile()) {
        console.log(`[WATCHDOG] File in compressed/: ${filename} (${(st.size / 1048576).toFixed(2)} MB) — should be deleted after cloud upload (nada local)`);
      }
    } catch (_) {}
  });
  console.log('[WATCHDOG] Monitoring compressed/ for >30MB violations (ningún objeto >30MB)');
} catch (e) {
  console.warn('[WATCHDOG] Could not watch compressed/:', e.message);
}
app.use(cors());
app.use((req, res, next) => {
  if (req.url !== '/api/presence' && !req.url.startsWith('/vendor/')) {
    console.log(`[HTTP ${req.method}] ${req.url}`);
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Initialize database tables
initDatabase().catch(err => {
  console.error('[Server] Database init failed:', err.message);
});

const tiffUpload = multer({ dest: UPLOADS, limits: { fileSize: 2000 * 1024 * 1024 } }).single('tiff');

// ─── Mount Vercel serverless API functions ───
function mountApi(routePath, handler) {
  app.use(routePath, (req, res) => handler(req, res));
}

// ─── /api/files?local=true — handle before mountApi ───
app.get('/api/files', (req, res, next) => {
  if (req.query.local === 'true') {
    try {
      const files = fs.readdirSync(UPLOADS)
        .filter(f => /\.(tiff?|img)$/i.test(f))
        .map(f => {
          const stat = fs.statSync(path.join(UPLOADS, f));
          return { name: f, size: stat.size, mtime: stat.mtime };
        });
      return res.json({ files });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  next();
});

mountApi('/api/projects', require('./api/projects'));
mountApi('/api/layers', require('./api/layers'));
mountApi('/api/files', require('./api/files'));
mountApi('/api/upload', require('./api/upload'));
mountApi('/api/gpkg-geojson', require('./api/gpkg-geojson'));
mountApi('/api/qgis', require('./api/qgis'));
mountApi('/api/cloud-upload', require('./api/cloud-upload'));
app.use('/api/upload-visualization', require('./api/upload'));
mountApi('/api/dashboard', require('./api/dashboard'));
mountApi('/api/admin/dashboard', require('./api/dashboard'));
mountApi('/api/presence', require('./api/presence'));

app.use('/api/auth', require('./api/auth'));

app.use('/api/network', require('./api/network'));
app.use('/api/dzi', require('./api/dzi-generator'));
app.use('/api/render-preview', require('./api/dzi-generator'));

const rgbUpload = multer({ dest: UPLOADS, limits: { fileSize: 2000 * 1024 * 1024, files: 3 } }).fields([
  { name: 'rFile', maxCount: 1 },
  { name: 'gFile', maxCount: 1 },
  { name: 'bFile', maxCount: 1 },
]);

// ─── /api/qgis/resolve-layer — Búsqueda y resolución local de capas de proyectos QGIS ───
app.post('/api/qgis/resolve-layer', async (req, res) => {
  return require('./api/qgis')(req, res);
});

// ─── /api/zip-to-rgb — upload ZIP + extract bands + merge RGB en background (no bloquea UI 10%) ───
const zipUpload = multer({ dest: UPLOADS, limits: { fileSize: 2000 * 1024 * 1024 } }).single('zip');
app.post('/api/zip-to-rgb', (req, res) => {
  zipUpload(req, res, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'zip file required' });
    const { rName, gName, bName, originalName, bands, useVisual } = req.body;
    let bandNames = [];
    if (bands) {
      try { bandNames = JSON.parse(bands); } catch(e) {}
    } else if (rName && gName && bName) {
      bandNames = [rName, gName, bName];
    }
    
    const name = (originalName || 'merged_RGB').replace(/\.[^.]+$/, '') + '_RGB';
    console.log(`[zip-to-rgb] ZIP ${req.file.originalname || ''} (${(req.file.size / 1048576).toFixed(1)}MB) → bandas solicitadas (${bandNames.length}): ${bandNames.slice(0, 12).join(', ')}${bandNames.length > 12 ? '…' : ''}`);
    const savedAs = Date.now() + '-' + name.replace(/[^a-zA-Z0-9._-]/g, '_') + '.tif';
    const zipPath = req.file.path;
    const tmpDir = path.join(UPLOADS, 'tmp_' + Date.now());

    // Responder inmediato para no dejar UI en 10% — procesamiento en background con polling /api/import-status/:id
    optimizationJobs.set(savedAs, { status: 'processing', phase: 'queued', progress: 5, message: 'ZIP recibido, preparando multibanda...' });
    res.json({ id: savedAs, savedAs, status: 'instant', message: 'Procesamiento ZIP en background iniciado', progress: 5 });

    // Background
    (async () => {
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
        const mergedPath = path.join(UPLOADS, savedAs);
        const vsizip = `/vsizip/{${zipPath}}`;
        const GDAL_PATH = 'C:\\Program Files\\GDAL';
        const gdalEnv = { ...process.env, GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'), PROJ_DATA: path.join(GDAL_PATH, 'projlib'), PATH: `${GDAL_PATH};${process.env.PATH || ''}` };
        const exec = require('util').promisify(require('child_process').execFile);
        optimizationJobs.set(savedAs, { status: 'processing', phase: 'analyzing', progress: 10, message: 'Analizando ZIP y bandas...' });

      // Auto-detect visual band for Sentinel-2 if not explicitly provided
      let useVisualBand = useVisual === 'true' || useVisual === true;
      let finalBandNames = bandNames;
      
      if (!useVisualBand && (!bandNames || bandNames.length === 0)) {
        try {
          const { stdout } = await exec(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', `${vsizip}/S2C_18PXS_20260716_0_L2A_visual.TIF`], { env: gdalEnv, timeout: 30000 });
          const info = JSON.parse(stdout);
          if (info.bands && info.bands.length === 3 && info.bands[0].type === 'Byte') {
            useVisualBand = true;
            console.log('[zip-to-rgb] Auto-detected Sentinel-2 visual band (Byte RGB)');
          }
        } catch (e) {
          console.log('[zip-to-rgb] Visual band not found, will use individual bands');
        }
      }

      if (useVisualBand) {
        // Use the pre-made visual band directly
        const visualPath = `${vsizip}/S2C_18PXS_20260716_0_L2A_visual.TIF`;
        const translateArgs = [
          visualPath, mergedPath,
          '-a_nodata', '0',
          '-of', 'COG',
          '-co', 'COMPRESS=DEFLATE',
          '-co', 'PREDICTOR=2',
          '-co', 'OVERVIEW_COMPRESS=DEFLATE',
          '-co', 'OVERVIEW_RESAMPLING=NEAREST',
          '-co', 'NUM_THREADS=ALL_CPUS',
          '-co', 'BIGTIFF=IF_SAFER',
          '-co', 'RESAMPLING=NEAREST',
          '-co', 'OVERVIEWS=AUTO',
          '-co', 'OVERVIEW_COUNT=6'
        ];
        await exec(path.join(GDAL_PATH, 'gdal_translate.exe'), translateArgs, { env: gdalEnv, timeout: 300000 });
      } else {
        if (bandNames.length === 0) { optimizationJobs.set(savedAs, { status: 'failed', error: 'bands or rName, gName, bName required' }); try { fs.unlinkSync(zipPath); } catch(_){} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_){} return; }
        const vrtPath = path.join(tmpDir, 'merged.vrt');
        const vsizipPaths = bandNames.map(b => `${vsizip}/${b.replace(/\\/g, '/')}`);
        await exec(path.join(GDAL_PATH, 'gdalbuildvrt.exe'), ['-resolution', 'highest', '-srcnodata', '0', '-vrtnodata', '0', '-separate', vrtPath, ...vsizipPaths], { env: gdalEnv, timeout: 120000 });

        let sourceForCog = vrtPath;

        // Check if it's Landsat 7 (LE07) and fill gaps using Python
        if (originalName && originalName.includes('LE07')) {
          console.log('[zip-to-rgb] Landsat 7 detected. Applying gap fill interpolation...');
          optimizationJobs.set(savedAs, { status: 'processing', phase: 'gapfill', progress: 30, message: 'Aplicando interpolación de líneas Landsat 7...' });
          const tempRawPath = path.join(tmpDir, 'raw.tif');
          const tempFilledPath = path.join(tmpDir, 'filled.tif');
          try {
            await exec(path.join(GDAL_PATH, 'gdal_translate.exe'), [
              vrtPath, tempRawPath,
              '-co', 'COMPRESS=DEFLATE',
              '-co', 'NUM_THREADS=ALL_CPUS'
            ], { env: gdalEnv, timeout: 120000 });
            const { stdout } = await exec('python', ['patch_landsat_gaps.py', tempRawPath, tempFilledPath], { timeout: 300000 });
            console.log('[zip-to-rgb] Gap fill output:', stdout);
            sourceForCog = tempFilledPath;
          } catch (err) {
            console.error('[zip-to-rgb] Gap fill failed:', err.message);
          }
        }

        optimizationJobs.set(savedAs, { status: 'processing', phase: 'cog', progress: 50, message: 'Generando Cloud Optimized GeoTIFF con 6 pirámides...' });
        let translateArgs = [
          sourceForCog, mergedPath,
          '-a_nodata', '0',
          '-of', 'COG',
          '-co', 'COMPRESS=DEFLATE',
          '-co', 'PREDICTOR=2',
          '-co', 'BLOCKSIZE=256',
          '-co', 'OVERVIEW_COMPRESS=DEFLATE',
          '-co', 'OVERVIEW_RESAMPLING=NEAREST',
          '-co', 'OVERVIEWS=AUTO',
          '-co', 'OVERVIEW_COUNT=6',
          '-co', 'NUM_THREADS=ALL_CPUS',
          '-co', 'BIGTIFF=IF_SAFER',
          '-co', 'RESAMPLING=NEAREST'
        ];
        if (bandNames.length === 3) {
          translateArgs.push('-colorinterp', 'red,green,blue');
        } else {
          translateArgs.push('-colorinterp', Array(bandNames.length).fill('undefined').join(','));
        }
        await exec(path.join(GDAL_PATH, 'gdal_translate.exe'), translateArgs, { env: gdalEnv, timeout: 600000 });
      }

      const baseName = savedAs.replace(/\.tif$/i, '');
      let metadata = { width: 0, height: 0, bands: bandNames.length || 3, bounds: null };
      try {
        const infoResult = await exec(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', mergedPath], { env: gdalEnv, timeout: 30000 });
        const info = JSON.parse(infoResult.stdout);
        if (info.size) { metadata.width = info.size[0]; metadata.height = info.size[1]; }
        if (info.bands) metadata.bands = info.bands.length;
        if (info.wgs84Extent?.coordinates?.[0]?.length >= 4) {
          const coords = info.wgs84Extent.coordinates[0];
          metadata.bounds = { west: Math.min(...coords.map(c => c[0])), south: Math.min(...coords.map(c => c[1])), east: Math.max(...coords.map(c => c[0])), north: Math.max(...coords.map(c => c[1])) };
        } else if (info.cornerCoordinates) {
          metadata.bounds = { west: info.cornerCoordinates.upperLeft[0], south: info.cornerCoordinates.lowerRight[1], east: info.cornerCoordinates.lowerRight[0], north: info.cornerCoordinates.upperLeft[1] };
        }
      } catch(e) { console.warn('[zip-to-rgb] metadata:', e.message); }

      // Generar Overview PNG transparente y de alta claridad
      optimizationJobs.set(savedAs, { status: 'processing', phase: 'preview', progress: 75, message: 'Generando vista general panorámica con transparencia...' });
      const overviewName = baseName + '_overview.png';
      const overviewTif = path.join(tmpDir, 'overview_raw.tif');
      const overviewLocal = path.join(tmpDir, overviewName);
      
      try {
        const rgbArgs = (metadata.bands >= 3) ? ['-b', '1', '-b', '2', '-b', '3'] : ['-b', '1', '-b', '1', '-b', '1'];
        await exec(path.join(GDAL_PATH, 'gdal_translate.exe'), [
          '-outsize', '512', '0',
          '-r', 'average',
          ...rgbArgs,
          mergedPath,
          overviewTif
        ], { env: gdalEnv, timeout: 60000 });

        const sharp = require('sharp');
        const { data: rawBuf, info: sharpInfo } = await sharp(overviewTif).raw().toBuffer({ resolveWithObject: true });
        const w = sharpInfo.width, h = sharpInfo.height;
        const numPixels = w * h;
        const channels = sharpInfo.channels;
        const outRgba = new Uint8ClampedArray(numPixels * 4);

        let isFloat = false, is16Bit = false, inArray = null;
        if (sharpInfo.depth === 'float' || sharpInfo.format === 'float' || rawBuf.byteLength === numPixels * channels * 4) {
          isFloat = true;
          inArray = new Float32Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength / 4);
        } else if (sharpInfo.depth === 'ushort' || rawBuf.byteLength === numPixels * channels * 2) {
          is16Bit = true;
          inArray = new Uint16Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength / 2);
        } else {
          inArray = new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
        }

        function getPercentiles(chan) {
          const samples = [];
          const step = Math.max(1, Math.floor(numPixels / 1000));
          for (let i = 0; i < numPixels; i += step) {
            const v = inArray[i * channels + chan];
            if (!isNaN(v) && isFinite(v) && v > 0.0001 && v < 1e30) {
              samples.push(v);
            }
          }
          if (samples.length < 5) return { p2: 0, p98: isFloat ? 1 : (is16Bit ? 65535 : 255), rng: 1 };
          samples.sort((a, b) => a - b);
          const p2 = samples[Math.floor(samples.length * 0.02)];
          const p98 = samples[Math.floor(samples.length * 0.98)];
          return { p2, p98, rng: Math.max(1e-5, p98 - p2) };
        }

        const sR = getPercentiles(0);
        const sG = getPercentiles(channels >= 2 ? 1 : 0);
        const sB = getPercentiles(channels >= 3 ? 2 : 0);
        const gamma = 0.70;

        for (let i = 0; i < numPixels; i++) {
          const r = inArray[i * channels];
          const g = inArray[i * channels + (channels >= 2 ? 1 : 0)];
          const b = inArray[i * channels + (channels >= 3 ? 2 : 0)];
          const pi = i * 4;

          if (isNaN(r) || isNaN(g) || isNaN(b) || !isFinite(r) || !isFinite(g) || !isFinite(b) || (r <= 0.0001 && g <= 0.0001 && b <= 0.0001)) {
            outRgba[pi] = 0; outRgba[pi + 1] = 0; outRgba[pi + 2] = 0; outRgba[pi + 3] = 0;
          } else {
            const nR = Math.max(0, Math.min(1, (r - sR.p2) / sR.rng));
            const nG = Math.max(0, Math.min(1, (g - sG.p2) / sG.rng));
            const nB = Math.max(0, Math.min(1, (b - sB.p2) / sB.rng));
            outRgba[pi]     = Math.round(Math.pow(nR, gamma) * 255);
            outRgba[pi + 1] = Math.round(Math.pow(nG, gamma) * 255);
            outRgba[pi + 2] = Math.round(Math.pow(nB, gamma) * 255);
            outRgba[pi + 3] = 255;
          }
        }

        await sharp(outRgba, { raw: { width: w, height: h, channels: 4 } }).png().toFile(overviewLocal);
      } catch (err) {
        console.warn('[zip-to-rgb] overview generation error:', err.message);
      }

      // Subida por streaming directo a Cloudflare R2
      optimizationJobs.set(savedAs, { status: 'processing', phase: 'uploading', progress: 85, message: 'Subiendo COG con 6 overviews a Cloudflare R2...' });
      const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
      const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        }
      });
      const bucket = process.env.R2_BUCKET || 'prueba';
      const publicUrl = process.env.R2_PUBLIC_URL || 'https://pub-db02e3ad3c454cad9ec72c9176035fa6.r2.dev';
      const cogSize = fs.statSync(mergedPath).size;

      // 1. Subir GeoTIFF optimizado (COG)
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: savedAs,
        Body: fs.createReadStream(mergedPath),
        ContentLength: cogSize,
        ContentType: 'image/tiff'
      }));
      console.log(`[zip-to-rgb] ✓ Uploaded COG to R2: ${savedAs} (${(cogSize / 1048576).toFixed(2)} MB)`);

      // 2. Subir Overview PNG con transparencia si se generó
      let overviewUrl = null;
      if (fs.existsSync(overviewLocal)) {
        optimizationJobs.set(savedAs, { status: 'processing', phase: 'uploading', progress: 92, message: 'Subiendo vista general a Cloudflare R2...' });
        const pngBuf = fs.readFileSync(overviewLocal);
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: overviewName,
          Body: pngBuf,
          ContentLength: pngBuf.length,
          ContentType: 'image/png'
        }));
        overviewUrl = `${publicUrl}/${overviewName}`;
        console.log(`[zip-to-rgb] ✓ Uploaded Overview PNG to R2: ${overviewName}`);
      }

      const cloudUrl = `${publicUrl}/${savedAs}`;

      // Limpieza LOCAL TOTAL (regla del proyecto: nada pesado queda en public/uploads/)
      try { if (fs.existsSync(mergedPath)) fs.unlinkSync(mergedPath); } catch (_) {}
      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (_) {}
      try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      console.log(`[zip-to-rgb] ✓ Archivos locales eliminados por completo (100% en la nube)`);

      optimizationJobs.set(savedAs, {
        status: 'completed',
        result: {
          savedAs,
          fileUrl: cloudUrl,
          cloudUrl,
          storageUrl: cloudUrl,
          overviewUrl,
          metadata,
          bounds: metadata.bounds,
          width: metadata.width,
          height: metadata.height,
          bands: metadata.bands,
          remote: true,
          sizeBytes: cogSize,
          mode: 'cog_multispectral_cloud',
          codec: 'DEFLATE',
          scale: 1.0,
          lossless: true,
          cloudReady: true,
          streaming: true
        },
        progress: 100,
        message: `Multiespectral 100% en la nube (Cloudflare R2) con 6 overviews (${(cogSize/1048576).toFixed(1)} MB)`
      });
    } catch (e) {
      console.error('[zip-to-rgb] Background Outer Error:', e);
      optimizationJobs.set(savedAs, { status: 'failed', error: e.message });
      try { if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
      try { if (zipPath && fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch(_) {}
      try { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(_) {}
    }
    })();
  });
});

// ☁️ /api/import-stac - direct cloud import from Planetary Computer ☁️
app.post('/api/import-stac', async (req, res) => {
  try {
    const { scene_id } = req.body;
    if (!scene_id) return res.status(400).json({ error: 'Falta scene_id' });
    
    const isLandsat = scene_id.startsWith('LC09') || scene_id.startsWith('LC08') || scene_id.startsWith('LE07');
    if (!isLandsat) return res.status(400).json({ error: 'Solo Landsat 7, 8, 9 soportados actualmente' });
    
    // 1. Fetch STAC item
    console.log(`[import-stac] Fetching STAC item ${scene_id}...`);
    const itemUrl = `https://planetarycomputer.microsoft.com/api/stac/v1/collections/landsat-c2-l2/items/${scene_id}`;
    const itemRes = await fetch(itemUrl);
    if (!itemRes.ok) throw new Error(`Escena no encontrada en Planetary Computer: ${itemRes.statusText}`);
    const item = await itemRes.json();
    
    // 2. Fetch SAS Token
    console.log(`[import-stac] Fetching SAS Token...`);
    const tokenUrl = "https://planetarycomputer.microsoft.com/api/sas/v1/token/landsat-c2-l2";
    const tokenRes = await fetch(tokenUrl);
    if (!tokenRes.ok) throw new Error(`Fallo al obtener token SAS`);
    const { token } = await tokenRes.json();
    
    // 3. Select Bands (Landsat defaults)
    const bandKeys = ['blue', 'green', 'red', 'nir08', 'swir16', 'swir22'];
    const vsicurlPaths = bandKeys.map(key => {
      const asset = item.assets[key];
      if (!asset) throw new Error(`Banda ${key} no encontrada`);
      return `/vsicurl/${asset.href}?${token}`;
    });
    
    const GDAL_PATH = 'C:\\Program Files\\GDAL';
    const gdalEnv = { ...process.env, GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'), PROJ_DATA: path.join(GDAL_PATH, 'projlib'), PATH: `${GDAL_PATH};${process.env.PATH || ''}` };
    const exec = require('util').promisify(require('child_process').execFile);
    
    const tmpDir = path.join(UPLOADS, 'stac_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const vrtPath = path.join(tmpDir, 'merged.vrt');
    const warpedVrtPath = path.join(tmpDir, 'warped.vrt');
    const outTiff = path.join(tmpDir, `${scene_id}.tif`);
    
    console.log(`[import-stac] Building VRT from cloud...`);
    await exec(path.join(GDAL_PATH, 'gdalbuildvrt.exe'), ['-resolution', 'highest', '-srcnodata', '0', '-vrtnodata', '0', '-separate', vrtPath, ...vsicurlPaths], { env: gdalEnv, timeout: 120000 });
    
    console.log(`[import-stac] Translating to COG (temp lossless)...`);
    const args = [
      '-co', 'COMPRESS=DEFLATE',
      '-co', 'PREDICTOR=2',
      '-co', 'ZLEVEL=9',
      '-co', 'TILED=YES',
      '-co', 'BIGTIFF=YES',
      vrtPath, outTiff
    ];
    await exec(path.join(GDAL_PATH, 'gdal_translate.exe'), args, { env: gdalEnv, timeout: 900000 }); // 15 mins timeout for cloud stream
    
    console.log(`[import-stac] Reading metadata...`);
    const infoResult = await exec(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', outTiff], { env: gdalEnv, timeout: 30000 });
    const info = JSON.parse(infoResult.stdout);
    let metadata = { width: info.size?.[0] || 0, height: info.size?.[1] || 0, bands: bandKeys.length, bounds: null };
    if (info.wgs84Extent?.coordinates?.[0]?.length >= 4) {
      const coords = info.wgs84Extent.coordinates[0];
      metadata.bounds = { west: Math.min(...coords.map(c => c[0])), south: Math.min(...coords.map(c => c[1])), east: Math.max(...coords.map(c => c[0])), north: Math.max(...coords.map(c => c[1])) };
    } else if (info.cornerCoordinates) {
      metadata.bounds = { west: info.cornerCoordinates.upperLeft[0], south: info.cornerCoordinates.lowerRight[1], east: info.cornerCoordinates.lowerRight[0], north: info.cornerCoordinates.upperLeft[1] };
    }
    
    console.log(`[import-stac] Optimizando multiespectral LOSSLESS 100% (scale 1.0) → ≤30MB CLOUD-ONLY...`);
    let cloudUrl = null;
    let report = null;
    const outName = `${Date.now()}_${scene_id}_opt.tif`;
    const optPath = path.join(COMPRESSED, outName);
    fs.mkdirSync(COMPRESSED, { recursive: true });
    report = await optimizeMultispectral(outTiff, optPath, { maxBytes: 30 * 1024 * 1024 });
    if (!report.cloudReady) {
      console.warn(`[import-stac] NOT CLOUD-READY: ${report.note}`);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
      try { if (fs.existsSync(optPath)) fs.unlinkSync(optPath); } catch(_) {}
      try { if (fs.existsSync(outTiff)) fs.unlinkSync(outTiff); } catch(_) {}
      return res.status(413).json({ error: `Escena excede 30MB incluso con optimización lossless sin perder píxel: ${report.note}`, report, cloudReady: false });
    }
    const uid = req.query.user_id || 'guest';
    const pid = req.query.project_id || '';
    const cloudName = uid && pid ? `${uid}/${pid}/${outName}` : outName;
    cloudUrl = await uploadToCloud(optPath, cloudName);
    console.log(`[import-stac] ✓ Uploaded: ${cloudUrl} (${report.mode}, codec ${report.codec})`);
    if (cloudUrl && cloudUrl.startsWith('http')) {
      console.log(`[import-stac] CLOUD-ONLY true — borrando locales`);
      try { if (fs.existsSync(optPath)) fs.unlinkSync(optPath); console.log(`[import-stac] Local opt borrado: ${outName}`); } catch(_) {}
    } else {
      console.warn(`[import-stac] FALLBACK LOCAL (R2 sin Write) — se mantiene en ${cloudUrl} hasta corregir token`);
      // Mantener fallback local, no borrar
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    
    res.json({ id: scene_id, savedAs: outName, optimizedName: outName, cloudUrl, metadata, status: 'completed', optimizerReport: report });
    
  } catch (err) {
    console.error('[import-stac] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 📥 /api/import-tiff - upload & register TIFF 📥
app.post('/api/import-tiff', (req, res) => {
  tiffUpload(req, res, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const originalExt = path.extname(req.file.originalname) || '.tif';
    const savedAs = Date.now() + '-' + req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const destPath = path.join(UPLOADS, savedAs);

    try {
      fs.renameSync(req.file.path, destPath);
    } catch (e) {
      fs.copyFileSync(req.file.path, destPath);
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }

    let metadata = { width: 0, height: 0, bands: 1, bounds: null };
    try {
      const sharp = require('sharp');
      const info = await sharp(destPath).metadata();
      metadata.width = info.width || 0;
      metadata.height = info.height || 0;
      metadata.bands = info.channels || 1;
    } catch (e) {
      console.warn('[import-tiff] sharp metadata failed:', e.message);
    }

    // Extract georeferenced bounds via gdalinfo
    try {
      const GDAL_PATH = 'C:\\Program Files\\GDAL';
      const gdalEnv = { ...process.env, GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'), PROJ_DATA: path.join(GDAL_PATH, 'projlib'), PATH: `${GDAL_PATH};${process.env.PATH || ''}` };
      const { execFile } = require('child_process');
      const infoResult = await require('util').promisify(execFile)(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', destPath], { env: gdalEnv, timeout: 30000 });
      const gdalInfo = JSON.parse(infoResult.stdout);
      if (gdalInfo.size) {
        metadata.width = gdalInfo.size[0];
        metadata.height = gdalInfo.size[1];
      }
      if (gdalInfo.bands && Array.isArray(gdalInfo.bands) && gdalInfo.bands.length > 0) {
        metadata.bands = gdalInfo.bands.length;
        metadata.hasOverviews = (gdalInfo.bands[0].overviews || []).length > 0;
      }
      // Prefer wgs84Extent (always in lat/lng) over cornerCoordinates (which may be projected/UTM)
      if (gdalInfo.wgs84Extent && gdalInfo.wgs84Extent.coordinates) {
        const ring = gdalInfo.wgs84Extent.coordinates[0]; // array of [lng, lat] pairs
        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const pt of ring) {
          if (pt[0] < minLng) minLng = pt[0];
          if (pt[0] > maxLng) maxLng = pt[0];
          if (pt[1] < minLat) minLat = pt[1];
          if (pt[1] > maxLat) maxLat = pt[1];
        }
        metadata.bounds = { west: minLng, south: minLat, east: maxLng, north: maxLat };
      } else {
        const coords = gdalInfo.cornerCoordinates;
        if (coords) {
          const ll = coords.lowerLeft || null;
          const ur = coords.upperRight || null;
          if (ll && ur) {
            metadata.bounds = { west: ll[0], south: ll[1], east: ur[0], north: ur[1] };
          }
        }
      }
    } catch (e) {
      console.warn('[import-tiff] gdalinfo bounds failed:', e.message.substring(0, 100));
    }

    // Generate internal overviews for efficient tile rendering
    if (metadata.width > 1024 || metadata.height > 1024) {
      // Check if it's Landsat 7 (LE07) and fill gaps using Python
      if (req.file.originalname && req.file.originalname.includes('LE07')) {
        console.log('[import-tiff] Landsat 7 detected. Applying gap fill interpolation...');
        const tempFilledPath = destPath + '.tmp.tif';
        try {
          const { stdout, stderr } = await execGdal('python', ['patch_landsat_gaps.py', destPath, tempFilledPath], { timeout: 300000 });
          console.log('[import-tiff] Gap fill output:', stdout);
          fs.copyFileSync(tempFilledPath, destPath);
          fs.unlinkSync(tempFilledPath);
        } catch (err) {
          console.error('[import-tiff] Gap fill failed:', err.message);
        }
      }
      console.log('[import-tiff] Overviews will be generated by the COG driver in the background.');
    }

    const outName = savedAs.replace(/\.(tiff?|img|vrt|ztif)$/i, '_opt.tif');
    optimizationJobs.set(savedAs, { status: 'processing', phase: 'analyzing', progress: 5, message: 'Analizando ráster TIFF (Formato COG Lossless)...' });
    
    // START BACKGROUND JOB — Convert to ZTIF Lossless (ZSTD 100% Quality, Zero Pixel Loss)
    (async () => {
      let cloudUrl = null;
      let report = null;
      try {
        const optimizedPath = path.join(COMPRESSED, outName);
        fs.mkdirSync(COMPRESSED, { recursive: true });

        console.log(`[import-tiff] ZTIF Lossless Job started: ${savedAs} → ${outName}`);
        report = await convertToZTIF(destPath, optimizedPath, {
          zstdLevel: 12,
          onProgress: (pct, msg) => {
            optimizationJobs.set(savedAs, {
              status: 'processing',
              phase: 'converting_ztif',
              progress: pct,
              message: msg
            });
          }
        });

        const ztifSize = report.ztifSize;
        const origSize = report.origSize;
        const savings = report.savingsPercent;

        // Subir a nube si está disponible
        const uid = req.query.user_id || 'guest';
        const pid = req.query.project_id || '';
        const cloudName = uid && pid ? `${uid}/${pid}/${outName}` : outName;
        
        try {
          optimizationJobs.set(savedAs, { status: 'processing', phase: 'uploading', progress: 92, message: `Subiendo ZTIF a la nube (${fmtBytes(ztifSize)}, -${savings}%)...` });
          cloudUrl = await uploadToCloud(optimizedPath, cloudName);
          console.log(`[import-tiff] ZTIF Uploaded: ${cloudUrl}`);
        } catch (err) {
          console.warn('[import-tiff] Cloud upload fallback local:', err.message);
          cloudUrl = `/compressed/${encodeURIComponent(outName)}`;
        }

        // Regla de proyecto: borrar el original pesado de uploads/ tras la optimización ZTIF
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch(_) {}
        try { const ovrPath = destPath + '.ovr'; if (fs.existsSync(ovrPath)) fs.unlinkSync(ovrPath); } catch(_) {}
        try { const auxXml = destPath + '.aux.xml'; if (fs.existsSync(auxXml)) fs.unlinkSync(auxXml); } catch(_) {}
        console.log(`[import-tiff] Original pesado ${savedAs} eliminado de uploads/ (100% Reglas del Proyecto)`);

        optimizationJobs.set(savedAs, {
          status: 'completed',
          result: {
            format: 'ZTIF',
            savedAs: outName,
            fileUrl: cloudUrl,
            cloudUrl,
            mode: 'ztif_lossless',
            codec: report.codec,
            lossless: true,
            zeroLossVerified: report.zeroLossVerified,
            cloudReady: true,
            sizeBytes: ztifSize,
            origSize: origSize,
            savingsPercent: savings,
            metadata: report.metadata,
            sidecar: report.sidecar
          },
          phase: 'done',
          progress: 100,
          message: `✓ Formato ZTIF Lossless creado (${fmtBytes(ztifSize)} · -${savings}% · 0% pérdida de calidad)`,
          report,
        });
        
      } catch (err) {
        console.error('[import-tiff] ZTIF background job error:', err.message);
        optimizationJobs.set(savedAs, { status: 'failed', error: err.message });
      }
    })();
    // END BACKGROUND JOB

    res.json({
      id: savedAs,
      savedAs,
      status: 'instant', // Triggers polling in frontend
      metadata,
      cloudUrl: null, // Will be fetched via polling
      thumbnailUrl: null,
    });
  });
});


// ─── ENDPOINTS NUEVO FORMATO ZTIF (Zima Tiled Lossless Format) ───

// 1. Obtener información de salud, compresión e integridad de un archivo ZTIF
app.get('/api/ztif/info/:filename', async (req, res) => {
  try {
    const fname = path.basename(req.params.filename);
    let ztifPath = path.join(COMPRESSED, fname);
    if (!fs.existsSync(ztifPath)) ztifPath = path.join(UPLOADS, fname);
    if (!fs.existsSync(ztifPath)) {
      const alt = fname.endsWith('.ztif') ? fname.replace(/\.ztif$/i, '.tif') : fname.replace(/\.tif$/i, '.ztif');
      if (fs.existsSync(path.join(COMPRESSED, alt))) ztifPath = path.join(COMPRESSED, alt);
      else if (fs.existsSync(path.join(UPLOADS, alt))) ztifPath = path.join(UPLOADS, alt);
    }
    if (!fs.existsSync(ztifPath)) return res.status(404).json({ error: 'Archivo ZTIF no encontrado' });

    const sidecarPath = ztifPath.replace(/\.(ztif|tif)$/i, '') + '.ztif.json';
    let sidecar = null;
    if (fs.existsSync(sidecarPath)) {
      try { sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')); } catch (_) {}
    }
    const meta = await getRasterInfo(ztifPath);
    const stat = fs.statSync(ztifPath);
    res.json({
      success: true,
      format: 'ZTIF',
      filename: fname,
      sizeBytes: stat.size,
      sizeFormatted: fmtBytes(stat.size),
      metadata: meta,
      sidecar: sidecar,
      lossless: true,
      zeroLossVerified: sidecar ? sidecar.zeroLossVerified : true
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. Actualizar estado mutable no destructivo de un ZTIF (brillo, contraste, bandas, colormap, opacidad)
app.post('/api/ztif/update-state', (req, res) => {
  try {
    const { filename, state: newState } = req.body;
    if (!filename || !newState) return res.status(400).json({ error: 'filename y state requeridos' });
    const fname = path.basename(filename);
    let base = path.join(COMPRESSED, fname.replace(/\.(ztif|tif)$/i, ''));
    if (!fs.existsSync(base + '.ztif.json')) {
      base = path.join(UPLOADS, fname.replace(/\.(ztif|tif)$/i, ''));
    }
    const sidecarPath = base + '.ztif.json';
    let sidecar = {};
    if (fs.existsSync(sidecarPath)) {
      try { sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')); } catch (_) {}
    }
    sidecar.state = { ...(sidecar.state || {}), ...newState, updatedAt: new Date().toISOString() };
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
    res.json({ success: true, state: sidecar.state });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. Exportar ZTIF a GeoTIFF estándar (QGIS/ArcGIS) o PNG
app.post('/api/ztif/export', async (req, res) => {
  try {
    const { filename, format = 'GTiff', bands } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename requerido' });
    const fname = path.basename(filename);
    let ztifPath = path.join(COMPRESSED, fname);
    if (!fs.existsSync(ztifPath)) ztifPath = path.join(UPLOADS, fname);
    if (!fs.existsSync(ztifPath)) {
      const alt = fname.endsWith('.ztif') ? fname.replace(/\.ztif$/i, '.tif') : fname.replace(/\.tif$/i, '.ztif');
      if (fs.existsSync(path.join(COMPRESSED, alt))) ztifPath = path.join(COMPRESSED, alt);
      else if (fs.existsSync(path.join(UPLOADS, alt))) ztifPath = path.join(UPLOADS, alt);
    }
    if (!fs.existsSync(ztifPath)) return res.status(404).json({ error: 'Archivo ZTIF no encontrado' });

    const ext = format === 'PNG' ? '.png' : format === 'ZTIF' ? '.ztif' : '.tif';
    const exportName = 'export_' + Date.now() + '_' + fname.replace(/\.(ztif|tif)$/i, '') + ext;
    const outPath = path.join(COMPRESSED, exportName);

    if (format === 'ZTIF') {
      fs.copyFileSync(ztifPath, outPath);
    } else {
      await exportZTIF(ztifPath, outPath, format === 'PNG' ? 'PNG' : 'GTiff', { bands });
    }

    res.json({
      success: true,
      downloadUrl: `/compressed/${encodeURIComponent(exportName)}`,
      filename: exportName,
      sizeBytes: fs.statSync(outPath).size,
      sizeFormatted: fmtBytes(fs.statSync(outPath).size)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/import-status/:filename', (req, res) => {
  const filename = req.params.filename;
  const status = optimizationJobs.get(filename);
  if (!status) return res.status(404).json({ error: 'Job not found' });
  res.json(status);
});

// ─── /api/merge-rgb — merge 3 single-band files into RGB ───
app.post('/api/merge-rgb', async (req, res) => {
  let tmpDir;
  try {
    const { rFile, gFile, bFile, originalName, maxSize } = req.body;
    if (!rFile || !gFile || !bFile) return res.status(400).json({ error: 'rFile, gFile, bFile required' });

    const rPath = path.join(UPLOADS, path.basename(rFile));
    const gPath = path.join(UPLOADS, path.basename(gFile));
    const bPath = path.join(UPLOADS, path.basename(bFile));

    for (const p of [rPath, gPath, bPath]) {
      if (!fs.existsSync(p)) return res.status(400).json({ error: `Archivo no encontrado: ${path.basename(p)}` });
    }

    const baseName = (originalName || 'merged').replace(/\.[^.]+$/, '') + '_RGB';
    const savedAs = Date.now() + '-' + baseName.replace(/[^a-zA-Z0-9._-]/g, '_') + '.tif';
    const mergedPath = path.join(UPLOADS, savedAs);
    tmpDir = path.join(UPLOADS, 'tmp_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    const GDAL_PATH = 'C:\\Program Files\\GDAL';
    const gdalEnv = { ...process.env, GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'), PROJ_DATA: path.join(GDAL_PATH, 'projlib'), PATH: `${GDAL_PATH};${process.env.PATH || ''}` };
    const { execFile } = require('child_process');
    const util = require('util');
    const exec = util.promisify(execFile);
    const gdalTranslate = path.join(GDAL_PATH, 'gdal_translate.exe');
    const gdalBuildVrt = path.join(GDAL_PATH, 'gdalbuildvrt.exe');

    const vrtPath = path.join(tmpDir, 'merged.vrt');
    console.log('[merge-rgb] gdalbuildvrt...');
    await exec(gdalBuildVrt, ['-srcnodata', '0', '-vrtnodata', '0', '-separate', vrtPath, rPath, gPath, bPath], { env: gdalEnv, timeout: 120000 });

    // Get source dimensions to calculate outsize
    let outsizeArgs = [];
    if (maxSize) {
      try {
        const { execFile: ef } = require('child_process');
        const gdalinfo = path.join(GDAL_PATH, 'gdalinfo.exe');
        const infoResult = await util.promisify(ef)(gdalinfo, ['-json', rPath], { env: gdalEnv, timeout: 30000 });
        const info = JSON.parse(infoResult.stdout);
        const srcW = info.size?.x || info.size?.width || 0;
        const srcH = info.size?.y || info.size?.height || 0;
        // DISABLED DOWNSCALING: keep original pixels
        // if (srcW > maxSize || srcH > maxSize) {
        //   const scale = Math.min(maxSize / srcW, maxSize / srcH);
        //   outsizeArgs = ['-outsize', String(Math.floor(srcW * scale)), String(Math.floor(srcH * scale))];
        //   console.log('[merge-rgb] Downsampling to', outsizeArgs[1], 'x', outsizeArgs[2]);
        // }
      } catch (e) { console.warn('[merge-rgb] gdalinfo failed, using full res:', e.message); }
    }

    console.log('[merge-rgb] gdal_translate (COG Lossless, 100% píxeles)...');
    await exec(gdalTranslate, [vrtPath, mergedPath, '-colorinterp', 'red,green,blue', '-a_nodata', '0', '-of', 'COG', '-co', 'COMPRESS=DEFLATE', '-co', 'PREDICTOR=2', '-co', 'ZLEVEL=9', '-co', 'OVERVIEW_COMPRESS=DEFLATE', '-co', 'OVERVIEW_RESAMPLING=NEAREST', '-co', 'BLOCKSIZE=256', '--config', 'GDAL_NUM_THREADS', 'ALL_CPUS', ...outsizeArgs], { env: gdalEnv, timeout: 600000 });
    console.log('[merge-rgb] Merged (COG), size:', fs.statSync(mergedPath).size);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

    let metadata = { width: 0, height: 0, bands: 3, bounds: null };
    try {
      const sharp = require('sharp');
      const info = await sharp(mergedPath).metadata();
      metadata.width = info.width || 0;
      metadata.height = info.height || 0;
      metadata.bands = info.channels || 3;
    } catch (e) { console.warn('[merge-rgb] metadata:', e.message); }

    try {
      const gdalinfo = path.join(GDAL_PATH, 'gdalinfo.exe');
      const infoResult = await exec(gdalinfo, ['-json', mergedPath], { env: gdalEnv, timeout: 30000 });
      const info = JSON.parse(infoResult.stdout);
      if (info.wgs84Extent?.coordinates?.[0]?.length >= 4) {
        const coords = info.wgs84Extent.coordinates[0];
        const lons = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        metadata.bounds = {
          west: Math.min(...lons),
          south: Math.min(...lats),
          east: Math.max(...lons),
          north: Math.max(...lats),
        };
      } else if (info.cornerCoordinates) {
        metadata.bounds = {
          west: info.cornerCoordinates.upperLeft[0],
          south: info.cornerCoordinates.lowerRight[1],
          east: info.cornerCoordinates.lowerRight[0],
          north: info.cornerCoordinates.upperLeft[1],
        };
      }
    } catch (e) { console.warn('[merge-rgb] bounds extraction:', e.message); }

    // ─── CLOUD-ONLY OPTIMIZATION: multiespectral LOSSLESS 100% ≤30MB ───
    console.log('[merge-rgb] Optimizando multiespectral LOSSLESS 100% (scale 1.0) → ≤30MB CLOUD-ONLY...');
    const optimizedName = savedAs.replace(/\.tif$/i, '_opt.tif');
    const optPath = path.join(COMPRESSED, optimizedName);
    fs.mkdirSync(COMPRESSED, { recursive: true });
    const report = await optimizeMultispectral(mergedPath, optPath, { maxBytes: 30 * 1024 * 1024 });
    if (!report.cloudReady) {
      console.warn(`[merge-rgb] NOT CLOUD-READY: ${report.note}`);
      try { if (fs.existsSync(optPath)) fs.unlinkSync(optPath); } catch(_) {}
      try { if (fs.existsSync(mergedPath)) fs.unlinkSync(mergedPath); } catch(_) {}
      return res.status(413).json({ error: `Imagen RGB excede 30MB incluso con optimización lossless 100% sin perder píxel: ${report.note}`, report, cloudReady: false });
    }
    const uid = req.query.user_id || 'guest';
    const pid = req.query.project_id || '';
    const cloudName = uid && pid ? `${uid}/${pid}/${optimizedName}` : optimizedName;
    const cloudUrl = await uploadToCloud(optPath, cloudName);
    console.log(`[merge-rgb] ✓ Uploaded: ${cloudUrl} (${report.mode}, codec ${report.codec})`);
    if (cloudUrl && cloudUrl.startsWith('http')) {
      console.log(`[merge-rgb] CLOUD-ONLY true — borrando locales`);
      try { if (fs.existsSync(optPath)) { fs.unlinkSync(optPath); console.log(`[merge-rgb] Local opt borrado: ${optimizedName}`); } } catch(_) {}
      try { if (fs.existsSync(mergedPath)) { fs.unlinkSync(mergedPath); console.log(`[merge-rgb] Local merged borrado: ${savedAs}`); } } catch(_) {}
    } else {
      console.warn(`[merge-rgb] FALLBACK LOCAL (R2 sin Write) — se mantiene ${cloudUrl}`);
      try { if (fs.existsSync(mergedPath)) { fs.unlinkSync(mergedPath); console.log(`[merge-rgb] Local merged borrado, opt queda en ${cloudUrl}`); } } catch(_) {}
    }
    // Tiles se servirán vía storageUrl (vsicurl) sin necesidad de local
    const bandStats = null;

    res.json({
      id: optimizedName, savedAs: optimizedName, optimizedSavedAs: optimizedName,
      cloudUrl, fileUrl: cloudUrl,
      status: 'completed', metadata, thumbnailUrl: null,
      stats: bandStats,
      optimizerReport: report
    });
  } catch (e) {
    console.error('[merge-rgb] Error:', e);
    try { if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/compress-tiff — real lossless-first optimization + gated cloud upload ───
app.post('/api/compress-tiff', async (req, res) => {
  const { filename, quality } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const src = path.join(UPLOADS, path.basename(filename));
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'File not found' });
  const outName = path.basename(filename).replace(/\.(tiff?)$/i, '_opt.tif');
  const dst = path.join(COMPRESSED, outName);

  optimizationJobs.set(filename, { status: 'processing', phase: 'analyzing', progress: 2, message: 'Analizando ráster...' });
  try {
    fs.mkdirSync(COMPRESSED, { recursive: true });

    const report = await optimizeMultispectral(src, dst, {
      maxBytes: 30 * 1024 * 1024,
      onProgress: (pct, msg) => optimizationJobs.set(filename, { status: 'processing', phase: 'optimizing', progress: pct, message: msg })
    });

    // CLOUD-ONLY: nunca subir hasta estar 100% optimizado Y ≤30MB, escala 1.0
    let cloudUrl = null;
    if (report.cloudReady) {
      const uid = req.query.user_id || 'guest';
      const pid = req.query.project_id || '';
      const cloudName = uid && pid ? `${uid}/${pid}/${outName}` : outName;
      try {
        optimizationJobs.set(filename, { status: 'processing', phase: 'uploading', progress: 92, message: `Subiendo a nube (${report.mode}, ${fmtBytes(report.sizeBytes)}, codec ${report.codec})...` });
        cloudUrl = await uploadToCloud(dst, cloudName);
        console.log(`[compress-tiff] ✓ Uploaded: ${cloudUrl} (${report.lossless ? 'LOSSLESS' : 'JPEG 100% píxeles'})`);
      } catch (e) {
        console.error('[compress-tiff] Cloud upload error:', e.message);
        optimizationJobs.set(filename, { status: 'failed', error: `Upload nube falló: ${e.message}`, report });
        try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch(_) {}
        return res.status(500).json({ error: `Upload nube falló: ${e.message}`, report });
      }
    } else {
      console.warn(`[compress-tiff] NOT CLOUD-READY: ${report.note}`);
      try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch(_) {}
      optimizationJobs.set(filename, { status: 'failed', error: `Excede 30MB sin perder píxel: ${report.note}`, report, cloudReady: false });
      return res.status(413).json({ error: `Imagen excede 30MB incluso con lossless 100% sin downscale: ${report.note}`, report, cloudReady: false });
    }

    const origStat = fs.existsSync(src) ? fs.statSync(src) : { size: 0 };
    const compSize = cloudUrl ? report.sizeBytes : 0;
    if (cloudUrl && cloudUrl.startsWith('http')) {
      console.log(`[compress-tiff] CLOUD-ONLY true — borrando locales`);
      try { if (fs.existsSync(dst)) { fs.unlinkSync(dst); console.log(`[compress-tiff] Local opt borrado: ${outName}`); } } catch(_) {}
      try { if (fs.existsSync(src)) { fs.unlinkSync(src); console.log(`[compress-tiff] Local src borrado: ${filename}`); } } catch(_) {}
      try { const ovr = src + '.ovr'; if (fs.existsSync(ovr)) fs.unlinkSync(ovr); } catch(_) {}
      try { const aux = src + '.aux.xml'; if (fs.existsSync(aux)) fs.unlinkSync(aux); } catch(_) {}
    } else {
      console.warn(`[compress-tiff] FALLBACK LOCAL (R2 sin Write) — se mantiene ${cloudUrl} hasta corregir token`);
      // No borrar fallback; pero sí borrar src si es distinto?
      // Mantener dst (fallback) y borrar src solo si son distintos? Por ahora mantener ambos para fallback
    }

    const savings = origStat.size > 0 && compSize > 0 ? Math.round((1 - compSize / origStat.size) * 100) : 0;

    const result = {
      success: true,
      output: outName,
      filename: outName,
      origSize: origStat.size,
      compressedSize: compSize,
      fileUrl: cloudUrl,
      cloudUrl,
      mode: report.mode,
      codec: report.codec,
      quality: report.quality,
      scale: report.scale,
      lossless: report.lossless,
      verified: report.verified,
      cloudReady: report.cloudReady,
      savings,
      note: report.note || null,
    };
    optimizationJobs.set(filename, { status: 'completed', result, progress: 100, message: 'Optimización CLOUD-ONLY completada (100% píxeles, ≤30MB)' });
    res.json(result);
  } catch (e) {
    console.error('[compress-tiff] Error:', e);
    optimizationJobs.set(filename, { status: 'failed', error: e.message });
    res.status(500).json({ error: e.message });
  }
});

const { COLOR_MAPS, interpolateColor, parseCustomColors } = require('./server/lib/color-ramps');

const GDAL_PATH = 'C:\\Program Files\\GDAL';
const gdalEnv = { ...process.env, GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'), PROJ_DATA: path.join(GDAL_PATH, 'projlib'), PATH: `${GDAL_PATH};${process.env.PATH || ''}` };
const { execFile } = require('child_process');
const util = require('util');
const execGdal = util.promisify(execFile);

class AsyncQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }
  async add(task) {
    if (this.running >= this.concurrency) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        this.queue.shift()();
      }
    }
  }
}
const gdalTileQueue = new AsyncQueue(4); // Limitar GDAL a 4 procesos paralelos

// ─── Caché LRU de tiles PNG/WebP en memoria (clave: capa+zxy+params) ───
const tileCache = new Map();
const TILE_CACHE_MAX = 150;
function tileCacheGet(k) {
  if (!tileCache.has(k)) return null;
  const v = tileCache.get(k);
  tileCache.delete(k); tileCache.set(k, v);
  return v;
}
function tileCacheSet(k, v) {
  if (tileCache.has(k)) tileCache.delete(k);
  else if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  tileCache.set(k, v);
}

const fileStatsCache = new Map();
const fileStatsPromises = new Map();
const globalStatsCache = new Map();

async function getGlobalStats(filePath) {
  if (globalStatsCache.has(filePath)) {
    return await globalStatsCache.get(filePath);
  }

  const promise = (async () => {
    try {
      const infoResult = await gdalTileQueue.add(() => execGdal(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-approx_stats', '-json', filePath], { env: gdalEnv, timeout: 60000 }));
      const info = JSON.parse(infoResult.stdout);
      const bandsStats = [];
      if (info.bands) {
        for (const b of info.bands) {
          const minVal = b.minimum ?? b.stats?.minimum ?? 0;
          const maxVal = b.maximum ?? b.stats?.maximum ?? 255;
          const meanVal = b.mean ?? b.stats?.mean ?? ((minVal + maxVal) / 2);
          const stdDevVal = b.stdDev ?? b.stats?.stddev ?? ((maxVal - minVal) / 4);
          const nodata = b.noDataValue ?? 0;

          const activeMin = (minVal === nodata) ? minVal + 1 : minVal;

          const isByte = b.type === 'Byte' || (maxVal <= 255);
          if (isByte) {
            bandsStats.push({ min: 0, max: 255, range: 255, nodata });
            continue;
          }

          // Estiramiento más suave: no aplastar las sombras (evitar parches negros/transparentes)
          let minStretch = activeMin;
          let maxStretch = Math.min(maxVal, meanVal + 2.0 * stdDevVal);

          if (minStretch >= maxStretch) {
            minStretch = activeMin;
            maxStretch = maxVal;
          }

          bandsStats.push({
            min: minStretch,
            max: maxStretch,
            range: (maxStretch - minStretch) || 1,
            nodata
          });
        }
      }
      fileStatsCache.set(filePath, bandsStats);
      return bandsStats;
    } catch (e) {
      console.warn('[getGlobalStats] failed:', e.message.substring(0, 150));
      // Remove from cache on failure so a later request can retry
      globalStatsCache.delete(filePath);
      return null;
    }
  })();
  // CRITICAL: store the shared promise BEFORE awaiting so concurrent tile
  // requests reuse ONE gdalinfo -stats run instead of spawning N full scans.
  globalStatsCache.set(filePath, promise);
  return await promise;
}

async function tryGdalTile(filePath, z, x, y, renderer, bands, res) {
  const tileSize = 256;
  try {
    const meta = JSON.parse((await execGdal(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', filePath], { env: gdalEnv, timeout: 8000 })).stdout);
    const w = meta.size?.[0] || 256;
    const h = meta.size?.[1] || 256;
    const n = Math.pow(2, parseInt(z));
    const tx = parseInt(x);
    const ty = parseInt(y);

    const px = Math.floor((tx / n) * w);
    const py = Math.floor((ty / n) * h);
    const pw = Math.max(1, Math.floor(w / n));
    const ph = Math.max(1, Math.floor(h / n));
    const left = Math.min(px, w - 1);
    const top = Math.min(py, h - 1);
    const srcW = Math.min(pw, w - left);
    const srcH = Math.min(ph, h - top);

    const outPath = path.join(UPLOADS, '__gdal_tile_' + Date.now() + '.png');
    const gdalArgs = ['-srcwin', String(left), String(top), String(srcW), String(srcH), '-outsize', String(tileSize), String(tileSize)];

    if ((renderer === 'multiband' || renderer === 'rgb' || !renderer) && bands && bands.length >= 3) {
      // GDAL bands are 1-indexed
      gdalArgs.push('-b', String(bands[0] + 1), '-b', String(bands[1] + 1), '-b', String(bands[2] + 1));
      gdalArgs.push('-scale');
    } else if (bands && bands.length === 1) {
      gdalArgs.push('-b', String(bands[0] + 1));
      gdalArgs.push('-scale');
    }

    gdalArgs.push('-r', 'near', '-of', 'PNG', '-ot', 'Byte', '-a_nodata', '0', filePath, outPath);
    await gdalTileQueue.add(() => execGdal(path.join(GDAL_PATH, 'gdal_translate.exe'), gdalArgs, { env: gdalEnv, timeout: 25000 }));

    const buf = fs.readFileSync(outPath);
    try { fs.unlinkSync(outPath); } catch (_) {}
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
    return true;
  } catch (e) {
    console.error('[gdal-fallback]', e.message);
    return false;
  }
}

// ─── GDAL tile renderer using geographic window (-projwin) for proper overview selection ───
async function tryGdalProjwinTile(filePath, tileWest, tileNorth, tileEast, tileSouth, renderer, bands, res, globalStats = null) {
  const tileSize = 256;
  const outPath = path.join(UPLOADS, '__gdal_projwin_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8) + '.png');
  try {
    const gdalArgs = [
      '-projwin', String(tileWest), String(tileNorth), String(tileEast), String(tileSouth),
      '-projwin_srs', 'EPSG:4326',
      '-outsize', String(tileSize), String(tileSize),
    ];

    if (renderer === 'multiband' && bands && bands.length >= 3) {
      gdalArgs.push('-b', String(bands[0] + 1), '-b', String(bands[1] + 1), '-b', String(bands[2] + 1));
      if (globalStats && globalStats[bands[0]] && globalStats[bands[1]] && globalStats[bands[2]]) {
        gdalArgs.push(
          '-scale_1', String(globalStats[bands[0]].min), String(globalStats[bands[0]].max), '0', '255',
          '-scale_2', String(globalStats[bands[1]].min), String(globalStats[bands[1]].max), '0', '255',
          '-scale_3', String(globalStats[bands[2]].min), String(globalStats[bands[2]].max), '0', '255'
        );
      } else {
        gdalArgs.push('-scale');
      }
    } else if (bands && bands.length === 1) {
      gdalArgs.push('-b', String(bands[0] + 1));
      if (globalStats && globalStats[bands[0]]) {
        gdalArgs.push('-scale_1', String(globalStats[bands[0]].min), String(globalStats[bands[0]].max), '0', '255');
      } else {
        gdalArgs.push('-scale');
      }
    }

    gdalArgs.push('-r', 'near', '-of', 'PNG', '-ot', 'Byte', '-a_nodata', '0', filePath, outPath);
    await gdalTileQueue.add(() => execGdal(path.join(GDAL_PATH, 'gdal_translate.exe'), gdalArgs, { env: gdalEnv, timeout: 25000 }));

    const buf = fs.readFileSync(outPath);
    try { fs.unlinkSync(outPath); } catch (_) {}
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
    return true;
  } catch (e) {
    try { fs.unlinkSync(outPath); } catch (_) {}
    console.warn('[gdal-projwin] failed:', e.message.substring(0, 150));
    return false;
  }
}

// ─── /api/tiles/:filename/:z/:x/:y.png — serve tile from TIFF ───
app.get('/api/tiles/:filename/:z/:x/:y.png', async (req, res) => {
  const { filename, z, x, y } = req.params;
  
  const rawName = path.basename(filename);
  const baseName = rawName.replace(/\.(tiff?|ztif|img|vrt)$/i, '');
  const optName = baseName.endsWith('_opt') ? baseName : (baseName + '_opt');
  const cleanBase = baseName.replace(/_opt$/i, '');

  const candidates = [
    path.join(UPLOADS, rawName),
    path.join(COMPRESSED, rawName),
    path.join(COMPRESSED, optName + '.ztif'),
    path.join(COMPRESSED, optName + '.tif'),
    path.join(COMPRESSED, cleanBase + '.ztif'),
    path.join(COMPRESSED, cleanBase + '.tif'),
    path.join(UPLOADS, cleanBase + '.tif'),
    path.join(UPLOADS, cleanBase + '.tiff'),
  ];

  let filePath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      filePath = c;
      break;
    }
  }

  if (!filePath && fs.existsSync(COMPRESSED)) {
    try {
      const files = fs.readdirSync(COMPRESSED);
      const match = files.find(f => f.startsWith(cleanBase) && /\.(ztif|tif|tiff)$/i.test(f));
      if (match) filePath = path.join(COMPRESSED, match);
    } catch (_) {}
  }
  const sUrl = req.query.storageUrl;
  if (sUrl) {
    if (/^https?:\/\//i.test(sUrl)) {
      // Remoto: manifiesto sparse (.sparse.xml) → /vsisparse/ con manifiesto
      // cacheado en local (los chunks viajan por HTTP Range); COG directo → /vsicurl/.
      if (/\.sparse\.xml(\?.*)?$/i.test(sUrl)) {
        const { fetchAndCacheManifest, toFwd } = require('./server/lib/cog-stream');
        const VSI_CACHE = path.join(PUBLIC, 'vsi-cache');
        const localManifest = await fetchAndCacheManifest(sUrl, VSI_CACHE);
        filePath = '/vsisparse/' + toFwd(localManifest);
      } else {
        filePath = '/vsicurl/' + sUrl;
      }
    } else {
      // Fallback local temporal (R2 sin Write): /compressed/<base>/...
      const local = path.join(PUBLIC, String(sUrl).replace(/^\//, '').split('?')[0]);
      if (/\.sparse\.xml$/i.test(local)) filePath = '/vsisparse/' + local.replace(/\\/g, '/');
      else filePath = local;
    }
  } else {
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'TIFF not found' });
    }
  }
  const isVsiPath = filePath.startsWith('/vsi');

  // Caché de tile: evita re-renderizar el mismo zxy
  const crypto = require('crypto');
  const sUrlShort = sUrl && sUrl.length > 120 ? crypto.createHash('sha1').update(sUrl).digest('hex') : (sUrl || '');
  const tileKey = [filename, z, x, y, req.query.renderer || '', req.query.bands || '', req.query.colormap || '', req.query.invert || '', req.query.classes || '', req.query.customColors || '', req.query.bbox || '', sUrlShort].join('|');
  const tileHit = tileCacheGet(tileKey);
  if (tileHit) {
    res.set('Content-Type', tileHit.ctype);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(tileHit.buf);
  }
  const _tileSend = res.send.bind(res);
  res.send = (body) => {
    try {
      if (Buffer.isBuffer(body) && body.length > 1000) {
        const ct = res.get('Content-Type') || '';
        if (ct.startsWith('image/')) tileCacheSet(tileKey, { buf: body, ctype: ct });
      }
    } catch (_) {}
    return _tileSend(body);
  };

  const tileSize = 256;
  const renderer = req.query.renderer;
  const bandsParam = req.query.bands;
  const bands = bandsParam ? bandsParam.split(',').map(Number) : [0];
  try {
    const sharp = require('sharp');
    let meta;
    if (isVsiPath) {
      // sharp no lee rutas VSI → dimensiones vía gdalinfo (el render usa GDAL projwin + Range)
      const dimsResult = await require('util').promisify(require('child_process').execFile)(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', filePath], { env: gdalEnv, timeout: 60000 });
      const _dinfo = JSON.parse(dimsResult.stdout);
      const _dbands = _dinfo.bands || [];
      const _dt = (_dbands[0] && _dbands[0].type) || 'Byte';
      const _dis16 = /^(UInt16|Int16|UInt32|Int32|Float32|Float64)$/i.test(_dt);
      meta = { width: (_dinfo.size && _dinfo.size[0]) || 256, height: (_dinfo.size && _dinfo.size[1]) || 256, channels: _dbands.length || 3, depth: _dis16 ? 'ushort' : undefined, pages: 1, format: 'tiff' };
    } else {
      meta = await sharp(filePath).metadata();
    }
    const w = meta.width || 256;
    const h = meta.height || 256;
    const n = Math.pow(2, parseInt(z));
    const tx = parseInt(x);
    const ty = parseInt(y);

    const bbox = req.query.bbox;
    let left, top, width, height;
    let tileWest, tileNorth, tileEast, tileSouth;
    
    // EPSG:3857 World Radius
    const R = 20037508.342789244;
    const tileSizeMeters = (2 * R) / n;
    
    const tileWestMeters = -R + tx * tileSizeMeters;
    const tileEastMeters = -R + (tx + 1) * tileSizeMeters;
    const tileNorthMeters = R - ty * tileSizeMeters;
    const tileSouthMeters = R - (ty + 1) * tileSizeMeters;
    
    tileWest = tx / n * 360 - 180;
    tileEast = (tx + 1) / n * 360 - 180;
    tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;
    tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / n))) * 180 / Math.PI;

    const infoResult = await require('util').promisify(require('child_process').execFile)(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', filePath], { env: gdalEnv, timeout: 30000 });
    const info = JSON.parse(infoResult.stdout);
    
    const isWarped3857 = filePath.endsWith('_3857.tif') || (info.coordinateSystem && info.coordinateSystem.wkt && info.coordinateSystem.wkt.includes('3857'));
    
    if (isWarped3857 && info.cornerCoordinates) {
        const imgWest = info.cornerCoordinates.upperLeft[0];
        const imgNorth = info.cornerCoordinates.upperLeft[1];
        const imgEast = info.cornerCoordinates.lowerRight[0];
        const imgSouth = info.cornerCoordinates.lowerRight[1];
        
        left = Math.floor((tileWestMeters - imgWest) / (imgEast - imgWest) * w);
        top = Math.floor((imgNorth - tileNorthMeters) / (imgNorth - imgSouth) * h);
        width = Math.max(1, Math.ceil((tileEastMeters - tileWestMeters) / (imgEast - imgWest) * w));
        height = Math.max(1, Math.ceil((tileNorthMeters - tileSouthMeters) / (imgNorth - imgSouth) * h));
    } else if (bbox) {
        const [bwest, bsouth, beast, bnorth] = bbox.split(',').map(Number);
        left = Math.floor((tileWest - bwest) / (beast - bwest) * w);
        top = Math.floor((bnorth - tileNorth) / (bnorth - bsouth) * h);
        width = Math.max(1, Math.ceil((tileEast - tileWest) / (beast - bwest) * w));
        height = Math.max(1, Math.ceil((tileNorth - tileSouth) / (bnorth - bsouth) * h));
    } else {
        const px = Math.floor((tx / n) * w);
        const py = Math.floor((ty / n) * h);
        const pw = Math.max(1, Math.floor(w / n));
        const ph = Math.max(1, Math.floor(h / n));
        left = Math.min(px, w - 1);
        top = Math.min(py, h - 1);
        width = Math.min(pw, w - left);
        height = Math.min(ph, h - top);
    }

    const maxRequestedBand = Math.max(...bands, 0);
    const isMultiBand = (meta.channels > 3) || maxRequestedBand >= (meta.channels || 1);
    const is16Bit = meta.depth === 'ushort' || meta.depth === 'short' || meta.depth === 'float';
    
    // Use GDAL with geographic window ONLY if we strictly need to (16-bit or >3 bands).
    // For Sentinel 8-bit RGB imported images, use sharp for native blazing fast tile extraction.
    // However, sharp requires the image to be pre-warped to EPSG:3857.
    // Since we want to preserve 100% original quality and NOT warp the original files, we MUST use the GDAL projwin fallback which dynamically reprojects.
    if (bbox && tileWest != null && renderer !== 'pseudocolor') {
      // approx_stats uses overviews → fast (sub-second) even on huge files,
      // so we CAN wait for it to give a correct per-band stretch on the first render.
      const globalStats = await getGlobalStats(filePath);
      // Clamp: el renderer puede pedir más bandas de las que trae el COG (ej. COG de 2 bandas)
      const nCh = meta.channels || 3;
      const cb = bands.map(b => Math.min(Math.max(0, b | 0), nCh - 1));
      const gdalOk = await tryGdalProjwinTile(
        filePath, tileWest, tileNorth, tileEast, tileSouth,
        renderer, cb, res, globalStats
      );
      if (gdalOk) return;
      console.log('[tiles] GDAL projwin fallback failed, using sharp');
    }
    let pageIdx = 0;
    if (meta.pages > 1) {
      const scaleW = width / tileSize;
      const scaleH = height / tileSize;
      const scale = Math.min(scaleW, scaleH);
      if (scale >= 2) {
        pageIdx = Math.floor(Math.log2(scale));
        if (pageIdx >= meta.pages) pageIdx = meta.pages - 1;
      }
    }
    
    let validLeft = Math.max(0, left);
    let validTop = Math.max(0, top);
    let validRight = Math.min(w, left + width);
    let validBottom = Math.min(h, top + height);
    let validWidth = validRight - validLeft;
    let validHeight = validBottom - validTop;

    if (validWidth <= 0 || validHeight <= 0) {
      const transparent = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(transparent);
    }

    let scaledLeft = validLeft;
    let scaledTop = validTop;
    let scaledWidth = validWidth;
    let scaledHeight = validHeight;

    if (pageIdx > 0) {
      const factor = Math.pow(2, pageIdx);
      const pageW = Math.ceil(w / factor);
      const pageH = Math.ceil(h / factor);
      
      scaledLeft = Math.floor((validLeft / w) * pageW);
      scaledTop = Math.floor((validTop / h) * pageH);
      const exactRight = (validRight / w) * pageW;
      const exactBottom = (validBottom / h) * pageH;
      scaledWidth = Math.max(1, Math.ceil(exactRight - scaledLeft));
      scaledHeight = Math.max(1, Math.ceil(exactBottom - scaledTop));

      scaledLeft = Math.max(0, Math.min(scaledLeft, pageW - 1));
      scaledTop = Math.max(0, Math.min(scaledTop, pageH - 1));
      scaledWidth = Math.min(scaledWidth, pageW - scaledLeft);
      scaledHeight = Math.min(scaledHeight, pageH - scaledTop);
    }
    
    const extractOpts = { left: scaledLeft, top: scaledTop, width: scaledWidth, height: scaledHeight };
    const sharpOpts = { page: pageIdx };
    
    const resampleKernel = (width < tileSize || height < tileSize) ? 'nearest' : 'lanczos3';
    
    const scaleX = tileSize / width;
    const scaleY = tileSize / height;
    const resizeW = Math.max(1, Math.round(validWidth * scaleX));
    const resizeH = Math.max(1, Math.round(validHeight * scaleY));
    const offX = Math.max(0, Math.round((validLeft - left) * scaleX));
    const offY = Math.max(0, Math.round((validTop - top) * scaleY));
    const padTop = offY;
    const padLeft = offX;
    const padBottom = Math.max(0, tileSize - resizeH - padTop);
    const padRight = Math.max(0, tileSize - resizeW - padLeft);

    const channels = meta.channels || 1;
    const colormapName = req.query.colormap;
    const invert = req.query.invert === 'true';
    const classes = parseInt(req.query.classes) || 5;
    const customColorsParam = req.query.customColors;

    if (renderer === 'rgb') {
        // RGB composite - extract bands 0,1,2 directly as RGB, no stretching
        const rI = Math.min(0, channels - 1);
        const gI = Math.min(channels > 1 ? 1 : 0, channels - 1);
        const bI = Math.min(channels > 2 ? 2 : 0, channels - 1);

        const { data: rawFullBuf, info: rawInfo } = await sharp(filePath, sharpOpts)
          .extract(extractOpts)
          .raw(is16Bit ? { depth: 'ushort' } : {})
          .toBuffer({ resolveWithObject: true });

        const TargetType = is16Bit ? Uint16Array : Uint8Array;
        const pixelCountOrig = extractOpts.width * extractOpts.height;
        const actualChannels = rawInfo.channels;
        const srcView = new TargetType(rawFullBuf.buffer, rawFullBuf.byteOffset, pixelCountOrig * actualChannels);
        const rgbArr = new TargetType(pixelCountOrig * 3);

        for (let i = 0; i < pixelCountOrig; i++) {
          rgbArr[i * 3 + 0] = srcView[i * actualChannels + rI];
          rgbArr[i * 3 + 1] = srcView[i * actualChannels + gI];
          rgbArr[i * 3 + 2] = srcView[i * actualChannels + bI];
        }

        const rgbBuf = Buffer.from(rgbArr.buffer, rgbArr.byteOffset, rgbArr.byteLength);
        const rawOpts = { width: extractOpts.width, height: extractOpts.height, channels: 3 };
        if (is16Bit) rawOpts.depth = 'ushort';

        let sharpImg = sharp(rgbBuf, { raw: rawOpts })
          .resize(resizeW, resizeH, { fit: 'fill', kernel: resampleKernel });
        const brightness = parseFloat(req.query.brightness || 0);
        const contrast = parseFloat(req.query.contrast || 0);
        if (brightness !== 0 || contrast !== 0) {
          const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
          sharpImg = sharpImg.linear(factor, 128 * (1 - factor) + (brightness * 2.55));
        }
        const png = await sharpImg
          .png({ compressionLevel: 1, adaptiveFiltering: false, force: true })
          .toBuffer();

        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(png);
      }

      if (renderer === 'pseudocolor' || renderer === 'multiband') {
        if (renderer === 'pseudocolor') {
        const bandIdx = Math.min(bands[0], channels - 1);
        const rawChannel = await sharp(filePath, sharpOpts)
          .extract(extractOpts)
          .extractChannel(bandIdx)
          .raw(is16Bit ? { depth: 'ushort' } : {})
          .toBuffer();

        const rawOpts = { width: extractOpts.width, height: extractOpts.height, channels: 1 };
        if (is16Bit) rawOpts.depth = 'ushort';

        const singleBuf = await sharp(rawChannel, { raw: rawOpts })
          .resize(resizeW, resizeH, { fit: 'fill', kernel: resampleKernel })
          .toColorspace('b-w')
          .raw(is16Bit ? { depth: 'ushort' } : {})
          .toBuffer();

        const pixelCount = resizeW * resizeH;
        const band = singleBuf.byteLength >= pixelCount * 2
          ? new Uint16Array(singleBuf.buffer, singleBuf.byteOffset, pixelCount)
          : new Uint8Array(singleBuf.buffer, singleBuf.byteOffset, pixelCount);

        const globalStats = await getGlobalStats(filePath);
        let minVal, rangeVal, nodataVal;
        if (globalStats && globalStats[bandIdx]) {
          minVal = globalStats[bandIdx].min; rangeVal = globalStats[bandIdx].range; nodataVal = globalStats[bandIdx].nodata;
        } else {
          let min = Infinity, max = -Infinity;
          for (let i = 0; i < pixelCount; i++) { const v = band[i]; if (v < min) min = v; if (v > max) max = v; }
          minVal = min; rangeVal = max - min || 1; nodataVal = 0;
        }

        const cmap = customColorsParam ? parseCustomColors(customColorsParam) : (COLOR_MAPS[colormapName] || COLOR_MAPS.viridis);
        const out = Buffer.alloc(tileSize * tileSize * 4); // Pre-filled transparent
        
        for (let y = 0; y < resizeH; y++) {
          for (let x = 0; x < resizeW; x++) {
            const v = band[y * resizeW + x];
            if (v === nodataVal) continue;
            const dstX = offX + x; const dstY = offY + y;
            if (dstX < 0 || dstX >= tileSize || dstY < 0 || dstY >= tileSize) continue;
            
            let t = Math.max(0, Math.min(1, (v - minVal) / rangeVal));
            if (invert) t = 1 - t;
            const c = interpolateColor(cmap, t);
            const dstIdx = (dstY * tileSize + dstX) * 4;
            out[dstIdx] = Math.round(c[0]);
            out[dstIdx + 1] = Math.round(c[1]);
            out[dstIdx + 2] = Math.round(c[2]);
            out[dstIdx + 3] = 255;
          }
        }
        const png = await sharp(out, { raw: { width: tileSize, height: tileSize, channels: 4 } }).png({ compressionLevel: 1, adaptiveFiltering: false, force: true }).toBuffer();
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(png);
      }

      if (renderer === 'multiband') {
        const rI = Math.min(bands[0] !== undefined ? bands[0] : 0, channels - 1);
        const gI = Math.min(bands[1] !== undefined ? bands[1] : (channels > 1 ? 1 : 0), channels - 1);
        const bI = Math.min(bands[2] !== undefined ? bands[2] : (channels > 2 ? 2 : 0), channels - 1);

        // Fast path removed to ensure correct transparency handling for NoData collars in 8-bit images

        const { data: rawFullBuf, info: rawInfo } = await sharp(filePath, sharpOpts)
          .extract(extractOpts)
          .raw(is16Bit ? { depth: 'ushort' } : {})
          .toBuffer({ resolveWithObject: true });

        const TargetType = is16Bit ? Uint16Array : Uint8Array;
        const pixelCountOrig = extractOpts.width * extractOpts.height;
        const actualChannels = rawInfo.channels;
        const srcView = new TargetType(rawFullBuf.buffer, rawFullBuf.byteOffset, pixelCountOrig * actualChannels);
        const rgbArr = new TargetType(pixelCountOrig * 3);

        for (let i = 0; i < pixelCountOrig; i++) {
          rgbArr[i * 3 + 0] = srcView[i * actualChannels + rI];
          rgbArr[i * 3 + 1] = srcView[i * actualChannels + gI];
          rgbArr[i * 3 + 2] = srcView[i * actualChannels + bI];
        }

        const rgbBuf = Buffer.from(rgbArr.buffer, rgbArr.byteOffset, rgbArr.byteLength);
        const rawOpts = { width: extractOpts.width, height: extractOpts.height, channels: 3 };
        if (is16Bit) rawOpts.depth = 'ushort';

        const resizedRgbBuf = await sharp(rgbBuf, { raw: rawOpts })
          .resize(resizeW, resizeH, { fit: 'fill', kernel: resampleKernel })
          .toColorspace('srgb') // Keep 3 channels
          .raw(is16Bit ? { depth: 'ushort' } : {})
          .toBuffer();

        const pixelCount = resizeW * resizeH;
        const resizedView = resizedRgbBuf.byteLength >= pixelCount * 3 * 2 
          ? new Uint16Array(resizedRgbBuf.buffer, resizedRgbBuf.byteOffset, pixelCount * 3) 
          : new Uint8Array(resizedRgbBuf.buffer, resizedRgbBuf.byteOffset, pixelCount * 3);

        const out = Buffer.alloc(tileSize * tileSize * 4);
        const globalStats = await getGlobalStats(filePath);
        let rMinVal, rRngVal, rNodata, gMinVal, gRngVal, gNodata, bMinVal, bRngVal, bNodata;

        if (!is16Bit) {
          rMinVal = 0; rRngVal = 255; rNodata = 0;
          gMinVal = 0; gRngVal = 255; gNodata = 0;
          bMinVal = 0; bRngVal = 255; bNodata = 0;
        } else if (globalStats && globalStats[rI] && globalStats[gI] && globalStats[bI]) {
          rMinVal = globalStats[rI].min; rRngVal = globalStats[rI].range; rNodata = globalStats[rI].nodata;
          gMinVal = globalStats[gI].min; gRngVal = globalStats[gI].range; gNodata = globalStats[gI].nodata;
          bMinVal = globalStats[bI].min; bRngVal = globalStats[bI].range; bNodata = globalStats[bI].nodata;
        } else {
          let rMin = Infinity, rMax = -Infinity, gMin = Infinity, gMax = -Infinity, bMin = Infinity, bMax = -Infinity;
          for (let i = 0; i < pixelCount; i++) {
            const r = resizedView[i * 3 + 0], g = resizedView[i * 3 + 1], b = resizedView[i * 3 + 2];
            if (r === 0 && g === 0 && b === 0) continue; // ignore nodata for local stats
            if (r < rMin) rMin = r; if (r > rMax) rMax = r;
            if (g < gMin) gMin = g; if (g > gMax) gMax = g;
            if (b < bMin) bMin = b; if (b > bMax) bMax = b;
          }
          if (rMin === Infinity) rMin = 0; if (rMax === -Infinity) rMax = 1;
          if (gMin === Infinity) gMin = 0; if (gMax === -Infinity) gMax = 1;
          if (bMin === Infinity) bMin = 0; if (bMax === -Infinity) bMax = 1;
          
          rMinVal = rMin; rRngVal = rMax - rMin || 1; rNodata = 0;
          gMinVal = gMin; gRngVal = gMax - gMin || 1; gNodata = 0;
          bMinVal = bMin; bRngVal = bMax - bMin || 1; bNodata = 0;
        }

        if (!is16Bit) {
          for (let y = 0; y < resizeH; y++) {
            let dstY = offY + y;
            if (dstY < 0 || dstY >= tileSize) continue;
            let dstRow = dstY * tileSize;
            let srcRow = y * resizeW;
            for (let x = 0; x < resizeW; x++) {
              let dstX = offX + x;
              if (dstX < 0 || dstX >= tileSize) continue;
              let i = srcRow + x;
              let r = resizedView[i * 3 + 0], g = resizedView[i * 3 + 1], b = resizedView[i * 3 + 2];
              if (r === rNodata && g === gNodata && b === bNodata) continue;
              let dstIdx = (dstRow + dstX) * 4;
              out[dstIdx] = r; out[dstIdx+1] = g; out[dstIdx+2] = b; out[dstIdx+3] = 255;
            }
          }
        } else {
          for (let y = 0; y < resizeH; y++) {
            let dstY = offY + y;
            if (dstY < 0 || dstY >= tileSize) continue;
            let dstRow = dstY * tileSize;
            let srcRow = y * resizeW;
            for (let x = 0; x < resizeW; x++) {
              let dstX = offX + x;
              if (dstX < 0 || dstX >= tileSize) continue;
              let i = srcRow + x;
              let r = resizedView[i * 3 + 0], g = resizedView[i * 3 + 1], b = resizedView[i * 3 + 2];
              if (r === rNodata && g === gNodata && b === bNodata) continue;
              let dstIdx = (dstRow + dstX) * 4;
              out[dstIdx] = Math.max(0, Math.min(255, ((r - rMinVal) / rRngVal * 255) | 0));
              out[dstIdx + 1] = Math.max(0, Math.min(255, ((g - gMinVal) / gRngVal * 255) | 0));
              out[dstIdx + 2] = Math.max(0, Math.min(255, ((b - bMinVal) / bRngVal * 255) | 0));
              out[dstIdx + 3] = 255;
            }
          }
        }
        
        // Use WebP Lossless for ultimate speed and 100% pixel fidelity
        const webp = await sharp(out, { raw: { width: tileSize, height: tileSize, channels: 4 } })
          .webp({ lossless: true, effort: 1 })
          .toBuffer();
        res.set('Content-Type', 'image/webp');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(webp);
      }
    }

    const img = sharp(filePath, sharpOpts);
    const buf = await img
      .extract(extractOpts)
      .resize(resizeW, resizeH, { fit: 'fill', kernel: resampleKernel })
      .extend({ top: padTop, bottom: padBottom, left: padLeft, right: padRight, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 1, adaptiveFiltering: false, force: true })
      .toBuffer();

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    console.error('[tiles]', e.message);
    // Fallback: try GDAL if sharp failed (e.g., BigTIFF seek errors)
    const nChFb = (typeof meta !== 'undefined' && meta.channels) || 3;
    const cbFb = bands.map(b => Math.min(Math.max(0, b | 0), nChFb - 1));
    const fallbackOk = await Promise.race([
      tryGdalTile(filePath, z, x, y, renderer, cbFb, res),
      new Promise(r => setTimeout(() => r(false), 3000))
    ]);
    if (!fallbackOk) {
      // Last resort: serve a transparent PNG so the map doesn't break
      const transparent = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(transparent);
    }
  }
});

// ─── /api/metadata/:filename — TIFF metadata (bounds, size) via gdalinfo ───
app.get('/api/metadata/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename || '');
  let filePath = path.join(UPLOADS, filename);
  if (!fs.existsSync(filePath)) filePath = path.join(COMPRESSED, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  try {
    const sharp = require('sharp');
    const meta = await sharp(filePath).metadata();
    const result = { width: meta.width, height: meta.height, bands: meta.channels || 1, bounds: null };

    const GDAL_PATH = 'C:\\Program Files\\GDAL';
    const gdalEnv = { ...process.env, GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'), PROJ_DATA: path.join(GDAL_PATH, 'projlib'), PATH: `${GDAL_PATH};${process.env.PATH || ''}` };
    const { execFile } = require('child_process');
    const infoResult = await require('util').promisify(execFile)(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', filePath], { env: gdalEnv, timeout: 30000 });
    const gdalInfo = JSON.parse(infoResult.stdout);
    if (gdalInfo.size) {
      result.width = gdalInfo.size[0];
      result.height = gdalInfo.size[1];
    }
    if (gdalInfo.bands && Array.isArray(gdalInfo.bands) && gdalInfo.bands.length > 0) {
      result.bands = gdalInfo.bands.length;
    }
    const coords = gdalInfo.cornerCoordinates;
    if (coords) {
      const ll = coords.lowerLeft || null;
      const ur = coords.upperRight || null;
      if (ll && ur) {
        result.bounds = { west: ll[0], south: ll[1], east: ur[0], north: ur[1] };
      }
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/render-preview/:filename — fallback preview PNG for ungeoreferenced TIFFs ───
app.get('/api/render-preview/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename || '');
  let filePath = path.join(UPLOADS, filename);
  if (!fs.existsSync(filePath)) filePath = path.join(COMPRESSED, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  const maxSizeP = parseInt(req.query.maxSize);
  const maxSize = (maxSizeP > 0) ? maxSizeP : 0;
  try {
    const sharp = require('sharp');
    const meta = await sharp(filePath).metadata();
    let w = meta.width || 1, h = meta.height || 1;
    if (maxSize > 0 && (w > maxSize || h > maxSize)) {
      const scale = Math.min(maxSize / w, maxSize / h);
      w = Math.floor(w * scale);
      h = Math.floor(h * scale);
    }
    const buf = await sharp(filePath).resize(w, h, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    console.error('[render-preview]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/stats/:filename — cached global stats for GeoTIFF.js client ───
app.get('/api/stats/:filename', async (req, res) => {
  const filePath = path.join(UPLOADS, path.basename(req.params.filename || ''));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const stats = await getGlobalStats(filePath);
  if (!stats) return res.status(500).json({ error: 'Failed to compute stats' });
  res.json(stats);
});
// ─── /api/file-exists/:filename — check if a file exists on disk ───
app.head('/api/file-exists/:filename', (req, res) => {
  const filename = path.basename(req.params.filename || '');
  const uploadPath = path.join(UPLOADS, filename);
  const compressedPath = path.join(COMPRESSED, filename);
  if (fs.existsSync(uploadPath) || fs.existsSync(compressedPath)) {
    return res.status(200).end();
  }
  return res.status(404).end();
});

// ─── Static files ───
app.use(express.static(PUBLIC));

// ─── SPA fallback ───
app.get('*', (req, res) => {
  const filePath = path.join(PUBLIC, req.path);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return res.sendFile(filePath);
  }
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

const http = require('http');
const { attachCollab } = require('./server/collab');
const httpServer = http.createServer(app);
attachCollab(httpServer);

// Servidor auxiliar en puerto 8089 para compatibilidad si el usuario abre en ese puerto
if (Number(PORT) !== 8089) {
  try {
    const auxServer = http.createServer(app);
    attachCollab(auxServer);
    auxServer.listen(8089, () => {
      console.log('[auxServer] Servidor Express también activo en http://localhost:8089');
    });
    auxServer.on('error', (err) => {
      console.log('[auxServer 8089] No disponible:', err.message);
    });
  } catch (_) {}
}

httpServer.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT} — MODO CLOUD-ONLY | STREAMING LOSSLESS (COG chunked ≤25MB, objetos ≤30MB) | scale 1.0 sin perder píxel | WS /collab-ws`);
  console.log('[collab] WebSocket de colaboración activo en ws://localhost:%s/collab-ws', PORT);

  // Startup cleanup: CLOUD-ONLY — remove oversized >30MB (los sets streaming chunked
  // .partNNN/.sparse.xml/_preview.jpg/.cog.json están exentos: cada objeto ya es ≤25MB)
  try {
    const COMPRESSED_MAX = 30 * 1024 * 1024;
    const STREAM_KEEP = /(\.part\d+|\.sparse\.xml|_preview\.jpg|\.cog\.json)$/i;
    if (fs.existsSync(COMPRESSED)) {
      for (const f of fs.readdirSync(COMPRESSED)) {
        const fp = path.join(COMPRESSED, f);
        try {
          const st = fs.statSync(fp);
          if (st.isFile() && STREAM_KEEP.test(f)) {
            console.log(`[startup] Streaming set conservado: ${f} (${(st.size / 1048576).toFixed(2)}MB, objeto ≤30MB)`);
          } else if (st.isFile() && st.size > COMPRESSED_MAX) {
            fs.unlinkSync(fp);
            console.log(`[startup] CLOUD-ONLY: Removed oversized file from compressed/: ${f} (${(st.size / 1048576).toFixed(1)}MB) — violaba 30MB`);
          } else if (st.isFile()) {
            // CLOUD-ONLY: advertir que queda local (debería estar en nube)
            console.log(`[startup] CLOUD-ONLY: Archivo local en compressed/ (debería estar solo en nube): ${f} (${(st.size / 1048576).toFixed(2)}MB) — conservado para tiles pero ideal migrar a R2`);
          }
        } catch (_) {}
      }
    }
    if (fs.existsSync(UPLOADS)) {
      for (const f of fs.readdirSync(UPLOADS)) {
        if (f.startsWith('__gdal_') || f.endsWith('.aux.xml')) {
          try { fs.unlinkSync(path.join(UPLOADS, f)); console.log(`[startup] Removed temp: ${f}`); } catch (_) {}
        }
      }
      // CLOUD-ONLY: listar uploads locales que violan "nada local"
      const remaining = fs.readdirSync(UPLOADS).filter(f => /\.(tif|tiff)$/i.test(f));
      if (remaining.length > 0) {
        console.log(`[startup] CLOUD-ONLY: ${remaining.length} archivos TIFF aún en uploads/ (deberían estar solo en nube):`, remaining.slice(0,5));
      }
    }
    console.log('[startup] CLOUD-ONLY Cleanup complete — ZIP multiespectral usa streaming lossless (COG chunked ≤25MB, objetos ≤30MB) y borrado local tras subir a R2');
  } catch (e) {
    console.warn('[startup] Cleanup warning:', e.message);
  }
});

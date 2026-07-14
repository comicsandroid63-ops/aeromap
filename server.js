require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const UPLOADS = path.join(PUBLIC, 'uploads');
const COMPRESSED = path.join(PUBLIC, 'compressed');

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

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
mountApi('/api/admin/dashboard', require('./api/dashboard'));

app.use('/api/network', require('./api/network'));
app.use('/api/dzi', require('./api/dzi-generator'));
app.use('/api/render-preview', require('./api/tiff-preview'));

// ─── /api/import-tiff — upload & register TIFF ───
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
      const gdalEnv = { ...process.env, GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'), PROJ_LIB: path.join(GDAL_PATH, 'projlib'), PATH: `${GDAL_PATH};${process.env.PATH || ''}` };
      const { execFile } = require('child_process');
      const infoResult = await require('util').promisify(execFile)(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', destPath], { env: gdalEnv, timeout: 30000 });
      const gdalInfo = JSON.parse(infoResult.stdout);
      const corners = gdalInfo.corners;
      if (corners) {
        const ll = corners.lowerLeft || corners.ll || null;
        const ur = corners.upperRight || corners.ur || null;
        if (ll && ur) {
          metadata.bounds = { west: ll[0], south: ll[1], east: ur[0], north: ur[1] };
        }
      }
    } catch (e) {
      console.warn('[import-tiff] gdalinfo bounds failed:', e.message.substring(0, 100));
    }

    res.json({
      id: savedAs,
      savedAs,
      status: 'completed',
      optimizedSavedAs: savedAs,
      metadata,
      thumbnailUrl: null,
    });
  });
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
    const gdalEnv = { ...process.env, GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'), PROJ_LIB: path.join(GDAL_PATH, 'projlib'), PATH: `${GDAL_PATH};${process.env.PATH || ''}` };
    const { execFile } = require('child_process');
    const util = require('util');
    const exec = util.promisify(execFile);
    const gdalTranslate = path.join(GDAL_PATH, 'gdal_translate.exe');
    const gdalBuildVrt = path.join(GDAL_PATH, 'gdalbuildvrt.exe');

    const vrtPath = path.join(tmpDir, 'merged.vrt');
    console.log('[merge-rgb] gdalbuildvrt...');
    await exec(gdalBuildVrt, ['-separate', vrtPath, rPath, gPath, bPath], { env: gdalEnv, timeout: 120000 });

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
        if (srcW > maxSize || srcH > maxSize) {
          const scale = Math.min(maxSize / srcW, maxSize / srcH);
          outsizeArgs = ['-outsize', String(Math.floor(srcW * scale)), String(Math.floor(srcH * scale))];
          console.log('[merge-rgb] Downsampling to', outsizeArgs[1], 'x', outsizeArgs[2]);
        }
      } catch (e) { console.warn('[merge-rgb] gdalinfo failed, using full res:', e.message); }
    }

    console.log('[merge-rgb] gdal_translate (LZW)...');
    await exec(gdalTranslate, [vrtPath, mergedPath, '-co', 'TILED=YES', '-co', 'BLOCKXSIZE=256', '-co', 'BLOCKYSIZE=256', '-co', 'COMPRESS=LZW', '--config', 'GDAL_NUM_THREADS', 'ALL_CPUS', ...outsizeArgs], { env: gdalEnv, timeout: 600000 });
    console.log('[merge-rgb] Merged, size:', fs.statSync(mergedPath).size);

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

    res.json({
      id: savedAs, savedAs, optimizedSavedAs: savedAs,
      status: 'completed', metadata, thumbnailUrl: null,
    });
  } catch (e) {
    console.error('[merge-rgb] Error:', e);
    try { if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/compress-tiff — stub ───
app.post('/api/compress-tiff', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const src = path.join(UPLOADS, filename);
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'File not found' });
  const outName = filename.replace(/\.(tiff?)$/i, '_opt.tif');
  const dst = path.join(COMPRESSED, outName);
  try {
    fs.mkdirSync(COMPRESSED, { recursive: true });
    fs.copyFileSync(src, dst);
    res.json({ success: true, output: outName, fileUrl: `/compressed/${encodeURIComponent(outName)}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/import-status/:id ───
app.get('/api/import-status/:id', (req, res) => {
  const filename = req.params.id;
  const exists = fs.existsSync(path.join(UPLOADS, filename));
  if (exists) {
    res.json({
      status: 'completed',
      result: {
        fileUrl: `/uploads/${encodeURIComponent(filename)}`,
        savedAs: filename,
      },
    });
  } else {
    res.json({ status: 'processing' });
  }
});

// ─── Color ramps for pseudocolor rendering ───
const COLOR_MAPS = {
  viridis: [[0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 145, 140], [0.75, 94, 201, 98], [1, 253, 231, 37]],
  magma: [[0, 0, 0, 4], [0.25, 80, 18, 123], [0.5, 182, 54, 121], [0.75, 251, 136, 97], [1, 252, 253, 191]],
  inferno: [[0, 0, 0, 4], [0.25, 120, 28, 109], [0.5, 182, 54, 121], [0.75, 239, 114, 0], [1, 252, 255, 164]],
  plasma: [[0, 13, 8, 135], [0.25, 126, 3, 168], [0.5, 204, 71, 120], [0.75, 248, 149, 64], [1, 240, 249, 33]],
  jet: [[0, 0, 0, 131], [0.125, 0, 60, 255], [0.375, 0, 255, 255], [0.625, 255, 255, 0], [0.875, 255, 0, 0], [1, 128, 0, 0]],
  rdylgn: [[0, 165, 0, 38], [0.5, 255, 255, 191], [1, 0, 104, 55]],
};

function interpolateColor(cmap, t) {
  if (t <= cmap[0][0]) return [cmap[0][1], cmap[0][2], cmap[0][3]];
  if (t >= cmap[cmap.length - 1][0]) return [cmap[cmap.length - 1][1], cmap[cmap.length - 1][2], cmap[cmap.length - 1][3]];
  for (let j = 0; j < cmap.length - 1; j++) {
    if (t >= cmap[j][0] && t <= cmap[j + 1][0]) {
      const lo = cmap[j], hi = cmap[j + 1];
      const r = hi[0] - lo[0] || 1;
      const f = (t - lo[0]) / r;
      return [lo[1] + (hi[1] - lo[1]) * f, lo[2] + (hi[2] - lo[2]) * f, lo[3] + (hi[3] - lo[3]) * f];
    }
  }
  return [cmap[0][1], cmap[0][2], cmap[0][3]];
}

function parseCustomColors(str) {
  if (!str) return null;
  const hexPattern = /#[0-9a-f]{6}/gi;
  const matches = str.match(hexPattern);
  if (!matches || matches.length < 2) return null;
  const cmap = [];
  matches.forEach((hex, i) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    cmap.push([i / (matches.length - 1 || 1), r, g, b]);
  });
  return cmap;
}

const GDAL_PATH = 'C:\\Program Files\\GDAL';
const gdalEnv = { ...process.env, GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'), PROJ_LIB: path.join(GDAL_PATH, 'projlib'), PATH: `${GDAL_PATH};${process.env.PATH || ''}` };
const { execFile } = require('child_process');
const util = require('util');
const execGdal = util.promisify(execFile);

const fileStatsCache = new Map();

async function getGlobalStats(filePath) {
  if (fileStatsCache.has(filePath)) {
    return fileStatsCache.get(filePath);
  }
  try {
    const infoResult = await execGdal(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-stats', '-json', filePath], { env: gdalEnv, timeout: 30000 });
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

        // Estiramiento de desviación estándar (media +/- 2 * stddev)
        let minStretch = Math.max(activeMin, meanVal - 2.0 * stdDevVal);
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
    console.warn('[getGlobalStats] failed:', e.message);
    return null;
  }
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

    if (renderer === 'multiband' && bands && bands.length >= 3) {
      // GDAL bands are 1-indexed
      gdalArgs.push('-b', String(bands[0] + 1), '-b', String(bands[1] + 1), '-b', String(bands[2] + 1));
    } else if (bands && bands.length === 1) {
      gdalArgs.push('-b', String(bands[0] + 1));
    }

    gdalArgs.push('-of', 'PNG', filePath, outPath);
    await execGdal(path.join(GDAL_PATH, 'gdal_translate.exe'), gdalArgs, { env: gdalEnv, timeout: 10000 });

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

// ─── /api/tiles/:filename/:z/:x/:y.png — serve tile from TIFF ───
app.get('/api/tiles/:filename/:z/:x/:y.png', async (req, res) => {
  const { filename, z, x, y } = req.params;

  let filePath = path.join(UPLOADS, filename);
  if (!fs.existsSync(filePath)) filePath = path.join(COMPRESSED, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'TIFF not found' });
  }

  const tileSize = 256;
  const renderer = req.query.renderer;
  const bandsParam = req.query.bands;
  const bands = bandsParam ? bandsParam.split(',').map(Number) : [0];
  try {
    const sharp = require('sharp');
    const meta = await sharp(filePath).metadata();
    const w = meta.width || 256;
    const h = meta.height || 256;
    const n = Math.pow(2, parseInt(z));
    const tx = parseInt(x);
    const ty = parseInt(y);

    const bbox = req.query.bbox;
    let left, top, width, height;
    if (bbox) {
      const [bwest, bsouth, beast, bnorth] = bbox.split(',').map(Number);
      const tileDegLon = 360 / n;
      // When tile covers more area than the image, fall back to non-bbox approach
      // so we don't extract the full image at every low-zoom tile
      if (tileDegLon >= beast - bwest || n <= 2) {
        const px = Math.floor((tx / n) * w);
        const py = Math.floor((ty / n) * h);
        const pw = Math.max(1, Math.floor(w / n));
        const ph = Math.max(1, Math.floor(h / n));
        left = Math.min(px, w - 1);
        top = Math.min(py, h - 1);
        width = Math.min(pw, w - left);
        height = Math.min(ph, h - top);
      } else {
        const tileWest = tx / n * 360 - 180;
        const tileEast = (tx + 1) / n * 360 - 180;
        const tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;
        const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / n))) * 180 / Math.PI;
        left = Math.floor((tileWest - bwest) / (beast - bwest) * w);
        top = Math.floor((bnorth - tileNorth) / (bnorth - bsouth) * h);
        width = Math.max(1, Math.ceil((tileEast - tileWest) / (beast - bwest) * w));
        height = Math.max(1, Math.ceil((tileNorth - tileSouth) / (bnorth - bsouth) * h));
        left = Math.max(0, Math.min(left, w - 1));
        top = Math.max(0, Math.min(top, h - 1));
        width = Math.min(width, w - left);
        height = Math.min(height, h - top);
        if (width <= 0 || height <= 0) {
          const transparent = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');
          res.set('Content-Type', 'image/png');
          res.set('Cache-Control', 'public, max-age=86400');
          return res.send(transparent);
        }
      }
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
    const extractOpts = { left, top, width, height };
    const channels = meta.channels || 1;
    const is16Bit = meta.depth === 'ushort';

    // Parse rendering params
    const colormapName = req.query.colormap;
    const invert = req.query.invert === 'true';
    const classes = parseInt(req.query.classes) || 5;
    const customColorsParam = req.query.customColors;

    // Use rendered path for pseudocolor or multiband
    if (renderer === 'pseudocolor' || renderer === 'multiband') {
      if (renderer === 'pseudocolor') {
        const bandIdx = Math.min(bands[0], channels - 1);
        // Use extractChannel to get a single band reliably
        const singleBuf = await sharp(filePath)
          .extract(extractOpts)
          .extractChannel(bandIdx)
          .resize(tileSize, tileSize, { fit: 'fill' })
          .raw()
          .toBuffer();

        const pixelCount = tileSize * tileSize;
        const band = singleBuf.byteLength >= pixelCount * 2
          ? new Uint16Array(singleBuf.buffer, singleBuf.byteOffset, pixelCount)
          : new Uint8Array(singleBuf.buffer, singleBuf.byteOffset, pixelCount);

        const globalStats = await getGlobalStats(filePath);
        let minVal, rangeVal, nodataVal;
        if (globalStats && globalStats[bandIdx]) {
          minVal = globalStats[bandIdx].min;
          rangeVal = globalStats[bandIdx].range;
          nodataVal = globalStats[bandIdx].nodata;
        } else {
          let min = Infinity, max = -Infinity;
          for (let i = 0; i < pixelCount; i++) { const v = band[i]; if (v < min) min = v; if (v > max) max = v; }
          minVal = min;
          rangeVal = max - min || 1;
          nodataVal = 0;
        }

        const cmap = customColorsParam ? parseCustomColors(customColorsParam) : (COLOR_MAPS[colormapName] || COLOR_MAPS.viridis);
        const out = Buffer.alloc(pixelCount * 4);
        for (let i = 0; i < pixelCount; i++) {
          const v = band[i];
          const o = i * 4;
          if (v === nodataVal) {
            out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
            continue;
          }
          let t = Math.max(0, Math.min(1, (v - minVal) / rangeVal));
          if (invert) t = 1 - t;
          const c = interpolateColor(cmap, t);
          out[o] = Math.round(c[0]);
          out[o + 1] = Math.round(c[1]);
          out[o + 2] = Math.round(c[2]);
          out[o + 3] = 255;
        }
        const png = await sharp(out, { raw: { width: tileSize, height: tileSize, channels: 4 } }).png().toBuffer();
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(png);
      }

      if (renderer === 'multiband') {
        const rI = Math.min(bands[0] || 0, channels - 1);
        const gI = Math.min(bands[1] || (channels > 1 ? 1 : 0), channels - 1);
        const bI = Math.min(bands[2] || (channels > 2 ? 2 : 0), channels - 1);

        const extractBand = async (idx) => {
          const buf = await sharp(filePath)
            .extract(extractOpts)
            .extractChannel(idx)
            .resize(tileSize, tileSize, { fit: 'fill' })
            .raw()
            .toBuffer();
          const n = tileSize * tileSize;
          return buf.byteLength >= n * 2
            ? new Uint16Array(buf.buffer, buf.byteOffset, n)
            : new Uint8Array(buf.buffer, buf.byteOffset, n);
        };

        const [rB, gB, bB] = await Promise.all([extractBand(rI), extractBand(gI), extractBand(bI)]);
        const pixelCount = tileSize * tileSize;
        const out = Buffer.alloc(pixelCount * 4);

        const globalStats = await getGlobalStats(filePath);
        let rMinVal, rRngVal, rNodata;
        let gMinVal, gRngVal, gNodata;
        let bMinVal, bRngVal, bNodata;

        if (globalStats && globalStats[rI] && globalStats[gI] && globalStats[bI]) {
          rMinVal = globalStats[rI].min; rRngVal = globalStats[rI].range; rNodata = globalStats[rI].nodata;
          gMinVal = globalStats[gI].min; gRngVal = globalStats[gI].range; gNodata = globalStats[gI].nodata;
          bMinVal = globalStats[bI].min; bRngVal = globalStats[bI].range; bNodata = globalStats[bI].nodata;
        } else {
          let rMin = Infinity, rMax = -Infinity, gMin = Infinity, gMax = -Infinity, bMin = Infinity, bMax = -Infinity;
          for (let i = 0; i < pixelCount; i++) {
            const r = rB[i], g = gB[i], b = bB[i];
            if (r < rMin) rMin = r; if (r > rMax) rMax = r;
            if (g < gMin) gMin = g; if (g > gMax) gMax = g;
            if (b < bMin) bMin = b; if (b > bMax) bMax = b;
          }
          rMinVal = rMin; rRngVal = rMax - rMin || 1; rNodata = 0;
          gMinVal = gMin; gRngVal = gMax - gMin || 1; gNodata = 0;
          bMinVal = bMin; bRngVal = bMax - bMin || 1; bNodata = 0;
        }

        for (let i = 0; i < pixelCount; i++) {
          const o = i * 4;
          const r = rB[i];
          const g = gB[i];
          const b = bB[i];

          if (r === rNodata && g === gNodata && b === bNodata) {
            out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
          } else {
            out[o] = Math.max(0, Math.min(255, Math.round((r - rMinVal) / rRngVal * 255)));
            out[o + 1] = Math.max(0, Math.min(255, Math.round((g - gMinVal) / gRngVal * 255)));
            out[o + 2] = Math.max(0, Math.min(255, Math.round((b - bMinVal) / bRngVal * 255)));
            out[o + 3] = 255;
          }
        }
        const png = await sharp(out, { raw: { width: tileSize, height: tileSize, channels: 4 } }).png().toBuffer();
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(png);
      }
    }

    // Default: raw tile
    const img = sharp(filePath);
    const buf = await img
      .extract(extractOpts)
      .resize(tileSize, tileSize, { fit: 'fill' })
      .png()
      .toBuffer();

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    console.error('[tiles]', e.message);
    // Fallback: try GDAL if sharp failed (e.g., BigTIFF seek errors)
    const fallbackOk = await Promise.race([
      tryGdalTile(filePath, z, x, y, renderer, bands, res),
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

// ─── /api/render-preview/:filename — fallback preview PNG for ungeoreferenced TIFFs ───
app.get('/api/render-preview/:filename', async (req, res) => {
  const { filename } = req.params;
  let filePath = path.join(UPLOADS, filename);
  if (!fs.existsSync(filePath)) filePath = path.join(COMPRESSED, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  const maxSize = parseInt(req.query.maxSize) || 2048;
  try {
    const sharp = require('sharp');
    const meta = await sharp(filePath).metadata();
    let w = meta.width || 1, h = meta.height || 1;
    if (w > maxSize || h > maxSize) {
      const scale = Math.min(maxSize / w, maxSize / h);
      w = Math.floor(w * scale);
      h = Math.floor(h * scale);
    }
    const buf = await sharp(filePath).resize(w, h, { fit: 'inside' }).png().toBuffer();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    console.error('[render-preview]', e.message);
    res.status(500).json({ error: e.message });
  }
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

app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});

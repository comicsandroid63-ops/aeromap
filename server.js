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
app.use('/api/upload-visualization', require('./api/upload-visualization'));
mountApi('/api/admin/dashboard', require('./api/dashboard'));

app.use('/api/network', require('./api/network'));
app.use('/api/dzi', require('./api/dzi-generator'));
app.use('/api/render-preview', require('./api/tiff-preview'));

const rgbUpload = multer({ dest: UPLOADS, limits: { fileSize: 2000 * 1024 * 1024, files: 3 } }).fields([
  { name: 'rFile', maxCount: 1 },
  { name: 'gFile', maxCount: 1 },
  { name: 'bFile', maxCount: 1 },
]);

// ─── /api/zip-to-rgb — upload ZIP + extract bands + merge RGB in one request ───
const zipUpload = multer({ dest: UPLOADS, limits: { fileSize: 2000 * 1024 * 1024 } }).single('zip');
app.post('/api/zip-to-rgb', (req, res) => {
  zipUpload(req, res, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'zip file required' });
    const { rName, gName, bName, originalName, bands } = req.body;
    let bandNames = [];
    if (bands) {
      try { bandNames = JSON.parse(bands); } catch(e) {}
    } else if (rName && gName && bName) {
      bandNames = [rName, gName, bName];
    }
    if (bandNames.length === 0) return res.status(400).json({ error: 'bands or rName, gName, bName required' });
    let tmpDir;
    try {
      const zipPath = req.file.path;
      const vsizip = `/vsizip/{${zipPath}}`;
      const name = (originalName || 'merged_RGB').replace(/\.[^.]+$/, '') + '_RGB';
      const savedAs = Date.now() + '-' + name.replace(/[^a-zA-Z0-9._-]/g, '_') + '.tif';
      const mergedPath = path.join(UPLOADS, savedAs);
      tmpDir = path.join(UPLOADS, 'tmp_' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });

      const GDAL_PATH = 'C:\\Program Files\\GDAL';
      const gdalEnv = { ...process.env, GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'), PROJ_LIB: path.join(GDAL_PATH, 'projlib'), PATH: `${GDAL_PATH};${process.env.PATH || ''}` };
      const exec = require('util').promisify(require('child_process').execFile);
      const vrtPath = path.join(tmpDir, 'merged.vrt');

      const vsizipPaths = bandNames.map(b => `${vsizip}/${b.replace(/\\/g, '/')}`);
      await exec(path.join(GDAL_PATH, 'gdalbuildvrt.exe'), ['-resolution', 'highest', '-srcnodata', '0', '-vrtnodata', '0', '-separate', vrtPath, ...vsizipPaths], { env: gdalEnv, timeout: 120000 });

      const warpedVrtPath = path.join(tmpDir, 'warped.vrt');
      await exec(path.join(GDAL_PATH, 'gdalwarp.exe'), ['-of', 'VRT', '-t_srs', 'EPSG:4326', vrtPath, warpedVrtPath], { env: gdalEnv, timeout: 120000 });

      let scaleArgs = [];
      try {
        // Read stats from unwarped VRT for performance
        const infoResult = await exec(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-approx_stats', '-json', vrtPath], { env: gdalEnv, timeout: 30000 });
        const info = JSON.parse(infoResult.stdout);
        if (info.bands) {
          let is16Bit = false;
          info.bands.forEach((b, i) => {
            let mean = b.mean || 0;
            let stdDev = b.stdDev || 1;
            let minVal = b.minimum ?? (b.stats?.minimum ?? 0);
            if (minVal === 0 && b.noDataValue === 0) minVal = 1;
            let maxVal = mean + 2.0 * stdDev;
            if (b.type === 'Byte' || (b.maximum !== undefined && b.maximum <= 255)) { 
               minVal = 0; maxVal = 255; 
            } else {
               is16Bit = true;
            }
            scaleArgs.push(`-scale_${i+1}`, String(Math.floor(minVal)), String(Math.ceil(maxVal)), '1', '255');
          });
          if (is16Bit) {
             scaleArgs.push('-exponent', '0.65');
          }
        }
      } catch(e) {
        console.warn('[zip-to-rgb] Stats failed, fallback to default scale', e.message);
        scaleArgs.push('-scale');
      }

      let translateArgs = [warpedVrtPath, mergedPath, ...scaleArgs, '-a_nodata', '0', '-ot', 'Byte', '-of', 'COG', '-co', 'COMPRESS=DEFLATE', '-co', 'PREDICTOR=YES', '-co', 'NUM_THREADS=ALL_CPUS', '-co', 'BIGTIFF=YES', '-co', 'RESAMPLING=AVERAGE'];
      if (bandNames.length !== 3) {
        translateArgs.push('-colorinterp', Array(bandNames.length).fill('undefined').join(','));
      }
      await exec(path.join(GDAL_PATH, 'gdal_translate.exe'), translateArgs, { env: gdalEnv, timeout: 600000 });

      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      try { fs.unlinkSync(zipPath); } catch(_) {}

      let metadata = { width: 0, height: 0, bands: 3, bounds: null };
      try {
        const sharp = require('sharp');
        const info = await sharp(mergedPath).metadata();
        metadata.width = info.width || 0; metadata.height = info.height || 0; metadata.bands = info.channels || 3;
      } catch(e) { console.warn('[zip-to-rgb] metadata:', e.message); }
      try {
        const infoResult = await exec(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', mergedPath], { env: gdalEnv, timeout: 30000 });
        const info = JSON.parse(infoResult.stdout);
        if (info.wgs84Extent?.coordinates?.[0]?.length >= 4) {
          const coords = info.wgs84Extent.coordinates[0];
          metadata.bounds = { west: Math.min(...coords.map(c => c[0])), south: Math.min(...coords.map(c => c[1])), east: Math.max(...coords.map(c => c[0])), north: Math.max(...coords.map(c => c[1])) };
        } else if (info.cornerCoordinates) {
          metadata.bounds = { west: info.cornerCoordinates.upperLeft[0], south: info.cornerCoordinates.lowerRight[1], east: info.cornerCoordinates.lowerRight[0], north: info.cornerCoordinates.upperLeft[1] };
        }
      } catch(e) { console.warn('[zip-to-rgb] bounds:', e.message); }

      // Background stats
      exec(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-stats', '-json', mergedPath], { env: gdalEnv, timeout: 60000 }).then(r => {
        try { const info = JSON.parse(r.stdout); if (info.bands) fileStatsCache.set(mergedPath, info.bands.map(b => { const mn=b.minimum??b.stats?.minimum??0,mx=b.maximum??b.stats?.maximum??255,mean=b.mean??b.stats?.mean??((mn+mx)/2),std=b.stdDev??b.stats?.stddev??((mx-mn)/4),aMn=(mn===(b.noDataValue??0))?mn+1:mn,mnS=Math.max(aMn,mean-3*std),mxS=Math.min(mx,mean+3*std);return{min:mnS<mxS?mnS:aMn,max:mxS>mnS?mxS:mx,range:(Math.max(mxS>mnS?mxS:mx,mnS<mxS?mnS:aMn)-(mnS<mxS?mnS:aMn))||1,nodata:b.noDataValue??0};})); } catch(e) {}
      }).catch(() => {});
      // Overviews are automatically generated by the COG driver during gdal_translate.
      res.json({ id: savedAs, savedAs, status: 'completed', metadata, thumbnailUrl: null });
    } catch (e) {
      console.error('[zip-to-rgb] Error:', e);
      try { if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
      try { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(_) {}
      res.status(500).json({ error: e.message });
    }
  });
});

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
      const coords = gdalInfo.cornerCoordinates;
      if (coords) {
        const ll = coords.lowerLeft || null;
        const ur = coords.upperRight || null;
        if (ll && ur) {
          metadata.bounds = { west: ll[0], south: ll[1], east: ur[0], north: ur[1] };
        }
      }
    } catch (e) {
      console.warn('[import-tiff] gdalinfo bounds failed:', e.message.substring(0, 100));
    }

    // Generate internal overviews for efficient tile rendering
    if (metadata.width > 1024 || metadata.height > 1024) {
      console.log('[import-tiff] Generating overviews...');
      await execGdal(path.join(GDAL_PATH, 'gdaladdo.exe'), [
        '-r', 'average',
        destPath,
        '2', '4', '8', '16', '32', '64', '128'
      ], { env: gdalEnv, timeout: 120000 }).then(() => {
        console.log('[import-tiff] Overviews generated for', savedAs);
      }).catch(e => {
        console.warn('[import-tiff] Overview generation failed:', e.message.substring(0, 100));
      });
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
        if (srcW > maxSize || srcH > maxSize) {
          const scale = Math.min(maxSize / srcW, maxSize / srcH);
          outsizeArgs = ['-outsize', String(Math.floor(srcW * scale)), String(Math.floor(srcH * scale))];
          console.log('[merge-rgb] Downsampling to', outsizeArgs[1], 'x', outsizeArgs[2]);
        }
      } catch (e) { console.warn('[merge-rgb] gdalinfo failed, using full res:', e.message); }
    }

    let scaleArgs = [];
    try {
      const gdalinfo = path.join(GDAL_PATH, 'gdalinfo.exe');
      const infoResult = await exec(gdalinfo, ['-approx_stats', '-json', vrtPath], { env: gdalEnv, timeout: 30000 });
      const info = JSON.parse(infoResult.stdout);
      if (info.bands) {
        info.bands.forEach((b, i) => {
          let mean = b.mean || 0;
          let stdDev = b.stdDev || 1;
          let minVal = Math.max(0, mean - 1.5 * stdDev);
          let maxVal = mean + 1.5 * stdDev;
          if (b.type === 'Byte' || (b.maximum !== undefined && b.maximum <= 255)) { 
             minVal = 0; maxVal = 255; 
          }
          scaleArgs.push(`-scale_${i+1}`, String(Math.floor(minVal)), String(Math.ceil(maxVal)), '1', '255');
        });
      }
    } catch(e) {
      console.warn('[merge-rgb] Stats failed, fallback to default scale', e.message);
      scaleArgs.push('-scale');
    }

    console.log('[merge-rgb] gdal_translate (DEFLATE)...');
    await exec(gdalTranslate, [vrtPath, mergedPath, ...scaleArgs, '-a_nodata', '0', '-ot', 'Byte', '-co', 'TILED=YES', '-co', 'BLOCKXSIZE=256', '-co', 'BLOCKYSIZE=256', '-co', 'COMPRESS=DEFLATE', '-co', 'PREDICTOR=2', '-co', 'ZLEVEL=1', '--config', 'GDAL_NUM_THREADS', 'ALL_CPUS', ...outsizeArgs], { env: gdalEnv, timeout: 600000 });
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

    const bandStats = await getGlobalStats(mergedPath).catch(() => null);

    res.json({
      id: savedAs, savedAs, optimizedSavedAs: savedAs,
      status: 'completed', metadata, thumbnailUrl: null,
      stats: bandStats,
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

const { COLOR_MAPS, interpolateColor, parseCustomColors } = require('./server/lib/color-ramps');

const GDAL_PATH = 'C:\\Program Files\\GDAL';
const gdalEnv = { ...process.env, GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'), PROJ_LIB: path.join(GDAL_PATH, 'projlib'), PATH: `${GDAL_PATH};${process.env.PATH || ''}` };
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

const fileStatsCache = new Map();
const fileStatsPromises = new Map();

async function getGlobalStats(filePath) {
  if (fileStatsCache.has(filePath)) {
    return fileStatsCache.get(filePath);
  }
  if (fileStatsPromises.has(filePath)) {
    return fileStatsPromises.get(filePath);
  }

  const promise = (async () => {
    try {
      const infoResult = await gdalTileQueue.add(() => execGdal(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-stats', '-json', filePath], { env: gdalEnv, timeout: 60000 }));
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
      return null;
    }
  })();
  fileStatsPromises.set(filePath, promise);
  const result = await promise;
  fileStatsPromises.delete(filePath);
  return result;
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
      gdalArgs.push('-scale');
    } else if (bands && bands.length === 1) {
      gdalArgs.push('-b', String(bands[0] + 1));
      gdalArgs.push('-scale');
    }

    gdalArgs.push('-r', 'near', '-of', 'PNG', '-ot', 'Byte', filePath, outPath);
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
  const outPath = path.join(UPLOADS, '__gdal_projwin_' + Date.now() + '.png');
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

    gdalArgs.push('-r', 'near', '-of', 'PNG', '-ot', 'Byte', filePath, outPath);
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
  console.log(`[TILE REQUEST] ${filename} z=${z} x=${x} y=${y}`);

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
    let tileWest, tileNorth, tileEast, tileSouth; // geographic bounds for GDAL projwin
    if (bbox) {
      const [bwest, bsouth, beast, bnorth] = bbox.split(',').map(Number);
      const tileDegLon = 360 / n;
      tileWest = tx / n * 360 - 180;
      tileEast = (tx + 1) / n * 360 - 180;
      tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;
      tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / n))) * 180 / Math.PI;
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

    const is16Bit = meta.depth === 'ushort';
    
    // Use GDAL with geographic window for 16-bit stretching
    if ((is16Bit) && bbox && tileWest != null && renderer !== 'pseudocolor') {
      const globalStats = await getGlobalStats(filePath);
      const gdalOk = await tryGdalProjwinTile(
        filePath, tileWest, tileNorth, tileEast, tileSouth,
        renderer, bands, res, globalStats
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

        if (!is16Bit && (channels === 3 || channels === 4) && rI === 0 && gI === 1 && bI === 2) {
          const buf = await sharp(filePath, sharpOpts)
            .extract(extractOpts)
            .resize(resizeW, resizeH, { fit: 'fill', kernel: 'lanczos3' })
            .extend({ top: padTop, bottom: padBottom, left: padLeft, right: padRight, background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png({ compressionLevel: 1, adaptiveFiltering: false, force: true })
            .toBuffer();
          res.set('Content-Type', 'image/png');
          res.set('Cache-Control', 'public, max-age=86400');
          return res.send(buf);
        }

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

        for (let y = 0; y < resizeH; y++) {
          for (let x = 0; x < resizeW; x++) {
            const i = y * resizeW + x;
            const r = resizedView[i * 3 + 0], g = resizedView[i * 3 + 1], b = resizedView[i * 3 + 2];
            if (r === rNodata && g === gNodata && b === bNodata) continue;
            
            const dstX = offX + x; const dstY = offY + y;
            if (dstX < 0 || dstX >= tileSize || dstY < 0 || dstY >= tileSize) continue;
            const dstIdx = (dstY * tileSize + dstX) * 4;

            out[dstIdx] = Math.max(0, Math.min(255, Math.round((r - rMinVal) / rRngVal * 255)));
            out[dstIdx + 1] = Math.max(0, Math.min(255, Math.round((g - gMinVal) / gRngVal * 255)));
            out[dstIdx + 2] = Math.max(0, Math.min(255, Math.round((b - bMinVal) / bRngVal * 255)));
            out[dstIdx + 3] = 255;
          }
        }
        const png = await sharp(out, { raw: { width: tileSize, height: tileSize, channels: 4 } }).png({ compressionLevel: 1, adaptiveFiltering: false, force: true }).toBuffer();
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(png);
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

// ─── /api/metadata/:filename — TIFF metadata (bounds, size) via gdalinfo ───
app.get('/api/metadata/:filename', async (req, res) => {
  const { filename } = req.params;
  let filePath = path.join(UPLOADS, filename);
  if (!fs.existsSync(filePath)) filePath = path.join(COMPRESSED, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  try {
    const sharp = require('sharp');
    const meta = await sharp(filePath).metadata();
    const result = { width: meta.width, height: meta.height, bands: meta.channels || 1, bounds: null };

    const GDAL_PATH = 'C:\\Program Files\\GDAL';
    const gdalEnv = { ...process.env, GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'), PROJ_LIB: path.join(GDAL_PATH, 'projlib'), PATH: `${GDAL_PATH};${process.env.PATH || ''}` };
    const { execFile } = require('child_process');
    const infoResult = await require('util').promisify(execFile)(path.join(GDAL_PATH, 'gdalinfo.exe'), ['-json', filePath], { env: gdalEnv, timeout: 30000 });
    const gdalInfo = JSON.parse(infoResult.stdout);
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
  const { filename } = req.params;
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
  const filePath = path.join(UPLOADS, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const stats = await getGlobalStats(filePath);
  if (!stats) return res.status(500).json({ error: 'Failed to compute stats' });
  res.json(stats);
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

const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);
const GDAL_PATH = 'C:\\Program Files\\GDAL';
const GDAL_ENV = {
  ...process.env,
  GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'),
  PROJ_LIB: path.join(GDAL_PATH, 'projlib'),
  PATH: `${GDAL_PATH};${process.env.PATH || ''}`
};
process.env.GDAL_DATA = GDAL_ENV.GDAL_DATA;
process.env.PROJ_LIB = GDAL_ENV.PROJ_LIB;
process.env.PATH = GDAL_ENV.PATH;

function runGdal(args) {
  return execFileAsync(path.join(GDAL_PATH, 'gdal_translate.exe'), args, { env: GDAL_ENV });
}

const router = express.Router();
const WEBP_CACHE_DIR = path.join(__dirname, '..', 'public', 'webp-cache');
if (!fs.existsSync(WEBP_CACHE_DIR)) fs.mkdirSync(WEBP_CACHE_DIR, { recursive: true });

// ─── In-memory tile cache (LRU) ───
const MEM_CACHE_MAX = 500;
const memCache = new Map();
function getCached(key) {
  if (!memCache.has(key)) return null;
  const val = memCache.get(key);
  memCache.delete(key); memCache.set(key, val);
  return val;
}
function setCache(key, val) {
  if (memCache.has(key)) memCache.delete(key);
  else if (memCache.size >= MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  memCache.set(key, val);
}

// ─── COG endpoint ───
router.get('/cog/:z/:x/:y', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Se requiere ?url=' });
    const { z, x, y } = req.params;
    const vsiPath = `/vsicurl/${url}`;
    const cacheKey = `cog_${Buffer.from(url).toString('base64').substring(0, 32)}_${z}_${x}_${y}`;
    const diskPath = path.join(WEBP_CACHE_DIR, `${cacheKey}.webp`);

    const cached = getCached(cacheKey);
    if (cached) {
      res.set('Content-Type', 'image/webp');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(cached);
    }
    if (fs.existsSync(diskPath)) {
      res.set('Content-Type', 'image/webp');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.sendFile(diskPath);
    }

    const n = Math.pow(2, parseInt(z));
    const lonMin = x / n * 360 - 180;
    const lonMax = (x + 1) / n * 360 - 180;
    const tileLat = (yt) => Math.atan(Math.sinh(Math.PI * (1 - 2 * yt / n))) * 180 / Math.PI;
    const latMax = tileLat(parseInt(y));
    const latMin = tileLat(parseInt(y) + 1);

    await runGdal([
      '-of', 'WEBP', '-b', '1', '-b', '2', '-b', '3', '-ot', 'Byte', '-scale',
      '-projwin', String(lonMin), String(latMax), String(lonMax), String(latMin),
      '-projwin_srs', 'EPSG:4326',
      '-outsize', '256', '256', '-co', 'QUALITY=85',
      vsiPath, diskPath,
    ]);

    const buf = fs.readFileSync(diskPath);
    setCache(cacheKey, buf);

    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(diskPath);
  } catch (err) {
    console.error('[COG] Error:', err.message.substring(0, 200));
    res.status(500).json({ error: 'Error al leer COG remoto' });
  }
});

module.exports = router;

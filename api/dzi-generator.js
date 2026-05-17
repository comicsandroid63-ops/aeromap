const express = require('express');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const router = express.Router();

const TIFF_SOURCE_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
const DZI_DIR = path.join(__dirname, '..', 'public', 'dzi');
const LEVEL_CACHE = path.join(__dirname, '..', 'public', 'dzi', 'levels');
const TILE_CACHE = path.join(__dirname, '..', 'public', 'dzi', 'tiles');

if (!fs.existsSync(DZI_DIR)) fs.mkdirSync(DZI_DIR, { recursive: true });
if (!fs.existsSync(LEVEL_CACHE)) fs.mkdirSync(LEVEL_CACHE, { recursive: true });
if (!fs.existsSync(TILE_CACHE)) fs.mkdirSync(TILE_CACHE, { recursive: true });

// Clear stale caches on startup (level convention changed to v2)
const CACHE_VERSION = 'v3';
const cacheVersionPath = path.join(DZI_DIR, '.cache_version');
try {
  const existing = fs.readFileSync(cacheVersionPath, 'utf8').trim();
  if (existing !== CACHE_VERSION) {
    console.log('[DZI] Cache version mismatch, clearing caches...');
    fs.rmSync(LEVEL_CACHE, { recursive: true });
    fs.rmSync(TILE_CACHE, { recursive: true });
    fs.mkdirSync(LEVEL_CACHE, { recursive: true });
    fs.mkdirSync(TILE_CACHE, { recursive: true });
    fs.writeFileSync(cacheVersionPath, CACHE_VERSION);
  }
} catch (e) {
  fs.writeFileSync(cacheVersionPath, CACHE_VERSION);
}

function findSource(filename) {
  const p1 = path.join(TIFF_SOURCE_DIR, filename);
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(UPLOAD_DIR, filename);
  if (fs.existsSync(p2)) return p2;
  const p3 = path.join(TIFF_SOURCE_DIR, 'compressed', filename);
  if (fs.existsSync(p3)) return p3;
  if (global.__localTiffPaths && global.__localTiffPaths[filename]) return global.__localTiffPaths[filename];
  return null;
}

const metaCache = new Map();
global.__dziMetaCache = metaCache;

// ─── Register TIFF: read metadata, write DZI XML, NO tiles ───
router.post('/register', async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Se requiere filename' });

    const sourcePath = findSource(filename);
    if (!sourcePath) return res.status(404).json({ error: 'Archivo no encontrado' });

    const dziBase = filename.replace(/\.[^.]+$/, '');
    const dziXmlPath = path.join(DZI_DIR, `${dziBase}.dzi`);

    if (fs.existsSync(dziXmlPath) && metaCache.has(dziBase)) {
      const meta = metaCache.get(dziBase);
      return res.json({
        success: true,
        dziName: dziBase,
        width: meta.width,
        height: meta.height,
        maxLevel: meta.maxLevel,
        cached: true,
      });
    }

    console.log(`[DZI] Registering ${filename}...`);
    const start = Date.now();

    const metadata = await sharp(sourcePath, { limitInputPixels: false }).metadata();
    const width = metadata.width;
    const height = metadata.height;
    const maxDim = Math.max(width, height);
    const maxLevel = Math.ceil(Math.log2(maxDim));
    const tileSize = 256;

    const dziXml = `<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"
  Format="jpeg"
  Overlap="0"
  TileSize="${tileSize}"
  MaxLevel="${maxLevel}"
  Width="${width}"
  Height="${height}"
/>`;
    fs.writeFileSync(dziXmlPath, dziXml);

    metaCache.set(dziBase, { width, height, sourcePath, maxLevel, tileSize });

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[DZI] Registered ${width}x${height}, ${maxLevel} levels in ${elapsed}s`);

    res.json({
      success: true,
      dziName: dziBase,
      width,
      height,
      maxLevel,
      time: elapsed,
    });
  } catch (err) {
    console.error('[DZI] Register error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve DZI XML ───
router.get('/:name.dzi', (req, res) => {
  try {
    const xmlPath = path.join(DZI_DIR, `${req.params.name}.dzi`);
    if (!fs.existsSync(xmlPath)) {
      return res.status(404).json({ error: 'DZI no registrado' });
    }
    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(xmlPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve tile ON-DEMAND ───
router.get('/:name/tiles/:level/:x_y', async (req, res) => {
  try {
    const { name, level, x_y } = req.params;
    const meta = metaCache.get(name);
    if (!meta) return res.status(404).json({ error: 'TIFF no registrado' });

    const [x, y] = x_y.replace(/\.(jpeg|jpg)$/, '').split('_').map(Number);
    if (isNaN(x) || isNaN(y)) return res.status(400).json({ error: 'Tile inválido' });

    const lvl = parseInt(level);
    const { width, height, sourcePath, maxLevel, tileSize } = meta;

    // Calculate level dimensions (level 0 = full res, higher = smaller thumbnails)
    const factor = Math.pow(2, lvl);
    const levelWidth = Math.max(1, Math.ceil(width / factor));
    const levelHeight = Math.max(1, Math.ceil(height / factor));

    // Tile position within the level
    const tileX = x * tileSize;
    const tileY = y * tileSize;
    const tileW = Math.min(tileSize, levelWidth - tileX);
    const tileH = Math.min(tileSize, levelHeight - tileY);

    if (tileW <= 0 || tileH <= 0) {
      return res.status(404).json({ error: 'Tile fuera de rango' });
    }

    // Check tile cache
    const tileCachePath = path.join(TILE_CACHE, name, `${lvl}_${x}_${y}.jpg`);
    if (fs.existsSync(tileCachePath)) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.sendFile(tileCachePath);
    }

    // Check if level is cached as a resized image
    const levelCachePath = path.join(LEVEL_CACHE, name, `${lvl}.jpg`);
    let levelBuffer;

    if (fs.existsSync(levelCachePath)) {
      levelBuffer = fs.readFileSync(levelCachePath);
    } else {
      // Resize source to level dimensions and cache it
      console.log(`[DZI] Generating level ${lvl}/${maxLevel}: ${levelWidth}x${levelHeight}`);
      const levelDir = path.join(LEVEL_CACHE, name);
      if (!fs.existsSync(levelDir)) fs.mkdirSync(levelDir, { recursive: true });

      levelBuffer = await sharp(sourcePath, { limitInputPixels: false })
        .resize(levelWidth, levelHeight, { fit: 'fill' })
        .jpeg({ quality: 90 })
        .toBuffer();

      fs.writeFileSync(levelCachePath, levelBuffer);
    }

    // Extract tile from the level image
    const tileBuffer = await sharp(levelBuffer)
      .extract({ left: tileX, top: tileY, width: tileW, height: tileH })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Save tile to cache
    const tileDir = path.join(TILE_CACHE, name);
    if (!fs.existsSync(tileDir)) fs.mkdirSync(tileDir, { recursive: true });
    fs.writeFileSync(tileCachePath, tileBuffer);

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(tileBuffer);
  } catch (err) {
    console.error(`[DZI Tile] Error:`, err.message.substring(0, 200));
    res.status(500).json({ error: 'Error generando tile' });
  }
});

// ─── Clear cache ───
router.delete('/cache/:name', (req, res) => {
  try {
    const levelDir = path.join(LEVEL_CACHE, req.params.name);
    const tileDir = path.join(TILE_CACHE, req.params.name);
    if (fs.existsSync(levelDir)) fs.rmSync(levelDir, { recursive: true });
    if (fs.existsSync(tileDir)) fs.rmSync(tileDir, { recursive: true });
    metaCache.delete(req.params.name);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

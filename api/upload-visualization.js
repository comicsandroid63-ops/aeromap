const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COMPRESSED_DIR = path.join(PUBLIC_DIR, 'compressed');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

router.post('/', async (req, res) => {
  console.log('[UploadVisualization] Route hit! body:', req.body, 'query:', req.query);

  const { savedAs, originalName, parts } = req.body;

  if (!savedAs) {
    return res.status(400).json({ success: false, errors: ['Falta savedAs'] });
  }

  try {
    fs.mkdirSync(COMPRESSED_DIR, { recursive: true });

    // If parts (chunked), move them to compressed/
    if (parts && parts.length > 0) {
      console.log(`[UploadVisualization] Processing ${parts.length} pre-chunked parts...`);
      const outName = savedAs.replace(/\.(tiff?)$/i, '_opt.tif');
      const destPath = path.join(COMPRESSED_DIR, outName);

      // Parts are already optimized; use the first as the final file
      // In the new flow, the optimizer writes directly to compressed/, so this is a no-op
      for (const part of parts) {
        const partPath = path.join(UPLOADS_DIR, part);
        if (fs.existsSync(partPath)) {
          try { fs.unlinkSync(partPath); } catch (_) {}
        }
      }

      const url = `/compressed/${encodeURIComponent(outName)}`;
      return res.json({ success: true, results: [{ type: 'tiff', url }] });
    }

    // Normal single-file upload
    const isTiff = savedAs.match(/\.(tiff?)$/i);
    let filePath = path.join(UPLOADS_DIR, savedAs);
    let outName = savedAs;

    if (isTiff) {
      const optName = savedAs.replace(/\.(tiff?)$/i, '_opt.tif');
      const optPath = path.join(COMPRESSED_DIR, optName);
      if (fs.existsSync(optPath)) {
        filePath = optPath;
        outName = optName;
        console.log(`[UploadVisualization] Using optimized version: ${optName}`);
      } else {
        return res.status(400).json({ success: false, errors: ['El archivo TIFF debe ser optimizado antes de subir.'] });
      }
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, errors: ['Archivo no encontrado'] });
    }

    const MAX_CLOUD_BYTES = 20 * 1024 * 1024;
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_CLOUD_BYTES) {
      return res.status(400).json({ success: false, errors: [`El archivo pesa ${(stat.size / 1048576).toFixed(2)}MB y supera el límite de 20MB.`] });
    }

    // Copy to compressed if not already there
    const destPath = path.join(COMPRESSED_DIR, outName);
    if (filePath !== destPath) {
      fs.copyFileSync(filePath, destPath);
    }

    const url = `/compressed/${encodeURIComponent(outName)}`;
    return res.json({ success: true, results: [{ type: 'tiff', url }] });

  } catch (err) {
    console.error('[UploadVisualization] Error:', err);
    return res.status(500).json({ success: false, errors: [err.message] });
  }
});

module.exports = router;

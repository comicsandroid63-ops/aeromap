const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const util = require('util');
const { createClient } = require('@supabase/supabase-js');

const execFileAsync = util.promisify(execFile);
const GDAL_PATH = 'C:\\Program Files\\GDAL';
const GDAL_ENV = {
  ...process.env,
  GDAL_DATA: path.join(GDAL_PATH, 'gdal-data'),
  PROJ_LIB: path.join(GDAL_PATH, 'projlib'),
  PATH: `${GDAL_PATH};${process.env.PATH || ''}`
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
let supabaseAdmin = null;
if (SUPABASE_URL && (SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY)) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY);
}

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const CHUNK_THRESHOLD = 25 * 1024 * 1024; // 25 MB

router.post('/', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ success: false, errors: ['Supabase no configurado'] });
  }

  const { savedAs, originalName } = req.body;
  const { user_id, project_id } = req.query;
  
  if (!savedAs) {
    return res.status(400).json({ success: false, errors: ['Falta savedAs'] });
  }

  const prefix = (user_id && project_id) ? `${user_id}/${project_id}` : 'guest';
  const bucket = process.env.SUPABASE_BUCKET || 'shapefiles';
  const filePath = path.join(UPLOADS_DIR, savedAs);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, errors: ['Archivo local no encontrado'] });
  }

  try {
    const stats = fs.statSync(filePath);
    
    // Si pesa menos de 25 MB, se sube directo
    if (stats.size < CHUNK_THRESHOLD) {
      const cloudName = `${prefix}/${savedAs}`;
      const fileBuffer = fs.readFileSync(filePath);
      const { data, error } = await supabaseAdmin.storage.from(bucket).upload(cloudName, fileBuffer, {
        contentType: 'image/tiff',
        cacheControl: '3600',
        upsert: true
      });
      if (error) throw error;
      const { data: publicData } = supabaseAdmin.storage.from(bucket).getPublicUrl(cloudName);
      return res.json({ success: true, results: [{ type: 'tiff', url: publicData.publicUrl }] });
    }

    // Proceso de retile (Mosaic)
    const baseFolderName = savedAs.replace(/\.[^.]+$/, '');
    const tmpDir = path.join(UPLOADS_DIR, 'tmp_retile_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    // 1. gdal_retile.py
    console.log(`[UploadVisualization] Retiling ${savedAs}...`);
    await execFileAsync('python', [
      path.join(GDAL_PATH, 'gdal_retile.py'),
      '-v', '-r', 'near',
      '-ps', '2048', '2048',
      '-co', 'TILED=YES',
      '-co', 'COMPRESS=DEFLATE',
      '-co', 'ZLEVEL=1',
      '-targetDir', tmpDir,
      filePath
    ], { env: GDAL_ENV, timeout: 600000 });

    // 2. gdalbuildvrt
    const vrtFile = 'index.vrt';
    const vrtPath = path.join(tmpDir, vrtFile);
    const tifFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tif'));
    
    console.log(`[UploadVisualization] Building VRT from ${tifFiles.length} tiles...`);
    // Le pasamos los nombres relativos al gdalbuildvrt ejecutándolo desde tmpDir
    await execFileAsync(path.join(GDAL_PATH, 'gdalbuildvrt.exe'), [
      vrtFile,
      ...tifFiles
    ], { env: GDAL_ENV, cwd: tmpDir, timeout: 60000 });

    // 3. Subir todos los archivos a Supabase en paralelo (con límite de concurrencia)
    const allFiles = [...tifFiles, vrtFile];
    const cloudFolder = `${prefix}/${baseFolderName}`;
    
    console.log(`[UploadVisualization] Uploading ${allFiles.length} files to Supabase bucket: ${bucket} in folder: ${cloudFolder}`);
    
    const uploadFileToCloud = async (filename) => {
      const buf = fs.readFileSync(path.join(tmpDir, filename));
      const cloudName = `${cloudFolder}/${filename}`;
      const mime = filename.endsWith('.vrt') ? 'application/xml' : 'image/tiff';
      const { data, error } = await supabaseAdmin.storage.from(bucket).upload(cloudName, buf, {
        contentType: mime,
        cacheControl: '3600',
        upsert: true
      });
      if (error) throw error;
      return cloudName;
    };

    // Subir en bloques de 5 para no saturar la red o API
    const concurrency = 5;
    for (let i = 0; i < allFiles.length; i += concurrency) {
      const chunk = allFiles.slice(i, i + concurrency);
      await Promise.all(chunk.map(f => uploadFileToCloud(f)));
    }

    // 4. Obtener URL pública del VRT
    const vrtCloudName = `${cloudFolder}/${vrtFile}`;
    const { data: publicData } = supabaseAdmin.storage.from(bucket).getPublicUrl(vrtCloudName);

    // Limpiar tmpDir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { console.warn(e); }

    return res.json({ success: true, results: [{ type: 'tiff', url: publicData.publicUrl }] });

  } catch (err) {
    console.error('[UploadVisualization] Error:', err);
    return res.status(500).json({ success: false, errors: [err.message] });
  }
});

module.exports = router;

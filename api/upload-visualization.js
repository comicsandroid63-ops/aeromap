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

  const { savedAs, originalName, parts } = req.body;
  const { user_id, project_id } = req.query;
  
  if (!savedAs) {
    return res.status(400).json({ success: false, errors: ['Falta savedAs'] });
  }

  const prefix = (user_id && project_id) ? `${user_id}/${project_id}` : 'guest';
  const bucket = process.env.SUPABASE_BUCKET || 'shapefiles';

  try {
    const uploadFileToCloud = async (filename, cloudName) => {
      const buf = fs.readFileSync(path.join(UPLOADS_DIR, filename));
      const mime = 'image/tiff';
      const { data, error } = await supabaseAdmin.storage.from(bucket).upload(cloudName, buf, {
        contentType: mime,
        cacheControl: '3600',
        upsert: true
      });
      if (error) throw error;
      return cloudName;
    };

    if (parts && parts.length > 0) {
      console.log(`[UploadVisualization] Uploading ${parts.length} pre-chunked parts to Supabase...`);
      const cloudFolder = `${prefix}/${savedAs.replace(/\.[^.]+$/, '')}`;
      let lastUploadedUrl = null;

      const concurrency = 5;
      for (let i = 0; i < parts.length; i += concurrency) {
        const chunk = parts.slice(i, i + concurrency);
        await Promise.all(chunk.map(async part => {
          const cloudName = `${cloudFolder}/${part}`;
          await uploadFileToCloud(part, cloudName);
          const { data: publicData } = supabaseAdmin.storage.from(bucket).getPublicUrl(cloudName);
          lastUploadedUrl = publicData.publicUrl;
          
          // Cleanup local chunk
          try {
            fs.unlinkSync(path.join(UPLOADS_DIR, part));
          } catch (e) {
            console.warn('[UploadVisualization] Failed to cleanup chunk:', part, e.message);
          }
        }));
      }

      // Cleanup the original merged huge file as well if it exists locally
      try {
        fs.unlinkSync(path.join(UPLOADS_DIR, savedAs));
      } catch (e) {}

      // Return the base URL derived from one of the parts, so the frontend can infer the rest
      return res.json({ success: true, results: [{ type: 'tiff', url: lastUploadedUrl }] });
    }

    // Si no hay parts, subida normal
    const filePath = path.join(UPLOADS_DIR, savedAs);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, errors: ['Archivo local no encontrado'] });
    }

    const cloudName = `${prefix}/${savedAs}`;
    await uploadFileToCloud(savedAs, cloudName);
    
    // Cleanup local file
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.warn('[UploadVisualization] Failed to cleanup file:', savedAs, e.message);
    }

    const { data: publicData } = supabaseAdmin.storage.from(bucket).getPublicUrl(cloudName);
    return res.json({ success: true, results: [{ type: 'tiff', url: publicData.publicUrl }] });

  } catch (err) {
    console.error('[UploadVisualization] Error:', err);
    return res.status(500).json({ success: false, errors: [err.message] });
  }
});

module.exports = router;

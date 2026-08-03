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
  console.log('[UploadVisualization] Route hit! body:', req.body, 'query:', req.query);
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
    const uploadFileToCloud = async (absPath, cloudName) => {
      const buf = fs.readFileSync(absPath);
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
          await uploadFileToCloud(path.join(UPLOADS_DIR, part), cloudName);
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
    let filePath = path.join(UPLOADS_DIR, savedAs);
    const isTiff = savedAs.match(/\.(tiff?)$/i);
    let optPath = null;
    
    if (isTiff) {
      const optName = savedAs.replace(/\.(tiff?)$/i, '_opt.tif');
      optPath = path.join(path.join(__dirname, '../public/compressed'), optName);
      if (fs.existsSync(optPath)) {
        filePath = optPath; // Use the optimized version
        console.log(`[UploadVisualization] Uploading optimized version instead: ${optName}`);
      } else {
        // Enforce project rule: heavy TIFFs MUST be optimized before uploading to cloud
        return res.status(400).json({ success: false, errors: ['El archivo TIFF debe ser optimizado localmente (botón Optimizar) antes de subirlo a la nube.'] });
      }
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, errors: ['Archivo local no encontrado'] });
    }

    const cloudName = `${prefix}/${savedAs}`;
    await uploadFileToCloud(filePath, cloudName);
    
    // Cleanup local file
    try {
      if (filePath !== optPath) {
        fs.unlinkSync(filePath);
      }
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

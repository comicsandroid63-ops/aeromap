const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
let supabase = null;
let supabaseAdmin = null;
try {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  }
} catch (e) {
  console.warn('[Upload] Supabase no configurado:', e.message);
}

const upload = multer({ storage: multer.memoryStorage() }).single('file');

module.exports = async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase no configurado (faltan SUPABASE_URL / SUPABASE_ANON_KEY)' });
  }

  // Configurar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  upload(req, res, async (err) => {
    if (err) {
      return res.status(500).json({ error: 'Error processing file' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = req.file;
    const { user_id, project_id } = req.query;
    const prefix = (user_id && project_id) ? `${user_id}/${project_id}` : '';
    const fileName = prefix ? `${prefix}/${file.originalname}` : file.originalname;

    const client = supabaseAdmin || supabase;
    const { data, error } = await client.storage
      .from(process.env.SUPABASE_BUCKET || 'shapefiles')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: true
      });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const { data: publicData } = client.storage
      .from(process.env.SUPABASE_BUCKET || 'shapefiles')
      .getPublicUrl(fileName);

    res.status(200).json({ 
      success: true, 
      url: publicData.publicUrl, 
      name: file.originalname,
      id: data.id,
      storagePath: fileName
    });
  });
};

const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const upload = multer({ storage: multer.memoryStorage() }).single('file');

module.exports = async (req, res) => {
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
    const fileName = `${uuidv4()}-${file.originalname}`;

    const { data, error } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET || 'shapefiles')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false
      });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Obtener URL pública
    const { data: publicData } = supabase.storage
      .from(process.env.SUPABASE_BUCKET || 'shapefiles')
      .getPublicUrl(fileName);

    res.status(200).json({ 
      success: true, 
      url: publicData.publicUrl, 
      name: file.originalname,
      id: data.id
    });
  });
};

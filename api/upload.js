const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');

const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { user_id, project_id } = req.query;
    const prefix = (user_id && project_id) ? `${user_id}/${project_id}` : '';
    const dest = prefix ? path.join(UPLOADS_DIR, prefix) : UPLOADS_DIR;
    
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage }).single('file');

module.exports = async (req, res) => {
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
    const storagePath = prefix ? `${prefix}/${file.originalname}` : file.originalname;

    const url = `/uploads/${storagePath}`;

    res.status(200).json({ 
      success: true, 
      url, 
      name: file.originalname,
      id: storagePath,
      storagePath
    });
  });
};

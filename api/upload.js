const multer = require('multer');
const fs = require('fs');
const path = require('path');

// En Vercel / serverless usar /tmp si public/uploads no es escribible
function getUploadsDir() {
  const localDir = path.join(__dirname, '..', 'public', 'uploads');
  try {
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    return localDir;
  } catch (e) {
    const tmpDir = path.join('/tmp', 'uploads');
    if (!fs.existsSync(tmpDir)) {
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
    }
    return tmpDir;
  }
}

const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
}).single('file');

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
      return res.status(500).json({ error: 'Error processing file: ' + err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = req.file;
    const { user_id, project_id } = req.query;
    const prefix = (user_id && project_id) ? `${user_id}/${project_id}` : '';
    const storagePath = prefix ? `${prefix}/${file.originalname}` : file.originalname;

    try {
      const targetDir = getUploadsDir();
      const fullDir = prefix ? path.join(targetDir, prefix) : targetDir;
      if (!fs.existsSync(fullDir)) {
        fs.mkdirSync(fullDir, { recursive: true });
      }
      fs.writeFileSync(path.join(fullDir, file.originalname), file.buffer);
    } catch (saveErr) {
      // Ignorar fallo de escritura a disco si el filesystem es de solo lectura (serverless)
      console.warn('[Upload] Failed to persist file on server disk:', saveErr.message);
    }

    const url = `/uploads/${storagePath}`;

    return res.status(200).json({ 
      success: true, 
      url, 
      name: file.originalname,
      id: storagePath,
      storagePath
    });
  });
};

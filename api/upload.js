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

    // Sanitización y whitelist de extensiones permitidas (previene RCE y subida de ejecutables)
    const ALLOWED_EXTS = /\.(tiff?|ztif|png|jpe?g|webp|geojson|json|zip|shp|dbf|shx|prj|gpkg|cpg|kml|kmz|csv)$/i;
    const DANGEROUS_EXTS = /\.(exe|bat|cmd|sh|php|phtml|phar|pl|cgi|py|rb|js|mjs|jsp|asp|aspx|vbs|wsf|scr|msi|dll|so|dylib|html?|svg)$/i;

    const originalSafeName = path.basename(file.originalname || 'upload').replace(/[^a-zA-Z0-9._\-]/g, '_');
    if (!ALLOWED_EXTS.test(originalSafeName) || DANGEROUS_EXTS.test(originalSafeName)) {
      return res.status(400).json({ error: 'Tipo de archivo no permitido por razones de seguridad' });
    }

    const { user_id, project_id } = req.query;
    const safeUserId = String(user_id || '').replace(/[^a-zA-Z0-9_\-]/g, '');
    const safeProjectId = String(project_id || '').replace(/[^a-zA-Z0-9_\-]/g, '');
    const prefix = (safeUserId && safeProjectId) ? `${safeUserId}/${safeProjectId}` : '';
    const storagePath = prefix ? `${prefix}/${originalSafeName}` : originalSafeName;

    try {
      const targetDir = getUploadsDir();
      const fullDir = (safeUserId && safeProjectId) ? path.join(targetDir, safeUserId, safeProjectId) : targetDir;
      const finalFilePath = path.join(fullDir, originalSafeName);

      // Verificación estricta contra Path Traversal
      const resolvedPath = path.resolve(finalFilePath);
      if (!resolvedPath.startsWith(path.resolve(targetDir))) {
        return res.status(400).json({ error: 'Ruta de archivo no permitida' });
      }

      if (!fs.existsSync(fullDir)) {
        fs.mkdirSync(fullDir, { recursive: true });
      }
      fs.writeFileSync(finalFilePath, file.buffer);
    } catch (saveErr) {
      // Ignorar fallo de escritura a disco si el filesystem es de solo lectura (serverless)
      console.warn('[Upload] Failed to persist file on server disk:', saveErr.message);
    }

    const url = `/uploads/${storagePath}`;

    return res.status(200).json({ 
      success: true, 
      url, 
      name: originalSafeName,
      id: storagePath,
      storagePath
    });
  });
};

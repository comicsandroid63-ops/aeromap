const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Usar /tmp en Vercel para uploads temporales (el resto del sistema de archivos es de solo lectura)
const getUploadsDir = () => {
    return process.env.VERCEL ? '/tmp' : path.join(__dirname, '..', 'uploads');
};

// Configuración de multer optimizada
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = getUploadsDir();
    if (!process.env.VERCEL && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname))
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // Reducido a 10MB para Vercel (limite real es ~4.5MB)
});

// Middleware
app.use(cors());
app.use(express.json());

// API: Endpoint para subir archivos
app.post('/api/upload', upload.array('files', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }
    const uploadedFiles = req.files.map(file => ({
      filename: file.filename,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      path: `/api/download/${file.filename}`,
      uploadedAt: new Date().toISOString()
    }));
    res.json({ success: true, message: `${req.files.length} archivo(s) subido(s) correctamente`, files: uploadedFiles });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al subir archivo', error: error.message });
  }
});

// API: Obtener lista de archivos subidos
app.get('/api/files', (req, res) => {
  try {
    const dir = getUploadsDir();
    if (!fs.existsSync(dir)) return res.json({ success: true, files: [] });
    const files = fs.readdirSync(dir).map(filename => {
      const stats = fs.statSync(path.join(dir, filename));
      return { filename, size: stats.size, uploadedAt: stats.birthtime, path: `/api/download/${filename}` };
    });
    res.json({ success: true, files });
  } catch (error) {
    res.json({ success: false, files: [], error: error.message });
  }
});

// API: Descargar archivo
app.get('/api/download/:filename', (req, res) => {
  try {
    const dir = getUploadsDir();
    const filepath = path.join(dir, req.params.filename);
    if (!filepath.startsWith(dir) || !fs.existsSync(filepath)) {
      return res.status(404).json({ success: false, message: 'Archivo no encontrado' });
    }
    res.download(filepath, req.params.filename);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al descargar archivo', error: error.message });
  }
});

// API: Eliminar archivo
app.delete('/api/files/:filename', (req, res) => {
  try {
    const dir = getUploadsDir();
    const filepath = path.join(dir, req.params.filename);
    if (!filepath.startsWith(dir) || !fs.existsSync(filepath)) {
      return res.status(404).json({ success: false, message: 'Archivo no encontrado' });
    }
    fs.unlinkSync(filepath);
    res.json({ success: true, message: 'Archivo eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al eliminar archivo', error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', environment: process.env.VERCEL ? 'production' : 'development' }));

// 404
app.use((req, res) => res.status(404).json({ success: false, message: 'API Endpoint not found' }));

// Listener Condicional
if (require.main === module || !process.env.VERCEL) {
  app.listen(port, () => console.log(`🚀 AeroMap API on http://localhost:${port}`));
}

module.exports = app;

const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Crear carpeta para uploads si no existe
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configurar multer para subida de archivos
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
    // Guardar con timestamp para evitar conflictos
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname))
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB límite
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ruta raíz - servir HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: Endpoint para subir archivos
app.post('/api/upload', upload.array('files', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No files uploaded' 
      });
    }

    // Retornar información de los archivos subidos
    const uploadedFiles = req.files.map(file => ({
      filename: file.filename,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      path: `/uploads/${file.filename}`,
      uploadedAt: new Date().toISOString()
    }));

    res.json({
      success: true,
      message: `${req.files.length} archivo(s) subido(s) correctamente`,
      files: uploadedFiles
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al subir archivo',
      error: error.message
    });
  }
});

// API: Obtener lista de archivos subidos
app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync('uploads/').map(filename => {
      const filepath = path.join('uploads', filename);
      const stats = fs.statSync(filepath);
      return {
        filename: filename,
        size: stats.size,
        uploadedAt: stats.birthtime,
        path: `/uploads/${filename}`
      };
    });
    res.json({
      success: true,
      files: files
    });
  } catch (error) {
    res.json({
      success: false,
      files: [],
      error: error.message
    });
  }
});

// API: Descargar archivo
app.get('/api/download/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filepath = path.join(__dirname, 'uploads', filename);
    
    // Validar que el archivo existe y está en la carpeta uploads
    if (!filepath.startsWith(path.join(__dirname, 'uploads'))) {
      return res.status(400).json({ 
        success: false, 
        message: 'Acceso denegado' 
      });
    }

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ 
        success: false, 
        message: 'Archivo no encontrado' 
      });
    }

    res.download(filepath, filename);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al descargar archivo',
      error: error.message
    });
  }
});

// API: Eliminar archivo
app.delete('/api/files/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filepath = path.join(__dirname, 'uploads', filename);
    
    // Validar ruta
    if (!filepath.startsWith(path.join(__dirname, 'uploads'))) {
      return res.status(400).json({ 
        success: false, 
        message: 'Acceso denegado' 
      });
    }

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ 
        success: false, 
        message: 'Archivo no encontrado' 
      });
    }

    fs.unlinkSync(filepath);
    res.json({
      success: true,
      message: 'Archivo eliminado correctamente'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al eliminar archivo',
      error: error.message
    });
  }
});

// Manejo de errores 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 AeroMap está corriendo en http://localhost:${port}`);
  console.log(`📁 Carpeta de uploads: ${uploadsDir}`);
});

module.exports = app;

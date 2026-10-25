const { getDb } = require('../lib/db');
const fs = require('fs');
const path = require('path');

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

const GUEST_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toValidUuid(val, fallback = null) {
  if (!val) return fallback;
  if (val === 'guest') return GUEST_UUID;
  if (UUID_REGEX.test(val)) return val;
  return fallback;
}

module.exports = async (req, res) => {
  let db;
  try {
    db = getDb();
  } catch (e) {
    return res.status(200).json([]);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { user_id, project_id } = req.query;

  if (req.method === 'DELETE' || (req.method === 'POST' && req.query.action === 'delete')) {
    let name, storagePath;
    if (req.method === 'DELETE') {
      name = req.query.name;
      storagePath = req.query.storagePath;
    } else {
      const body = req.body || {};
      name = body.name || req.query.name;
      storagePath = body.storagePath || req.query.storagePath;
    }
    
    if (!name && !storagePath) return res.status(400).json({ error: 'name or storagePath is required' });
    
    const rawTarget = String(storagePath || name || '').replace(/\\/g, '/');
    let relPath = rawTarget.replace(/^\/?uploads\/?/, '');
    if (/^https?:\/\//i.test(relPath)) {
      try { relPath = new URL(relPath).pathname.replace(/^\//, ''); } catch (_) {}
    }
    const safePath = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
    const UPLOADS_DIR = getUploadsDir();
    const fullPath = path.resolve(UPLOADS_DIR, safePath);
    
    // Verificación estricta contra Path Traversal
    if (!fullPath.startsWith(path.resolve(UPLOADS_DIR))) {
      return res.status(400).json({ error: 'Ruta no permitida' });
    }
    
    if (fs.existsSync(fullPath)) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
    }

    if (storagePath) {
      await db.execute({
        sql: 'DELETE FROM layers WHERE storage_url = ? OR storage_url = ? OR storage_url LIKE ?',
        args: [storagePath, `/uploads/${storagePath.replace(/^\/?uploads\//, '')}`, `%${safePath}%`]
      });
    }

    return res.status(200).json({ success: true });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let query = 'SELECT * FROM layers';
  const conditions = [];
  const args = [];
  
  if (project_id) {
    // Proyecto compartido: se listan TODOS los archivos del proyecto (invitados incluidos)
    const validPid = toValidUuid(project_id, null);
    if (validPid) {
      conditions.push('project_id = ?');
      args.push(validPid);
    } else {
      conditions.push('project_id IS NULL');
    }
  } else if (user_id) {
    conditions.push('user_id = ?');
    args.push(toValidUuid(user_id, GUEST_UUID));
  }
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  query += ' ORDER BY created_at DESC';

  const { rows: layersData } = await db.execute({ sql: query, args });

  const layersWithStorage = (layersData || []).filter(l => l.storage_url);

  const filesWithStatus = layersWithStorage.map(layer => {
    let rawStorage = layer.storage_url || '';
    // Normalizar storagePath y url
    let storagePath = rawStorage;
    if (storagePath.startsWith('/uploads/')) {
      storagePath = storagePath.slice('/uploads/'.length);
    } else if (storagePath.startsWith('uploads/')) {
      storagePath = storagePath.slice('uploads/'.length);
    }
    
    const UPLOADS_DIR = getUploadsDir();
    const fullPath = path.join(UPLOADS_DIR, storagePath);
    const fileExists = fs.existsSync(fullPath);
    
    const fileUrl = rawStorage.startsWith('http://') || rawStorage.startsWith('https://') 
      ? rawStorage 
      : `/uploads/${storagePath}`;

    // Nombre para mostrar: usar layer.name o basename del archivo
    const displayName = layer.name || path.basename(storagePath);
    
    return {
      name: displayName,
      url: fileUrl,
      storagePath: rawStorage,
      type: /\.gpkg$/i.test(storagePath) ? 'application/geopackage' : (layer.type === 'vector' ? 'application/json' : 'image/tiff'),
      isActive: layer.visible === 1,
      exists: fileExists
    };
  });

  res.status(200).json(filesWithStatus);
};

const { getDb } = require('../lib/db');
const fs = require('fs');
const path = require('path');

const GUEST_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toValidUuid(val, fallback = null) {
  if (!val) return fallback;
  if (val === 'guest') return GUEST_UUID;
  if (UUID_REGEX.test(val)) return val;
  return fallback;
}

function normalizeLayerData(data) {
  const normalized = { ...data };
  if (normalized.config && !normalized.metadata) {
    normalized.metadata = normalized.config;
  }
  delete normalized.config;
  normalized.user_id = toValidUuid(normalized.user_id, GUEST_UUID);
  normalized.project_id = toValidUuid(normalized.project_id, null);
  return normalized;
}

module.exports = async (req, res) => {
  let db;
  try {
    db = getDb();
  } catch (e) {
    return res.status(200).json([]);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const tableName = 'layers';

  if (req.method === 'GET') {
    const { project_id, user_id } = req.query;
    let query = 'SELECT * FROM layers';
    const conditions = [];
    const args = [];
    
    if (project_id !== undefined) {
      if (!project_id || project_id.trim() === '') {
        return res.status(200).json([]);
      }
      // Proyecto compartido: se devuelven TODAS las capas del proyecto (invitados incluidos)
      const validPid = toValidUuid(project_id, null);
      if (validPid) {
        conditions.push('project_id = ?');
        args.push(validPid);
      } else {
        conditions.push('project_id IS NULL');
      }
    } else if (user_id !== undefined && user_id !== '') {
      const validUid = toValidUuid(user_id, GUEST_UUID);
      conditions.push('user_id = ?');
      args.push(validUid);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY created_at DESC';

    const { rows } = await db.execute({ sql: query, args });
    
    const mapped = (rows || []).map(row => {
      const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
      return {
        ...row,
        config: metadata,
        metadata
      };
    });
    return res.status(200).json(mapped);
  }

  if (req.method === 'POST') {
    const layerData = normalizeLayerData(req.body);
    const id = crypto.randomUUID();
    const metadataStr = JSON.stringify(layerData.metadata || {});
    
    await db.execute({
      sql: `INSERT INTO layers (id, user_id, project_id, name, type, storage_url, metadata, visible, opacity) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        layerData.user_id || GUEST_UUID,
        layerData.project_id || null,
        layerData.name || '',
        layerData.type || 'raster',
        layerData.storage_url || null,
        metadataStr,
        layerData.visible !== false ? 1 : 0,
        layerData.opacity || 1.0
      ]
    });

    const { rows } = await db.execute({
      sql: 'SELECT * FROM layers WHERE id = ?',
      args: [id]
    });

    const row = rows[0];
    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    return res.status(200).json({
      ...row,
      config: metadata,
      metadata
    });
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    
    const updateData = normalizeLayerData(req.body);
    delete updateData.id;
    
    const fields = [];
    const args = [];
    
    Object.entries(updateData).forEach(([key, value]) => {
      if (key === 'metadata') {
        fields.push(`${key} = ?`);
        args.push(JSON.stringify(value || {}));
      } else {
        fields.push(`${key} = ?`);
        args.push(value);
      }
    });
    
    fields.push("updated_at = datetime('now')");
    args.push(id);
    
    await db.execute({
      sql: `UPDATE layers SET ${fields.join(', ')} WHERE id = ?`,
      args
    });
    
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    const { id, storage_url } = req.query;

    if (id) {
      const { rows } = await db.execute({
        sql: 'SELECT storage_url FROM layers WHERE id = ?',
        args: [id]
      });
      
      await db.execute({
        sql: 'DELETE FROM layers WHERE id = ?',
        args: [id]
      });
      
      if (rows[0]?.storage_url) {
        const filePath = path.join(__dirname, '..', 'public', 'uploads', rows[0].storage_url);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    } else if (storage_url) {
      const { rows } = await db.execute({
        sql: 'SELECT id FROM layers WHERE storage_url = ?',
        args: [storage_url]
      });
      
      await db.execute({
        sql: 'DELETE FROM layers WHERE storage_url = ?',
        args: [storage_url]
      });

      const filePath = path.join(__dirname, '..', 'public', 'uploads', storage_url);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    return res.status(200).json({ success: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};

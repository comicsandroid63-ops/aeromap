const crypto = require('crypto');
const { getDb } = require('../lib/db');

module.exports = async (req, res) => {
  let db;
  try {
    db = getDb();
  } catch (e) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse body safely
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = {};
    }
  } else if (!body && req.method === 'POST') {
    try {
      const buffers = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const raw = Buffer.concat(buffers).toString('utf8');
      body = raw ? JSON.parse(raw) : {};
    } catch (_) {
      body = {};
    }
  }
  body = body || {};

  // Extract path info robustly for both Express and Vercel serverless
  const rawUrl = req.url || '';
  const urlPath = (req.path || rawUrl.split('?')[0] || '').replace(/\/+$/, '');
  const isShareVerify = urlPath.endsWith('/share/verify');
  const isShare = !isShareVerify && urlPath.endsWith('/share');

  if (req.method === 'GET') {
    // Endpoint de colaboración: verificar token de compartir
    if (isShareVerify) {
      const { token } = req.query;
      if (!token) return res.status(400).json({ error: 'token required' });
      try {
        const { rows } = await db.execute({ sql: 'SELECT id, user_id, name, description, config FROM projects', args: [] });
        const match = rows.find(r => {
          try {
            const cfg = typeof r.config === 'string' ? JSON.parse(r.config) : (r.config || {});
            return cfg.share_token === token;
          } catch (e) { return false; }
        });
        if (!match) return res.status(404).json({ error: 'Enlace de compartir inválido o revocado' });
        return res.status(200).json({
          id: match.id,
          name: match.name,
          description: match.description
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // Endpoint de colaboración: abrir proyecto ajeno por id (dueño o compartido)
    const { id, user_id: currentUid } = req.query;
    if (id) {
      const { rows } = await db.execute({
        sql: 'SELECT * FROM projects WHERE id = ?',
        args: [id]
      });
      if (rows.length === 0) return res.status(404).json({ error: 'Proyecto no encontrado' });
      const row = rows[0];

      // Si se pasa user_id y es un invitado, agregarlo a project_members
      if (currentUid && currentUid !== 'guest' && currentUid !== row.user_id) {
        try {
          await db.execute({
            sql: `INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, 'collaborator')`,
            args: [id, currentUid]
          });
        } catch (_) {}
      }

      return res.status(200).json({
        ...row,
        config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config
      });
    }

    const { user_id } = req.query;
    let rows = [];

    if (user_id && user_id !== 'guest') {
      // Proyectos creados por el usuario O proyectos compartidos donde es miembro
      const query = `
        SELECT p.*, 
          CASE WHEN p.user_id = ? THEN 'owner' ELSE 'member' END as access_role
        FROM projects p
        WHERE p.user_id = ?
           OR p.id IN (SELECT project_id FROM project_members WHERE user_id = ?)
        ORDER BY p.updated_at DESC
      `;
      const result = await db.execute({ sql: query, args: [user_id, user_id, user_id] });
      rows = result.rows || [];
    } else if (user_id === 'guest') {
      const query = 'SELECT *, \'owner\' as access_role FROM projects WHERE user_id = ? ORDER BY updated_at DESC';
      const result = await db.execute({ sql: query, args: ['guest'] });
      rows = result.rows || [];
    } else {
      const query = 'SELECT *, \'owner\' as access_role FROM projects ORDER BY updated_at DESC';
      const result = await db.execute({ sql: query, args: [] });
      rows = result.rows || [];
    }

    const data = rows.map(row => ({
      ...row,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config
    }));

    return res.status(200).json(data);
  }

  if (req.method === 'POST' && isShare) {
    const { id } = body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const { rows } = await db.execute({
      sql: 'SELECT * FROM projects WHERE id = ?',
      args: [id]
    });
    if (rows.length === 0) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const row = rows[0];
    let cfg = {};
    try { cfg = typeof row.config === 'string' ? JSON.parse(row.config) : (row.config || {}); } catch (e) {}
    if (!cfg.share_token) {
      cfg.share_token = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      await db.execute({
        sql: "UPDATE projects SET config = ?, updated_at = datetime('now') WHERE id = ?",
        args: [JSON.stringify(cfg), id]
      });
    }
    return res.status(200).json({ share_token: cfg.share_token, id });
  }

  if (req.method === 'POST') {
    const { user_id, name, description, config } = body;
    if (!user_id || !name) return res.status(400).json({ error: 'user_id and name required' });
    
    const id = crypto.randomUUID();
    const configStr = JSON.stringify(config || {});
    
    await db.execute({
      sql: `INSERT INTO projects (id, user_id, name, description, config) VALUES (?, ?, ?, ?, ?)`,
      args: [id, user_id, name, description || '', configStr]
    });
    
    const { rows } = await db.execute({
      sql: 'SELECT * FROM projects WHERE id = ?',
      args: [id]
    });
    
    const project = {
      ...rows[0],
      config: typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config
    };
    
    return res.status(201).json(project);
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    
    await db.execute({
      sql: 'DELETE FROM projects WHERE id = ?',
      args: [id]
    });

    try {
      await db.execute({
        sql: 'DELETE FROM project_members WHERE project_id = ?',
        args: [id]
      });
    } catch (_) {}
    
    return res.status(200).json({ success: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};

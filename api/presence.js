const { getDb } = require('../lib/db');

const ACTIVE_WINDOW_MS = 35000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};

  const projectId = req.query.project_id || body.project_id;
  if (!projectId) {
    return res.status(400).json({ error: 'project_id required' });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const now = Date.now();
  const cutoff = now - ACTIVE_WINDOW_MS;

  if (req.method === 'POST') {
    const { user_id, session_id, name, color } = body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const sessionKey = `${user_id}:${session_id || 'main'}`;
    const displayName = (name || 'Invitado').toString().slice(0, 40);
    const displayColor = (color || '#6366f1').toString().slice(0, 20);

    try {
      await db.execute({
        sql: `
          INSERT INTO presence (project_id, session_key, user_id, name, color, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, session_key)
          DO UPDATE SET
            last_seen = excluded.last_seen,
            name = excluded.name,
            color = excluded.color
        `,
        args: [projectId, sessionKey, user_id, displayName, displayColor, now]
      });

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[Presence POST] error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'GET') {
    try {
      // Limpiar entradas viejas periódicamente
      db.execute({
        sql: 'DELETE FROM presence WHERE last_seen < ?',
        args: [now - 60000]
      }).catch(() => {});

      const { rows } = await db.execute({
        sql: 'SELECT session_key, user_id, name, color, last_seen FROM presence WHERE project_id = ? AND last_seen >= ? ORDER BY last_seen DESC',
        args: [projectId, cutoff]
      });

      const users = (rows || []).map(r => ({
        user_id: r.user_id,
        key: r.session_key,
        name: r.name,
        color: r.color || '#6366f1',
        seconds_since_seen: Math.max(0, Math.round((now - r.last_seen) / 1000))
      }));

      return res.status(200).json({ active: users.length, users });
    } catch (e) {
      console.error('[Presence GET] error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};

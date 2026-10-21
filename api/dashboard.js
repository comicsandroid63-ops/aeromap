const { getDb } = require('../lib/db');
const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let db;
  try {
    db = getDb();
  } catch (e) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  // Admin auth verification
  const authHeader = req.headers['authorization'] || '';
  const token = (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '') || req.query?.token || '';
  if (!token) {
    return res.status(401).json({ error: 'Acceso no autorizado. Inicie sesión con una cuenta de administrador.' });
  }

  let isAdmin = false;
  try {
    const userRes = await db.execute({
      sql: 'SELECT id, email, token_expiry FROM users WHERE token = ?',
      args: [token]
    });
    if (userRes.rows && userRes.rows.length > 0) {
      const u = userRes.rows[0];
      const email = (u.email || '').toLowerCase().trim();
      if (email === 'admin@aeromap.com' || email === 'comicsandroid63@gmail.com' || (process.env.ADMIN_EMAIL && email === process.env.ADMIN_EMAIL.toLowerCase().trim())) {
        isAdmin = true;
      }
    }
  } catch (e) {
    console.warn('[Dashboard] Auth check error:', e.message);
  }

  if (!isAdmin) {
    return res.status(403).json({ error: 'Acceso restringido: Se requiere cuenta con permisos de Administrador.' });
  }

  try {
    // 1) Total users
    let totalUsers = 0;
    try {
      const { rows } = await db.execute('SELECT COUNT(*) as count FROM users');
      totalUsers = rows[0]?.count || 0;
    } catch (e) {
      console.warn('[Dashboard] Error counting users:', e.message);
    }

    // 2) Total projects
    let totalProjects = 0;
    try {
      const { rows } = await db.execute('SELECT COUNT(*) as count FROM projects');
      totalProjects = rows[0]?.count || 0;
    } catch (e) {
      console.warn('[Dashboard] Error counting projects:', e.message);
    }

    // 3) Total layers
    let totalLayers = 0;
    try {
      const { rows } = await db.execute('SELECT COUNT(*) as count FROM layers');
      totalLayers = rows[0]?.count || 0;
    } catch (e) {
      console.warn('[Dashboard] Error counting layers:', e.message);
    }

    // 4) Files in compressed/
    let totalFiles = 0;
    let storageSizeBytes = 0;
    try {
      const compressedDir = path.join(__dirname, '..', 'public', 'compressed');
      if (fs.existsSync(compressedDir)) {
        const files = fs.readdirSync(compressedDir).filter(f => /\.(tiff?|img|jpg|png)$/i.test(f));
        totalFiles = files.length;
        for (const f of files) {
          try { storageSizeBytes += fs.statSync(path.join(compressedDir, f)).size; } catch (_) {}
        }
      }
    } catch (e) {
      console.warn('[Dashboard] Error counting files:', e.message);
    }

    // 5) Active users (users with projects)
    let activeUsers = 0;
    try {
      const { rows } = await db.execute('SELECT COUNT(DISTINCT user_id) as count FROM projects');
      activeUsers = rows[0]?.count || 0;
    } catch (e) {
      console.warn('[Dashboard] Error counting active users:', e.message);
    }

    // 6) Recent projects (last 7 days)
    let recentProjects = 0;
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { rows } = await db.execute({ sql: 'SELECT COUNT(*) as count FROM projects WHERE updated_at >= ?', args: [sevenDaysAgo] });
      recentProjects = rows[0]?.count || 0;
    } catch (e) {
      console.warn('[Dashboard] Error counting recent projects:', e.message);
    }

    // 7) New users this week (last 7 days)
    let newUsersThisWeek = 0;
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { rows } = await db.execute({ sql: 'SELECT COUNT(*) as count FROM users WHERE created_at >= ?', args: [sevenDaysAgo] });
      newUsersThisWeek = rows[0]?.count || 0;
    } catch (e) {
      console.warn('[Dashboard] Error counting new users:', e.message);
    }

    // 8) All user accounts with activity & metrics
    let usersList = [];
    try {
      const { rows } = await db.execute(`
        SELECT 
          u.id, 
          u.email, 
          u.name, 
          u.created_at,
          u.token_expiry,
          CASE 
            WHEN u.token IS NOT NULL AND (u.token_expiry IS NULL OR u.token_expiry >= datetime('now')) THEN 1 
            ELSE 0 
          END as is_active_session,
          (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) as projects_count,
          (SELECT COUNT(*) FROM layers l WHERE l.user_id = u.id) as layers_count
        FROM users u
        ORDER BY u.created_at DESC
      `);
      usersList = (rows || []).map(r => ({
        id: r.id,
        email: r.email,
        name: r.name || '',
        createdAt: r.created_at,
        isOnline: Boolean(r.is_active_session),
        projectsCount: Number(r.projects_count) || 0,
        layersCount: Number(r.layers_count) || 0,
      }));
    } catch (e) {
      console.warn('[Dashboard] Complex users query failed, trying simple query:', e.message);
      try {
        const { rows } = await db.execute('SELECT id, email, name, created_at FROM users ORDER BY created_at DESC');
        usersList = (rows || []).map(r => ({
          id: r.id,
          email: r.email,
          name: r.name || '',
          createdAt: r.created_at,
          isOnline: false,
          projectsCount: 0,
          layersCount: 0,
        }));
      } catch (e2) {
        console.warn('[Dashboard] Error querying users accounts:', e2.message);
      }
    }

    if (totalUsers === 0 && usersList.length > 0) {
      totalUsers = usersList.length;
    }

    // 9) Top users by layers
    let topUsers = [];
    try {
      const { rows } = await db.execute('SELECT user_id, COUNT(*) as layers, MAX(created_at) as lastActive FROM layers GROUP BY user_id ORDER BY layers DESC LIMIT 5');
      topUsers = rows.map(r => {
        const matchUser = usersList.find(u => u.id === r.user_id);
        return {
          userId: r.user_id,
          userName: matchUser ? (matchUser.name || matchUser.email) : r.user_id,
          userEmail: matchUser ? matchUser.email : '',
          layers: r.layers,
          files: 0,
          lastActive: r.lastActive,
        };
      });
    } catch (e) {
      console.warn('[Dashboard] Error getting top users:', e.message);
    }

    res.json({
      totalUsers,
      activeUsers,
      newUsersThisWeek,
      totalProjects,
      totalLayers,
      totalFiles,
      storageSizeBytes,
      storageSizeMB: Math.round((storageSizeBytes / (1024 * 1024)) * 100) / 100,
      recentProjects,
      topUsers,
      users: usersList,
    });
  } catch (err) {
    console.error('[Dashboard] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

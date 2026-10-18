const { getDb } = require('../lib/db');
const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let db;
  try {
    db = getDb();
  } catch (e) {
    return res.status(503).json({ error: 'Database not configured' });
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

    // 7) Top users by layers
    let topUsers = [];
    try {
      const { rows } = await db.execute('SELECT user_id, COUNT(*) as layers, MAX(created_at) as lastActive FROM layers GROUP BY user_id ORDER BY layers DESC LIMIT 5');
      topUsers = rows.map(r => ({
        userId: r.user_id,
        layers: r.layers,
        files: 0,
        lastActive: r.lastActive,
      }));
    } catch (e) {
      console.warn('[Dashboard] Error getting top users:', e.message);
    }

    res.json({
      totalUsers,
      activeUsers,
      totalProjects,
      totalLayers,
      totalFiles,
      storageSizeBytes,
      storageSizeMB: Math.round((storageSizeBytes / (1024 * 1024)) * 100) / 100,
      recentProjects,
      topUsers,
    });
  } catch (err) {
    console.error('[Dashboard] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

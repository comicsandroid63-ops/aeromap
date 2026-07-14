const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
let supabase = null;
try {
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  }
} catch (e) {
  console.warn('[Dashboard] Supabase no configurado:', e.message);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Supabase no configurado' });

  try {
    // 1) Total de usuarios registrados (via Auth Admin API)
    let totalUsers = 0;
    try {
      const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers();
      if (!usersError && usersData) totalUsers = usersData.users?.length || 0;
    } catch (e) {
      console.warn('[Dashboard] Error listing users:', e.message);
    }

    // 2) Total de proyectos
    let totalProjects = 0;
    try {
      const { count, error } = await supabase.from('projects').select('*', { count: 'exact', head: true });
      if (!error) totalProjects = count || 0;
    } catch (e) {
      console.warn('[Dashboard] Error counting projects:', e.message);
    }

    // 3) Total de capas (layers)
    let totalLayers = 0;
    try {
      const { count, error } = await supabase.from('layers').select('*', { count: 'exact', head: true });
      if (!error) totalLayers = count || 0;
    } catch (e) {
      console.warn('[Dashboard] Error counting layers:', e.message);
    }

    // 4) Archivos en storage
    let totalFiles = 0;
    let storageSizeBytes = 0;
    try {
      const bucket = process.env.SUPABASE_BUCKET || 'shapefiles';
      const { data: files, error: filesError } = await supabase.storage.from(bucket).list('', { limit: 1000 });
      if (!filesError && files) {
        totalFiles = files.length;
        for (const f of files) {
          storageSizeBytes += f.metadata?.size || 0;
        }
      }
    } catch (e) {
      console.warn('[Dashboard] Error listing storage:', e.message);
    }

    // 5) Usuarios con proyectos (activos)
    let activeUsers = 0;
    try {
      const { data: projectUsers, error: puError } = await supabase
        .from('projects')
        .select('user_id');
      if (!puError && projectUsers) {
        const unique = new Set(projectUsers.map(p => p.user_id));
        activeUsers = unique.size;
      }
    } catch (e) {
      console.warn('[Dashboard] Error counting active users:', e.message);
    }

    // 6) Proyectos recientes (últimos 7 días)
    let recentProjects = 0;
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { count, error } = await supabase
        .from('projects')
        .select('*', { count: 'exact', head: true })
        .gte('updated_at', sevenDaysAgo);
      if (!error) recentProjects = count || 0;
    } catch (e) {
      console.warn('[Dashboard] Error counting recent projects:', e.message);
    }

    // 7) Storage por usuario (top 5)
    let topUsers = [];
    try {
      const { data: allLayers, error: layersError } = await supabase
        .from('layers')
        .select('user_id, storage_url, created_at');
      if (!layersError && allLayers) {
        const userMap = {};
        for (const l of allLayers) {
          if (!l.user_id) continue;
          if (!userMap[l.user_id]) userMap[l.user_id] = { layers: 0, files: 0, lastActive: l.created_at };
          userMap[l.user_id].layers++;
          if (l.storage_url) userMap[l.user_id].files++;
          if (l.created_at && (!userMap[l.user_id].lastActive || l.created_at > userMap[l.user_id].lastActive)) {
            userMap[l.user_id].lastActive = l.created_at;
          }
        }
        topUsers = Object.entries(userMap)
          .map(([userId, data]) => ({ userId, ...data }))
          .sort((a, b) => b.layers - a.layers)
          .slice(0, 5);
      }
    } catch (e) {
      console.warn('[Dashboard] Error getting user stats:', e.message);
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

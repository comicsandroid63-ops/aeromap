const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
let supabase = null;
let supabaseAdmin = null;
try {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  }
} catch (e) {
  console.warn('[Files] Supabase no configurado:', e.message);
}

module.exports = async (req, res) => {
  if (!supabase) {
    return res.status(200).json([]);
  }

  // Configurar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { user_id, project_id } = req.query;
  const storagePath = (user_id && project_id) ? `${user_id}/${project_id}` : '';

  if (req.method === 'DELETE' || (req.method === 'POST' && req.query.action === 'delete')) {
    let name, fileStoragePath;
    if (req.method === 'DELETE') {
      name = req.query.name;
      fileStoragePath = req.query.storagePath;
    } else {
      const body = req.body || {};
      name = body.name || req.query.name;
      fileStoragePath = body.storagePath || req.query.storagePath;
    }
    console.log('[Files] Delete request:', { name, fileStoragePath });
    if (!name) return res.status(400).json({ error: 'name is required' });
    const client = supabaseAdmin || supabase;
    const filePath = fileStoragePath || (storagePath ? `${storagePath}/${name}` : name);
    console.log(`[Files] Deleting path: "${filePath}" from bucket: "${process.env.SUPABASE_BUCKET || 'shapefiles'}"`);
    const { error, data } = await client.storage
      .from(process.env.SUPABASE_BUCKET || 'shapefiles')
      .remove([filePath]);
    console.log('[Files] Delete result:', { error, data });

    // También borrar la entrada de la tabla layers si existe
    if (!error && fileStoragePath) {
      const tableName = process.env.SUPABASE_LAYERS_TABLE || 'layers';
      const { error: layerError } = await supabase
        .from(tableName)
        .delete()
        .match({ storage_url: fileStoragePath });
      if (layerError) console.warn('[Files] Error deleting layer entry:', layerError.message);
    }

    if (error) {
      console.error('[Files] Delete error:', error);
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ success: true });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Obtener capas activas de la tabla layers
  const tableName = process.env.SUPABASE_LAYERS_TABLE || 'layers';
  let layerQuery = supabase.from(tableName).select('*');
  if (project_id) {
    layerQuery = layerQuery.eq('project_id', project_id);
  }
  if (user_id) layerQuery = layerQuery.eq('user_id', user_id);
  
  const { data: layersData, error: layersError } = await layerQuery.order('created_at', { ascending: false });

  if (layersError) {
    console.error('[Files] Error querying layers:', layersError);
    return res.status(500).json({ error: layersError.message });
  }

  console.log('[Files] Query params:', { user_id, project_id });
  console.log('[Files] Layers found:', layersData?.length || 0);
  console.log('[Files] Layers with storage_url:', layersData?.filter(l => l.storage_url).length || 0);

  // Filtrar solo capas con storage_url
  const layersWithStorage = (layersData || []).filter(l => l.storage_url);

  // Obtener archivos del bucket para verificar existencia
  const listPath = storagePath ? `${storagePath}/` : '';
  const { data: bucketFiles, error: bucketError } = await supabase.storage
    .from(process.env.SUPABASE_BUCKET || 'shapefiles')
    .list(listPath, { limit: 100 });

  if (bucketError) {
    console.warn('[Files] Bucket list error:', bucketError);
  }

  const bucketFileNames = new Set((bucketFiles || []).map(f => f.name));

  // Mapear capas a formato de archivos
  const filesWithStatus = layersWithStorage.map(layer => {
    const fileName = layer.storage_url.split('/').pop();
    const fileExists = bucketFileNames.has(fileName) || bucketFiles?.some(f => layer.storage_url.includes(f.name));
    
    return {
      name: fileName,
      url: layer.storage_url,
      storagePath: layer.storage_url,
      type: layer.type === 'vector' ? 'application/json' : 'image/tiff',
      isActive: true,
      exists: fileExists
    };
  });

  console.log('[Files] Returning files:', filesWithStatus.length);
  res.status(200).json(filesWithStatus);
};

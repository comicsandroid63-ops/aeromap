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
  console.warn('[Layers] Supabase no configurado:', e.message);
}

module.exports = async (req, res) => {
  if (!supabase) {
    return res.status(200).json([]);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const tableName = process.env.SUPABASE_LAYERS_TABLE || 'layers';

  if (req.method === 'GET') {
    const { project_id, user_id } = req.query;
    let query = supabase.from(tableName).select('*');
    if (project_id !== undefined) {
      if (project_id) {
        query = query.eq('project_id', project_id);
      } else {
        query = query.is('project_id', null);
      }
    }
    if (user_id) query = query.eq('user_id', user_id);
    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const layerData = req.body;
    const { data, error } = await supabase
      .from(tableName)
      .insert([layerData])
      .select();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data[0]);
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    const { error } = await supabase.from(tableName).update(req.body).match({ id });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    const { id, storage_url } = req.query;

    if (id) {
      const { error } = await supabase.from(tableName).delete().match({ id });
      if (error) return res.status(500).json({ error: error.message });
    } else if (storage_url) {
      const { error } = await supabase.from(tableName).delete().match({ storage_url });
      if (error) return res.status(500).json({ error: error.message });

      const bucket = process.env.SUPABASE_BUCKET || 'shapefiles';
      const fileName = storage_url.split('/').pop();
      if (fileName) {
        const client = supabaseAdmin || supabase;
        await client.storage.from(bucket).remove([fileName]).catch(e =>
          console.warn('[Layers] No se pudo eliminar archivo del storage:', e.message)
        );
      }
    }

    return res.status(200).json({ success: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};

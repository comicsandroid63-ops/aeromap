const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
let supabase = null;
try {
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  }
} catch (e) {
  console.warn('[Projects] Supabase no configurado:', e.message);
}

module.exports = async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase no configurado' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { user_id } = req.query;
    let query = supabase.from('projects').select('*').order('updated_at', { ascending: false });
    if (user_id) query = query.eq('user_id', user_id);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { user_id, name, description, config } = req.body;
    if (!user_id || !name) return res.status(400).json({ error: 'user_id and name required' });
    const { data, error } = await supabase.from('projects').insert([
      { user_id, name, description: description || '', config: config || {} }
    ]).select();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data[0]);
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    const { error } = await supabase.from('projects').delete().match({ id });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};

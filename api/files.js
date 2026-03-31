const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

module.exports = async (req, res) => {
  // Configurar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { data, error } = await supabase.storage
    .from(process.env.SUPABASE_BUCKET || 'shapefiles')
    .list('', {
      limit: 100,
      offset: 0,
      sortBy: { column: 'created_at', order: 'desc' },
    });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Obtener URLs públicas para cada archivo
  const filesWithUrls = data.map(file => {
    const { data: publicData } = supabase.storage
      .from(process.env.SUPABASE_BUCKET || 'shapefiles')
      .getPublicUrl(file.name);
    
    return {
      ...file,
      url: publicData.publicUrl
    };
  });

  res.status(200).json(filesWithUrls);
};

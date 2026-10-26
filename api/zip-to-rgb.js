// Endpoint de respaldo para Vercel Serverless
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Notificar que la composición con GDAL corre en local o via R2
  return res.status(200).json({
    status: 'notice',
    message: 'El procesamiento pesado de GDAL se realiza en local o mediante subida directa a Cloudflare R2. Las bandas se procesan directamente en el cliente.',
    cloudUrl: null
  });
};

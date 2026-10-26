const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '7f8bfe8955005f8f69112f9f4ade7b71';
const R2_BUCKET = process.env.R2_BUCKET || 'prueba';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || 'https://pub-db02e3ad3c454cad9ec72c9176035fa6.r2.dev').replace(/\/+$/, '');

function getS3Client() {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;

  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey
    }
  });
}

function safeKey(filename) {
  const base = String(filename || 'raster.tif')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'raster.tif';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const s3 = getS3Client();
  if (!s3) {
    return res.status(500).json({
      error: 'Credenciales de Cloudflare R2 no configuradas en el servidor (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).'
    });
  }

  const { action, filename, contentType } = req.query;

  // 1. Obtener URL prefirmada para subida directa desde el navegador (sin límite de tamaño ni timeout)
  if (action === 'presign' || req.method === 'GET') {
    try {
      const cleanName = safeKey(filename);
      const uniqueName = `${Date.now().toString(36)}_${cleanName}`;
      const type = contentType || 'image/tiff';

      const command = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: uniqueName,
        ContentType: type
      });

      const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
      const publicUrl = `${R2_PUBLIC_URL}/${uniqueName}`;

      return res.status(200).json({
        success: true,
        presignedUrl,
        publicUrl,
        key: uniqueName,
        bucket: R2_BUCKET
      });
    } catch (err) {
      console.error('[R2 Presign Error]:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Acción no soportada' });
};

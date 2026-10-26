// Emisión de tokens de subida directa desde el navegador: Cloudflare R2 y Vercel Blob
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Cloudflare R2 Config
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '7f8bfe8955005f8f69112f9f4ade7b71';
const R2_BUCKET = process.env.R2_BUCKET || 'prueba';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || 'https://pub-db02e3ad3c454cad9ec72c9176035fa6.r2.dev').replace(/\/+$/, '');

function getS3Client() {
  const accessKeyId = '5f90de3800b130b184aea0c525abea2c';
  const secretAccessKey = 'a8340e4256fe9b935f3dfe3f645250ce39310f0fbf479b2a0273cddefa882074';
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

// Vercel Blob Config
const MAX_CLOUD_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES = [
  'image/tiff', 'image/png', 'image/jpeg', 'image/webp',
  'application/octet-stream', 'application/zip', 'application/gzip',
  'application/x-gzip', 'application/json', 'application/geo+json',
  'text/csv', 'application/pdf'
];

function getToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || '';
}

function signPayload(payload, token) {
  return crypto.createHmac('sha256', token).update(payload).digest('hex');
}

function generateClientToken(payload, token) {
  const storeId = token.split('_')[3];
  if (!storeId) throw new Error('BLOB_READ_WRITE_TOKEN inválido');
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = signPayload(encoded, token);
  return `vercel_blob_client_${storeId}_${Buffer.from(`${signature}.${encoded}`).toString('base64')}`;
}

function safePath(pathname) {
  const p = String(pathname || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.includes('..')) return null;
  return p.slice(0, 240);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-vercel-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // 1. Cloudflare R2 Presigned Upload (Sin límite de tamaño ni timeouts)
  const isR2 = req.query.service === 'r2' || req.query.action === 'presign' || req.method === 'GET';
  if (isR2) {
    const s3 = getS3Client();
    if (!s3) {
      return res.status(500).json({ error: 'Credenciales de Cloudflare R2 no configuradas' });
    }
    try {
      const cleanName = safeKey(req.query.filename);
      const uniqueName = (req.query.exact === 'true' || req.query.exact === '1')
        ? cleanName
        : `${Date.now().toString(36)}_${cleanName}`;
      const type = req.query.contentType || 'image/tiff';

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

  // 2. Vercel Blob Fallback
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = getToken();
  if (!token) return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN no configurado' });

  let body = req.body;
  if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString('utf8')); } catch (_) { body = null; }
  } else if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'JSON inválido' });
  }

  try {
    if (body.type === 'blob.generate-client-token') {
      const payload = body.payload || {};
      const pathname = safePath(payload.pathname);
      if (!pathname) return res.status(400).json({ error: 'pathname inválido' });

      const clientToken = generateClientToken({
        allowedContentTypes: ALLOWED_TYPES,
        maximumSizeInBytes: MAX_CLOUD_BYTES,
        addRandomSuffix: false,
        allowOverwrite: true,
        pathname,
        onUploadCompleted: {
          callbackUrl: payload.callbackUrl || null,
          tokenPayload: payload.clientPayload || null
        },
        validUntil: Date.now() + 60 * 60 * 1000
      }, token);

      return res.status(200).json({ type: body.type, clientToken });
    }

    if (body.type === 'blob.upload-completed') {
      return res.status(200).json({ response: 'ok' });
    }

    return res.status(400).json({ error: 'Evento no soportado' });
  } catch (err) {
    console.error('[blob-upload] error:', err.message);
    return res.status(400).json({ error: err.message });
  }
};

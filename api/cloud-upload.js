// Vercel Blob: emisión de tokens de subida directa desde el navegador.
// Implementado sin importar @vercel/blob para evitar problemas de bundling en Vercel.
const crypto = require('crypto');

const MAX_CLOUD_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES = [
  'image/tiff',
  'application/octet-stream',
  'application/zip',
  'application/json'
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-vercel-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();
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
      const signature = req.headers['x-vercel-signature'] || '';
      const expected = signPayload(JSON.stringify(body), token);
      const sigBuf = Buffer.from(String(signature));
      const expBuf = Buffer.from(expected);
      const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
      if (!valid) return res.status(400).json({ error: 'Firma inválida' });
      return res.status(200).json({ response: 'ok' });
    }

    return res.status(400).json({ error: 'Evento no soportado' });
  } catch (err) {
    console.error('[blob-upload] error:', err.message);
    return res.status(400).json({ error: err.message });
  }
};

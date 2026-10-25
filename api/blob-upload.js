const { handleUpload } = require('@vercel/blob/client');

const MAX_CLOUD_BYTES = 20 * 1024 * 1024;

function safeSegment(v, fallback) {
  const s = String(v || '').replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 120);
  return s || fallback;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-vercel-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let meta = {};
        try { meta = clientPayload ? JSON.parse(clientPayload) : {}; } catch (_) {}
        const userId = safeSegment(meta.userId, 'guest');
        const projectId = safeSegment(meta.projectId, 'general');
        const filename = safeSegment(pathname, 'raster.ztif');
        const prefix = meta.prefix ? safeSegment(meta.prefix, 'raster') : 'raster';

        return {
          allowedContentTypes: [
            'image/tiff',
            'application/octet-stream',
            'application/zip',
            'application/json'
          ],
          maximumSizeInBytes: MAX_CLOUD_BYTES,
          addRandomSuffix: false,
          allowOverwrite: true,
          tokenPayload: JSON.stringify({
            userId,
            projectId,
            pathname: `${userId}/${projectId}/${prefix}/${filename}`
          })
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.log('[blob-upload] completed:', blob.url);
      }
    });

    return res.status(200).json(jsonResponse);
  } catch (err) {
    console.error('[blob-upload] error:', err.message);
    return res.status(400).json({ error: err.message });
  }
};

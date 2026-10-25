// Diagnóstico temporal: comprueba escritura/lectura real en Vercel Blob.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { put, del } = require('@vercel/blob');
    const blob = await put(`__diag__/hello-${Date.now()}.txt`, Buffer.from('hola-vercel-blob'), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'text/plain'
    });
    const r = await fetch(blob.url, { headers: { Range: 'bytes=0-3', Origin: 'https://aeromap-zeta.vercel.app' } });
    const headers = {};
    for (const [k, v] of r.headers) {
      if (/access-control|accept-ranges|content-range|content-type/.test(k)) headers[k] = v;
    }
    const body = await r.text();
    await del(blob.url);
    return res.status(200).json({ ok: true, url: blob.url, status: r.status, body, headers, deleted: true });
  } catch (e) {
    return res.status(500).json({ ok: false, name: e.name, error: e.message });
  }
};

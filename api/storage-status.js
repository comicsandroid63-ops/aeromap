// Diagnóstico temporal de almacenamiento en la nube.
// No expone secretos: solo indica si las variables existen y si escritura/lectura funcionan.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const out = {
    vercel: !!process.env.VERCEL,
    region: process.env.VERCEL_REGION || null,
    turso: {
      url: !!process.env.TURSO_URL,
      token: !!process.env.TURSO_AUTH_TOKEN,
      ok: false,
      error: null
    },
    r2: {
      account: !!process.env.R2_ACCOUNT_ID,
      key: !!process.env.R2_ACCESS_KEY_ID,
      secret: !!process.env.R2_SECRET_ACCESS_KEY,
      bucket: process.env.R2_BUCKET || null,
      publicUrl: process.env.R2_PUBLIC_URL || null,
      writeOk: false,
      readOk: false,
      deleteOk: false,
      error: null
    },
    blobToken: !!process.env.BLOB_READ_WRITE_TOKEN
  };

  try {
    const { getDb } = require('../lib/db');
    const db = getDb();
    await db.execute('SELECT 1');
    out.turso.ok = true;
  } catch (e) {
    out.turso.error = (e && e.message) || String(e);
  }

  if (out.r2.account && out.r2.key && out.r2.secret) {
    try {
      const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
      const client = new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
        }
      });
      const Bucket = process.env.R2_BUCKET || 'prueba';
      const Key = `__diag__/status-${Date.now()}.txt`;
      await client.send(new PutObjectCommand({ Bucket, Key, Body: Buffer.from('ok'), ContentType: 'text/plain' }));
      out.r2.writeOk = true;
      const got = await client.send(new GetObjectCommand({ Bucket, Key }));
      out.r2.readOk = !!got.Body;
      await client.send(new DeleteObjectCommand({ Bucket, Key }));
      out.r2.deleteOk = true;
    } catch (e) {
      out.r2.error = `${e.name || 'Error'}: ${e.message || e}`;
    }
  }

  res.status(200).json(out);
};

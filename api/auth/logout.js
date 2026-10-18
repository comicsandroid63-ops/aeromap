const { createClient } = require('@libsql/client');

function getDb() {
  if (!process.env.TURSO_URL) throw new Error('TURSO_URL not configured');
  return createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token } = req.body || {};
    if (token) {
      const db = getDb();
      await db.execute({
        sql: 'UPDATE users SET token = NULL WHERE token = ?',
        args: [token],
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
};

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
    if (!token) return res.status(400).json({ error: 'Token requerido' });

    const db = getDb();
    const result = await db.execute({
      sql: 'SELECT id, email, name, token_expiry FROM users WHERE token = ?',
      args: [token],
    });

    if (result.rows.length === 0) return res.status(401).json({ error: 'Token inválido' });

    const user = result.rows[0];
    if (new Date(user.token_expiry) < new Date()) {
      return res.status(401).json({ error: 'Token expirado' });
    }

    res.json({ id: user.id, email: user.email, name: user.name });
  } catch (e) {
    console.error('[Auth/Verify]', e);
    res.status(500).json({ error: 'Error del servidor' });
  }
};

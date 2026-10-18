const crypto = require('crypto');
const { createClient } = require('@libsql/client');

function getDb() {
  if (!process.env.TURSO_URL) throw new Error('TURSO_URL not configured');
  return createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === derived;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

    const db = getDb();
    const result = await db.execute({
      sql: 'SELECT id, email, password_hash, name FROM users WHERE email = ?',
      args: [email],
    });

    if (result.rows.length === 0) return res.status(401).json({ error: 'Credenciales inválidas' });

    const user = result.rows[0];
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = generateToken();
    const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.execute({
      sql: 'UPDATE users SET token = ?, token_expiry = ? WHERE id = ?',
      args: [token, tokenExpiry, user.id],
    });

    res.json({ id: user.id, email: user.email, name: user.name, token });
  } catch (e) {
    console.error('[Auth/Login]', e);
    res.status(500).json({ error: 'Error del servidor' });
  }
};

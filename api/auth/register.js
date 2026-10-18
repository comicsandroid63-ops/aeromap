const crypto = require('crypto');
const { createClient } = require('@libsql/client');

function getDb() {
  if (!process.env.TURSO_URL) throw new Error('TURSO_URL not configured');
  return createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
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
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    const db = getDb();
    const existing = await db.execute({
      sql: 'SELECT id FROM users WHERE email = ?',
      args: [email],
    });
    if (existing.rows.length > 0) return res.status(409).json({ error: 'El email ya está registrado' });

    const id = crypto.randomUUID();
    const passwordHash = hashPassword(password);
    const token = generateToken();
    const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await db.execute({
      sql: 'INSERT INTO users (id, email, password_hash, name, token, token_expiry) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, email, passwordHash, name || email.split('@')[0], token, tokenExpiry],
    });

    res.json({ id, email, name: name || email.split('@')[0], token });
  } catch (e) {
    console.error('[Auth/Register]', e);
    res.status(500).json({ error: 'Error del servidor' });
  }
};

const crypto = require('crypto');
const { getDb } = require('../lib/db');

// In-memory brute force protection
const failedAttempts = new Map(); // key -> { count, lockUntil }
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '127.0.0.1';
}

function checkRateLimit(key) {
  const record = failedAttempts.get(key);
  if (!record) return { allowed: true };
  if (record.lockUntil && Date.now() < record.lockUntil) {
    const remainingSec = Math.ceil((record.lockUntil - Date.now()) / 1000);
    return { allowed: false, remainingSec };
  }
  if (record.lockUntil && Date.now() >= record.lockUntil) {
    failedAttempts.delete(key);
    return { allowed: true };
  }
  return { allowed: true };
}

function recordFailedAttempt(key) {
  const record = failedAttempts.get(key) || { count: 0, lockUntil: 0 };
  record.count += 1;
  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
  failedAttempts.set(key, record);
}

function clearFailedAttempts(key) {
  failedAttempts.delete(key);
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 128 && EMAIL_REGEX.test(email);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  try {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(derived, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Parse body if received as raw string or buffer
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = {};
    }
  } else if (!body && req.method === 'POST') {
    // If body not parsed yet by middleware
    try {
      const buffers = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const raw = Buffer.concat(buffers).toString('utf8');
      body = raw ? JSON.parse(raw) : {};
    } catch (_) {
      body = {};
    }
  }
  body = body || {};

  // Extract action: from query param or from path segment
  // E.g. /api/auth?action=login OR /api/auth/login OR /login
  let action = req.query?.action;
  if (!action) {
    const rawUrl = req.url || '';
    const cleanUrl = rawUrl.split('?')[0].replace(/\/+$/, '');
    const parts = cleanUrl.split('/').filter(Boolean);
    action = parts[parts.length - 1] || '';
  }

  try {
    const db = getDb();

    if (action === 'register') {
      const { email, password, name } = body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email y contraseña requeridos' });
      }
      const cleanEmail = String(email).trim().toLowerCase();
      if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ error: 'Formato de correo electrónico inválido' });
      }
      if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
        return res.status(400).json({ error: 'La contraseña debe tener entre 6 y 128 caracteres' });
      }
      const safeName = String(name || '').replace(/[<>]/g, '').trim().slice(0, 80);

      const existing = await db.execute({
        sql: 'SELECT id FROM users WHERE lower(email) = ?',
        args: [cleanEmail]
      });
      if (existing.rows && existing.rows.length > 0) {
        return res.status(409).json({ error: 'El email ya está registrado' });
      }

      const id = crypto.randomUUID();
      const passwordHash = hashPassword(password);
      const token = generateToken();
      const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await db.execute({
        sql: 'INSERT INTO users (id, email, password_hash, name, token, token_expiry) VALUES (?, ?, ?, ?, ?, ?)',
        args: [id, cleanEmail, passwordHash, safeName || cleanEmail.split('@')[0], token, tokenExpiry]
      });

      return res.json({ id, email: cleanEmail, name: safeName || cleanEmail.split('@')[0], role: 'user', isAdmin: false, token });
    }

    if (action === 'login') {
      const { email, password } = body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email y contraseña requeridos' });
      }

      const cleanEmail = String(email).trim().toLowerCase();
      if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ error: 'Formato de correo electrónico inválido' });
      }
      if (typeof password !== 'string' || password.length > 128) {
        return res.status(400).json({ error: 'Credenciales inválidas' });
      }

      const clientIp = getClientIp(req);
      const rateLimitKey = `${clientIp}_${cleanEmail}`;
      const limitStatus = checkRateLimit(rateLimitKey);
      if (!limitStatus.allowed) {
        return res.status(429).json({
          error: `Demasiados intentos fallidos. Por seguridad, intente de nuevo en ${Math.ceil(limitStatus.remainingSec / 60)} minutos.`
        });
      }

      let result = await db.execute({
        sql: 'SELECT id, email, password_hash, name FROM users WHERE lower(email) = ?',
        args: [cleanEmail]
      });

      // Auto-crear cuenta admin@aeromap.com si no existe aún en la base de datos
      if ((!result.rows || result.rows.length === 0) && cleanEmail === 'admin@aeromap.com') {
        const id = crypto.randomUUID();
        const passwordHash = hashPassword('admin123456');
        try {
          await db.execute({
            sql: 'INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)',
            args: [id, 'admin@aeromap.com', passwordHash, 'Administrador']
          });
          result = await db.execute({
            sql: 'SELECT id, email, password_hash, name FROM users WHERE lower(email) = ?',
            args: ['admin@aeromap.com']
          });
        } catch (e) {
          console.warn('[Auth] Error auto-seeding admin:', e.message);
        }
      }

      if (!result.rows || result.rows.length === 0) {
        recordFailedAttempt(rateLimitKey);
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }

      const user = result.rows[0];
      if (!verifyPassword(password, user.password_hash)) {
        recordFailedAttempt(rateLimitKey);
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }

      // Login exitoso: limpiar intentos fallidos
      clearFailedAttempts(rateLimitKey);

      const token = generateToken();
      const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await db.execute({
        sql: 'UPDATE users SET token = ?, token_expiry = ? WHERE id = ?',
        args: [token, tokenExpiry, user.id]
      });

      const userEmail = (user.email || '').toLowerCase().trim();
      const isAdmin = userEmail === 'admin@aeromap.com' || userEmail === 'comicsandroid63@gmail.com' || (process.env.ADMIN_EMAIL && userEmail === process.env.ADMIN_EMAIL.toLowerCase().trim());
      const role = isAdmin ? 'admin' : 'user';
      return res.json({ id: user.id, email: user.email, name: user.name, role, isAdmin, token });
    }

    if (action === 'verify') {
      const { token } = body;
      if (!token) {
        return res.status(400).json({ error: 'Token requerido' });
      }

      const result = await db.execute({
        sql: 'SELECT id, email, name, token_expiry FROM users WHERE token = ?',
        args: [token]
      });
      if (!result.rows || result.rows.length === 0) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const user = result.rows[0];
      if (new Date(user.token_expiry) < new Date()) {
        return res.status(401).json({ error: 'Token expirado' });
      }

      const userEmail = (user.email || '').toLowerCase().trim();
      const isAdmin = userEmail === 'admin@aeromap.com' || userEmail === 'comicsandroid63@gmail.com' || (process.env.ADMIN_EMAIL && userEmail === process.env.ADMIN_EMAIL.toLowerCase().trim());
      const role = isAdmin ? 'admin' : 'user';
      return res.json({ id: user.id, email: user.email, name: user.name, role, isAdmin });
    }

    if (action === 'logout') {
      const { token } = body;
      if (token) {
        await db.execute({
          sql: 'UPDATE users SET token = NULL WHERE token = ?',
          args: [token]
        });
      }
      return res.json({ ok: true });
    }

    return res.status(404).json({ error: `Ruta de autenticación no encontrada: ${action}` });
  } catch (err) {
    console.error(`[Auth] Error in ${action}:`, err);
    return res.status(500).json({ error: 'Error del servidor: ' + (err.message || 'desconocido') });
  }
};

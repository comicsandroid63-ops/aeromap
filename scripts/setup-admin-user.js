const path = require('path');
const fs = require('fs');
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}
const crypto = require('crypto');
const { getDb } = require('../lib/db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

(async () => {
  try {
    const db = getDb();
    try {
      await db.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
      console.log('Role column created or already exists');
    } catch(e) {
      console.log('Role column note:', e.message);
    }

    await db.execute("UPDATE users SET role = 'admin' WHERE email = 'comicsandroid63@gmail.com'");

    const check = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: ['admin@aeromap.com'] });
    if (!check.rows || check.rows.length === 0) {
      const id = crypto.randomUUID();
      const pwHash = hashPassword('admin123456');
      await db.execute({
        sql: "INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'admin')",
        args: [id, 'admin@aeromap.com', pwHash, 'Administrador']
      });
      console.log('Created admin@aeromap.com with password: admin123456');
    } else {
      const pwHash = hashPassword('admin123456');
      await db.execute({
        sql: "UPDATE users SET role = 'admin', password_hash = ? WHERE email = ?",
        args: [pwHash, 'admin@aeromap.com']
      });
      console.log('admin@aeromap.com updated to role admin with password: admin123456');
    }

    const { rows } = await db.execute('SELECT id, email, name, role FROM users');
    console.log('Current users:', rows);
  } catch (err) {
    console.error('Admin setup error:', err);
  }
})();

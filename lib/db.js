const { createClient } = require('@libsql/client');

let db = null;

function getDb() {
  if (!db) {
    const url = process.env.TURSO_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      throw new Error('TURSO_URL not configured');
    }
    db = createClient({
      url,
      authToken: authToken || undefined,
    });
  }
  return db;
}

async function initDatabase() {
  const client = getDb();
  
  await client.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      config TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT DEFAULT '',
      role TEXT DEFAULT 'user',
      token TEXT,
      token_expiry TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS layers (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT DEFAULT '00000000-0000-0000-0000-000000000000',
      project_id TEXT,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'raster',
      storage_url TEXT,
      metadata TEXT DEFAULT '{}',
      visible INTEGER DEFAULT 1,
      opacity REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  console.log('[DB] Tables initialized');
}

module.exports = { getDb, initDatabase };

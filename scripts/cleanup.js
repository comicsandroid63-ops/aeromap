const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(PUBLIC, 'uploads');
const COMPRESS_DIR = path.join(PUBLIC, 'compressed');
const DZI_DIR = path.join(PUBLIC, 'dzi');
const TILE_CACHE_DIR = path.join(PUBLIC, 'tiles');
const WEBP_CACHE_DIR = path.join(PUBLIC, 'webp-cache');

function sizeStr(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function log(...args) {
  console.log(`[Cleanup]`, ...args);
}

function rmdir(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += rmdir(full);
      } else {
        fs.unlinkSync(full);
        count++;
      }
    }
    fs.rmdirSync(dir);
    log(`Eliminado directorio: ${dir}`);
  } catch (e) {
    log(`Error eliminando ${dir}: ${e.message}`);
  }
  return count;
}

function clearDirectory(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += rmdir(full);
      } else {
        fs.unlinkSync(full);
        count++;
      }
    }
    log(`Vaciado directorio: ${dir} (${count} archivos)`);
  } catch (e) {
    log(`Error vaciando ${dir}: ${e.message}`);
  }
  return count;
}

function groupByName(files) {
  const groups = new Map();
  for (const f of files) {
    const base = f.name.replace(/^\d+-/, '').replace(/^\d+-/, '').replace(/_\d+_thumb/, '_thumb');
    const key = base.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return groups;
}

function deduplicate(dir) {
  if (!fs.existsSync(dir)) return { removed: 0, saved: 0 };
  let removed = 0;
  let savedBytes = 0;

  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && !e.name.endsWith('.aux.xml'))
    .map(e => {
      const full = path.join(dir, e.name);
      const stat = fs.statSync(full);
      return { name: e.name, full, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const groups = groupByName(files);

  for (const [key, group] of groups) {
    if (group.length <= 1) continue;
    const [keep, ...remove] = group;
    for (const f of remove) {
      const auxXml = f.full + '.aux.xml';
      try {
        fs.unlinkSync(f.full);
        removed++;
        savedBytes += f.size;
      } catch (e) {
        log(`Error eliminando ${f.full}: ${e.message}`);
      }
      try { if (fs.existsSync(auxXml)) { fs.unlinkSync(auxXml); removed++; } } catch (e) {}
    }
    log(`  ${keep.name} → conservado (${sizeStr(keep.size)}), ${remove.length} duplicados eliminados`);
  }

  // Remove orphan .aux.xml files (no matching parent file)
  const allFiles = new Set(fs.readdirSync(dir).filter(f => !f.endsWith('.aux.xml')));
  const auxFiles = fs.readdirSync(dir).filter(f => f.endsWith('.aux.xml'));
  for (const aux of auxFiles) {
    const parent = aux.replace(/\.aux\.xml$/, '');
    if (!allFiles.has(parent)) {
      try { fs.unlinkSync(path.join(dir, aux)); removed++; } catch (e) {}
    }
  }

  return { removed, saved: savedBytes };
}

async function cleanup(args = {}) {
  const dryRun = args.dryRun || false;
  log(`=== LIMPIEZA DE CACHÉ DE TESELAS ${dryRun ? '(SOLO DIAGNÓSTICO)' : ''} ===`);
  let totalRemoved = 0;
  let totalSaved = 0;
  const start = Date.now();

  // 1. webp-cache (sistema legacy, no usado por el código actual)
  if (fs.existsSync(WEBP_CACHE_DIR)) {
    log(`\n--- webp-cache/ (caché legacy, ${fs.readdirSync(WEBP_CACHE_DIR).length} archivos) ---`);
    if (!dryRun) {
      const n = clearDirectory(WEBP_CACHE_DIR);
      totalRemoved += n;
    }
  }

  // 2. tiles/ (caché regenerable del tile server GDAL)
  if (fs.existsSync(TILE_CACHE_DIR)) {
    const entries = fs.readdirSync(TILE_CACHE_DIR, { withFileTypes: true });
    log(`\n--- tiles/ (caché GDAL, ${entries.length} entradas) ---`);
    if (!dryRun) {
      for (const entry of entries) {
        if (entry.isDirectory()) {
          totalRemoved += rmdir(path.join(TILE_CACHE_DIR, entry.name));
        } else {
          try { fs.unlinkSync(path.join(TILE_CACHE_DIR, entry.name)); totalRemoved++; } catch (e) {}
        }
      }
    }
  }

  // 3. dzi/levels/ y dzi/tiles/ (caché regenerable de DZI)
  for (const sub of ['levels', 'tiles']) {
    const dir = path.join(DZI_DIR, sub);
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const valid = entries.filter(e => e.isDirectory());
      log(`\n--- dzi/${sub}/ (${valid.length} sets de teselas) ---`);
      if (!dryRun) {
        for (const entry of valid) {
          totalRemoved += rmdir(path.join(dir, entry.name));
        }
      }
    }
  }

  // 4. compressed/ (deduplicar)
  log(`\n--- compressed/ (deduplicación) ---`);
  if (!dryRun) {
    const result = deduplicate(COMPRESS_DIR);
    totalRemoved += result.removed;
    if (dryRun) totalSaved += result.saved;
  }

  // 5. uploads/ (deduplicar)
  log(`\n--- uploads/ (deduplicación) ---`);
  if (!dryRun) {
    const result = deduplicate(UPLOAD_DIR);
    totalRemoved += result.removed;
    if (dryRun) totalSaved += result.saved;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`\n=== COMPLETADO en ${elapsed}s: ${totalRemoved} archivos eliminados${totalSaved ? `, ${sizeStr(totalSaved)} liberados` : ''} ===`);
  
  return { removed: totalRemoved, saved: totalSaved, time: elapsed };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  cleanup({ dryRun }).catch(e => log('Error:', e.message));
}

module.exports = { cleanup, deduplicate, clearDirectory, rmdir };

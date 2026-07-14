const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const BUCKET = process.env.SUPABASE_BUCKET || 'shapefiles';
const TABLE = process.env.SUPABASE_LAYERS_TABLE || 'layers';

async function listAllFiles(path = '', allFiles = []) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(path, { limit: 100 });

  if (error) {
    console.error(`Error listing ${path}:`, error);
    return allFiles;
  }

  for (const item of data) {
    const fullPath = path ? `${path}/${item.name}` : item.name;
    if (item.metadata?.size !== undefined) {
      allFiles.push({ ...item, fullPath });
    } else {
      await listAllFiles(fullPath, allFiles);
    }
  }

  return allFiles;
}

function normalizeName(name) {
  return name.toLowerCase()
    .replace(/\.(gz|json|geojson|shp|zip)$/i, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_');
}

async function syncCloudWithActiveLayers() {
  console.log('=== Sincronizando bucket con capas activas ===\n');

  // 1. Obtener capas activas de la tabla layers
  const { data: layers, error: layersError } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false });

  if (layersError) {
    console.error('Error al obtener capas:', layersError);
    return;
  }

  console.log(`Capas en BD: ${layers.length}`);

  // 2. Obtener todos los archivos del bucket
  const files = await listAllFiles();
  console.log(`Archivos en bucket: ${files.length}`);

  // 3. Para cada capa activa, buscar archivo correspondiente en el bucket
  console.log('\nBuscando archivos correspondientes...');
  const updates = [];

  for (const layer of layers) {
    if (!layer.storage_url) {
      console.log(`   ${layer.name}: sin storage_url`);
      continue;
    }

    const layerNameNormalized = normalizeName(layer.name);
    const currentFileName = layer.storage_url.split('/').pop();
    const currentFileNameNormalized = normalizeName(currentFileName);

    // Buscar archivo en bucket que coincida con el nombre de la capa
    const matchingFile = files.find(f => {
      const fileName = f.fullPath.split('/').pop();
      const fileNameNormalized = normalizeName(fileName);
      return fileNameNormalized === layerNameNormalized;
    });

    if (matchingFile) {
      const { data: publicData } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(matchingFile.fullPath);

      if (publicData.publicUrl !== layer.storage_url) {
        console.log(`  ✓ ${layer.name}: actualizando storage_url`);
        console.log(`    De: ${layer.storage_url}`);
        console.log(`    A:  ${publicData.publicUrl}`);
        updates.push({ id: layer.id, storage_url: publicData.publicUrl });
      } else {
        console.log(`  ✓ ${layer.name}: storage_url correcto`);
      }
    } else {
      console.log(`  ⚠ ${layer.name}: no se encontró archivo en bucket`);
      console.log(`    Buscando: ${layerNameNormalized}`);
      console.log(`    Archivos disponibles: ${files.map(f => normalizeName(f.fullPath.split('/').pop())).join(', ')}`);
    }
  }

  // 4. Actualizar storage_url en la BD
  if (updates.length > 0) {
    console.log(`\nActualizando ${updates.length} capas...`);
    for (const update of updates) {
      const { error } = await supabase
        .from(TABLE)
        .update({ storage_url: update.storage_url })
        .eq('id', update.id);

      if (error) {
        console.error(`  Error actualizando ${update.id}:`, error);
      } else {
        console.log(`  ✓ Actualizado ${update.id}`);
      }
    }
  }

  console.log('\n=== Sincronización completada ===');
}

syncCloudWithActiveLayers().catch(console.error);

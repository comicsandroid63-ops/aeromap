const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const TABLE = process.env.SUPABASE_LAYERS_TABLE || 'layers';

async function cleanDuplicateLayers() {
  console.log('=== Limpiando capas duplicadas ===\n');

  const { data: layers, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log(`Total capas: ${layers.length}`);

  // Agrupar por nombre
  const grouped = {};
  layers.forEach(l => {
    if (!grouped[l.name]) grouped[l.name] = [];
    grouped[l.name].push(l);
  });

  const duplicates = Object.entries(grouped).filter(([_, items]) => items.length > 1);
  console.log(`\nGrupos con duplicados: ${duplicates.length}`);

  let deletedCount = 0;

  for (const [name, items] of duplicates) {
    console.log(`\n${name}: ${items.length} registros`);
    
    // Mantener el más reciente (primero en la lista), eliminar el resto
    const toKeep = items[0];
    const toDelete = items.slice(1);
    
    console.log(`  Mantener: ${toKeep.id} (${toKeep.created_at})`);
    
    for (const item of toDelete) {
      console.log(`  Eliminar: ${item.id} (${item.created_at})`);
      const { error: deleteError } = await supabase
        .from(TABLE)
        .delete()
        .eq('id', item.id);
      
      if (deleteError) {
        console.error(`    Error:`, deleteError);
      } else {
        deletedCount++;
      }
    }
  }

  console.log(`\n=== Eliminados: ${deletedCount} capas duplicadas ===`);
}

cleanDuplicateLayers().catch(console.error);

let maplibreMap = null;
let current3DBasemap = 'satellite';
let active3DLayers = {};
let current3DExaggeration = 1.5;

const basemapDefs = {
  dark: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    attribution: '&copy; Esri'
  },
  light: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    attribution: '&copy; Esri'
  },
  satellite: {
    tiles: ['https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'],
    attribution: '&copy; Google'
  },
  osm: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '&copy; OpenStreetMap'
  },
  terrain: {
    tiles: ['https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}'],
    attribution: '&copy; Google'
  },
  voyager: {
    tiles: ['https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'],
    attribution: '&copy; CARTO'
  }
};

function init3DMap(center, zoom, visibleLayers, vectorLayers) {
  destroy3DMap();

  const bm = basemapDefs[current3DBasemap] || basemapDefs.satellite;

  maplibreMap = new maplibregl.Map({
    container: 'map3DContainer',
    dragPan: true,
    dragRotate: true,
    scrollZoom: true,
    touchZoomRotate: true,
    doubleClickZoom: true,
    keyboard: true,
    style: buildStyle(bm),
    center: center,
    zoom: zoom,
    pitch: 60,
    bearing: 45,
    maxPitch: 85
  });

  maplibreMap.addControl(new maplibregl.NavigationControl(), 'bottom-right');

  maplibreMap.on('load', () => {
    console.log('[3D] MapLibre loaded');
    
    // Activar elevación 3D explícitamente en el motor de MapLibre
    try {
      maplibreMap.setTerrain({
        source: 'terrainSource',
        exaggeration: current3DExaggeration
      });
      console.log('[3D] Elevación 3D Terrarium activada con éxito');
    } catch(err) {
      console.warn('[3D] Advertencia al activar terreno 3D:', err);
    }

    // Ocultar indicadores de depuración cuando la carga ha sido exitosa
    const dbg = document.getElementById('dbgGlobal');
    if (dbg) {
      dbg.style.display = 'none';
      dbg.textContent = '';
    }
    const dbg3d = document.getElementById('dbg3d');
    if (dbg3d) dbg3d.style.display = 'none';

    if (visibleLayers && visibleLayers.length) {
      console.log('[3D] Adding', visibleLayers.length, 'raster layers');
      addRasterLayers(visibleLayers);
    } else {
      console.log('[3D] No raster layers to add');
    }
    if (vectorLayers && vectorLayers.length) {
      console.log('[3D] Adding', vectorLayers.length, 'vector layers');
      addVectorLayers(vectorLayers);
    } else {
      console.log('[3D] No vector layers to add');
    }
    try { initFloodSimulation(); } catch(fErr) { console.warn('[3D-Flood] Error iniciando:', fErr); }
    hideProgress();
  });

  maplibreMap.on('error', (e) => {
    console.error('[3D] MapLibre error:', e.error?.message || e);
    hideProgress();
  });

  requestAnimationFrame(() => {
    maplibreMap.resize();
  });
}

function set3DExaggeration(val) {
  if (!maplibreMap) return;
  const num = parseFloat(val);
  if (isNaN(num) || num < 0) return;
  current3DExaggeration = num;
  try {
    maplibreMap.setTerrain({
      source: 'terrainSource',
      exaggeration: num
    });
    console.log('[3D] Exageración de relieve actualizada a:', num);
  } catch(e) {
    console.warn('[3D] Error setTerrain:', e);
  }
}
window.set3DExaggeration = set3DExaggeration;

function reset3DView() {
  if (!maplibreMap) return;
  maplibreMap.easeTo({
    pitch: 60,
    bearing: 45,
    duration: 800
  });
}
window.reset3DView = reset3DView;

function addVectorLayers(layers) {
  const dbg = document.getElementById('dbgGlobal');
  let added = 0;
  layers.forEach((l) => {
    if (!l.geoJson || !l.geoJson.features || !l.geoJson.features.length) {
      console.log('[3D] Skipping vector layer (no features):', l.name);
      return;
    }
    const sourceId = 'vector-' + l.id;
    const firstGeom = l.geoJson.features[0]?.geometry?.type;
    const layerIds = [];

    try {
      maplibreMap.addSource(sourceId, {
        type: 'geojson',
        data: l.geoJson
      });

      if (firstGeom === 'Polygon' || firstGeom === 'MultiPolygon') {
        const fillId = sourceId + '-fill';
        const outlineId = sourceId + '-outline';
        maplibreMap.addLayer({
          id: fillId,
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-color': l.color || '#6366f1',
            'fill-opacity': l.fillOpacity ?? 0.5
          }
        });
        maplibreMap.addLayer({
          id: outlineId,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': l.strokeColor || '#333',
            'line-width': l.strokeWidth ?? 1.5,
            'line-opacity': l.strokeOpacity ?? 1
          }
        });
        layerIds.push(fillId, outlineId);
      } else if (firstGeom === 'LineString' || firstGeom === 'MultiLineString') {
        maplibreMap.addLayer({
          id: sourceId,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': l.color || '#6366f1',
            'line-width': l.strokeWidth ?? 1.5,
            'line-opacity': l.opacity ?? 1
          }
        });
        layerIds.push(sourceId);
      } else if (firstGeom === 'Point' || firstGeom === 'MultiPoint') {
        maplibreMap.addLayer({
          id: sourceId,
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-color': l.color || '#6366f1',
            'circle-radius': Math.max(3, (l.pointSize || 36) / 8),
            'circle-opacity': l.opacity ?? 1,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1
          }
        });
        layerIds.push(sourceId);
      }

      active3DLayers[sourceId] = { layerId: l.id, mlLayerIds: layerIds, sourceId: sourceId };
      added++;
      console.log('[3D] Vector layer added:', l.name, 'type:', firstGeom);
    } catch (e) {
      console.warn('[3D] Error adding vector layer', l.name, e);
      if (dbg) dbg.textContent += ' | FAIL: ' + l.name + ' ' + e.message;
    }
  });
  if (dbg) dbg.textContent += ' | vecAdded ' + added + '/' + layers.length;
}

function buildStyle(bm) {
  return {
    version: 8,
    sources: {
      base: {
        type: 'raster',
        tiles: bm.tiles,
        tileSize: 256,
        attribution: bm.attribution
      },
      terrainSource: {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15
      }
    },
    layers: [
      { id: 'base', type: 'raster', source: 'base' },
      {
        id: 'hills',
        type: 'hillshade',
        source: 'terrainSource',
        layout: { visibility: 'visible' },
        paint: {
          'hillshade-shadow-color': '#000000',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-accent-color': '#000000',
          'hillshade-exaggeration': 0.25
        }
      }
    ],
    terrain: {
      source: 'terrainSource',
      exaggeration: current3DExaggeration
    }
  };
}

function addRasterLayers(layers) {
  const dbg = document.getElementById('dbgGlobal');
  let added = 0;
  layers.forEach((l) => {
    const hasFilename = l._tileSavedAs || l.serverFilename;
    if (l.type !== 'raster' || !hasFilename) {
      console.log('[3D] Skipping layer', l.name, 'type:', l.type, 'hasFilename:', !!hasFilename);
      return;
    }
    const url = buildTileUrl(l);
    console.log('[3D] Adding raster layer:', l.name, 'URL:', url);
    if (!url) return;
    const sourceId = 'layer-' + l.id;

    try {
      maplibreMap.addSource(sourceId, {
        type: 'raster',
        tiles: [url],
        tileSize: 256,
        bounds: l._bounds || undefined
      });
      maplibreMap.addLayer({
        id: sourceId,
        type: 'raster',
        source: sourceId,
        paint: {
          'raster-opacity': l.opacity ?? 1
        }
      });
      active3DLayers[sourceId] = { layerId: l.id };
      added++;
      console.log('[3D] Layer added successfully:', l.name);
    } catch (e) {
      console.warn('[3D] Error adding layer', l.name, e);
      if (dbg) dbg.textContent += ' | FAIL: ' + l.name + ' ' + e.message;
    }
  });
  if (dbg) dbg.textContent += ' | added ' + added + '/' + layers.length + ' layers';
  // Force repaint so terrain recalculates with new layers
  if (maplibreMap) maplibreMap.triggerRepaint();
}

function buildTileUrl(layer) {
  const fn = layer._tileSavedAs || layer.serverFilename;
  if (!fn) return null;
  let url = `/api/tiles/${encodeURIComponent(fn)}/{z}/{x}/{y}.png`;
  const params = new URLSearchParams();
  const rp = layer.rendererParams || {};
  if (layer.renderer) params.set('renderer', layer.renderer);
  if (rp.bands && rp.bands.length) params.set('bands', rp.bands.join(','));
  if (rp.colormap) params.set('colormap', rp.colormap);
  if (rp.invert) params.set('invert', 'true');
  if (rp.customColors && rp.customColors.length) {
    params.set('customColors', rp.customColors.join(','));
  } else if (rp.classes || layer.renderer === 'pseudocolor') {
    params.set('classes', rp.classes || 5);
  }
  const qs = params.toString();
  if (qs) url += '?' + qs;
  return url;
}

function rebuild3DRasterLayer(layer, savedAs) {
  if (!maplibreMap || !layer) return;
  const sourceId = 'layer-' + layer.id;
  // Remove existing source/layer
  try {
    if (maplibreMap.getLayer(sourceId)) maplibreMap.removeLayer(sourceId);
    if (maplibreMap.getSource(sourceId)) maplibreMap.removeSource(sourceId);
  } catch (e) {}
  // Build new tile URL with current symbology
  const fn = savedAs || layer._tileSavedAs || layer.serverFilename;
  if (!fn) return;
  let url = `/api/tiles/${encodeURIComponent(fn)}/{z}/{x}/{y}.png`;
  const params = new URLSearchParams();
  const rp = layer.rendererParams || {};
  if (layer.renderer) params.set('renderer', layer.renderer);
  if (rp.bands && rp.bands.length) params.set('bands', rp.bands.join(','));
  if (rp.colormap) params.set('colormap', rp.colormap);
  if (rp.invert) params.set('invert', 'true');
  if (rp.customColors && rp.customColors.length) {
    params.set('customColors', rp.customColors.join(','));
  } else if (rp.classes || layer.renderer === 'pseudocolor') {
    params.set('classes', rp.classes || 5);
  }
  const qs = params.toString();
  if (qs) url += '?' + qs;
  // Re-add source and layer
  try {
    maplibreMap.addSource(sourceId, {
      type: 'raster',
      tiles: [url],
      tileSize: 256
    });
    maplibreMap.addLayer({
      id: sourceId,
      type: 'raster',
      source: sourceId,
      paint: { 'raster-opacity': layer.opacity ?? 1 }
    });
    active3DLayers[sourceId] = { layerId: layer.id };
  } catch (e) {
    console.warn('[3D] Error rebuilding raster layer', layer.name, e);
  }
}

function destroy3DMap() {
  try { disposeFloodSimulation(); } catch(_) {}
  if (maplibreMap) {
    maplibreMap.remove();
    maplibreMap = null;
  }
  active3DLayers = {};
}

function get3DMap() {
  return maplibreMap;
}

function switchBasemap(id) {
  const bm = basemapDefs[id];
  if (!bm || !maplibreMap) return;
  current3DBasemap = id;
  const source = maplibreMap.getSource('base');
  if (source) {
    source.setTiles(bm.tiles);
  }
}

function setLayerVisibility(layerId, visible) {
  if (!maplibreMap) return;
  // Try raster layer first
  let sourceId = 'layer-' + layerId;
  let entry = active3DLayers[sourceId];
  // Fallback to vector layer
  if (!entry) {
    sourceId = 'vector-' + layerId;
    entry = active3DLayers[sourceId];
  }
  if (!entry) return;
  const layerNames = entry.mlLayerIds || [sourceId];
  const newVisibility = visible ? 'visible' : 'none';
  for (const name of layerNames) {
    try {
      const current = maplibreMap.getLayoutProperty(name, 'visibility');
      if (current !== newVisibility) {
        maplibreMap.setLayoutProperty(name, 'visibility', newVisibility);
      }
    } catch (e) {}
  }
}

function remove3DLayer(layerId) {
  if (!maplibreMap) return;
  let sourceId = 'layer-' + layerId;
  let entry = active3DLayers[sourceId];
  if (!entry) {
    sourceId = 'vector-' + layerId;
    entry = active3DLayers[sourceId];
  }
  if (!entry) return;
  const layerNames = entry.mlLayerIds || [sourceId];
  try {
    for (const name of layerNames) {
      try { maplibreMap.removeLayer(name); } catch (e) {}
    }
    maplibreMap.removeSource(sourceId);
  } catch (e) {}
  delete active3DLayers[sourceId];
}


// ════════════════════════════════════════════════════════════════════════════════
//  3D FLOOD SIMULATION ENGINE (RIVER-CENTRIC HYDROLOGY & MAPLIBRE 3D INTEGRATION)
// ════════════════════════════════════════════════════════════════════════════════

const floodState = {
  active: true,
  zone: 'guatapuri',
  precipitation: 120,
  targetPrecipitation: 120,
  isSimulating: false,
  simAnimId: null,
  flowAnimId: null,
  pickMode: false,
  customRiverPath: null,
  layersReady: false,
  flowPhase: 0,
  isMinimized: false
};

// ════════════════════════════════════════════════════════════════════════════════
//  BASE DE DATOS HIDROGRÁFICA: CAUCES DE RÍOS REALES (DIGITALIZACIÓN GEOGRÁFICA)
// ════════════════════════════════════════════════════════════════════════════════
const riverBasins = {
  guatapuri: {
    name: 'Río Guatapurí (Valledupar & Hurtado)',
    camera: { center: [-73.250, 10.485], zoom: 13.5, pitch: 65, bearing: 35 },
    path: [
      [-73.550, 10.740], // Cabeceras Sierra Nevada de Santa Marta (~3,500m)
      [-73.490, 10.690], // Valle Donachui
      [-73.430, 10.645], // Cañón del Guatapurí
      [-73.375, 10.605], // Chemesquemena
      [-73.330, 10.570], // La Mina
      [-73.295, 10.535], // La Vega Arriba
      [-73.275, 10.510], // Garganta de Hurtado
      [-73.265, 10.495], // Balneario Hurtado & Puente Hurtado
      [-73.255, 10.482], // Parque de la Leyenda Vallenata
      [-73.245, 10.470], // Margen Este de Valledupar
      [-73.238, 10.455], // Margen Urbana Pescadito / Zapato en Mano
      [-73.230, 10.438], // Vía a La Paz
      [-73.220, 10.415], // Meandros de El Jabo
      [-73.210, 10.390], // Llanuras aluviales de El Rincón
      [-73.200, 10.360], // Los Corazones
      [-73.185, 10.335]  // Confluencia directa con el Río Cesar
    ],
    tributaries: [
      [[-73.295, 10.512], [-73.280, 10.502], [-73.265, 10.495]],
      [[-73.205, 10.470], [-73.218, 10.450], [-73.230, 10.438]]
    ]
  },
  cesar: {
    name: 'Río Cesar (Eje Fluvial Central & Meandros)',
    camera: { center: [-73.340, 10.150], zoom: 12.0, pitch: 60, bearing: 25 },
    path: [
      [-73.020, 10.820], // Nacimiento Serranía del Perijá (San Juan del Cesar)
      [-73.080, 10.720], // San Juan del Cesar
      [-73.140, 10.580], // Límite La Guajira - Cesar
      [-73.185, 10.450], // Puente Salguero regional
      [-73.185, 10.335], // Confluencia con Río Guatapurí
      [-73.240, 10.270], // Meandros de San Diego
      [-73.290, 10.210], // Llanura aluvial La Paz
      [-73.340, 10.150], // Meandros de Los Venados
      [-73.390, 10.080], // Valle aluvial de Caracolí
      [-73.450, 10.010], // El Paso (Cesar)
      [-73.510, 9.920],  // Puente Arjona
      [-73.570, 9.810],  // Humedales de La Loma
      [-73.630, 9.680],  // Astrea / Chimichagua
      [-73.710, 9.520],  // Entrada a la Depresión Momposina
      [-73.780, 9.350]   // Desembocadura en la Ciénaga de Zapatosa
    ]
  },
  zapatosa: {
    name: 'Ciénaga de Zapatosa & Depresión Momposina',
    camera: { center: [-73.750, 9.320], zoom: 11.5, pitch: 55, bearing: 15 },
    path: [
      [-73.680, 9.480], // Caño El Burro / Chimichagua
      [-73.720, 9.420], // Ciénaga Norte
      [-73.760, 9.350], // Espejo de agua central (Saloa)
      [-73.810, 9.280], // Salida hacia El Banco
      [-73.850, 9.200], // Confluencia fluvial con Brazo de Loba
      [-73.890, 9.120]  // Sistema de caños del Río Magdalena
    ]
  },
  magdalena: {
    name: 'Río Magdalena (Gamarra, Aguachica & La Gloria)',
    camera: { center: [-73.740, 8.520], zoom: 12.5, pitch: 60, bearing: 30 },
    path: [
      [-73.660, 8.280], // Puerto Mosquito
      [-73.690, 8.380], // Aguachica Occidental
      [-73.725, 8.500], // Puerto Gamarra
      [-73.760, 8.620], // Capulco
      [-73.790, 8.750], // La Gloria (Cesar)
      [-73.830, 8.890], // El Banco (Magdalena / Cesar)
      [-73.870, 9.020], // Tamalameque
      [-73.820, 9.180]  // Brazo de Mompox
    ]
  },
  badillo: {
    name: 'Río Badillo (Patillal & Balneario Badillo)',
    camera: { center: [-73.280, 10.600], zoom: 13.0, pitch: 60, bearing: 40 },
    path: [
      [-73.420, 10.750], // Sierra Nevada
      [-73.360, 10.680], // Cañón de Badillo
      [-73.310, 10.630], // La Mina de Badillo
      [-73.275, 10.595], // Corregimiento de Badillo
      [-73.230, 10.540], // Sabanas de Patillal
      [-73.180, 10.490], // Valle aluvial oriental
      [-73.130, 10.440]  // Confluencia con el Río Cesar
    ]
  },
  ariguani: {
    name: 'Río Ariguaní (Pueblo Bello, El Copey & Bosconia)',
    camera: { center: [-73.720, 10.100], zoom: 12.0, pitch: 55, bearing: 20 },
    path: [
      [-73.880, 10.450], // Flanco occidental Sierra Nevada
      [-73.820, 10.320], // Pueblo Bello bajo
      [-73.770, 10.180], // El Copey
      [-73.710, 10.020], // Límite Cesar - Magdalena
      [-73.670, 9.880],  // Bosconia occidental
      [-73.690, 9.720]   // Sabanas de San Ángel
    ]
  },
  lebrija: {
    name: 'Río Lebrija (Sur del Cesar / San Alberto)',
    camera: { center: [-73.550, 8.050], zoom: 12.2, pitch: 58, bearing: 25 },
    path: [
      [-73.480, 8.180], // Piedemonte Cordillera Oriental
      [-73.530, 8.110], // San Alberto
      [-73.610, 8.030], // San Martín
      [-73.700, 7.940]  // Desembocadura en el Río Magdalena
    ]
  }
};

// Encuentra el río real más cercano a unas coordenadas
function findNearestRealRiver(targetLng, targetLat) {
  let closestKey = null;
  let minDistance = Infinity;

  for (const [key, basin] of Object.entries(riverBasins)) {
    if (!basin.path) continue;
    for (const pt of basin.path) {
      const d = Math.hypot(pt[0] - targetLng, pt[1] - targetLat);
      if (d < minDistance) {
        minDistance = d;
        closestKey = key;
      }
    }
  }

  if (minDistance < 1.0 && closestKey) {
    return { key: closestKey, basin: riverBasins[closestKey], distance: minDistance };
  }
  return null;
}

// Traza el cauce real del valle topográfico muestreando el modelo DEM 3D
function traceTerrainValleyRiver(centerLngLat, spanDeg = 0.15) {
  const [cLng, cLat] = centerLngLat;
  const count = 16;
  const path = [];
  const hasElevation = maplibreMap && typeof maplibreMap.queryTerrainElevation === 'function';

  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) - 0.5; // -0.5 a 0.5
    let bestLng = cLng + t * spanDeg * 1.1;
    let bestLat = cLat - t * spanDeg * 0.9;

    if (hasElevation) {
      let minEle = Infinity;
      let minLng = bestLng;
      let minLat = bestLat;
      const perpX = -0.9 * spanDeg * 0.15;
      const perpY = -1.1 * spanDeg * 0.15;

      // Muestrear 7 puntos a través del corte transversal del valle para hallar el talweg (cota mínima)
      for (let s = -3; s <= 3; s++) {
        const testLng = bestLng + (s / 3) * perpX;
        const testLat = bestLat + (s / 3) * perpY;
        try {
          const ele = maplibreMap.queryTerrainElevation([testLng, testLat]);
          if (ele !== null && !isNaN(ele) && ele < minEle) {
            minEle = ele;
            minLng = testLng;
            minLat = testLat;
          }
        } catch (_) {}
      }
      bestLng = minLng;
      bestLat = minLat;
    }

    path.push([Number(bestLng.toFixed(6)), Number(bestLat.toFixed(6))]);
  }

  return path;
}

// Modelo Hidrológico: Calcula cotas, caudales y polígonos de inundación
function computeHydrologicalFlood(riverCoords, precipitationMm) {
  const p = Math.max(0, precipitationMm);
  const smoothed = smoothRiverPath(riverCoords, 4);

  // Cota de subida del río (Delta H en metros)
  const deltaH = Math.min(8.5, Math.pow(p / 32, 1.12) * 0.65);
  // Caudal punta estimado (Q en m3/s)
  const discharge = Math.round(12 + Math.pow(p / 15, 1.4) * 24);
  // Superficie anegada estimada (Hectáreas)
  const floodedAreaHa = Math.round(15 + Math.pow(p / 18, 1.35) * 28);

  const mToDeg = 0.0000095;
  // Ancho del lecho en estiaje/caudal base
  const baseW = (24 + Math.min(55, deltaH * 7.5)) * mToDeg;

  // Umbral de desbordamiento de orilla (1.1m)
  const overflowH = Math.max(0, deltaH - 1.1);
  const maxSpreadDeg = baseW + Math.pow(overflowH, 1.32) * 165 * mToDeg;

  const polygonFeatures = [];

  // Nivel 1: Cauce Principal y Zonas Profundas (> 2.0m)
  polygonFeatures.push({
    type: 'Feature',
    properties: { tier: 'deep', depthM: (deltaH + 1.2).toFixed(1) },
    geometry: { type: 'Polygon', coordinates: [buildFloodplainPolygon(smoothed, baseW * 1.15, 0.15)] }
  });

  // Nivel 2: Llanura de Inundación y Meandros Medios (0.8m - 2.0m)
  if (p > 40) {
    const medWidth = baseW + (maxSpreadDeg - baseW) * 0.62;
    polygonFeatures.push({
      type: 'Feature',
      properties: { tier: 'medium', depthM: (deltaH * 0.62).toFixed(1) },
      geometry: { type: 'Polygon', coordinates: [buildFloodplainPolygon(smoothed, medWidth, 0.35)] }
    });
  }

  // Nivel 3: Zonas Anegadas Marginales y Paleocauces (< 0.8m)
  if (p > 90) {
    polygonFeatures.push({
      type: 'Feature',
      properties: { tier: 'shallow', depthM: (deltaH * 0.28).toFixed(1) },
      geometry: { type: 'Polygon', coordinates: [buildFloodplainPolygon(smoothed, maxSpreadDeg, 0.50)] }
    });
  }

  // Línea de Corriente Activa (Thalweg con animación de flujo)
  const streamFeature = {
    type: 'Feature',
    properties: { discharge },
    geometry: { type: 'LineString', coordinates: smoothed }
  };

  return {
    polygonsGeoJSON: { type: 'FeatureCollection', features: polygonFeatures },
    streamGeoJSON: { type: 'FeatureCollection', features: [streamFeature] },
    deltaH: Number(deltaH.toFixed(2)),
    discharge,
    floodedAreaHa
  };
}

// ════════════════════════════════════════════════════════════════════════════════
//  SISTEMA DE ANIMACIÓN DE LLUVIA & TEMPESTAD ATMOSFÉRICA (CANVAS 60 FPS NATIVO)
// ════════════════════════════════════════════════════════════════════════════════
let rainCanvas = null;
let rainCtx = null;
let rainAnimId = null;
let rainDrops = [];
let rainSplashes = [];

function initRainEffect() {
  rainCanvas = document.getElementById('floodRainCanvas');
  if (!rainCanvas) return;
  rainCtx = rainCanvas.getContext('2d');
  resizeRainCanvas();
  window.removeEventListener('resize', resizeRainCanvas);
  window.addEventListener('resize', resizeRainCanvas);
  startRainAnimationLoop();
}

function resizeRainCanvas() {
  if (!rainCanvas) return;
  rainCanvas.width = window.innerWidth;
  rainCanvas.height = window.innerHeight;
}

function startRainAnimationLoop() {
  if (rainAnimId) cancelAnimationFrame(rainAnimId);

  function loop() {
    if (!rainCanvas || !rainCtx) return;

    const w = rainCanvas.width;
    const h = rainCanvas.height;
    rainCtx.clearRect(0, 0, w, h);

    const p = floodState.precipitation || 0;

    // Solo animar si la capa 3D está activa y la lluvia acumulada > 0 mm
    if (floodState.active && p > 4) {
      // 1. Cantidad de gotas proporcional a la precipitación (60 a 950 gotas)
      const maxDrops = Math.min(950, Math.round(50 + Math.pow(p / 14, 1.25) * 45));

      while (rainDrops.length < maxDrops) {
        rainDrops.push({
          x: Math.random() * (w + 140) - 70,
          y: Math.random() * -h,
          len: 14 + Math.random() * 16 + (p > 150 ? 8 : 0),
          vy: 16 + Math.random() * 11 + (p > 150 ? 6 : 0),
          vx: -2.2 - Math.random() * 1.5,
          alpha: 0.35 + Math.random() * 0.45
        });
      }
      if (rainDrops.length > maxDrops) {
        rainDrops.length = maxDrops;
      }

      // 2. Oscurecimiento atmosférico por nubes de tormenta y humedad
      if (p > 50) {
        const stormAlpha = Math.min(0.36, (p - 50) / 450 * 0.36);
        rainCtx.fillStyle = `rgba(15, 23, 42, ${stormAlpha.toFixed(3)})`;
        rainCtx.fillRect(0, 0, w, h);
      }

      // 3. Dibujar gotas de lluvia en perspectiva oblicua
      rainCtx.beginPath();
      for (let i = 0; i < rainDrops.length; i++) {
        const d = rainDrops[i];
        d.x += d.vx;
        d.y += d.vy;

        rainCtx.moveTo(d.x, d.y);
        rainCtx.lineTo(d.x + d.vx * (d.len / d.vy), d.y + d.len);

        // Salpicaduras sobre la superficie del agua o suelo
        if (d.y > h * 0.65 && Math.random() < 0.14) {
          if (rainSplashes.length < 60) {
            rainSplashes.push({
              x: d.x,
              y: d.y,
              r: 1,
              maxR: 5 + Math.random() * 6,
              alpha: 0.60
            });
          }
        }

        // Reubicar gota cuando sale del lienzo
        if (d.y > h || d.x < -70) {
          d.x = Math.random() * (w + 140) - 35;
          d.y = -Math.random() * 40;
        }
      }
      rainCtx.strokeStyle = 'rgba(215, 240, 255, 0.70)';
      rainCtx.lineWidth = p > 200 ? 1.4 : 1.1;
      rainCtx.stroke();

      // 4. Dibujar ondas elípticas de salpicaduras
      if (rainSplashes.length > 0) {
        rainCtx.lineWidth = 1;
        for (let j = rainSplashes.length - 1; j >= 0; j--) {
          const sp = rainSplashes[j];
          sp.r += 0.65;
          sp.alpha -= 0.04;
          if (sp.alpha <= 0 || sp.r >= sp.maxR) {
            rainSplashes.splice(j, 1);
            continue;
          }
          rainCtx.beginPath();
          rainCtx.ellipse(sp.x, sp.y, sp.r * 1.6, sp.r * 0.7, 0, 0, Math.PI * 2);
          rainCtx.strokeStyle = `rgba(186, 230, 253, ${sp.alpha.toFixed(2)})`;
          rainCtx.stroke();
        }
      }
    } else {
      rainDrops = [];
      rainSplashes = [];
    }

    rainAnimId = requestAnimationFrame(loop);
  }

  rainAnimId = requestAnimationFrame(loop);
}

function stopRainAnimation() {
  if (rainAnimId) {
    cancelAnimationFrame(rainAnimId);
    rainAnimId = null;
  }
  if (rainCanvas && rainCtx) {
    rainCtx.clearRect(0, 0, rainCanvas.width, rainCanvas.height);
  }
  rainDrops = [];
  rainSplashes = [];
}

// Inicialización de fuentes y capas de inundación en MapLibre 3D
function initFloodSimulation() {
  if (!maplibreMap) return;
  console.log('[3D-Flood] Inicializando motor de inundación fluvial con ríos reales...');

  const center = maplibreMap.getCenter();
  const nearest = findNearestRealRiver(center.lng, center.lat);

  let riverPath = null;
  if (nearest) {
    floodState.zone = nearest.key;
    riverPath = nearest.basin.path;
    const sel = document.getElementById('selectFloodZone');
    if (sel) sel.value = nearest.key;
    const lbl = document.getElementById('floodZoneLabel');
    if (lbl) lbl.textContent = nearest.basin.name;
  } else {
    // Si la cámara no está en Cesar, trazar el cauce real a partir del modelo DEM 3D
    floodState.zone = 'viewport';
    const bounds = maplibreMap.getBounds();
    const span = bounds ? Math.max(0.06, Math.abs(bounds.getEast() - bounds.getWest()) * 0.8) : 0.15;
    riverPath = traceTerrainValleyRiver([center.lng, center.lat], span);
    floodState.customRiverPath = riverPath;
    const sel = document.getElementById('selectFloodZone');
    if (sel) sel.value = 'viewport';
    const lbl = document.getElementById('floodZoneLabel');
    if (lbl) lbl.textContent = 'Valle Fluvial Real (DEM 3D)';
  }

  const hydro = computeHydrologicalFlood(riverPath, floodState.precipitation);

  // Agregar Fuente GeoJSON de Polígonos de Agua
  if (!maplibreMap.getSource('flood-water-source')) {
    maplibreMap.addSource('flood-water-source', {
      type: 'geojson',
      data: hydro.polygonsGeoJSON
    });
  } else {
    maplibreMap.getSource('flood-water-source').setData(hydro.polygonsGeoJSON);
  }

  // Agregar Fuente GeoJSON del Thalweg / Corriente Fluvial
  if (!maplibreMap.getSource('flood-stream-source')) {
    maplibreMap.addSource('flood-stream-source', {
      type: 'geojson',
      data: hydro.streamGeoJSON
    });
  } else {
    maplibreMap.getSource('flood-stream-source').setData(hydro.streamGeoJSON);
  }

  // Capa 1: Zonas Anegadas Marginales / Baja Profundidad (< 0.8m)
  if (!maplibreMap.getLayer('flood-shallow-layer')) {
    maplibreMap.addLayer({
      id: 'flood-shallow-layer',
      type: 'fill',
      source: 'flood-water-source',
      filter: ['==', ['get', 'tier'], 'shallow'],
      paint: {
        'fill-color': '#7dd3fc',
        'fill-opacity': 0.45
      }
    });
  }

  // Capa 2: Llanura de Inundación / Media Profundidad (0.8m - 2.0m)
  if (!maplibreMap.getLayer('flood-medium-layer')) {
    maplibreMap.addLayer({
      id: 'flood-medium-layer',
      type: 'fill',
      source: 'flood-water-source',
      filter: ['==', ['get', 'tier'], 'medium'],
      paint: {
        'fill-color': '#0ea5e9',
        'fill-opacity': 0.65
      }
    });
  }

  // Capa 3: Cauce Principal / Alta Profundidad (> 2.0m)
  if (!maplibreMap.getLayer('flood-deep-layer')) {
    maplibreMap.addLayer({
      id: 'flood-deep-layer',
      type: 'fill',
      source: 'flood-water-source',
      filter: ['==', ['get', 'tier'], 'deep'],
      paint: {
        'fill-color': '#0284c7',
        'fill-opacity': 0.86
      }
    });
  }

  // Capa 4: Borde de Lámina de Agua (Línea de Costa Ribereña)
  if (!maplibreMap.getLayer('flood-fringe-layer')) {
    maplibreMap.addLayer({
      id: 'flood-fringe-layer',
      type: 'line',
      source: 'flood-water-source',
      paint: {
        'line-color': '#0369a1',
        'line-width': 1.6,
        'line-opacity': 0.60
      }
    });
  }

  // Capa 5: Corriente Activa del Río (Línea animada de flujo)
  if (!maplibreMap.getLayer('flood-stream-layer')) {
    maplibreMap.addLayer({
      id: 'flood-stream-layer',
      type: 'line',
      source: 'flood-stream-source',
      paint: {
        'line-color': '#f0f9ff',
        'line-width': 3.2,
        'line-dasharray': [2, 3],
        'line-opacity': 0.90
      }
    });
  }

  floodState.layersReady = true;

  // Iniciar animación ligera de corriente de agua
  startRiverCurrentAnimation();

  // Iniciar sistema de lluvia
  initRainEffect();

  // Actualizar dashboard y controles UI
  updateFloodUIDashboard(hydro);

  // Manejador de clics interactivos si está en modo selección de punto
  setupMaplibreFloodClickHandler();

  // Activar arrastre del menú
  initDraggableFloodMenu();
}

// Actualiza la geometría y métricas según la precipitación y cuenca activa
function updateFloodSimulation() {
  if (!maplibreMap || !floodState.layersReady) return;

  let riverPath = riverBasins[floodState.zone]?.path;
  if (floodState.zone === 'custom' && floodState.customRiverPath) {
    riverPath = floodState.customRiverPath;
  }
  if (!riverPath && floodState.customRiverPath) {
    riverPath = floodState.customRiverPath;
  }
  if (!riverPath) {
    const center = maplibreMap.getCenter();
    riverPath = traceTerrainValleyRiver([center.lng, center.lat]);
  }

  const hydro = computeHydrologicalFlood(riverPath, floodState.precipitation);

  try {
    const polySrc = maplibreMap.getSource('flood-water-source');
    if (polySrc) polySrc.setData(hydro.polygonsGeoJSON);

    const streamSrc = maplibreMap.getSource('flood-stream-source');
    if (streamSrc) streamSrc.setData(hydro.streamGeoJSON);
  } catch (e) {
    console.warn('[3D-Flood] Error actualizando GeoJSON:', e);
  }

  updateFloodUIDashboard(hydro);
}

// Animación de la corriente fluvial (onda de agua desplazándose por el cauce)
function startRiverCurrentAnimation() {
  if (floodState.flowAnimId) cancelAnimationFrame(floodState.flowAnimId);

  let lastTime = 0;
  function step(time) {
    if (!maplibreMap || !floodState.active || !floodState.layersReady) return;

    if (time - lastTime > 80) { // ~12 fps para actualización de guiones, 0% CPU
      lastTime = time;
      floodState.flowPhase = (floodState.flowPhase + 0.5) % 8;
      try {
        if (maplibreMap.getLayer('flood-stream-layer')) {
          const p1 = Math.max(0.1, Number((2 + Math.sin(floodState.flowPhase)).toFixed(1)));
          maplibreMap.setPaintProperty('flood-stream-layer', 'line-dasharray', [p1, 3]);
        }
      } catch (_) {}
    }

    floodState.flowAnimId = requestAnimationFrame(step);
  }

  floodState.flowAnimId = requestAnimationFrame(step);
}

// Actualización en tiempo real del HUD de Métricas Hidrológicas
function updateFloodUIDashboard(hydro) {
  const p = floodState.precipitation;

  // 1. Badge de Precipitación
  const badgeP = document.getElementById('badgePrecipitation');
  if (badgeP) badgeP.textContent = Math.round(p) + ' mm';

  // 2. Slider
  const slider = document.getElementById('sliderPrecipitation');
  if (slider && parseFloat(slider.value) !== p) {
    slider.value = p;
  }

  // 3. Nivel de Riesgo y Alerta
  const badgeRisk = document.getElementById('badgeFloodRisk');
  if (badgeRisk) {
    if (p < 50) {
      badgeRisk.textContent = 'Normal';
      badgeRisk.className = 'text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    } else if (p < 120) {
      badgeRisk.textContent = 'Alerta Amarilla';
      badgeRisk.className = 'text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30';
    } else if (p < 250) {
      badgeRisk.textContent = 'Alerta Naranja';
      badgeRisk.className = 'text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/30';
    } else {
      badgeRisk.textContent = 'Alerta Roja (Crítico)';
      badgeRisk.className = 'text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 animate-pulse';
    }
  }

  // 4. Métricas Numéricas
  const metricL = document.getElementById('metricFloodLevel');
  if (metricL) metricL.textContent = '+' + hydro.deltaH.toFixed(1) + ' m';

  const metricQ = document.getElementById('metricFloodDischarge');
  if (metricQ) metricQ.textContent = hydro.discharge + ' m³/s';

  const metricA = document.getElementById('metricFloodArea');
  if (metricA) metricA.textContent = hydro.floodedAreaHa + ' Ha';
}

// Interacción: Selección de Zona
function onFloodZoneChange(zoneKey) {
  floodState.zone = zoneKey;
  const label = document.getElementById('floodZoneLabel');

  if (zoneKey === 'custom') {
    floodState.pickMode = true;
    if (maplibreMap) maplibreMap.getCanvas().style.cursor = 'crosshair';
    if (label) label.textContent = 'Haz clic en el río...';
    if (typeof toast === 'function') toast('Haz clic sobre el cauce de cualquier río para simular su desbordamiento', 'info');
    return;
  }

  floodState.pickMode = false;
  if (maplibreMap) maplibreMap.getCanvas().style.cursor = '';

  const basin = riverBasins[zoneKey];
  if (basin) {
    if (label) label.textContent = basin.name;
    floodState.customRiverPath = basin.path;
    // Volar suavemente la cámara 3D hacia el río real elegido
    if (maplibreMap && basin.camera) {
      maplibreMap.flyTo({
        center: basin.camera.center,
        zoom: basin.camera.zoom,
        pitch: basin.camera.pitch,
        bearing: basin.camera.bearing,
        duration: 2200,
        essential: true
      });
    }
  } else if (zoneKey === 'viewport') {
    if (label) label.textContent = 'Valle Fluvial Real (DEM 3D)';
    const center = maplibreMap.getCenter();
    const bounds = maplibreMap.getBounds();
    const span = Math.abs(bounds.getEast() - bounds.getWest()) * 0.8;
    floodState.customRiverPath = traceTerrainValleyRiver([center.lng, center.lat], span);
  }

  updateFloodSimulation();
}

// Interacción: Ajuste de Precipitación (Slider o Presets)
function setFloodPrecipitation(val) {
  const p = Math.max(0, Math.min(500, parseFloat(val) || 0));
  floodState.precipitation = p;
  floodState.targetPrecipitation = p;
  updateFloodSimulation();
}

// Reproducción interactiva de la Crecida Fluvial: LLUVIA Y RÍO CRECIENDO EN TIEMPO REAL
function togglePlayFloodSimulation() {
  if (floodState.isSimulating) {
    // Pausar
    floodState.isSimulating = false;
    if (floodState.simAnimId) cancelAnimationFrame(floodState.simAnimId);
    updatePlayButtonUI(false);
  } else {
    // Iniciar crecida progresiva desde caudal base (10mm) hasta la precipitación meta
    floodState.isSimulating = true;
    updatePlayButtonUI(true);

    const targetP = Math.max(100, floodState.targetPrecipitation || 250);
    const startP = 10;
    const duration = 7500; // 7.5 segundos de animación de crecida
    const startTime = performance.now();

    function animateStep(now) {
      if (!floodState.isSimulating) return;

      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      // Easing cúbico suave (Hermite S-curve)
      const ease = progress * progress * (3 - 2 * progress);
      const currentP = startP + (targetP - startP) * ease;

      floodState.precipitation = currentP;
      updateFloodSimulation();

      if (progress < 1) {
        floodState.simAnimId = requestAnimationFrame(animateStep);
      } else {
        floodState.isSimulating = false;
        updatePlayButtonUI(false);
        if (typeof toast === 'function') {
          toast(`✓ Crecida máxima completada: Río desbordado a ${Math.round(targetP)} mm`, 'warning');
        }
      }
    }

    floodState.simAnimId = requestAnimationFrame(animateStep);
  }
}

function updatePlayButtonUI(isPlaying) {
  const btn = document.getElementById('btnPlayFloodSim');
  const icon = document.getElementById('iconPlayFlood');
  const label = document.getElementById('labelPlayFlood');
  if (!btn || !icon || !label) return;

  if (isPlaying) {
    icon.textContent = 'pause';
    label.textContent = 'Pausar';
    btn.className = 'flex-1 py-1.5 px-3 rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white text-[9.5px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 shadow-lg active:scale-95 transition-all';
  } else {
    icon.textContent = 'play_arrow';
    label.textContent = 'Simular Crecida';
    btn.className = 'flex-1 py-1.5 px-3 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white text-[9.5px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 shadow-lg active:scale-95 transition-all';
  }
}

function resetFloodSimulation() {
  if (floodState.simAnimId) cancelAnimationFrame(floodState.simAnimId);
  floodState.isSimulating = false;
  updatePlayButtonUI(false);
  setFloodPrecipitation(25);
  if (typeof toast === 'function') toast('Simulación de inundación restablecida a caudal base', 'info');
}

// Activar o pausar la visualización de la capa de inundación
function toggleFloodSimulation() {
  if (!maplibreMap || !floodState.layersReady) return;
  floodState.active = !floodState.active;

  const visibility = floodState.active ? 'visible' : 'none';
  const layerIds = ['flood-shallow-layer', 'flood-medium-layer', 'flood-deep-layer', 'flood-fringe-layer', 'flood-stream-layer'];

  for (const id of layerIds) {
    try {
      if (maplibreMap.getLayer(id)) {
        maplibreMap.setLayoutProperty(id, 'visibility', visibility);
      }
    } catch (_) {}
  }

  const btn = document.getElementById('btnToggleFlood');
  if (btn) {
    if (floodState.active) {
      btn.innerHTML = '<span class="w-2 h-2 rounded-full bg-cyan-200 animate-pulse"></span><span>Activa</span>';
      btn.className = 'px-2 py-1 rounded-lg text-[8.5px] font-bold uppercase tracking-wider transition-all flex items-center gap-1 bg-cyan-600 hover:bg-cyan-500 text-white shadow-sm';
      startRiverCurrentAnimation();
      initRainEffect();
    } else {
      btn.innerHTML = '<span class="w-2 h-2 rounded-full bg-zinc-400"></span><span>Pausa</span>';
      btn.className = 'px-2 py-1 rounded-lg text-[8.5px] font-bold uppercase tracking-wider transition-all flex items-center gap-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 shadow-sm';
      stopRainAnimation();
    }
  }
}

// Abrir / Cerrar el menú flotante de opciones de simulación de inundación
function toggleFloodMenu(forceState) {
  const dock = document.getElementById('flood3DDock');
  const btn = document.getElementById('btnFloodSimTrigger');
  const icon = document.getElementById('iconFloodMenuChevron');
  if (!dock) return;

  const isHidden = dock.style.display === 'none' || !dock.style.display;
  const shouldOpen = typeof forceState === 'boolean' ? forceState : isHidden;

  if (shouldOpen) {
    dock.style.display = 'flex';
    if (btn) {
      btn.classList.add('border-cyan-400', 'bg-zinc-900', 'ring-2', 'ring-cyan-500/40');
    }
    if (icon) icon.textContent = 'expand_less';
  } else {
    dock.style.display = 'none';
    if (btn) {
      btn.classList.remove('border-cyan-400', 'bg-zinc-900', 'ring-2', 'ring-cyan-500/40');
    }
    if (icon) icon.textContent = 'tune';
  }
}
window.toggleFloodMenu = toggleFloodMenu;

// Inundar inmediatamente el río o cuenca visible en la cámara 3D actual
function floodVisibleRiver() {
  if (!maplibreMap) return;
  const center = maplibreMap.getCenter();
  const nearest = findNearestRealRiver(center.lng, center.lat);

  if (nearest) {
    floodState.zone = nearest.key;
    floodState.customRiverPath = nearest.basin.path;
    const sel = document.getElementById('selectFloodZone');
    if (sel) sel.value = nearest.key;
    const lbl = document.getElementById('floodZoneLabel');
    if (lbl) lbl.textContent = nearest.basin.name;
    if (nearest.basin.camera) {
      maplibreMap.flyTo({
        center: nearest.basin.camera.center,
        zoom: nearest.basin.camera.zoom,
        pitch: nearest.basin.camera.pitch,
        bearing: nearest.basin.camera.bearing,
        duration: 1800,
        essential: true
      });
    }
    if (typeof toast === 'function') toast(`🌊 Río real identificado: ${nearest.basin.name}`, 'success');
  } else {
    // Si no es un río catalogado, trazar el fondo real del valle mediante el DEM 3D
    const bounds = maplibreMap.getBounds();
    const span = bounds ? Math.max(0.06, Math.abs(bounds.getEast() - bounds.getWest()) * 0.8) : 0.15;
    floodState.zone = 'viewport';
    floodState.customRiverPath = traceTerrainValleyRiver([center.lng, center.lat], span);
    const sel = document.getElementById('selectFloodZone');
    if (sel) sel.value = 'viewport';
    const lbl = document.getElementById('floodZoneLabel');
    if (lbl) lbl.textContent = 'Valle Fluvial Real (DEM 3D)';
    if (typeof toast === 'function') toast('🌊 Cauce fluvial trazado siguiendo el valle topográfico real', 'info');
  }

  updateFloodSimulation();
}
window.floodVisibleRiver = floodVisibleRiver;

// Activar modo de selección interactiva para marcar punto en cualquier río
function startPickRiverPoint() {
  floodState.pickMode = true;
  if (maplibreMap) maplibreMap.getCanvas().style.cursor = 'crosshair';
  const lbl = document.getElementById('floodZoneLabel');
  if (lbl) lbl.textContent = 'Haz clic en el río...';
  if (typeof toast === 'function') toast('Haz clic sobre el cauce de cualquier río para simular su desbordamiento', 'info');
}
window.startPickRiverPoint = startPickRiverPoint;

// Inicializa el arrastre (drag) libre del menú de opciones
function initDraggableFloodMenu() {
  const dock = document.getElementById('flood3DDock');
  const header = document.getElementById('floodDockHeader');
  if (!dock || !header || dock._dragInitialized) return;
  dock._dragInitialized = true;

  let isDragging = false;
  let startX, startY, origLeft, origTop;

  header.style.cursor = 'grab';

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return;
    isDragging = true;
    header.style.cursor = 'grabbing';
    const rect = dock.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    origLeft = rect.left;
    origTop = rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    dock.style.left = Math.max(10, Math.min(window.innerWidth - dock.offsetWidth - 10, origLeft + dx)) + 'px';
    dock.style.top = Math.max(70, Math.min(window.innerHeight - dock.offsetHeight - 10, origTop + dy)) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      header.style.cursor = 'grab';
    }
  });
}

// Clic interactivo en mapa 3D para ubicar punto de inundación
function setupMaplibreFloodClickHandler() {
  if (!maplibreMap || maplibreMap._floodClickBound) return;
  maplibreMap._floodClickBound = true;

  maplibreMap.on('click', (e) => {
    if (!floodState.pickMode) return;

    const coords = [Number(e.lngLat.lng.toFixed(6)), Number(e.lngLat.lat.toFixed(6))];
    console.log('[3D-Flood] Punto seleccionado para inundación:', coords);

    const nearest = findNearestRealRiver(coords[0], coords[1]);
    if (nearest && nearest.distance < 0.25) {
      floodState.zone = nearest.key;
      floodState.customRiverPath = nearest.basin.path;
      const sel = document.getElementById('selectFloodZone');
      if (sel) sel.value = nearest.key;
      const lbl = document.getElementById('floodZoneLabel');
      if (lbl) lbl.textContent = nearest.basin.name;
      if (typeof toast === 'function') toast(`✓ Río real detectado: ${nearest.basin.name}`, 'success');
    } else {
      floodState.zone = 'custom';
      floodState.customRiverPath = traceTerrainValleyRiver(coords, 0.12);
      const label = document.getElementById('floodZoneLabel');
      if (label) label.textContent = 'Cauce: ' + coords[1].toFixed(3) + ', ' + coords[0].toFixed(3);
      if (typeof toast === 'function') toast('✓ Cauce fluvial real trazado en el punto seleccionado', 'success');
    }

    floodState.pickMode = false;
    maplibreMap.getCanvas().style.cursor = '';
    updateFloodSimulation();
  });
}

// Limpieza de memoria y recursos al salir de 3D
function disposeFloodSimulation() {
  if (floodState.simAnimId) cancelAnimationFrame(floodState.simAnimId);
  if (floodState.flowAnimId) cancelAnimationFrame(floodState.flowAnimId);
  stopRainAnimation();
  floodState.isSimulating = false;
  floodState.layersReady = false;
  floodState.pickMode = false;
  toggleFloodMenu(false);
}

// Exportación para interacción global desde la UI
window.toggleFloodSimulation = toggleFloodSimulation;
window.setFloodPrecipitation = setFloodPrecipitation;
window.onFloodZoneChange = onFloodZoneChange;
window.togglePlayFloodSimulation = togglePlayFloodSimulation;
window.resetFloodSimulation = resetFloodSimulation;
window.initFloodSimulation = initFloodSimulation;
window.disposeFloodSimulation = disposeFloodSimulation;

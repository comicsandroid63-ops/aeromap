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

// Coordenadas geográficas de los principales ejes fluviales y cuencas del Cesar
const riverBasins = {
  guatapuri: {
    name: 'Río Guatapurí (Valledupar)',
    camera: { center: [-73.250, 10.485], zoom: 13.5, pitch: 65, bearing: 35 },
    path: [
      [-73.345, 10.590], // Cañón Sierra Nevada
      [-73.325, 10.570],
      [-73.305, 10.545],
      [-73.288, 10.522],
      [-73.275, 10.505], // Garganta de Hurtado
      [-73.265, 10.495], // Balneario Hurtado / Parque de la Leyenda
      [-73.255, 10.482], // Puente Salguero / Margen Este de Valledupar
      [-73.245, 10.470], // Borde Urbano
      [-73.238, 10.455], // Asentamientos ribereños Pescadito / El Edén
      [-73.230, 10.438], // Vía a La Paz
      [-73.222, 10.418], // Meandros de El Jabo
      [-73.214, 10.395], // Sabanas y humedales de El Rincón
      [-73.205, 10.368], // Los Corazones
      [-73.195, 10.338]  // Confluencia con el Río Cesar
    ],
    tributaries: [
      // Arroyo Hurtado
      [[-73.295, 10.512], [-73.280, 10.502], [-73.265, 10.495]],
      // Arroyo Las Raíces
      [[-73.205, 10.470], [-73.218, 10.450], [-73.230, 10.438]]
    ]
  },
  cesar: {
    name: 'Valle del Río Cesar',
    camera: { center: [-73.320, 10.220], zoom: 12.2, pitch: 62, bearing: 45 },
    path: [
      [-73.120, 10.480],
      [-73.160, 10.420],
      [-73.195, 10.338], // Confluencia con Guatapurí
      [-73.240, 10.270], // Puente Salguero regional
      [-73.290, 10.210], // Cuenca La Paz / San Diego
      [-73.340, 10.150], // Meandros de El Paso
      [-73.390, 10.080],
      [-73.450, 10.010],
      [-73.510, 9.920]   // Hacia Ciénaga de Zapatosa
    ],
    tributaries: [
      [[-73.280, 10.290], [-73.260, 10.250], [-73.240, 10.270]]
    ]
  },
  sur: {
    name: 'Sur del Cesar (Depresión Momposina)',
    camera: { center: [-73.720, 8.820], zoom: 11.5, pitch: 58, bearing: 25 },
    path: [
      [-73.650, 8.920],
      [-73.710, 8.850], // Aguachica / Gamarra
      [-73.760, 8.780],
      [-73.820, 8.700], // Río Magdalena y caños
      [-73.880, 8.630],
      [-73.940, 8.560]
    ],
    tributaries: [
      [[-73.680, 8.890], [-73.710, 8.850]]
    ]
  }
};

// Suavizado Catmull-Rom para cauces fluviales continuos y orgánicos
function smoothRiverPath(points, subdivisions = 5) {
  if (!points || points.length < 3) return points || [];
  const smoothed = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    for (let t = 0; t < subdivisions; t++) {
      const u = t / subdivisions;
      const u2 = u * u;
      const u3 = u2 * u;

      const x = 0.5 * (
        (2 * p1[0]) +
        (-p0[0] + p2[0]) * u +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * u3
      );
      const y = 0.5 * (
        (2 * p1[1]) +
        (-p0[1] + p2[1]) * u +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3
      );
      smoothed.push([Number(x.toFixed(6)), Number(y.toFixed(6))]);
    }
  }
  smoothed.push(points[points.length - 1]);
  return smoothed;
}

// Construye el polígono de llanura de inundación a lo largo del cauce fluvial
function buildFloodplainPolygon(coords, widthDeg, asymmetry = 0.25) {
  if (!coords || coords.length < 2) return [];
  const leftSide = [];
  const rightSide = [];

  for (let i = 0; i < coords.length; i++) {
    const curr = coords[i];
    let dx = 0, dy = 0;

    if (i < coords.length - 1) {
      dx += coords[i + 1][0] - curr[0];
      dy += coords[i + 1][1] - curr[1];
    }
    if (i > 0) {
      dx += curr[0] - coords[i - 1][0];
      dy += curr[1] - coords[i - 1][1];
    }

    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    // Mayor expansión en el curso medio y bajo (planicies aluviales)
    const progress = i / (coords.length - 1);
    const localWidth = widthDeg * (0.65 + progress * 0.95 + Math.sin(i * 0.5) * 0.22);

    // Asimetría natural de meandros (desborde hacia la orilla externa y paleocauces)
    const wLeft = localWidth * (1 + asymmetry * Math.sin(i * 0.65));
    const wRight = localWidth * (1 - asymmetry * Math.sin(i * 0.65));

    leftSide.push([Number((curr[0] + nx * wLeft).toFixed(6)), Number((curr[1] + ny * wLeft).toFixed(6))]);
    rightSide.push([Number((curr[0] - nx * wRight).toFixed(6)), Number((curr[1] - ny * wRight).toFixed(6))]);
  }

  return leftSide.concat(rightSide.reverse()).concat([leftSide[0]]);
}

// Generador de cauce fluvial adaptativo para la vista visible en pantalla o clic personalizado
function generateAdaptiveRiverPath(centerLngLat, spanDeg = 0.12) {
  const [cLng, cLat] = centerLngLat;
  const count = 10;
  const path = [];
  
  // Flujo general hacia el Sur-Suroeste (pendiente natural regional)
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) - 0.5;
    const lng = cLng + t * spanDeg * 1.1 + Math.sin(i * 0.9) * (spanDeg * 0.18);
    const lat = cLat - t * spanDeg * 0.9 + Math.cos(i * 0.8) * (spanDeg * 0.12);
    path.push([Number(lng.toFixed(6)), Number(lat.toFixed(6))]);
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

// Inicialización de fuentes y capas de inundación en MapLibre 3D
function initFloodSimulation() {
  if (!maplibreMap) return;
  console.log('[3D-Flood] Inicializando motor de inundación fluvial...');

  // Obtener trazado del río de la zona activa
  let riverPath = riverBasins[floodState.zone]?.path;
  if (!riverPath && floodState.zone === 'custom' && floodState.customRiverPath) {
    riverPath = floodState.customRiverPath;
  }
  if (!riverPath) {
    const center = maplibreMap.getCenter();
    riverPath = generateAdaptiveRiverPath([center.lng, center.lat]);
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
        'fill-opacity': 0.40
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
        'fill-opacity': 0.62
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
        'fill-opacity': 0.84
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
        'line-width': 1.5,
        'line-opacity': 0.55
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
        'line-color': '#e0f2fe',
        'line-width': 3.0,
        'line-dasharray': [2, 3],
        'line-opacity': 0.85
      }
    });
  }

  floodState.layersReady = true;

  // Iniciar animación ligera de corriente de agua (~60fps con mínimo overhead)
  startRiverCurrentAnimation();

  // Actualizar dashboard y controles UI
  updateFloodUIDashboard(hydro);

  // Manejador de clics interactivos si está en modo selección de punto
  setupMaplibreFloodClickHandler();
}

// Actualiza la geometría y métricas según la precipitación y cuenca activa
function updateFloodSimulation() {
  if (!maplibreMap || !floodState.layersReady) return;

  let riverPath = riverBasins[floodState.zone]?.path;
  if (floodState.zone === 'custom' && floodState.customRiverPath) {
    riverPath = floodState.customRiverPath;
  }
  if (!riverPath) {
    const center = maplibreMap.getCenter();
    riverPath = generateAdaptiveRiverPath([center.lng, center.lat]);
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
    if (label) label.textContent = 'Haz clic en el mapa';
    if (typeof toast === 'function') toast('Haz clic en cualquier punto o río del mapa 3D para centrar la simulación', 'info');
    return;
  }

  floodState.pickMode = false;
  if (maplibreMap) maplibreMap.getCanvas().style.cursor = '';

  const basin = riverBasins[zoneKey];
  if (basin) {
    if (label) label.textContent = basin.name;
    // Volar suavemente la cámara 3D hacia la cuenca elegida
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
    if (label) label.textContent = 'Zona Visible';
    const center = maplibreMap.getCenter();
    const bounds = maplibreMap.getBounds();
    const span = Math.abs(bounds.getEast() - bounds.getWest()) * 0.8;
    floodState.customRiverPath = generateAdaptiveRiverPath([center.lng, center.lat], span);
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

// Reproducción interactiva de la Crecida Fluvial (Simulación dinámica en tiempo real)
function togglePlayFloodSimulation() {
  if (floodState.isSimulating) {
    // Pausar
    floodState.isSimulating = false;
    if (floodState.simAnimId) cancelAnimationFrame(floodState.simAnimId);
    updatePlayButtonUI(false);
  } else {
    // Iniciar crecida progresiva desde 10mm hasta la precipitación meta
    floodState.isSimulating = true;
    updatePlayButtonUI(true);

    const targetP = floodState.targetPrecipitation || 180;
    let currentP = Math.min(floodState.precipitation, 15);
    const duration = 6000; // 6 segundos
    const startTime = performance.now();
    const startP = currentP;

    function animateStep(now) {
      if (!floodState.isSimulating) return;

      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      // Easing suave (Cubic Out)
      const ease = 1 - Math.pow(1 - progress, 3);
      currentP = startP + (targetP - startP) * ease;

      floodState.precipitation = currentP;
      updateFloodSimulation();

      if (progress < 1) {
        floodState.simAnimId = requestAnimationFrame(animateStep);
      } else {
        floodState.isSimulating = false;
        updatePlayButtonUI(false);
        if (typeof toast === 'function') toast('✓ Crecida máxima alcanzada para ' + Math.round(targetP) + ' mm de lluvia', 'warning');
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
      btn.className = 'px-2.5 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-all flex items-center gap-1 bg-cyan-600 hover:bg-cyan-500 text-white shadow-sm';
      startRiverCurrentAnimation();
    } else {
      btn.innerHTML = '<span class="w-2 h-2 rounded-full bg-zinc-400"></span><span>Pausa</span>';
      btn.className = 'px-2.5 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-all flex items-center gap-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 shadow-sm';
    }
  }
}

// Minimizar o expandir el Dock flotante en 3D
function toggleMinimizeFloodDock() {
  const body = document.getElementById('floodDockBody');
  const icon = document.getElementById('iconMinimizeFlood');
  const dock = document.getElementById('flood3DDock');
  if (!body || !icon || !dock) return;

  floodState.isMinimized = !floodState.isMinimized;
  if (floodState.isMinimized) {
    body.style.display = 'none';
    icon.textContent = 'expand_more';
    dock.classList.add('w-auto');
    dock.classList.remove('w-80');
  } else {
    body.style.display = 'flex';
    icon.textContent = 'expand_less';
    dock.classList.remove('w-auto');
    dock.classList.add('w-80');
  }
}

// Clic interactivo en mapa 3D para ubicar punto de inundación
function setupMaplibreFloodClickHandler() {
  if (!maplibreMap || maplibreMap._floodClickBound) return;
  maplibreMap._floodClickBound = true;

  maplibreMap.on('click', (e) => {
    if (!floodState.pickMode) return;

    const coords = [Number(e.lngLat.lng.toFixed(6)), Number(e.lngLat.lat.toFixed(6))];
    console.log('[3D-Flood] Punto seleccionado para inundación:', coords);

    floodState.customRiverPath = generateAdaptiveRiverPath(coords, 0.10);
    floodState.pickMode = false;
    maplibreMap.getCanvas().style.cursor = '';

    const label = document.getElementById('floodZoneLabel');
    if (label) label.textContent = 'Punto: ' + coords[1].toFixed(3) + ', ' + coords[0].toFixed(3);

    updateFloodSimulation();
    if (typeof toast === 'function') toast('✓ Cuenca fluvial generada en el punto seleccionado', 'success');
  });
}

// Limpieza de memoria y recursos al salir de 3D
function disposeFloodSimulation() {
  if (floodState.simAnimId) cancelAnimationFrame(floodState.simAnimId);
  if (floodState.flowAnimId) cancelAnimationFrame(floodState.flowAnimId);
  floodState.isSimulating = false;
  floodState.layersReady = false;
  floodState.pickMode = false;
}

// Exportación para interacción global desde la UI
window.toggleFloodSimulation = toggleFloodSimulation;
window.setFloodPrecipitation = setFloodPrecipitation;
window.onFloodZoneChange = onFloodZoneChange;
window.togglePlayFloodSimulation = togglePlayFloodSimulation;
window.resetFloodSimulation = resetFloodSimulation;
window.toggleMinimizeFloodDock = toggleMinimizeFloodDock;
window.initFloodSimulation = initFloodSimulation;
window.disposeFloodSimulation = disposeFloodSimulation;

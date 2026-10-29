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
      },
      osmHydroSource: {
        type: 'vector',
        tiles: ['https://tiles.openfreemap.org/planet/20261025_080012_pt/{z}/{x}/{y}.pbf'],
        minzoom: 3,
        maxzoom: 14
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
      },
      {
        id: 'osm-waterways-global',
        type: 'line',
        source: 'osmHydroSource',
        'source-layer': 'waterway',
        filter: ['in', ['get', 'class'], ['literal', ['river', 'stream', 'canal']]],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'visibility': 'visible'
        },
        paint: {
          'line-color': '#0ea5e9',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 11, 2.8, 15, 6],
          'line-opacity': 0.75
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
//  3D FLOOD SIMULATION ENGINE (REAL-RIVER HYDROLOGY & MAPLIBRE 3D INTEGRATION)
//  Basado en ríos reales mundiales · Trazado directo en pantalla · Sin ríos inventados
// ════════════════════════════════════════════════════════════════════════════════

const floodState = {
  active: true,
  precipitation: 120,
  targetPrecipitation: 120,
  isSimulating: false,
  simAnimId: null,
  flowAnimId: null,
  layersReady: false,
  flowPhase: 0,
  riverPath: null,        // Coordenadas continuas [[lng, lat], ...] del cauce real
  riverName: 'Río Real',
  userPolygon: null,      // Perímetro poligonal opcional [[lng, lat], ...]
  polygonAreaHa: 0
};

const floodDrawingState = {
  isDrawing: false,
  mode: 'river',          // 'river' (trazar cauce) o 'polygon' (delimitar área)
  points: [],
  tempPoint: null
};

// ════════════════════════════════════════════════════════════════════════════════
//  UTILIDADES GEOMÉTRICAS Y ESPACIALES (WGS84 & CATMULL-ROM SPLINES)
// ════════════════════════════════════════════════════════════════════════════════

function computePolygonAreaHa(ring) {
  if (!ring || ring.length < 3) return 0;
  let area = 0;
  const latRad = (ring[0][1] * Math.PI) / 180;
  const mPerDegLat = 111132;
  const mPerDegLng = 111132 * Math.cos(latRad);
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i][0] * mPerDegLng;
    const y1 = ring[i][1] * mPerDegLat;
    const x2 = ring[i + 1][0] * mPerDegLng;
    const y2 = ring[i + 1][1] * mPerDegLat;
    area += (x1 * y2 - x2 * y1);
  }
  return Math.abs(area) / (2 * 10000);
}

function isPointInPolygon(point, vs) {
  const x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0], yi = vs[i][1];
    const xj = vs[j][0], yj = vs[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Suavizado Catmull-Rom para curvas fluviales continuas sin artefactos ni zig-zag
function smoothRiverPath(points, subdivs = 3) {
  if (!points || points.length < 2) return points || [];
  const result = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = i > 0 ? points[i - 1] : points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i < points.length - 2 ? points[i + 2] : p2;
    for (let j = 0; j < subdivs; j++) {
      const t = j / subdivs;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      result.push([Number(x.toFixed(6)), Number(y.toFixed(6))]);
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

// Construye un polígono de lámina de agua que se expande a ambos lados del cauce real
function buildFloodplainPolygon(coords, halfWidthDeg, meanderNoise = 0.15) {
  if (!coords || coords.length < 2) return [];
  const left = [];
  const right = [];
  const len = coords.length;
  for (let i = 0; i < len; i++) {
    const prev = coords[Math.max(0, i - 1)];
    const next = coords[Math.min(len - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const mag = Math.hypot(dx, dy) || 1e-6;
    const nx = -dy / mag;
    const ny = dx / mag;
    const noise = 1 + Math.sin(i * 0.95) * meanderNoise;
    const w = halfWidthDeg * noise;
    left.push([Number((coords[i][0] + nx * w).toFixed(6)), Number((coords[i][1] + ny * w).toFixed(6))]);
    right.push([Number((coords[i][0] - nx * w).toFixed(6)), Number((coords[i][1] - ny * w).toFixed(6))]);
  }
  const ring = left.concat(right.reverse());
  if (ring.length > 0) ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

// ════════════════════════════════════════════════════════════════════════════════
//  IDENTIFICACIÓN DE RÍOS REALES EN LA VISTA O EN EL POLÍGONO DEL USUARIO
// ════════════════════════════════════════════════════════════════════════════════

// Consulta las líneas reales de ríos presentes en la red hidrográfica renderizada en MapLibre
function queryRealWaterwaysInView(polygonFilter = null) {
  if (!maplibreMap) return null;

  let features = [];
  try {
    features = maplibreMap.queryRenderedFeatures(undefined, {
      layers: ['osm-waterways-global']
    });
  } catch (_) {}

  if (!features || features.length === 0) return null;

  // Filtrar y ordenar ríos por longitud para tomar el cauce principal
  const candidateLines = [];
  for (const feat of features) {
    if (!feat.geometry) continue;
    const geom = feat.geometry;
    const name = feat.properties?.name || 'Río Principal';

    if (geom.type === 'LineString' && geom.coordinates?.length >= 2) {
      const coords = geom.coordinates;
      // Si hay filtro de polígono, verificar que al menos un punto esté dentro
      if (polygonFilter) {
        const inside = coords.some(pt => isPointInPolygon(pt, polygonFilter));
        if (inside) candidateLines.push({ name, coords, len: coords.length });
      } else {
        candidateLines.push({ name, coords, len: coords.length });
      }
    } else if (geom.type === 'MultiLineString' && geom.coordinates) {
      for (const line of geom.coordinates) {
        if (line.length >= 2) {
          if (polygonFilter) {
            const inside = line.some(pt => isPointInPolygon(pt, polygonFilter));
            if (inside) candidateLines.push({ name, coords: line, len: line.length });
          } else {
            candidateLines.push({ name, coords: line, len: line.length });
          }
        }
      }
    }
  }

  if (candidateLines.length === 0) return null;

  // Elegir el río más largo / principal
  candidateLines.sort((a, b) => b.len - a.len);
  return candidateLines[0];
}

// Traza un cauce continuo y suave a través del centro de un polígono (sin saltos ni zig-zag)
function generateSmoothMidlineAcrossPolygon(polygonRing) {
  if (!polygonRing || polygonRing.length < 3) return null;

  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const pt of polygonRing) {
    if (pt[0] < minLng) minLng = pt[0];
    if (pt[0] > maxLng) maxLng = pt[0];
    if (pt[1] < minLat) minLat = pt[1];
    if (pt[1] > maxLat) maxLat = pt[1];
  }

  const dLng = maxLng - minLng;
  const dLat = maxLat - minLat;

  // Generar 7 puntos a lo largo del eje principal que cruzan el polígono de un lado al otro
  const pts = [];
  const numSteps = 7;
  for (let i = 0; i <= numSteps; i++) {
    const t = i / numSteps;
    let x, y;
    if (dLng >= dLat) {
      // Flujo Este-Oeste suave
      x = minLng + t * dLng;
      // Curvatura suave natural (sin zig-zag)
      y = minLat + (0.35 + 0.3 * Math.sin(t * Math.PI)) * dLat;
    } else {
      // Flujo Norte-Sur suave
      y = minLat + t * dLat;
      x = minLng + (0.35 + 0.3 * Math.sin(t * Math.PI)) * dLng;
    }
    pts.push([Number(x.toFixed(6)), Number(y.toFixed(6))]);
  }

  return smoothRiverPath(pts, 4);
}

// ════════════════════════════════════════════════════════════════════════════════
//  MODELO HIDROLÓGICO: CÁLCULO DE CRECIDA DESDE EL CAUCE REAL
// ════════════════════════════════════════════════════════════════════════════════
function computeHydrologicalFlood(riverCoords, precipitationMm) {
  const p = Math.max(0, precipitationMm);
  const smoothed = smoothRiverPath(riverCoords, 4);

  // Cota de subida del río (Delta H en metros por encima del lecho base)
  const deltaH = Math.min(8.5, Math.pow(p / 30, 1.15) * 0.65);
  // Caudal punta estimado (Q en m3/s)
  const discharge = Math.round(15 + Math.pow(p / 14, 1.42) * 28);

  const mToDeg = 0.0000095;
  // Ancho del lecho en estiaje / caudal base
  const baseW = (24 + Math.min(50, deltaH * 7.5)) * mToDeg;

  // Umbral de desbordamiento de orilla (1.0m)
  const overflowH = Math.max(0, deltaH - 1.0);
  const maxSpreadDeg = baseW + Math.pow(overflowH, 1.34) * 160 * mToDeg;

  // Cálculo de superficie anegada en Hectáreas
  let floodedAreaHa = 0;
  if (floodState.polygonAreaHa > 0) {
    const fillRatio = p <= 15 ? 0.08 : (p >= 350 ? 0.95 : (0.08 + Math.pow((p - 15) / 335, 1.1) * 0.87));
    floodedAreaHa = Math.round(floodState.polygonAreaHa * fillRatio);
  } else {
    floodedAreaHa = Math.round(18 + Math.pow(p / 16, 1.38) * 32);
  }

  const polygonFeatures = [];

  // Nivel 1: Cauce Principal / Zonas Profundas (> 2.0m)
  polygonFeatures.push({
    type: 'Feature',
    properties: { tier: 'deep', depthM: (deltaH + 1.2).toFixed(1) },
    geometry: { type: 'Polygon', coordinates: [buildFloodplainPolygon(smoothed, baseW * 1.15, 0.12)] }
  });

  // Nivel 2: Llanura de Inundación / Nivel Medio (0.8m - 2.0m)
  if (p > 35) {
    const medWidth = baseW + (maxSpreadDeg - baseW) * 0.62;
    polygonFeatures.push({
      type: 'Feature',
      properties: { tier: 'medium', depthM: (deltaH * 0.65).toFixed(1) },
      geometry: { type: 'Polygon', coordinates: [buildFloodplainPolygon(smoothed, medWidth, 0.22)] }
    });
  }

  // Nivel 3: Zonas Anegadas Marginales / Bajo Nivel (< 0.8m)
  if (p > 85) {
    polygonFeatures.push({
      type: 'Feature',
      properties: { tier: 'shallow', depthM: (deltaH * 0.30).toFixed(1) },
      geometry: { type: 'Polygon', coordinates: [buildFloodplainPolygon(smoothed, maxSpreadDeg, 0.30)] }
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
//  SISTEMA DE ANIMACIÓN DE LLUVIA & TEMPESTAD (CANVAS 60 FPS NATIVO)
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

    // Solo animar si la capa 3D está activa y la lluvia acumulada > 4 mm
    if (floodState.active && p > 4) {
      const maxDrops = Math.min(950, Math.round(50 + Math.pow(p / 14, 1.25) * 45));

      while (rainDrops.length < maxDrops) {
        rainDrops.push({
          x: Math.random() * (w + 200) - 100,
          y: Math.random() * -h,
          length: 12 + Math.random() * 18 + (p / 25),
          speed: 16 + Math.random() * 14 + (p / 20),
          alpha: 0.15 + Math.random() * 0.45,
          thickness: 1 + Math.random() * 1.2
        });
      }

      if (rainDrops.length > maxDrops) {
        rainDrops.length = maxDrops;
      }

      rainCtx.lineWidth = 1.2;
      const windAngle = 0.18;
      for (let i = 0; i < rainDrops.length; i++) {
        const d = rainDrops[i];
        d.x += d.speed * windAngle;
        d.y += d.speed;

        rainCtx.strokeStyle = `rgba(186, 230, 253, ${d.alpha})`;
        rainCtx.lineWidth = d.thickness;
        rainCtx.beginPath();
        rainCtx.moveTo(d.x, d.y);
        rainCtx.lineTo(d.x + d.length * windAngle, d.y + d.length);
        rainCtx.stroke();

        if (d.y > h - 100 + Math.random() * 90) {
          if (rainSplashes.length < 80 && Math.random() < 0.28) {
            rainSplashes.push({
              x: d.x,
              y: d.y,
              radius: 1,
              maxRadius: 3 + Math.random() * 6 + (p / 60),
              alpha: 0.6
            });
          }
          d.y = -10 - Math.random() * 50;
          d.x = Math.random() * (w + 200) - 100;
        }
      }

      for (let i = rainSplashes.length - 1; i >= 0; i--) {
        const s = rainSplashes[i];
        s.radius += 0.6;
        s.alpha *= 0.88;

        rainCtx.strokeStyle = `rgba(224, 242, 254, ${s.alpha.toFixed(2)})`;
        rainCtx.lineWidth = 0.9;
        rainCtx.beginPath();
        rainCtx.ellipse(s.x, s.y, s.radius * 2, s.radius * 0.8, 0, 0, Math.PI * 2);
        rainCtx.stroke();

        if (s.alpha < 0.05 || s.radius >= s.maxRadius) {
          rainSplashes.splice(i, 1);
        }
      }

      if (p > 120) {
        const hazeAlpha = Math.min(0.24, (p - 120) / 900);
        rainCtx.fillStyle = `rgba(15, 23, 42, ${hazeAlpha})`;
        rainCtx.fillRect(0, 0, w, h);
      }
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

// ════════════════════════════════════════════════════════════════════════════════
//  DIBUJO INTERACTIVO EN MAPA 3D: TRAZAR RÍO O DELIMITAR ÁREA
// ════════════════════════════════════════════════════════════════════════════════

function initFloodDrawingLayers() {
  if (!maplibreMap) return;

  if (!maplibreMap.getSource('flood-drawing-source')) {
    maplibreMap.addSource('flood-drawing-source', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
  }

  if (!maplibreMap.getLayer('flood-drawing-polygon')) {
    maplibreMap.addLayer({
      id: 'flood-drawing-polygon',
      type: 'fill',
      source: 'flood-drawing-source',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': '#06b6d4',
        'fill-opacity': 0.18
      }
    });
  }

  if (!maplibreMap.getLayer('flood-drawing-line')) {
    maplibreMap.addLayer({
      id: 'flood-drawing-line',
      type: 'line',
      source: 'flood-drawing-source',
      filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
      paint: {
        'line-color': '#22d3ee',
        'line-width': 3,
        'line-dasharray': [2, 2]
      }
    });
  }

  if (!maplibreMap.getLayer('flood-drawing-points')) {
    maplibreMap.addLayer({
      id: 'flood-drawing-points',
      type: 'circle',
      source: 'flood-drawing-source',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5.5,
        'circle-color': '#38bdf8',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff'
      }
    });
  }
}

function updateDrawingGeoJSON() {
  if (!maplibreMap) return;
  const src = maplibreMap.getSource('flood-drawing-source');
  if (!src) return;

  const features = [];
  const pts = floodDrawingState.points.slice();

  const allPts = pts.slice();
  if (floodDrawingState.tempPoint) {
    allPts.push(floodDrawingState.tempPoint);
  }

  for (let i = 0; i < pts.length; i++) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pts[i] },
      properties: { index: i }
    });
  }

  if (allPts.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: allPts },
      properties: {}
    });
  }

  if (floodDrawingState.mode === 'polygon' && allPts.length >= 3) {
    const ring = allPts.slice();
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
      ring.push(ring[0]);
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {}
    });
  }

  src.setData({ type: 'FeatureCollection', features });
}

// 1. MODO: Trazar el cauce real del río haciendo clics directamente sobre la imagen
function startDrawingFloodRiver() {
  if (!maplibreMap) return;
  initFloodDrawingLayers();
  floodDrawingState.isDrawing = true;
  floodDrawingState.mode = 'river';
  floodDrawingState.points = [];
  floodDrawingState.tempPoint = null;
  updateDrawingGeoJSON();

  maplibreMap.getCanvas().style.cursor = 'crosshair';

  const hud = document.getElementById('floodDrawingHUD');
  if (hud) hud.style.display = 'flex';

  const title = document.getElementById('floodHUDTitle');
  if (title) title.textContent = 'Trazar Cauce del Río Real';

  const sub = document.getElementById('floodHUDSubtitle');
  if (sub) sub.textContent = 'Haz clic a lo largo del río visible en la imagen satelital. Doble clic para terminar.';

  const vCount = document.getElementById('floodDrawVertexCount');
  if (vCount) vCount.textContent = '0 puntos';

  const icon = document.getElementById('floodHUDIcon');
  if (icon) icon.textContent = 'route';

  if (typeof toast === 'function') {
    toast('✏️ Haz clic a lo largo del río visible en la imagen para marcar su cauce real.', 'info');
  }
}

// 2. MODO: Delimitar el área o cuenca de inundación (Polígono)
function startDrawingFloodPolygon() {
  if (!maplibreMap) return;
  initFloodDrawingLayers();
  floodDrawingState.isDrawing = true;
  floodDrawingState.mode = 'polygon';
  floodDrawingState.points = [];
  floodDrawingState.tempPoint = null;
  updateDrawingGeoJSON();

  maplibreMap.getCanvas().style.cursor = 'crosshair';

  const hud = document.getElementById('floodDrawingHUD');
  if (hud) hud.style.display = 'flex';

  const title = document.getElementById('floodHUDTitle');
  if (title) title.textContent = 'Delimitar Área de Inundación';

  const sub = document.getElementById('floodHUDSubtitle');
  if (sub) sub.textContent = 'Haz clic para marcar el perímetro de la zona. Doble clic para cerrar.';

  const vCount = document.getElementById('floodDrawVertexCount');
  if (vCount) vCount.textContent = '0 vértices';

  const icon = document.getElementById('floodHUDIcon');
  if (icon) icon.textContent = 'polyline';

  if (typeof toast === 'function') {
    toast('📐 Haz clic en el mapa 3D para delimitar el área de inundación.', 'info');
  }
}

function finishCurrentFloodDrawing() {
  if (!floodDrawingState.isDrawing) return;

  const pts = floodDrawingState.points;

  if (floodDrawingState.mode === 'river') {
    if (pts.length < 2) {
      if (typeof toast === 'function') toast('⚠️ Marca al menos 2 puntos a lo largo del río.', 'warning');
      return;
    }

    floodState.riverPath = smoothRiverPath(pts, 4);
    floodState.riverName = 'Cauce trazado en pantalla';

    floodDrawingState.isDrawing = false;
    floodDrawingState.tempPoint = null;
    if (maplibreMap) maplibreMap.getCanvas().style.cursor = '';
    const hud = document.getElementById('floodDrawingHUD');
    if (hud) hud.style.display = 'none';

    const label = document.getElementById('floodZoneLabel');
    if (label) label.textContent = `Río: Cauce trazado (${pts.length} pts) ✓`;

    const badge = document.getElementById('floodAreaStatusBadge');
    if (badge) {
      badge.textContent = 'Río Trazado';
      badge.className = 'text-[8px] font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-400/30';
    }

    // Mostrar el cauce trazado
    const src = maplibreMap.getSource('flood-drawing-source');
    if (src) {
      src.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: floodState.riverPath },
          properties: {}
        }]
      });
    }

    updateFloodSimulation();
    if (typeof toast === 'function') {
      toast(`✓ Cauce real trazado con éxito (${pts.length} puntos). Simulación activa.`, 'success');
    }
  } else {
    // Modo Polígono
    if (pts.length < 3) {
      if (typeof toast === 'function') toast('⚠️ Debes marcar al menos 3 puntos para cerrar un área.', 'warning');
      return;
    }

    const closedRing = pts.slice();
    if (closedRing[0][0] !== closedRing[closedRing.length - 1][0] || closedRing[0][1] !== closedRing[closedRing.length - 1][1]) {
      closedRing.push([closedRing[0][0], closedRing[0][1]]);
    }

    floodState.userPolygon = closedRing;
    floodState.polygonAreaHa = computePolygonAreaHa(closedRing);

    floodDrawingState.isDrawing = false;
    floodDrawingState.tempPoint = null;
    if (maplibreMap) maplibreMap.getCanvas().style.cursor = '';
    const hud = document.getElementById('floodDrawingHUD');
    if (hud) hud.style.display = 'none';

    // Si aún no hay río trazado, buscar río real en la hidrografía o generar eje continuo
    if (!floodState.riverPath) {
      const realRiver = queryRealWaterwaysInView(closedRing);
      if (realRiver) {
        floodState.riverPath = smoothRiverPath(realRiver.coords, 3);
        floodState.riverName = realRiver.name;
      } else {
        floodState.riverPath = generateSmoothMidlineAcrossPolygon(closedRing);
        floodState.riverName = 'Eje fluvial de la cuenca';
      }
    }

    const label = document.getElementById('floodZoneLabel');
    if (label) {
      label.textContent = `Área: ${floodState.polygonAreaHa.toFixed(0)} Ha · ${floodState.riverName} ✓`;
    }
    const badge = document.getElementById('floodAreaStatusBadge');
    if (badge) {
      badge.textContent = `${floodState.polygonAreaHa.toFixed(0)} Ha`;
      badge.className = 'text-[8px] font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-400/30';
    }

    const src = maplibreMap.getSource('flood-drawing-source');
    if (src) {
      src.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [closedRing] },
          properties: {}
        }]
      });
    }

    updateFloodSimulation();
    if (typeof toast === 'function') {
      toast(`✓ Área de ${floodState.polygonAreaHa.toFixed(0)} Ha delimitada.`, 'success');
    }
  }
}

function cancelCurrentFloodDrawing() {
  floodDrawingState.isDrawing = false;
  floodDrawingState.points = [];
  floodDrawingState.tempPoint = null;
  if (maplibreMap) maplibreMap.getCanvas().style.cursor = '';

  const hud = document.getElementById('floodDrawingHUD');
  if (hud) hud.style.display = 'none';

  if (!floodState.userPolygon && !floodState.riverPath) {
    const src = maplibreMap?.getSource('flood-drawing-source');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }
}

// 3. Auto-detección de ríos reales en la vista
function autoDetectRealRiver() {
  if (!maplibreMap) return;

  const realRiver = queryRealWaterwaysInView(floodState.userPolygon);
  if (realRiver) {
    floodState.riverPath = smoothRiverPath(realRiver.coords, 3);
    floodState.riverName = realRiver.name;
    const label = document.getElementById('floodZoneLabel');
    if (label) label.textContent = `Río: ${realRiver.name} (Real detectado ✓)`;

    const badge = document.getElementById('floodAreaStatusBadge');
    if (badge) {
      badge.textContent = 'Río Detectado';
      badge.className = 'text-[8px] font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-400/30';
    }

    updateFloodSimulation();
    if (typeof toast === 'function') toast(`✓ Río real detectado: ${realRiver.name}`, 'success');
  } else {
    // Si no está en el mapa base, invitar a trazar el río directamente
    startDrawingFloodRiver();
    if (typeof toast === 'function') {
      toast('💡 Haz clic sobre el río visible en la imagen satelital para trazarlo exactamente.', 'info');
    }
  }
}

function useViewportAsFloodArea() {
  if (!maplibreMap) return;
  initFloodDrawingLayers();

  const bounds = maplibreMap.getBounds();
  const w = Number(bounds.getWest().toFixed(6));
  const e = Number(bounds.getEast().toFixed(6));
  const s = Number(bounds.getSouth().toFixed(6));
  const n = Number(bounds.getNorth().toFixed(6));

  const viewportRing = [[w, s], [e, s], [e, n], [w, n], [w, s]];
  floodState.userPolygon = viewportRing;
  floodState.polygonAreaHa = computePolygonAreaHa(viewportRing);

  // Buscar río real en la vista
  const realRiver = queryRealWaterwaysInView(viewportRing);
  if (realRiver) {
    floodState.riverPath = smoothRiverPath(realRiver.coords, 3);
    floodState.riverName = realRiver.name;
  } else if (!floodState.riverPath) {
    floodState.riverPath = generateSmoothMidlineAcrossPolygon(viewportRing);
    floodState.riverName = 'Eje de cuenca visible';
  }

  const label = document.getElementById('floodZoneLabel');
  if (label) {
    label.textContent = `Área: Vista pantalla (${floodState.polygonAreaHa.toFixed(0)} Ha) · ${floodState.riverName} ✓`;
  }
  const badge = document.getElementById('floodAreaStatusBadge');
  if (badge) {
    badge.textContent = 'Pantalla';
    badge.className = 'text-[8px] font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/30';
  }

  const src = maplibreMap.getSource('flood-drawing-source');
  if (src) {
    src.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [viewportRing] },
        properties: {}
      }]
    });
  }

  updateFloodSimulation();
  if (typeof toast === 'function') {
    toast(`✓ Toda la vista fijada (${floodState.polygonAreaHa.toFixed(0)} Ha).`, 'info');
  }
}

function clearFloodAll() {
  floodState.userPolygon = null;
  floodState.riverPath = null;
  floodState.polygonAreaHa = 0;
  const src = maplibreMap?.getSource('flood-drawing-source');
  if (src) src.setData({ type: 'FeatureCollection', features: [] });

  useViewportAsFloodArea();
}

function setupMaplibreDrawingListeners() {
  if (!maplibreMap || maplibreMap._floodDrawingListenersAttached) return;
  maplibreMap._floodDrawingListenersAttached = true;

  maplibreMap.on('click', (e) => {
    if (!floodDrawingState.isDrawing) return;

    const pt = [Number(e.lngLat.lng.toFixed(6)), Number(e.lngLat.lat.toFixed(6))];

    // En modo polígono, si hace clic cerca del primer punto con 3+ vértices, cerramos
    if (floodDrawingState.mode === 'polygon' && floodDrawingState.points.length >= 3) {
      const first = floodDrawingState.points[0];
      const dist = Math.hypot(pt[0] - first[0], pt[1] - first[1]);
      if (dist < 0.0012) {
        finishCurrentFloodDrawing();
        return;
      }
    }

    floodDrawingState.points.push(pt);

    const vCount = document.getElementById('floodDrawVertexCount');
    if (vCount) {
      vCount.textContent = `${floodDrawingState.points.length} ${floodDrawingState.mode === 'river' ? 'puntos' : 'vértices'}`;
    }

    updateDrawingGeoJSON();
  });

  maplibreMap.on('mousemove', (e) => {
    if (!floodDrawingState.isDrawing || floodDrawingState.points.length === 0) return;
    floodDrawingState.tempPoint = [Number(e.lngLat.lng.toFixed(6)), Number(e.lngLat.lat.toFixed(6))];
    updateDrawingGeoJSON();
  });

  maplibreMap.on('dblclick', (e) => {
    if (!floodDrawingState.isDrawing) return;
    e.preventDefault();
    finishCurrentFloodDrawing();
  });
}

// ════════════════════════════════════════════════════════════════════════════════
//  INICIALIZACIÓN Y ACTUALIZACIÓN DE CAPAS DE INUNDACIÓN EN MAPLIBRE 3D
// ════════════════════════════════════════════════════════════════════════════════

function initFloodSimulation() {
  if (!maplibreMap) return;
  console.log('[3D-Flood] Inicializando simulación de inundación 3D con ríos reales...');

  initFloodDrawingLayers();
  setupMaplibreDrawingListeners();

  if (!floodState.userPolygon || !floodState.riverPath) {
    useViewportAsFloodArea();
    return;
  }

  const hydro = computeHydrologicalFlood(floodState.riverPath, floodState.precipitation);

  if (!maplibreMap.getSource('flood-water-source')) {
    maplibreMap.addSource('flood-water-source', {
      type: 'geojson',
      data: hydro.polygonsGeoJSON
    });
  } else {
    maplibreMap.getSource('flood-water-source').setData(hydro.polygonsGeoJSON);
  }

  if (!maplibreMap.getSource('flood-stream-source')) {
    maplibreMap.addSource('flood-stream-source', {
      type: 'geojson',
      data: hydro.streamGeoJSON
    });
  } else {
    maplibreMap.getSource('flood-stream-source').setData(hydro.streamGeoJSON);
  }

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

  startRiverCurrentAnimation();
  initRainEffect();
  updateFloodUIDashboard(hydro);
  initDraggableFloodMenu();
}

function updateFloodSimulation() {
  if (!maplibreMap || !floodState.layersReady) return;

  if (!floodState.riverPath) {
    const realRiver = queryRealWaterwaysInView(floodState.userPolygon);
    if (realRiver) {
      floodState.riverPath = smoothRiverPath(realRiver.coords, 3);
      floodState.riverName = realRiver.name;
    } else if (floodState.userPolygon) {
      floodState.riverPath = generateSmoothMidlineAcrossPolygon(floodState.userPolygon);
    } else {
      useViewportAsFloodArea();
      return;
    }
  }

  const hydro = computeHydrologicalFlood(floodState.riverPath, floodState.precipitation);

  try {
    const srcWater = maplibreMap.getSource('flood-water-source');
    if (srcWater) srcWater.setData(hydro.polygonsGeoJSON);

    const srcStream = maplibreMap.getSource('flood-stream-source');
    if (srcStream) srcStream.setData(hydro.streamGeoJSON);
  } catch (err) {
    console.warn('[3D-Flood] Error actualizando GeoJSON:', err);
  }

  updateFloodUIDashboard(hydro);
}

function startRiverCurrentAnimation() {
  if (floodState.flowAnimId) cancelAnimationFrame(floodState.flowAnimId);

  let lastTime = 0;
  function step(time) {
    if (!maplibreMap || !floodState.active || !floodState.layersReady) return;

    if (time - lastTime > 80) {
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

// ════════════════════════════════════════════════════════════════════════════════
//  DASHBOARD HIDROLÓGICO Y CONTROLES INTERACTIVOS DE USUARIO
// ════════════════════════════════════════════════════════════════════════════════

function updateFloodUIDashboard(hydro) {
  const p = floodState.precipitation;

  const badgeP = document.getElementById('badgePrecipitation');
  if (badgeP) badgeP.textContent = Math.round(p) + ' mm';

  const slider = document.getElementById('sliderPrecipitation');
  if (slider && Math.abs(parseFloat(slider.value) - p) > 1) {
    slider.value = p;
  }

  const badgeR = document.getElementById('badgeFloodRisk');
  if (badgeR) {
    if (p < 40) {
      badgeR.textContent = 'Normal';
      badgeR.className = 'text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    } else if (p < 100) {
      badgeR.textContent = 'Alerta Amarilla';
      badgeR.className = 'text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30';
    } else if (p < 220) {
      badgeR.textContent = 'Alerta Naranja';
      badgeR.className = 'text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/30';
    } else {
      badgeR.textContent = 'Alerta Roja';
      badgeR.className = 'text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 animate-pulse';
    }
  }

  const metricL = document.getElementById('metricFloodLevel');
  if (metricL) metricL.textContent = '+' + hydro.deltaH.toFixed(1) + ' m';

  const metricQ = document.getElementById('metricFloodDischarge');
  if (metricQ) metricQ.textContent = hydro.discharge + ' m³/s';

  const metricA = document.getElementById('metricFloodArea');
  if (metricA) metricA.textContent = hydro.floodedAreaHa + ' Ha';
}

function setFloodPrecipitation(val) {
  const p = Math.max(0, Math.min(500, parseFloat(val) || 0));
  floodState.precipitation = p;
  floodState.targetPrecipitation = p;
  updateFloodSimulation();
}

function togglePlayFloodSimulation() {
  if (floodState.isSimulating) {
    floodState.isSimulating = false;
    if (floodState.simAnimId) cancelAnimationFrame(floodState.simAnimId);
    updatePlayButtonUI(false);
  } else {
    floodState.isSimulating = true;
    updatePlayButtonUI(true);

    const targetP = Math.max(120, floodState.targetPrecipitation || 260);
    const startP = 15;
    const duration = 7500;
    const startTime = performance.now();

    function animateStep(now) {
      if (!floodState.isSimulating) return;

      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
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
          toast(`✓ Crecida máxima alcanzada: Río desbordado a ${Math.round(targetP)} mm`, 'warning');
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

function disposeFloodSimulation() {
  if (floodState.simAnimId) cancelAnimationFrame(floodState.simAnimId);
  if (floodState.flowAnimId) cancelAnimationFrame(floodState.flowAnimId);
  stopRainAnimation();
  cancelCurrentFloodDrawing();
  floodState.isSimulating = false;
  floodState.layersReady = false;
  toggleFloodMenu(false);
}

// Exportación global para UI
window.startDrawingFloodRiver = startDrawingFloodRiver;
window.startDrawingFloodPolygon = startDrawingFloodPolygon;
window.finishCurrentFloodDrawing = finishCurrentFloodDrawing;
window.cancelCurrentFloodDrawing = cancelCurrentFloodDrawing;
window.autoDetectRealRiver = autoDetectRealRiver;
window.useViewportAsFloodArea = useViewportAsFloodArea;
window.clearFloodAll = clearFloodAll;
window.setFloodPrecipitation = setFloodPrecipitation;
window.togglePlayFloodSimulation = togglePlayFloodSimulation;
window.resetFloodSimulation = resetFloodSimulation;
window.toggleFloodSimulation = toggleFloodSimulation;
window.toggleFloodMenu = toggleFloodMenu;
window.initFloodSimulation = initFloodSimulation;
window.disposeFloodSimulation = disposeFloodSimulation;

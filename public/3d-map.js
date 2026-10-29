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
//  Basado en ríos reales mundiales · Trazado directo · Caudal Q interactivo (m³/s)
// ════════════════════════════════════════════════════════════════════════════════

const floodState = {
  active: true,
  discharge: 450,          // Caudal Q en m³/s (default 450)
  targetDischarge: 450,
  precipitation: 120,      // Precipitación acumulada en mm
  targetPrecipitation: 120,
  isSimulating: false,
  simAnimId: null,
  flowAnimId: null,
  layersReady: false,
  flowPhase: 0,
  riverPath: null,         // Coordenadas continuas [[lng, lat], ...] del cauce principal
  riverName: 'Río Real',
  secondaryRivers: [],     // Afluentes / ramales en la cuenca visible
  userPolygon: null,       // Perímetro poligonal opcional [[lng, lat], ...]
  polygonAreaHa: 0
};

const floodDrawingState = {
  isDrawing: false,
  mode: 'river',           // 'river' (trazar cauce) o 'polygon' (delimitar área)
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

// Suavizado Catmull-Rom para curvas fluviales continuas naturales
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

// Construye un polígono de lámina de agua que se expande orgánicamente desde el cauce
function buildFloodplainPolygon(coords, halfWidthDeg, meanderNoise = 0.12) {
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
//  EXTRACCIÓN Y ENLACE DE RÍOS REALES EN LA VISTA (OPENMAPTILES / OPENFREEMAP)
// ════════════════════════════════════════════════════════════════════════════════

function extractRiverPathsFromFeatures(features, polygonFilter = null) {
  if (!features || features.length === 0) return [];

  const rawLines = [];
  for (const feat of features) {
    if (!feat.geometry) continue;
    const geom = feat.geometry;
    const name = feat.properties?.name || feat.properties?.name_en || '';
    if (geom.type === 'LineString' && geom.coordinates?.length >= 2) {
      rawLines.push({ name, coords: geom.coordinates });
    } else if (geom.type === 'MultiLineString' && geom.coordinates) {
      for (const line of geom.coordinates) {
        if (line.length >= 2) rawLines.push({ name, coords: line });
      }
    }
  }

  if (rawLines.length === 0) return [];

  let filtered = rawLines;
  if (polygonFilter && polygonFilter.length >= 3) {
    const inside = rawLines.filter(item =>
      item.coords.some(pt => isPointInPolygon(pt, polygonFilter))
    );
    if (inside.length > 0) filtered = inside;
  }

  // Concatenar segmentos contiguos para formar cauces continuos a través del mapa
  const connected = [];
  const used = new Set();
  const dist = (p1, p2) => Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);

  for (let i = 0; i < filtered.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let chain = filtered[i].coords.slice();
    let name = filtered[i].name;

    let expanded = true;
    while (expanded) {
      expanded = false;
      const head = chain[0];
      const tail = chain[chain.length - 1];

      for (let j = 0; j < filtered.length; j++) {
        if (used.has(j)) continue;
        const other = filtered[j].coords;
        const oHead = other[0];
        const oTail = other[other.length - 1];
        const thresh = 0.0035; // ~300m tolerancia de empalme entre tramos OSM

        if (dist(tail, oHead) < thresh) {
          chain = chain.concat(other.slice(1));
          used.add(j);
          if (!name && filtered[j].name) name = filtered[j].name;
          expanded = true;
          break;
        } else if (dist(tail, oTail) < thresh) {
          chain = chain.concat(other.slice().reverse().slice(1));
          used.add(j);
          if (!name && filtered[j].name) name = filtered[j].name;
          expanded = true;
          break;
        } else if (dist(head, oTail) < thresh) {
          chain = other.slice().concat(chain.slice(1));
          used.add(j);
          if (!name && filtered[j].name) name = filtered[j].name;
          expanded = true;
          break;
        } else if (dist(head, oHead) < thresh) {
          chain = other.slice().reverse().concat(chain.slice(1));
          used.add(j);
          if (!name && filtered[j].name) name = filtered[j].name;
          expanded = true;
          break;
        }
      }
    }
    connected.push({ name: name || 'Río Principal', coords: chain });
  }

  // Ordenar por longitud de tramo descendente
  connected.sort((a, b) => b.coords.length - a.coords.length);
  return connected;
}

function queryRealWaterwaysInView(polygonFilter = null) {
  if (!maplibreMap) return null;

  let features = [];
  try {
    features = maplibreMap.queryRenderedFeatures(undefined, {
      layers: ['osm-waterways-global']
    });
  } catch (_) {}

  if (!features || features.length === 0) return null;

  const connected = extractRiverPathsFromFeatures(features, polygonFilter);
  if (connected.length === 0) return null;

  const mainRiver = connected[0];
  const secondaries = connected.slice(1, 4).map(c => c.coords);

  return {
    name: mainRiver.name,
    coords: mainRiver.coords,
    secondaries
  };
}

// Genera un eje central continuo y sinuoso para la cuenca o vista
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

  const pts = [];
  const numSteps = 8;
  for (let i = 0; i <= numSteps; i++) {
    const t = i / numSteps;
    let x, y;
    if (dLng >= dLat) {
      x = minLng + t * dLng;
      y = minLat + (0.35 + 0.3 * Math.sin(t * Math.PI)) * dLat;
    } else {
      y = minLat + t * dLat;
      x = minLng + (0.35 + 0.3 * Math.sin(t * Math.PI)) * dLng;
    }
    pts.push([Number(x.toFixed(6)), Number(y.toFixed(6))]);
  }

  return smoothRiverPath(pts, 4);
}

// ════════════════════════════════════════════════════════════════════════════════
//  MODELO HIDROLÓGICO: CÁLCULO DE CRECIDA DESDE EL CAUDAL Q (m³/s)
// ════════════════════════════════════════════════════════════════════════════════

function computeHydrologicalFlood(riverPathOrList, dischargeM3s, precipitationMm = null) {
  const discharge = Math.max(10, dischargeM3s || floodState.discharge || 450);

  // Derivar lluvia si no se pasa directamente
  const p = precipitationMm !== null
    ? Math.max(0, precipitationMm)
    : Math.round(14 * Math.pow(Math.max(0, discharge - 15) / 28, 1 / 1.42));

  // Cota de ascenso hidráulico (Delta H en metros sobre nivel de estiaje)
  const deltaH = Number((0.50 * Math.pow(discharge / 60, 0.42)).toFixed(2));

  // Factor de escala metros a grados (~111.132 km/grado a latitud tropical)
  const mToDeg = 0.0000092;

  // 1. Ancho medio del cauce principal (Deep Tier en metros)
  // At 60 m³/s -> ~112m; At 450 m³/s -> ~200m; At 1800 m³/s -> ~320m; At 4800 m³/s -> ~453m
  const baseW = (45 + 15 * Math.pow(discharge, 0.40)) * mToDeg;

  // 2. Llanura de inundación al desbordar orilla (Medium Tier)
  const medW = baseW * (1 + 0.90 * Math.pow(discharge / 350, 0.52));

  // 3. Anegamiento somero / cuenca marginal (Shallow Tier)
  const shallowW = baseW * (1 + 1.85 * Math.pow(discharge / 300, 0.62));

  // Cálculo de superficie anegada en Hectáreas
  let floodedAreaHa = 0;
  if (floodState.polygonAreaHa > 0) {
    const ratio = Math.min(1.0, 0.08 + 0.88 * Math.pow(discharge / 4500, 0.68));
    floodedAreaHa = Math.round(floodState.polygonAreaHa * ratio);
  } else {
    floodedAreaHa = Math.round(35 + 2.4 * Math.pow(discharge, 0.68));
  }

  // Normalizar lista de cauces
  let paths = [];
  if (Array.isArray(riverPathOrList) && Array.isArray(riverPathOrList[0]) && Array.isArray(riverPathOrList[0][0])) {
    paths = riverPathOrList;
  } else if (Array.isArray(riverPathOrList) && riverPathOrList.length >= 2) {
    paths = [riverPathOrList];
  }

  const polygonFeatures = [];
  const streamFeatures = [];

  paths.forEach((rawCoords, idx) => {
    if (!rawCoords || rawCoords.length < 2) return;
    const coords = smoothRiverPath(rawCoords, 3);
    const scale = idx === 0 ? 1.0 : 0.65; // Afluentes secundarios

    // Nivel 1: Cauce Principal / Zonas Profundas (>2m)
    const deepRing = buildFloodplainPolygon(coords, baseW * scale, 0.08);
    if (deepRing.length >= 4) {
      polygonFeatures.push({
        type: 'Feature',
        properties: { tier: 'deep', depthM: (deltaH + 1.2).toFixed(1) },
        geometry: { type: 'Polygon', coordinates: [deepRing] }
      });
    }

    // Nivel 2: Llanura de Inundación / Nivel Medio (0.8m - 2m)
    if (discharge > 120) {
      const medRing = buildFloodplainPolygon(coords, medW * scale, 0.16);
      if (medRing.length >= 4) {
        polygonFeatures.push({
          type: 'Feature',
          properties: { tier: 'medium', depthM: (deltaH * 0.70).toFixed(1) },
          geometry: { type: 'Polygon', coordinates: [medRing] }
        });
      }
    }

    // Nivel 3: Anegamiento Somero Marginal (<0.8m)
    if (discharge > 400) {
      const shallowRing = buildFloodplainPolygon(coords, shallowW * scale, 0.24);
      if (shallowRing.length >= 4) {
        polygonFeatures.push({
          type: 'Feature',
          properties: { tier: 'shallow', depthM: (deltaH * 0.35).toFixed(1) },
          geometry: { type: 'Polygon', coordinates: [shallowRing] }
        });
      }
    }

    // Thalweg / línea de flujo animada
    streamFeatures.push({
      type: 'Feature',
      properties: { discharge },
      geometry: { type: 'LineString', coordinates: coords }
    });
  });

  return {
    polygonsGeoJSON: { type: 'FeatureCollection', features: polygonFeatures },
    streamGeoJSON: { type: 'FeatureCollection', features: streamFeatures },
    deltaH,
    discharge: Math.round(discharge),
    precipitation: Math.round(p),
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
    toast('✏️ Haz clic a lo largo del río visible en la imagen satelital para trazar su cauce.', 'info');
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
    floodState.secondaryRivers = [];
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
      toast(`✓ Cauce trazado (${pts.length} puntos). Simulación activa.`, 'success');
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

    // Buscar río real dentro del área delimitada
    const realRiver = queryRealWaterwaysInView(closedRing);
    if (realRiver) {
      floodState.riverPath = smoothRiverPath(realRiver.coords, 3);
      floodState.secondaryRivers = realRiver.secondaries || [];
      floodState.riverName = realRiver.name;
    } else if (!floodState.riverPath) {
      floodState.riverPath = generateSmoothMidlineAcrossPolygon(closedRing);
      floodState.secondaryRivers = [];
      floodState.riverName = 'Eje fluvial de la cuenca';
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
function autoDetectRealRiver(verbose = true) {
  if (!maplibreMap) return;

  const realRiver = queryRealWaterwaysInView(floodState.userPolygon);
  if (realRiver) {
    floodState.riverPath = smoothRiverPath(realRiver.coords, 3);
    floodState.secondaryRivers = realRiver.secondaries || [];
    floodState.riverName = realRiver.name;
    const label = document.getElementById('floodZoneLabel');
    if (label) label.textContent = `Río: ${realRiver.name} (Real detectado ✓)`;

    const badge = document.getElementById('floodAreaStatusBadge');
    if (badge) {
      badge.textContent = 'Río Detectado';
      badge.className = 'text-[8px] font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-400/30';
    }

    updateFloodSimulation();
    if (verbose && typeof toast === 'function') toast(`✓ Río real detectado: ${realRiver.name}`, 'success');
  } else {
    if (verbose) {
      startDrawingFloodRiver();
      if (typeof toast === 'function') {
        toast('💡 Haz clic sobre el río visible en la imagen satelital para trazarlo exactamente.', 'info');
      }
    }
  }
}

function useViewportAsFloodArea() {
  if (!maplibreMap) return;
  ensureFloodLayersReady();

  const bounds = maplibreMap.getBounds();
  const w = Number(bounds.getWest().toFixed(6));
  const e = Number(bounds.getEast().toFixed(6));
  const s = Number(bounds.getSouth().toFixed(6));
  const n = Number(bounds.getNorth().toFixed(6));

  const viewportRing = [[w, s], [e, s], [e, n], [w, n], [w, s]];
  floodState.userPolygon = viewportRing;
  floodState.polygonAreaHa = computePolygonAreaHa(viewportRing);

  // Buscar ríos reales en la vista
  const realRiver = queryRealWaterwaysInView(viewportRing);
  if (realRiver) {
    floodState.riverPath = smoothRiverPath(realRiver.coords, 3);
    floodState.secondaryRivers = realRiver.secondaries || [];
    floodState.riverName = realRiver.name;
  } else if (!floodState.riverPath) {
    floodState.riverPath = generateSmoothMidlineAcrossPolygon(viewportRing);
    floodState.secondaryRivers = [];
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
}

function clearFloodAll() {
  floodState.userPolygon = null;
  floodState.riverPath = null;
  floodState.secondaryRivers = [];
  floodState.polygonAreaHa = 0;
  floodState.riverName = 'Río Real';

  const srcDraw = maplibreMap?.getSource('flood-drawing-source');
  if (srcDraw) srcDraw.setData({ type: 'FeatureCollection', features: [] });

  useViewportAsFloodArea();
  if (typeof toast === 'function') toast('Área restablecida a la vista completa', 'info');
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
//  INICIALIZACIÓN Y GESTIÓN DE FUENTES Y CAPAS EN MAPLIBRE 3D
// ════════════════════════════════════════════════════════════════════════════════

function ensureFloodLayersReady() {
  if (!maplibreMap) return false;
  if (!maplibreMap.isStyleLoaded()) {
    maplibreMap.once('styledata', () => {
      ensureFloodLayersReady();
      updateFloodSimulation();
    });
    return false;
  }

  initFloodDrawingLayers();

  if (!maplibreMap.getSource('flood-water-source')) {
    maplibreMap.addSource('flood-water-source', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
  }

  if (!maplibreMap.getSource('flood-stream-source')) {
    maplibreMap.addSource('flood-stream-source', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
  }

  if (!maplibreMap.getLayer('flood-shallow-layer')) {
    maplibreMap.addLayer({
      id: 'flood-shallow-layer',
      type: 'fill',
      source: 'flood-water-source',
      filter: ['==', ['get', 'tier'], 'shallow'],
      paint: {
        'fill-color': '#38bdf8',
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
        'fill-color': '#0284c7',
        'fill-opacity': 0.70
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
        'fill-color': '#075985',
        'fill-opacity': 0.90
      }
    });
  }

  if (!maplibreMap.getLayer('flood-fringe-layer')) {
    maplibreMap.addLayer({
      id: 'flood-fringe-layer',
      type: 'line',
      source: 'flood-water-source',
      paint: {
        'line-color': '#bae6fd',
        'line-width': 2.0,
        'line-opacity': 0.85
      }
    });
  }

  if (!maplibreMap.getLayer('flood-stream-layer')) {
    maplibreMap.addLayer({
      id: 'flood-stream-layer',
      type: 'line',
      source: 'flood-stream-source',
      paint: {
        'line-color': '#ffffff',
        'line-width': 3.5,
        'line-dasharray': [2, 3],
        'line-opacity': 0.95
      }
    });
  }

  floodState.layersReady = true;
  return true;
}

function initFloodSimulation() {
  if (!maplibreMap) return;
  console.log('[3D-Flood] Inicializando simulación de inundación 3D...');

  ensureFloodLayersReady();
  setupMaplibreDrawingListeners();
  initDraggableFloodMenu();

  if (!floodState.riverPath) {
    useViewportAsFloodArea();
  } else {
    updateFloodSimulation();
  }

  startRiverCurrentAnimation();
  initRainEffect();

  // Si los azulejos vectoriales terminan de renderizar después, auto-detectar río si usaba provisional
  maplibreMap.once('idle', () => {
    if (floodState.riverName === 'Eje de cuenca visible' || !floodState.riverPath) {
      const detected = queryRealWaterwaysInView(floodState.userPolygon);
      if (detected) {
        floodState.riverPath = smoothRiverPath(detected.coords, 3);
        floodState.secondaryRivers = detected.secondaries || [];
        floodState.riverName = detected.name;
        const label = document.getElementById('floodZoneLabel');
        if (label) label.textContent = `Río: ${detected.name} (Real detectado ✓)`;
        updateFloodSimulation();
      }
    }
  });
}

function updateFloodSimulation() {
  if (!maplibreMap) return;
  if (!ensureFloodLayersReady()) return;

  if (!floodState.riverPath) {
    const realRiver = queryRealWaterwaysInView(floodState.userPolygon);
    if (realRiver) {
      floodState.riverPath = smoothRiverPath(realRiver.coords, 3);
      floodState.secondaryRivers = realRiver.secondaries || [];
      floodState.riverName = realRiver.name;
    } else if (floodState.userPolygon) {
      floodState.riverPath = generateSmoothMidlineAcrossPolygon(floodState.userPolygon);
      floodState.secondaryRivers = [];
      floodState.riverName = 'Eje de cuenca visible';
    } else {
      useViewportAsFloodArea();
      return;
    }
  }

  const riverList = [floodState.riverPath];
  if (floodState.secondaryRivers && floodState.secondaryRivers.length > 0) {
    riverList.push(...floodState.secondaryRivers);
  }

  const hydro = computeHydrologicalFlood(riverList, floodState.discharge, floodState.precipitation);

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
  const q = hydro.discharge || floodState.discharge;
  const p = hydro.precipitation !== undefined ? hydro.precipitation : floodState.precipitation;

  // Actualizar input numérico de caudal si el usuario no está escribiendo en él
  const inputQ = document.getElementById('inputRiverDischarge');
  if (inputQ && document.activeElement !== inputQ) {
    inputQ.value = Math.round(q);
  }

  // Actualizar slider de caudal
  const sliderQ = document.getElementById('sliderFloodDischarge');
  if (sliderQ && Math.abs(parseFloat(sliderQ.value) - q) > 1) {
    sliderQ.value = Math.min(8000, Math.round(q));
  }

  // Actualizar slider y badge de lluvia
  const badgeP = document.getElementById('badgePrecipitation');
  if (badgeP) badgeP.textContent = Math.round(p) + ' mm';

  const sliderP = document.getElementById('sliderPrecipitation');
  if (sliderP && Math.abs(parseFloat(sliderP.value) - p) > 1) {
    sliderP.value = Math.min(450, Math.round(p));
  }

  // Badge de riesgo hidrológico
  const badgeR = document.getElementById('badgeFloodRisk');
  if (badgeR) {
    if (q < 180) {
      badgeR.textContent = 'Estiaje Normal';
      badgeR.className = 'text-[7.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    } else if (q < 800) {
      badgeR.textContent = 'Caudal Medio';
      badgeR.className = 'text-[7.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-400/30';
    } else if (q < 2400) {
      badgeR.textContent = 'Alerta Amarilla';
      badgeR.className = 'text-[7.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30';
    } else if (q < 6000) {
      badgeR.textContent = 'Alerta Naranja';
      badgeR.className = 'text-[7.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/30';
    } else {
      badgeR.textContent = 'Alerta Roja';
      badgeR.className = 'text-[7.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 animate-pulse';
    }
  }

  const metricL = document.getElementById('metricFloodLevel');
  if (metricL) metricL.textContent = '+' + hydro.deltaH.toFixed(1) + ' m';

  const metricQ = document.getElementById('metricFloodDischarge');
  if (metricQ) metricQ.textContent = Math.round(q) + ' m³/s';

  const metricA = document.getElementById('metricFloodArea');
  if (metricA) metricA.textContent = hydro.floodedAreaHa + ' Ha';
}

function setFloodDischarge(val) {
  const q = Math.max(10, Math.min(30000, parseFloat(val) || 0));
  floodState.discharge = q;
  floodState.targetDischarge = q;

  // Lluvia equivalente asociada
  const p = Math.round(14 * Math.pow(Math.max(0, q - 15) / 28, 1 / 1.42));
  floodState.precipitation = Math.max(0, Math.min(500, p));
  floodState.targetPrecipitation = floodState.precipitation;

  updateFloodSimulation();
}

function setFloodPrecipitation(val) {
  const p = Math.max(0, Math.min(500, parseFloat(val) || 0));
  floodState.precipitation = p;
  floodState.targetPrecipitation = p;

  // Caudal equivalente asociado
  const q = Math.round(15 + 28 * Math.pow(p / 14, 1.42));
  floodState.discharge = q;
  floodState.targetDischarge = q;

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

    const startQ = 80;
    const targetQ = Math.max(800, floodState.targetDischarge || 3500);
    const duration = 8000;
    const startTime = performance.now();

    function animateStep(now) {
      if (!floodState.isSimulating) return;

      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      const ease = progress * progress * (3 - 2 * progress);
      const currentQ = startQ + (targetQ - startQ) * ease;

      floodState.discharge = currentQ;
      const p = Math.round(14 * Math.pow(Math.max(0, currentQ - 15) / 28, 1 / 1.42));
      floodState.precipitation = Math.max(0, Math.min(500, p));

      updateFloodSimulation();

      if (progress < 1) {
        floodState.simAnimId = requestAnimationFrame(animateStep);
      } else {
        floodState.isSimulating = false;
        updatePlayButtonUI(false);
        if (typeof toast === 'function') {
          toast(`✓ Simulación completada: Crecida máxima de ${Math.round(targetQ)} m³/s alcanzada`, 'warning');
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
  setFloodDischarge(80);
  if (typeof toast === 'function') toast('Simulación de inundación restablecida a caudal base (80 m³/s)', 'info');
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

// ════════════════════════════════════════════════════════════════════════════════
//  EXPORTACIONES GLOBALES
// ════════════════════════════════════════════════════════════════════════════════
window.setFloodDischarge = setFloodDischarge;
window.setFloodPrecipitation = setFloodPrecipitation;
window.startDrawingFloodRiver = startDrawingFloodRiver;
window.startDrawingFloodPolygon = startDrawingFloodPolygon;
window.finishCurrentFloodDrawing = finishCurrentFloodDrawing;
window.cancelCurrentFloodDrawing = cancelCurrentFloodDrawing;
window.autoDetectRealRiver = autoDetectRealRiver;
window.useViewportAsFloodArea = useViewportAsFloodArea;
window.clearFloodAll = clearFloodAll;
window.togglePlayFloodSimulation = togglePlayFloodSimulation;
window.resetFloodSimulation = resetFloodSimulation;
window.toggleFloodSimulation = toggleFloodSimulation;
window.toggleFloodMenu = toggleFloodMenu;
window.initFloodSimulation = initFloodSimulation;
window.disposeFloodSimulation = disposeFloodSimulation;
window.ensureFloodLayersReady = ensureFloodLayersReady;

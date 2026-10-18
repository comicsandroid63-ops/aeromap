let maplibreMap = null;
let current3DBasemap = 'satellite';
let active3DLayers = {};

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

  const bm = basemapDefs[current3DBasemap];

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
    const dbg = document.getElementById('dbgGlobal');
    if (dbg) dbg.textContent += ' | LOADED';
    if (visibleLayers && visibleLayers.length) {
      console.log('[3D] Adding', visibleLayers.length, 'raster layers');
      if (dbg) dbg.textContent += ' | raster ' + visibleLayers.length;
      addRasterLayers(visibleLayers);
    } else {
      console.log('[3D] No raster layers to add');
    }
    if (vectorLayers && vectorLayers.length) {
      console.log('[3D] Adding', vectorLayers.length, 'vector layers');
      if (dbg) dbg.textContent += ' | vector ' + vectorLayers.length;
      addVectorLayers(vectorLayers);
    } else {
      console.log('[3D] No vector layers to add');
    }
    hideProgress();
  });

  maplibreMap.on('error', (e) => {
    console.error('[3D] MapLibre error:', e.error?.message || e);
    const dbg = document.getElementById('dbgGlobal');
    if (dbg) dbg.textContent += ' | ERROR: ' + (e.error?.message || e);
    hideProgress();
  });

  requestAnimationFrame(() => {
    maplibreMap.resize();
  });
}

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
        tiles: ['/terrain-dem/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14
      }
    },
    layers: [
      { id: 'base', type: 'raster', source: 'base' }
    ],
    terrain: {
      source: 'terrainSource',
      exaggeration: 1.5
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

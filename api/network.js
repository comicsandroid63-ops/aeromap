const express = require('express');
const router = express.Router();

// ─── Graph structure ───
function buildGraph(featureCollection) {
  const nodes = {};
  const edges = [];
  const nodeCoords = {};

  function addNode(id, lng, lat) {
    if (!nodes[id]) {
      nodes[id] = { id, lng, lat, adj: [] };
      nodeCoords[id] = { lng, lat };
    }
    return id;
  }

  function nodeKey(lng, lat) {
    return `${lng.toFixed(7)},${lat.toFixed(7)}`;
  }

  function getOrCreateNode(lng, lat) {
    const key = nodeKey(lng, lat);
    addNode(key, lng, lat);
    return key;
  }

  const MAX_LOOKUP_DIST = 1.0; // ~111km max — find nearest node within reason

  function findClosestNode(lng, lat) {
    let best = null;
    let bestDist = Infinity;
    for (const id in nodes) {
      const d = Math.hypot(nodes[id].lng - lng, nodes[id].lat - lat);
      if (d < bestDist) { bestDist = d; best = id; }
    }
    if (best && bestDist < MAX_LOOKUP_DIST) return best;
    // Fallback: return the closest regardless (up to the caller to validate)
    return best;
  }

  function splitLineAtNodes(coords) {
    if (coords.length < 2) return [];
    const segments = [];
    let current = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
      current.push(coords[i]);
      const p = coords[i];
      const key = nodeKey(p[0], p[1]);
      if (nodes[key] || i === coords.length - 1) {
        if (current.length >= 2) segments.push([...current]);
        current = [coords[i]];
      }
    }
    return segments;
  }

  function haversineDist(c1, c2) {
    const R = 6371000;
    const dLat = (c2[1] - c1[1]) * Math.PI / 180;
    const dLon = (c2[0] - c1[0]) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(c1[1] * Math.PI / 180) * Math.cos(c2[1] * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // First pass: add all vertices as nodes
  for (const feat of featureCollection.features || []) {
    if (feat.geometry?.type === 'LineString') {
      for (const coord of feat.geometry.coordinates) {
        getOrCreateNode(coord[0], coord[1]);
      }
    }
    if (feat.geometry?.type === 'MultiLineString') {
      for (const line of feat.geometry.coordinates) {
        for (const coord of line) {
          getOrCreateNode(coord[0], coord[1]);
        }
      }
    }
  }

  // Second pass: split lines at nodes and create edges
  for (const feat of featureCollection.features || []) {
    const props = feat.properties || {};
    if (feat.geometry?.type === 'LineString') {
      const segments = splitLineAtNodes(feat.geometry.coordinates);
      for (const seg of segments) {
        const from = getOrCreateNode(seg[0][0], seg[0][1]);
        const to = getOrCreateNode(seg[seg.length - 1][0], seg[seg.length - 1][1]);
        if (from === to) continue;
        const dist = haversineDist(seg[0], seg[seg.length - 1]);
        const edge = { from, to, dist, props };
        edges.push(edge);
        nodes[from].adj.push(edge);
        const rev = { from: to, to: from, dist, props };
        edges.push(rev);
        nodes[to].adj.push(rev);
      }
    }
    if (feat.geometry?.type === 'MultiLineString') {
      for (const line of feat.geometry.coordinates) {
        const segments = splitLineAtNodes(line);
        for (const seg of segments) {
          const from = getOrCreateNode(seg[0][0], seg[0][1]);
          const to = getOrCreateNode(seg[seg.length - 1][0], seg[seg.length - 1][1]);
          if (from === to) continue;
          const dist = haversineDist(seg[0], seg[seg.length - 1]);
          const edge = { from, to, dist, props };
          edges.push(edge);
          nodes[from].adj.push(edge);
          const rev = { from: to, to: from, dist, props };
          edges.push(rev);
          nodes[to].adj.push(rev);
        }
      }
    }
  }

  return { nodes, edges, nodeCoords, findClosestNode, haversineDist };
}

// ─── Dijkstra shortest path ───
function dijkstra(graph, sourceId, targetId) {
  const dist = {};
  const prev = {};
  const visited = new Set();
  const pq = [];

  for (const id in graph.nodes) {
    dist[id] = Infinity;
    prev[id] = null;
  }
  dist[sourceId] = 0;
  pq.push({ id: sourceId, dist: 0 });

  while (pq.length > 0) {
    pq.sort((a, b) => a.dist - b.dist);
    const u = pq.shift();
    if (u.id === targetId) break;
    if (visited.has(u.id)) continue;
    visited.add(u.id);

    for (const edge of graph.nodes[u.id].adj) {
      if (visited.has(edge.to)) continue;
      const alt = dist[u.id] + edge.dist;
      if (alt < dist[edge.to]) {
        dist[edge.to] = alt;
        prev[edge.to] = u.id;
        pq.push({ id: edge.to, dist: alt });
      }
    }
  }

  // Reconstruct path
  if (dist[targetId] === Infinity) return { path: null, distance: null };
  const coords = [];
  let current = targetId;
  while (current !== null) {
    coords.unshift([graph.nodes[current].lng, graph.nodes[current].lat]);
    current = prev[current];
  }

  return {
    path: { type: 'LineString', coordinates: coords },
    distance: dist[targetId],
  };
}

// ─── Service area (isochrone from source, limited by maxCost) ───
function serviceArea(graph, sourceId, maxCost) {
  const dist = {};
  const reachedEdges = [];
  const pq = [];

  for (const id in graph.nodes) dist[id] = Infinity;
  dist[sourceId] = 0;
  pq.push({ id: sourceId, dist: 0 });

  while (pq.length > 0) {
    pq.sort((a, b) => a.dist - b.dist);
    const u = pq.shift();
    if (u.dist > maxCost) break;

    for (const edge of graph.nodes[u.id].adj) {
      const alt = dist[u.id] + edge.dist;
      if (alt < dist[edge.to] && alt <= maxCost) {
        dist[edge.to] = alt;
        pq.push({ id: edge.to, dist: alt });
        // Record the edge that leads to this node
        reachedEdges.push({
          from: [graph.nodes[edge.from].lng, graph.nodes[edge.from].lat],
          to: [graph.nodes[edge.to].lng, graph.nodes[edge.to].lat],
          cost: alt,
        });
      }
    }
  }

  const reachableNodes = Object.entries(dist)
    .filter(([id, d]) => d > 0 && d <= maxCost)
    .map(([id, d]) => ({
      coordinates: [graph.nodes[id].lng, graph.nodes[id].lat],
      cost: d,
    }));

  return { reachableNodes, reachedEdges };
}

// ─── Closest facility ───
function closestFacility(graph, originId, facilityIds) {
  let best = null;
  let bestDist = Infinity;
  let bestPath = null;

  for (const fid of facilityIds) {
    if (fid === originId) continue;
    if (!graph.nodes[fid]) continue;
    const result = dijkstra(graph, originId, fid);
    if (result.path && result.distance < bestDist) {
      bestDist = result.distance;
      best = fid;
      bestPath = result;
    }
  }

  return {
    facility: best,
    distance: bestDist === Infinity ? null : bestDist,
    path: bestPath?.path || null,
  };
}

function getFeatureCenter(feature) {
  if (feature.geometry.type === 'Point') return { lng: feature.geometry.coordinates[0], lat: feature.geometry.coordinates[1] };
  if (feature.geometry.type === 'MultiPoint') return { lng: feature.geometry.coordinates[0][0], lat: feature.geometry.coordinates[0][1] };
  if (feature.geometry.type === 'LineString') {
    const c = feature.geometry.coordinates;
    const mid = Math.floor(c.length / 2);
    return { lng: c[mid][0], lat: c[mid][1] };
  }
  if (feature.geometry.type === 'Polygon') {
    const c = feature.geometry.coordinates[0];
    let sumLng = 0, sumLat = 0, n = 0;
    for (const p of c) { sumLng += p[0]; sumLat += p[1]; n++; }
    return { lng: sumLng / n, lat: sumLat / n };
  }
  return null;
}

// ─── POST /api/network/shortest-path ───
router.post('/shortest-path', async (req, res) => {
  try {
    const { network, origin, destination } = req.body;
    if (!network || !origin || !destination) {
      return res.status(400).json({ error: 'Se requieren: network (GeoJSON), origin (Point), destination (Point)' });
    }

    const graph = buildGraph(network);
    const originCenter = getFeatureCenter(origin);
    const destCenter = getFeatureCenter(destination);
    if (!originCenter || !destCenter) {
      return res.status(400).json({ error: 'No se pudieron determinar las coordenadas de origen/destino' });
    }

    const sourceNode = graph.findClosestNode(originCenter.lng, originCenter.lat);
    const targetNode = graph.findClosestNode(destCenter.lng, destCenter.lat);
    if (!sourceNode || !targetNode) {
      return res.status(404).json({ error: 'No se encontraron nodos cercanos en la red' });
    }

    const result = dijkstra(graph, sourceNode, targetNode);
    if (!result.path) {
      return res.status(404).json({ error: 'No se encontró una ruta entre los puntos' });
    }

    res.json({
      success: true,
      path: result.path,
      distance_meters: Math.round(result.distance),
      distance_km: parseFloat((result.distance / 1000).toFixed(3)),
      source_coords: [graph.nodes[sourceNode].lng, graph.nodes[sourceNode].lat],
      target_coords: [graph.nodes[targetNode].lng, graph.nodes[targetNode].lat],
      nodes_visited: Object.keys(graph.nodes).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/network/service-area ───
router.post('/service-area', async (req, res) => {
  try {
    const { network, origin, max_distance_meters = 1000 } = req.body;
    if (!network || !origin) {
      return res.status(400).json({ error: 'Se requieren: network (GeoJSON), origin (Point)' });
    }

    const graph = buildGraph(network);
    const originCenter = getFeatureCenter(origin);
    if (!originCenter) {
      return res.status(400).json({ error: 'No se pudo determinar la coordenada de origen' });
    }

    const sourceNode = graph.findClosestNode(originCenter.lng, originCenter.lat);
    if (!sourceNode) {
      return res.status(404).json({ error: 'No se encontró un nodo cercano en la red' });
    }

    const area = serviceArea(graph, sourceNode, max_distance_meters);

    // Build a polygon from reachable edge endpoints (concave hull approximation)
    const points = area.reachedEdges.map(e => [e.from, e.to]).flat();
    // Remove duplicates
    const seen = new Set();
    const uniquePoints = [];
    for (const p of points) {
      const k = `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
      if (!seen.has(k)) { seen.add(k); uniquePoints.push(p); }
    }

    res.json({
      success: true,
      reachable_nodes: area.reachableNodes,
      reached_edges: area.reachedEdges,
      edge_count: area.reachedEdges.length,
      max_distance_meters,
      points: uniquePoints,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/network/closest-facility ───
router.post('/closest-facility', async (req, res) => {
  try {
    const { network, origin, facilities } = req.body;
    if (!network || !origin || !facilities) {
      return res.status(400).json({ error: 'Se requieren: network (GeoJSON), origin (Point), facilities (FeatureCollection)' });
    }

    const graph = buildGraph(network);
    const originCenter = getFeatureCenter(origin);
    if (!originCenter) {
      return res.status(400).json({ error: 'No se pudo determinar la coordenada de origen' });
    }

    const sourceNode = graph.findClosestNode(originCenter.lng, originCenter.lat);
    if (!sourceNode) {
      return res.status(404).json({ error: 'No se encontró un nodo cercano en la red' });
    }

    const facilityIds = [];
    const facilityMap = {};
    for (const feat of facilities.features || []) {
      const center = getFeatureCenter(feat);
      if (center) {
        const node = graph.findClosestNode(center.lng, center.lat);
        if (node) {
          facilityIds.push(node);
          facilityMap[node] = { feature: feat, center };
        }
      }
    }

    if (facilityIds.length === 0) {
      return res.status(404).json({ error: 'No se encontraron facilities válidas en la red' });
    }

    const result = closestFacility(graph, sourceNode, facilityIds);
    if (!result.facility) {
      return res.status(404).json({ error: 'Ninguna facility es alcanzable desde el origen' });
    }

    res.json({
      success: true,
      closest_facility: facilityMap[result.facility] || null,
      distance_meters: Math.round(result.distance),
      distance_km: parseFloat((result.distance / 1000).toFixed(3)),
      path: result.path,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/network/build-graph ─── (debug/info)
router.post('/build-graph', async (req, res) => {
  try {
    const { network } = req.body;
    if (!network) return res.status(400).json({ error: 'Se requiere network (GeoJSON)' });

    const graph = buildGraph(network);
    const nodeCount = Object.keys(graph.nodes).length;
    const edgeCount = graph.edges.length;
    const totalLength = graph.edges.reduce((sum, e) => sum + e.dist, 0);

    res.json({
      success: true,
      node_count: nodeCount,
      edge_count: edgeCount,
      total_length_meters: Math.round(totalLength),
      total_length_km: parseFloat((totalLength / 1000).toFixed(3)),
      sample_nodes: Object.entries(graph.nodes).slice(0, 10).map(([id, n]) => ({ id, lng: n.lng, lat: n.lat })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

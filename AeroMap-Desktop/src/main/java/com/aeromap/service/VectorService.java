package com.aeromap.service;

import org.geotools.data.shapefile.ShapefileDataStore;
import org.geotools.data.simple.SimpleFeatureCollection;
import org.geotools.data.simple.SimpleFeatureIterator;
import org.geotools.data.simple.SimpleFeatureSource;
import org.opengis.feature.simple.SimpleFeature;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.index.strtree.STRtree;
import org.opengis.referencing.crs.CoordinateReferenceSystem;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

public class VectorService {

    public static class VectorData {
        public List<Geometry> geometries;
        public List<java.util.Map<String, Object>> attributes;
        public ReferencedEnvelope envelope;
        public CoordinateReferenceSystem crs;
        public STRtree spatialIndex;
        public java.util.Map<Geometry, java.util.Map<String, Object>> geomToAttrs;
        public javafx.scene.paint.Color color = javafx.scene.paint.Color.LIME;
        public javafx.scene.paint.Color fillColor = javafx.scene.paint.Color.LIME.deriveColor(0, 1, 1, 0.3);
        public double lineWidth = 1.5;
        public LabelService.LabelConfig labelConfig;
        
        public VectorData(List<Geometry> geometries, List<java.util.Map<String, Object>> attributes, ReferencedEnvelope envelope, CoordinateReferenceSystem crs) {
            this.geometries = geometries;
            this.attributes = attributes;
            this.envelope = envelope;
            this.crs = crs;
            rebuildIndex();
        }

        public void rebuildIndex() {
            this.spatialIndex = new STRtree();
            this.geomToAttrs = new java.util.HashMap<>();
            for (int i = 0; i < geometries.size(); i++) {
                Geometry g = geometries.get(i);
                spatialIndex.insert(g.getEnvelopeInternal(), g);
                geomToAttrs.put(g, i < attributes.size() ? attributes.get(i) : new java.util.HashMap<>());
            }
            this.spatialIndex.build();
        }
    }

    public VectorData loadShapefile(File file) throws IOException {
        List<Geometry> geometries = new ArrayList<>();
        List<java.util.Map<String, Object>> attributes = new ArrayList<>();
        ShapefileDataStore dataStore = new ShapefileDataStore(file.toURI().toURL());
        dataStore.setCharset(java.nio.charset.Charset.forName("UTF-8"));
        ReferencedEnvelope envelope = null;
        CoordinateReferenceSystem crs = null;
        try {
            String typeName = dataStore.getTypeNames()[0];
            SimpleFeatureSource featureSource = dataStore.getFeatureSource(typeName);
            envelope = featureSource.getBounds();
            crs = featureSource.getSchema().getCoordinateReferenceSystem();
            SimpleFeatureCollection collection = featureSource.getFeatures();
            
            try (SimpleFeatureIterator iterator = collection.features()) {
                while (iterator.hasNext()) {
                    SimpleFeature feature = iterator.next();
                    geometries.add((Geometry) feature.getDefaultGeometry());
                    
                    java.util.Map<String, Object> attrMap = new java.util.HashMap<>();
                    for (org.opengis.feature.Property prop : feature.getProperties()) {
                        if (!(prop.getValue() instanceof Geometry)) {
                            attrMap.put(prop.getName().getLocalPart(), prop.getValue());
                        }
                    }
                    attributes.add(attrMap);
                }
            }
        } finally {
            dataStore.dispose();
        }
        return new VectorData(geometries, attributes, envelope, crs);
    }
    public VectorData buffer(VectorData input, double distance) {
        List<Geometry> buffered = new ArrayList<>();
        for (Geometry g : input.geometries) {
            buffered.add(g.buffer(distance));
        }
        ReferencedEnvelope env = new ReferencedEnvelope(input.envelope);
        env.expandBy(distance);
        return new VectorData(buffered, input.attributes, env, input.crs);
    }

    public VectorData intersect(VectorData input, Geometry clipper) {
        List<Geometry> intersected = new ArrayList<>();
        for (Geometry g : input.geometries) {
            if (g.intersects(clipper)) {
                Geometry res = g.intersection(clipper);
                if (!res.isEmpty()) intersected.add(res);
            }
        }
        return new VectorData(intersected, new ArrayList<>(), new ReferencedEnvelope(clipper.getEnvelopeInternal(), input.crs), input.crs);
    }

    public VectorData union(VectorData a, VectorData b) {
        List<Geometry> results = new ArrayList<>();
        Geometry allB = b.geometries.get(0);
        for (int i=1; i<b.geometries.size(); i++) allB = allB.union(b.geometries.get(i));
        
        for (Geometry ga : a.geometries) {
            results.add(ga.union(allB));
        }
        ReferencedEnvelope env = new ReferencedEnvelope(a.envelope);
        env.expandToInclude(b.envelope);
        return new VectorData(results, new ArrayList<>(), env, a.crs);
    }

    public VectorData erase(VectorData input, VectorData eraser) {
        List<Geometry> results = new ArrayList<>();
        Geometry eraserGeom = eraser.geometries.get(0);
        for (int i=1; i<eraser.geometries.size(); i++) eraserGeom = eraserGeom.union(eraser.geometries.get(i));

        for (Geometry g : input.geometries) {
            results.add(g.difference(eraserGeom));
        }
        return new VectorData(results, input.attributes, input.envelope, input.crs);
    }

    public VectorData dissolve(VectorData input) {
        if (input.geometries.isEmpty()) return input;
        Geometry dissolved = input.geometries.get(0);
        for (int i=1; i<input.geometries.size(); i++) {
            dissolved = dissolved.union(input.geometries.get(i));
        }
        List<Geometry> results = new ArrayList<>();
        results.add(dissolved);
        return new VectorData(results, new ArrayList<>(), input.envelope, input.crs);
    }

    public VectorData simplify(VectorData input, double tolerance) {
        List<Geometry> results = new ArrayList<>();
        org.locationtech.jts.simplify.DouglasPeuckerSimplifier simplifier;
        for (Geometry g : input.geometries) {
            results.add(org.locationtech.jts.simplify.DouglasPeuckerSimplifier.simplify(g, tolerance));
        }
        return new VectorData(results, input.attributes, input.envelope, input.crs);
    }

    public VectorData convexHull(VectorData input) {
        org.locationtech.jts.geom.GeometryFactory factory = new org.locationtech.jts.geom.GeometryFactory();
        org.locationtech.jts.geom.GeometryCollection col = factory.createGeometryCollection(input.geometries.toArray(new Geometry[0]));
        List<Geometry> results = new ArrayList<>();
        results.add(col.convexHull());
        return new VectorData(results, new ArrayList<>(), input.envelope, input.crs);
    }

    public VectorData centroids(VectorData input) {
        List<Geometry> results = new ArrayList<>();
        for (Geometry g : input.geometries) {
            results.add(g.getCentroid());
        }
        return new VectorData(results, input.attributes, input.envelope, input.crs);
    }

    public VectorData voronoi(VectorData input) {
        org.locationtech.jts.triangulate.VoronoiDiagramBuilder builder = new org.locationtech.jts.triangulate.VoronoiDiagramBuilder();
        List<org.locationtech.jts.geom.Coordinate> coords = new ArrayList<>();
        for (Geometry g : input.geometries) coords.add(g.getCentroid().getCoordinate());
        builder.setSites(coords);
        builder.setClipEnvelope(input.envelope);
        Geometry diagram = builder.getDiagram(new org.locationtech.jts.geom.GeometryFactory());
        List<Geometry> results = new ArrayList<>();
        for (int i=0; i<diagram.getNumGeometries(); i++) results.add(diagram.getGeometryN(i));
        return new VectorData(results, new ArrayList<>(), input.envelope, input.crs);
    }

    public java.awt.image.BufferedImage generateHeatmap(VectorData input, int width, int height, double radius) {
        java.awt.image.BufferedImage img = new java.awt.image.BufferedImage(width, height, java.awt.image.BufferedImage.TYPE_INT_ARGB);
        double[][] density = new double[width][height];
        double maxD = 0;

        ReferencedEnvelope env = input.envelope;
        for (Geometry g : input.geometries) {
            org.locationtech.jts.geom.Coordinate c = g.getCentroid().getCoordinate();
            int px = (int) ((c.x - env.getMinX()) / env.getWidth() * width);
            int py = (int) ((1 - (c.y - env.getMinY()) / env.getHeight()) * height);

            int r = (int) (radius * (width / env.getWidth()));
            for (int dy = -r; dy <= r; dy++) {
                for (int dx = -r; dx <= r; dx++) {
                    int nx = px + dx, ny = py + dy;
                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        double distSq = dx * dx + dy * dy;
                        if (distSq < r * r) {
                            double weight = 1.0 - Math.sqrt(distSq) / r;
                            density[nx][ny] += weight;
                            if (density[nx][ny] > maxD) maxD = density[nx][ny];
                        }
                    }
                }
            }
        }

        if (maxD == 0) maxD = 1;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                double val = density[x][y] / maxD;
                if (val > 0) {
                    // Heatmap gradient: Blue -> Cyan -> Green -> Yellow -> Red
                    int rgb = java.awt.Color.HSBtoRGB((float) (0.66 * (1.0 - val)), 0.8f, 0.9f);
                    img.setRGB(x, y, (int)(val * 255) << 24 | (rgb & 0xFFFFFF));
                }
            }
        }
        return img;
    }
}

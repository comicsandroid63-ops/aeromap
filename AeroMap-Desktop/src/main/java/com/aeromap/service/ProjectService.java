package com.aeromap.service;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import org.geotools.data.DefaultTransaction;
import org.geotools.data.Transaction;
import org.geotools.data.collection.ListFeatureCollection;
import org.geotools.data.shapefile.ShapefileDataStore;
import org.geotools.data.shapefile.ShapefileDataStoreFactory;
import org.geotools.data.simple.SimpleFeatureSource;
import org.geotools.data.simple.SimpleFeatureStore;
import org.geotools.feature.simple.SimpleFeatureBuilder;
import org.geotools.feature.simple.SimpleFeatureTypeBuilder;
import org.locationtech.jts.geom.*;
import org.opengis.feature.simple.SimpleFeature;
import org.opengis.feature.simple.SimpleFeatureType;
import org.opengis.referencing.crs.CoordinateReferenceSystem;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.Serializable;
import java.util.*;

public class ProjectService {

    public static class ProjectMetadata {
        public String projectName;
        public String masterCRSCode;
        public List<LayerMeta> vectorLayers = new ArrayList<>();
        public List<LayerMeta> rasterLayers = new ArrayList<>();
    }

    public static class LayerMeta {
        public String name;
        public String relativePath; // e.g., "layers/my_shapefile.shp"
        public String color;
        public String fillColor;
    }

    private Gson gson = new GsonBuilder().setPrettyPrinting().create();

    public void saveProject(File projectFolder, File projectFile, String projectName, CoordinateReferenceSystem masterCrs,
                            List<VectorService.VectorData> vectors, java.util.Map<VectorService.VectorData, String> vectorNames,
                            List<GeoTiffService.RasterData> rasters) throws Exception {
        if (!projectFolder.exists()) {
            projectFolder.mkdirs();
        }

        ProjectMetadata meta = new ProjectMetadata();
        meta.projectName = projectName;
        meta.masterCRSCode = masterCrs != null ? masterCrs.toWKT() : null;

        File layersDir = new File(projectFolder, projectName + "_layers");
        if (!layersDir.exists()) layersDir.mkdir();

        // Export Vectors
        for (VectorService.VectorData v : vectors) {
            String name = vectorNames.get(v);
            if (name == null) name = "VectorLayer";
            // Sanitize name for filename
            String cleanName = name.replace("[Vector] ", "").replaceAll("[^a-zA-Z0-9_-]", "_");
            File shpFile = new File(layersDir, cleanName + ".shp");
            
            exportToShapefile(v, shpFile);

            LayerMeta lm = new LayerMeta();
            lm.name = name;
            lm.relativePath = projectName + "_layers/" + shpFile.getName();
            lm.color = String.format("#%02X%02X%02X", 
                (int)(v.color.getRed() * 255),
                (int)(v.color.getGreen() * 255),
                (int)(v.color.getBlue() * 255));
            lm.fillColor = String.format("#%02X%02X%02X%02X", 
                (int)(v.fillColor.getRed() * 255),
                (int)(v.fillColor.getGreen() * 255),
                (int)(v.fillColor.getBlue() * 255),
                (int)(v.fillColor.getOpacity() * 255));
            meta.vectorLayers.add(lm);
        }

        // Save JSON
        try (FileWriter writer = new FileWriter(projectFile)) {
            gson.toJson(meta, writer);
        }
    }

    public ProjectMetadata loadProjectMeta(File jsonFile) throws Exception {
        try (FileReader reader = new FileReader(jsonFile)) {
            return gson.fromJson(reader, ProjectMetadata.class);
        }
    }

    private void exportToShapefile(VectorService.VectorData data, File file) throws Exception {
        if (data.geometries.isEmpty()) return;

        ShapefileDataStoreFactory dataStoreFactory = new ShapefileDataStoreFactory();
        Map<String, Serializable> params = new HashMap<>();
        params.put("url", file.toURI().toURL());
        params.put("create spatial index", Boolean.TRUE);

        ShapefileDataStore newDataStore = (ShapefileDataStore) dataStoreFactory.createNewDataStore(params);
        newDataStore.setCharset(java.nio.charset.Charset.forName("UTF-8"));

        SimpleFeatureTypeBuilder builder = new SimpleFeatureTypeBuilder();
        builder.setName(file.getName().replace(".shp", ""));
        builder.setCRS(data.crs);

        // Determine geometry class
        Class<?> geomClass = Geometry.class;
        Geometry firstG = data.geometries.get(0);
        if (firstG instanceof Point) geomClass = Point.class;
        else if (firstG instanceof MultiPoint) geomClass = MultiPoint.class;
        else if (firstG instanceof LineString) geomClass = LineString.class;
        else if (firstG instanceof MultiLineString) geomClass = MultiLineString.class;
        else if (firstG instanceof Polygon) geomClass = Polygon.class;
        else if (firstG instanceof MultiPolygon) geomClass = MultiPolygon.class;

        builder.add("the_geom", geomClass);

        // Add attributes if present
        List<String> attrKeys = new ArrayList<>();
        if (data.attributes != null && !data.attributes.isEmpty()) {
            Map<String, Object> firstAttr = data.attributes.get(0);
            for (Map.Entry<String, Object> entry : firstAttr.entrySet()) {
                if (entry.getKey().equalsIgnoreCase("the_geom")) continue;
                Class<?> binding = entry.getValue() != null ? entry.getValue().getClass() : String.class;
                // Shapefile limits field names to 10 chars
                String fName = entry.getKey();
                if (fName.length() > 10) fName = fName.substring(0, 10);
                builder.add(fName, binding);
                attrKeys.add(entry.getKey());
            }
        }

        SimpleFeatureType type = builder.buildFeatureType();
        newDataStore.createSchema(type);

        List<SimpleFeature> features = new ArrayList<>();
        SimpleFeatureBuilder featureBuilder = new SimpleFeatureBuilder(type);

        for (int i = 0; i < data.geometries.size(); i++) {
            featureBuilder.add(data.geometries.get(i));
            if (data.attributes != null && i < data.attributes.size()) {
                Map<String, Object> attrs = data.attributes.get(i);
                for (String key : attrKeys) {
                    featureBuilder.add(attrs.get(key));
                }
            }
            features.add(featureBuilder.buildFeature(null));
        }

        SimpleFeatureSource featureSource = newDataStore.getFeatureSource(newDataStore.getTypeNames()[0]);
        if (featureSource instanceof SimpleFeatureStore) {
            SimpleFeatureStore featureStore = (SimpleFeatureStore) featureSource;
            Transaction transaction = new DefaultTransaction("create");
            featureStore.setTransaction(transaction);
            try {
                featureStore.addFeatures(new ListFeatureCollection(type, features));
                transaction.commit();
            } catch (Exception e) {
                transaction.rollback();
                throw e;
            } finally {
                transaction.close();
            }
        } else {
            throw new Exception("Shapefile does not support write access");
        }
    }
}

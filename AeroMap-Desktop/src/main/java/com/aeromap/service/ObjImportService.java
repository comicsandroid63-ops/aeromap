package com.aeromap.service;

import javafx.scene.paint.Color;
import javafx.scene.paint.PhongMaterial;
import javafx.scene.shape.CullFace;
import javafx.scene.shape.MeshView;
import javafx.scene.shape.TriangleMesh;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;

public class ObjImportService {

    public static class ObjModel {
        public final List<MeshView> meshViews;
        public final String name;
        public final float modelWidth;
        public final float modelHeight;
        public final float modelDepth;

        public ObjModel(List<MeshView> meshViews, String name, float width, float height, float depth) {
            this.meshViews = meshViews;
            this.name = name;
            this.modelWidth = width;
            this.modelHeight = height;
            this.modelDepth = depth;
        }
    }

    public ObjModel loadObj(File objFile) throws IOException {
        String baseDir = objFile.getParent();

        List<float[]> vertices = new ArrayList<>();
        List<float[]> texCoords = new ArrayList<>();
        List<float[]> normals = new ArrayList<>();

        List<MeshGroup> groups = new ArrayList<>();
        MeshGroup currentGroup = new MeshGroup("default");
        groups.add(currentGroup);

        String currentMaterial = null;
        Map<String, ObjMaterial> materials = new HashMap<>();

        List<String> lines = Files.readAllLines(objFile.toPath(), StandardCharsets.UTF_8);

        for (String line : lines) {
            line = line.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;

            String[] parts = line.split("\\s+");
            if (parts.length == 0) continue;

            switch (parts[0]) {
                case "v" -> {
                    float x = Float.parseFloat(parts[1]);
                    float y = Float.parseFloat(parts[2]);
                    float z = parts.length > 3 ? Float.parseFloat(parts[3]) : 0;
                    vertices.add(new float[]{x, y, z});
                }
                case "vt" -> {
                    float u = Float.parseFloat(parts[1]);
                    float v = parts.length > 2 ? Float.parseFloat(parts[2]) : 0;
                    texCoords.add(new float[]{u, v});
                }
                case "vn" -> {
                    float x = Float.parseFloat(parts[1]);
                    float y = Float.parseFloat(parts[2]);
                    float z = Float.parseFloat(parts[3]);
                    normals.add(new float[]{x, y, z});
                }
                case "f" -> {
                    int[][] faceVerts = new int[parts.length - 1][3];
                    for (int i = 1; i < parts.length; i++) {
                        String[] indices = parts[i].split("/");
                        int vi = parseIndex(indices[0], vertices.size());
                        int ti = indices.length > 1 && !indices[1].isEmpty() ? parseIndex(indices[1], texCoords.size()) : -1;
                        int ni = indices.length > 2 && !indices[2].isEmpty() ? parseIndex(indices[2], normals.size()) : -1;
                        faceVerts[i - 1] = new int[]{vi, ti, ni};
                    }
                    if (faceVerts.length >= 3) {
                        for (int i = 1; i < faceVerts.length - 1; i++) {
                            currentGroup.faces.add(new int[][]{faceVerts[0], faceVerts[i], faceVerts[i + 1]});
                            currentGroup.faceMaterials.add(currentMaterial);
                        }
                    }
                }
                case "usemtl" -> currentMaterial = parts[1];
                case "mtllib" -> {
                    String mtlFile = parts[1];
                    File mtlPath = new File(baseDir, mtlFile);
                    if (mtlPath.exists()) {
                        materials.putAll(loadMtl(mtlPath));
                    }
                }
                case "o", "g" -> {
                    if (!currentGroup.faces.isEmpty()) {
                        currentGroup = new MeshGroup(parts.length > 1 ? parts[1] : "group");
                        groups.add(currentGroup);
                    } else {
                        currentGroup.name = parts.length > 1 ? parts[1] : "group";
                    }
                }
            }
        }

        // Compute bounding box from all vertices used across all groups
        float minX = Float.MAX_VALUE, maxX = -Float.MAX_VALUE;
        float minY = Float.MAX_VALUE, maxY = -Float.MAX_VALUE;
        float minZ = Float.MAX_VALUE, maxZ = -Float.MAX_VALUE;

        for (float[] v : vertices) {
            if (v[0] < minX) minX = v[0];
            if (v[0] > maxX) maxX = v[0];
            if (v[1] < minY) minY = v[1];
            if (v[1] > maxY) maxY = v[1];
            if (v[2] < minZ) minZ = v[2];
            if (v[2] > maxZ) maxZ = v[2];
        }

        float w = maxX - minX;
        float h = maxY - minY;
        float d = maxZ - minZ;
        float cx = (minX + maxX) / 2f;
        float cy = (minY + maxY) / 2f;
        float cz = (minZ + maxZ) / 2f;

        // Target size: ~5 units max dimension
        float maxDim = Math.max(w, Math.max(h, d));
        float scale = maxDim > 0 ? 5f / maxDim : 1f;

        List<MeshView> meshViews = new ArrayList<>();
        for (MeshGroup group : groups) {
            if (group.faces.isEmpty()) continue;
            MeshView mv = buildMeshView(group, vertices, texCoords, materials, scale, cx, cy, cz);
            if (mv != null) meshViews.add(mv);
        }

        String name = objFile.getName();
        if (name.toLowerCase().endsWith(".obj")) name = name.substring(0, name.length() - 4);

        return new ObjModel(meshViews, name, w * scale, h * scale, d * scale);
    }

    private MeshView buildMeshView(MeshGroup group, List<float[]> vertices, List<float[]> texCoords,
                                    Map<String, ObjMaterial> materials,
                                    float scale, float cx, float cy, float cz) {
        TriangleMesh mesh = new TriangleMesh();

        Map<String, Integer> vertMap = new LinkedHashMap<>();
        List<Float> posList = new ArrayList<>();
        List<Float> tcList = new ArrayList<>();
        List<Integer> faceIndices = new ArrayList<>();

        Set<String> usedMaterials = new LinkedHashSet<>();

        for (int fi = 0; fi < group.faces.size(); fi++) {
            int[][] face = group.faces.get(fi);
            String matName = group.faceMaterials.get(fi);
            if (matName != null) usedMaterials.add(matName);

            for (int[] vert : face) {
                int vi = vert[0];
                int ti = vert[1];

                String key = vi + "/" + ti;
                Integer existing = vertMap.get(key);
                if (existing == null) {
                    float[] v = vertices.get(vi);
                    posList.add((v[0] - cx) * scale);
                    posList.add(((v[1] - cy) * scale) - 2.0f); // offset up (negative Y = up in JavaFX)
                    posList.add((v[2] - cz) * scale);

                    if (ti >= 0 && ti < texCoords.size()) {
                        float[] tc = texCoords.get(ti);
                        tcList.add(tc[0]);
                        tcList.add(1.0f - tc[1]);
                    } else {
                        tcList.add(0f);
                        tcList.add(0f);
                    }

                    vertMap.put(key, vertMap.size());
                }
                faceIndices.add(vertMap.get(key));
            }
        }

        float[] posArray = new float[posList.size()];
        for (int i = 0; i < posList.size(); i++) posArray[i] = posList.get(i);

        float[] tcArray = new float[tcList.size()];
        for (int i = 0; i < tcList.size(); i++) tcArray[i] = tcList.get(i);

        mesh.getPoints().setAll(posArray);
        mesh.getTexCoords().setAll(tcArray);

        // JavaFX TriangleMesh face format: [p0, t0, p1, t1, p2, t2, ...]
        // Each vertex = 2 ints (point index + texCoord index)
        int[] faces = new int[faceIndices.size() * 2];
        for (int i = 0; i < faceIndices.size(); i++) {
            int idx = faceIndices.get(i);
            faces[i * 2] = idx;
            faces[i * 2 + 1] = idx;
        }
        mesh.getFaces().setAll(faces);

        int numPoints = mesh.getPoints().size() / 3;
        int numFaces = mesh.getFaces().size() / 6;
        System.err.println("DEBUG OBJ MESH: group=" + group.name + " vertices=" + numPoints + " triangles=" + numFaces);

        MeshView meshView = new MeshView(mesh);
        meshView.setCullFace(CullFace.NONE);

        PhongMaterial mat = new PhongMaterial();
        mat.setDiffuseColor(Color.LIGHTGRAY);
        mat.setSpecularColor(Color.rgb(30, 30, 30));
        mat.setSpecularPower(8.0);

        for (String matName : usedMaterials) {
            ObjMaterial objMat = materials.get(matName);
            if (objMat != null) {
                if (objMat.diffuseColor != null) {
                    mat.setDiffuseColor(objMat.diffuseColor);
                }
                if (objMat.diffuseTexturePath != null) {
                    try {
                        File texFile = new File(objMat.basePath, objMat.diffuseTexturePath);
                        if (texFile.exists()) {
                            javafx.scene.image.Image img = new javafx.scene.image.Image(new FileInputStream(texFile));
                            mat.setDiffuseMap(img);
                        }
                    } catch (Exception e) {
                        System.err.println("Could not load texture: " + objMat.diffuseTexturePath);
                    }
                }
                if (objMat.specularColor != null) {
                    mat.setSpecularColor(objMat.specularColor);
                }
                mat.setSpecularPower((float) objMat.specularPower);
                break;
            }
        }

        meshView.setMaterial(mat);
        return meshView;
    }

    private Map<String, ObjMaterial> loadMtl(File mtlFile) throws IOException {
        Map<String, ObjMaterial> materials = new HashMap<>();
        ObjMaterial current = null;
        String baseDir = mtlFile.getParent();

        for (String line : Files.readAllLines(mtlFile.toPath(), StandardCharsets.UTF_8)) {
            line = line.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;

            String[] parts = line.split("\\s+");
            if (parts.length == 0) continue;

            switch (parts[0]) {
                case "newmtl" -> {
                    current = new ObjMaterial(parts[1], baseDir);
                    materials.put(parts[1], current);
                }
                case "Kd" -> {
                    if (current != null) {
                        current.diffuseColor = Color.color(
                            Double.parseDouble(parts[1]),
                            Double.parseDouble(parts[2]),
                            Double.parseDouble(parts[3])
                        );
                    }
                }
                case "Ks" -> {
                    if (current != null) {
                        current.specularColor = Color.color(
                            Double.parseDouble(parts[1]),
                            Double.parseDouble(parts[2]),
                            Double.parseDouble(parts[3])
                        );
                    }
                }
                case "Ns" -> {
                    if (current != null) {
                        current.specularPower = Double.parseDouble(parts[1]);
                    }
                }
                case "map_Kd" -> {
                    if (current != null && parts.length > 1) {
                        current.diffuseTexturePath = parts[1];
                    }
                }
                case "d", "Tr" -> {}
            }
        }

        return materials;
    }

    public void addBaseToModel(ObjModel model) {
        if (model == null || model.meshViews.isEmpty()) return;

        float minX = Float.MAX_VALUE, maxX = -Float.MAX_VALUE;
        float minY = Float.MAX_VALUE, maxY = -Float.MAX_VALUE;
        float minZ = Float.MAX_VALUE, maxZ = -Float.MAX_VALUE;

        for (MeshView mv : model.meshViews) {
            TriangleMesh mesh = (TriangleMesh) mv.getMesh();
            float[] pts = new float[mesh.getPoints().size()];
            mesh.getPoints().toArray(pts);
            for (int i = 0; i < pts.length / 3; i++) {
                float x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (z < minZ) minZ = z;
                if (z > maxZ) maxZ = z;
            }
        }
        if (minX == Float.MAX_VALUE) return;

        float margin = 0.4f;
        float thick = 0.3f;
        float bx1 = minX - margin, bx2 = maxX + margin;
        float bz1 = minZ - margin, bz2 = maxZ + margin;
        float byTop = minY + thick * 0.3f;
        float byBot = minY - thick * 0.7f;

        TriangleMesh baseMesh = new TriangleMesh();
        baseMesh.getPoints().addAll(
            bx1, byTop, bz1, bx2, byTop, bz1, bx2, byTop, bz2, bx1, byTop, bz2,
            bx1, byBot, bz1, bx2, byBot, bz1, bx2, byBot, bz2, bx1, byBot, bz2
        );
        baseMesh.getTexCoords().addAll(0, 0, 1, 0, 1, 1, 0, 1);
        baseMesh.getFaces().setAll(new int[]{
            2,2, 1,1, 0,0,  3,3, 2,2, 0,0,
            5,1, 6,2, 4,0,  6,2, 7,3, 4,0,
            5,1, 4,0, 0,0,  1,1, 5,1, 0,0,
            6,2, 2,2, 3,3,  7,3, 6,2, 3,3,
            7,3, 3,3, 0,0,  4,0, 7,3, 0,0,
            6,2, 5,1, 1,1,  2,2, 6,2, 1,1
        });

        MeshView baseView = new MeshView(baseMesh);
        baseView.setCullFace(CullFace.NONE);
        PhongMaterial baseMat = new PhongMaterial();
        baseMat.setDiffuseColor(Color.LIGHTGRAY);
        baseMat.setSpecularColor(Color.rgb(30, 30, 30));
        baseMat.setSpecularPower(8.0);
        baseView.setMaterial(baseMat);
        model.meshViews.add(baseView);
    }

    private int parseIndex(String s, int size) {
        int idx = Integer.parseInt(s);
        if (idx > 0) return idx - 1;
        if (idx < 0) return size + idx;
        return 0;
    }

    private static class MeshGroup {
        String name;
        List<int[][]> faces = new ArrayList<>();
        List<String> faceMaterials = new ArrayList<>();

        MeshGroup(String name) {
            this.name = name;
        }
    }

    private static class ObjMaterial {
        String name;
        String basePath;
        Color diffuseColor;
        Color specularColor;
        double specularPower = 8.0;
        String diffuseTexturePath;

        ObjMaterial(String name, String basePath) {
            this.name = name;
            this.basePath = basePath;
        }
    }
}

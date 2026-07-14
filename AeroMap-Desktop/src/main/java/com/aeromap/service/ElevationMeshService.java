package com.aeromap.service;

import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import javafx.scene.image.WritableImage;
import javafx.scene.paint.Color;
import javafx.scene.paint.PhongMaterial;
import javafx.scene.shape.CullFace;
import javafx.scene.shape.DrawMode;
import javafx.scene.shape.MeshView;
import javafx.scene.shape.TriangleMesh;
import javafx.embed.swing.SwingFXUtils;

import java.awt.image.BufferedImage;

public class ElevationMeshService {

    private static final int MAX_MESH_RESOLUTION = 320;

    public static class MeshResult {
        public final MeshView meshView;
        public final float widthScale;
        public final float heightScale;
        public final float depthScale;

        public MeshResult(MeshView meshView, float widthScale, float heightScale, float depthScale) {
            this.meshView = meshView;
            this.widthScale = widthScale;
            this.heightScale = heightScale;
            this.depthScale = depthScale;
        }
    }

    public MeshResult createMesh(GeoTiffService.RasterData rasterData, float verticalExaggeration, int resolution) {
        if (rasterData == null || rasterData.reader == null) return null;

        try {
            int meshW = resolution;
            int meshH = resolution;

            double envW = rasterData.envelope.getWidth();
            double envH = rasterData.envelope.getHeight();

            double min = Double.isNaN(rasterData.globalMin) ? 0 : rasterData.globalMin;
            double max = Double.isNaN(rasterData.globalMax) ? 1 : rasterData.globalMax;
            double range = max - min;
            if (range <= 0) range = 1;

            java.awt.image.BufferedImage elevationImg = renderElevationGrid(rasterData, meshW, meshH);
            if (elevationImg == null) return null;

            BufferedImage colorImg = renderColorTexture(rasterData, meshW, meshH);

            float[][] heightGrid = new float[meshH][meshW];
            java.awt.image.Raster elevRaster = elevationImg.getData();
            double[] pixel = new double[elevRaster.getNumBands()];
            float minH = Float.MAX_VALUE, maxH = -Float.MAX_VALUE;

            for (int y = 0; y < meshH; y++) {
                for (int x = 0; x < meshW; x++) {
                    elevRaster.getPixel(x, y, pixel);
                    double val = pixel[0];
                    if (Double.isNaN(val) || val <= -9999 || val <= -1_000_000) {
                        heightGrid[y][x] = 0;
                    } else {
                        float norm = (float) Math.max(0, Math.min(1, (val - min) / range));
                        heightGrid[y][x] = norm;
                        if (norm < minH) minH = norm;
                        if (norm > maxH) maxH = norm;
                    }
                }
            }

            TriangleMesh mesh = new TriangleMesh();

            // Calculate correct aspect ratio based on envelope
            float aspectRatio = (float) (envH / envW);
            float scaleX = 15.0f; // Base size
            float scaleZ = scaleX * aspectRatio;
            float scaleY = verticalExaggeration * 4.0f;

            for (int y = 0; y < meshH; y++) {
                for (int x = 0; x < meshW; x++) {
                    float px = (x / (float) (meshW - 1)) * scaleX - scaleX / 2.0f;
                    float py = -heightGrid[y][x] * scaleY; // Negative Y is UP in JavaFX
                    float pz = scaleZ / 2.0f - (y / (float) (meshH - 1)) * scaleZ;
                    mesh.getPoints().addAll(px, py, pz);
                }
            }

            for (int y = 0; y < meshH; y++) {
                for (int x = 0; x < meshW; x++) {
                    float tu = x / (float) (meshW - 1);
                    float tv = y / (float) (meshH - 1);
                    mesh.getTexCoords().addAll(tu, tv);
                }
            }

            for (int y = 0; y < meshH - 1; y++) {
                for (int x = 0; x < meshW - 1; x++) {
                    int topLeft = y * meshW + x;
                    int topRight = topLeft + 1;
                    int bottomLeft = (y + 1) * meshW + x;
                    int bottomRight = bottomLeft + 1;

                    // Triangle 1
                    mesh.getFaces().addAll(topLeft, topLeft, bottomLeft, bottomLeft, topRight, topRight);
                    // Triangle 2
                    mesh.getFaces().addAll(topRight, topRight, bottomLeft, bottomLeft, bottomRight, bottomRight);
                }
            }

            MeshView meshView = new MeshView(mesh);
            meshView.setCullFace(CullFace.NONE);
            meshView.setDrawMode(DrawMode.FILL);

            PhongMaterial material = new PhongMaterial();
            if (colorImg != null) {
                Image diffuseMap = SwingFXUtils.toFXImage(colorImg, null);
                material.setDiffuseMap(diffuseMap);
            }
            material.setSpecularColor(Color.rgb(30, 30, 30));
            material.setSpecularPower(8.0);
            material.setDiffuseColor(Color.WHITE);
            meshView.setMaterial(material);

            return new MeshResult(meshView, scaleX, scaleY, scaleZ);

        } catch (Exception e) {
            System.err.println("ERROR creating elevation mesh: " + e.getMessage());
            e.printStackTrace();
            return null;
        }
    }

    private BufferedImage renderElevationGrid(GeoTiffService.RasterData data, int w, int h) {
        try {
            org.opengis.parameter.ParameterValueGroup readParams = data.reader.getFormat().getReadParameters();
            org.geotools.coverage.grid.GridGeometry2D gridGeom = new org.geotools.coverage.grid.GridGeometry2D(
                new org.geotools.coverage.grid.GeneralGridEnvelope(new java.awt.Rectangle(0, 0, w, h)),
                data.envelope
            );
            readParams.parameter(org.geotools.coverage.grid.io.AbstractGridFormat.READ_GRIDGEOMETRY2D.getName().getCode()).setValue(gridGeom);
            org.geotools.coverage.grid.GridCoverage2D coverage = data.reader.read(
                readParams.values().toArray(new org.opengis.parameter.GeneralParameterValue[0])
            );
            if (coverage == null) return null;

            java.awt.image.RenderedImage renderedImg = coverage.getRenderedImage();
            java.awt.image.Raster raster = renderedImg.getData();
            int rW = raster.getWidth(), rH = raster.getHeight();
            int bands = raster.getNumBands();

            BufferedImage out = new BufferedImage(w, h, java.awt.image.BufferedImage.TYPE_USHORT_GRAY);
            double[] px = new double[bands];

            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    int rx = Math.min((int) ((x / (double) w) * rW), rW - 1);
                    int ry = Math.min((int) ((y / (double) h) * rH), rH - 1);
                    raster.getPixel(rx, ry, px);
                    double val = px[0];
                    if (Double.isNaN(val) || val <= -999 || val <= -1_000_000) {
                        out.getRaster().setSample(x, y, 0, 0);
                    } else {
                        out.getRaster().setSample(x, y, 0, val);
                    }
                }
            }
            coverage.dispose(true);
            return out;
        } catch (Exception e) {
            return null;
        }
    }

    private BufferedImage renderColorTexture(GeoTiffService.RasterData data, int w, int h) {
        try {
            if (data.cachedOverview != null) {
                BufferedImage resized = new BufferedImage(w, h, java.awt.image.BufferedImage.TYPE_INT_ARGB);
                java.awt.Graphics2D g2d = resized.createGraphics();
                g2d.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION, java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                g2d.drawImage(data.cachedOverview, 0, 0, w, h, null);
                g2d.dispose();
                return resized;
            }

            org.opengis.parameter.ParameterValueGroup readParams = data.reader.getFormat().getReadParameters();
            org.geotools.coverage.grid.GridGeometry2D gridGeom = new org.geotools.coverage.grid.GridGeometry2D(
                new org.geotools.coverage.grid.GeneralGridEnvelope(new java.awt.Rectangle(0, 0, w, h)),
                data.envelope
            );
            readParams.parameter(org.geotools.coverage.grid.io.AbstractGridFormat.READ_GRIDGEOMETRY2D.getName().getCode()).setValue(gridGeom);
            org.geotools.coverage.grid.GridCoverage2D coverage = data.reader.read(
                readParams.values().toArray(new org.opengis.parameter.GeneralParameterValue[0])
            );
            if (coverage == null) return null;

            java.awt.image.RenderedImage renderedImg = coverage.getRenderedImage();
            java.awt.image.Raster raster = renderedImg.getData();
            int rW = raster.getWidth(), rH = raster.getHeight();
            int bands = raster.getNumBands();
            int useBands = Math.min(3, bands);

            double min = Double.isNaN(data.globalMin) ? 0 : data.globalMin;
            double max = Double.isNaN(data.globalMax) ? 255 : data.globalMax;
            double range = max - min; if (range <= 0) range = 1;

            BufferedImage out = new BufferedImage(w, h, java.awt.image.BufferedImage.TYPE_INT_ARGB);
            double[] px = new double[bands];

            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    int rx = Math.min((int) ((x / (double) w) * rW), rW - 1);
                    int ry = Math.min((int) ((y / (double) h) * rH), rH - 1);
                    raster.getPixel(rx, ry, px);

                    if (useBands >= 3) {
                        int r = clamp((int) ((px[0] - min) / range * 255));
                        int g = clamp((int) ((px[1] - min) / range * 255));
                        int b = clamp((int) ((px[2] - min) / range * 255));
                        out.setRGB(x, y, 0xFF000000 | (r << 16) | (g << 8) | b);
                    } else {
                        double val = px[0];
                        if (Double.isNaN(val) || val <= -9999) {
                            out.setRGB(x, y, 0xFF222222);
                        } else {
                            double norm = Math.max(0, Math.min(1, (val - min) / range));
                            int argb;
                            // Always use a color scheme for 3D to make it look great
                            GeoTiffService.ColorScheme schemeToUse = data.isColorized ? data.colorScheme : GeoTiffService.ColorScheme.ELEVATION;
                            argb = GeoTiffService.applyColorScheme(norm, schemeToUse);
                            out.setRGB(x, y, argb);
                        }
                    }
                }
            }
            coverage.dispose(true);
            return out;
        } catch (Exception e) {
            return null;
        }
    }

    private static int clamp(int v) { return v < 0 ? 0 : Math.min(v, 255); }
}

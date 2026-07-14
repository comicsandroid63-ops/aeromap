package com.aeromap.service;

import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.coverage.grid.io.AbstractGridFormat;
import java.awt.image.BufferedImage;
import java.awt.image.Raster;
import java.awt.*;

/**
 * Service for performing terrain analysis on raster data.
 * Zero JAI dependency.
 */
public class RasterAnalysisService {

    public enum AnalysisType {
        SLOPE, ASPECT, HILLSHADE, HYDROLOGY, TRI, CURVATURE, MULTI_HILLSHADE, FLOW_ACCUMULATION
    }

    public static class AnalysisParams {
        public double zFactor = 1.0;
        public double azimuth = 315.0; // For Hillshade
        public double altitude = 45.0; // For Hillshade
        public int resolution = 1024;
    }

    public BufferedImage performAnalysis(GeoTiffService.RasterData data, AnalysisType type, AnalysisParams params) {
        if (data == null || data.reader == null) return null;

        try {
            int analysisRes = params.resolution;
            org.opengis.parameter.ParameterValueGroup readParams = data.reader.getFormat().getReadParameters();
            org.geotools.coverage.grid.GridGeometry2D gridGeom = new org.geotools.coverage.grid.GridGeometry2D(
                new org.geotools.coverage.grid.GeneralGridEnvelope(new Rectangle(0, 0, analysisRes, analysisRes)),
                data.envelope
            );
            readParams.parameter(AbstractGridFormat.READ_GRIDGEOMETRY2D.getName().getCode()).setValue(gridGeom);
            GridCoverage2D coverage = data.reader.read(readParams.values().toArray(new org.opengis.parameter.GeneralParameterValue[0]));
            
            if (coverage == null) return null;

            Raster raster = coverage.getRenderedImage().getData();
            int width = raster.getWidth();
            int height = raster.getHeight();
            
            BufferedImage result = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
            
            double cellWidth = data.envelope.getWidth() / width;
            double cellHeight = data.envelope.getHeight() / height;

            // --- SMART UNIT CORRECTION ---
            // If the CRS is geographic (degrees), we MUST convert dx/dy to meters for slope/hillshade math to work.
            if (GeoTiffService.isGeographic(data.envelope.getCoordinateReferenceSystem())) {
                double centerLat = data.envelope.getMedian(1);
                cellWidth *= GeoTiffService.getMetersPerDegreeLongitude(centerLat);
                cellHeight *= GeoTiffService.getMetersPerDegreeLatitude();
                System.err.println("DEBUG: Geographic CRS detected. Corrected cell size: " + cellWidth + "m x " + cellHeight + "m");
            }

            switch (type) {
                case SLOPE:
                    calculateSlope(raster, result, cellWidth, cellHeight, params.zFactor);
                    break;
                case ASPECT:
                    calculateAspect(raster, result, cellWidth, cellHeight);
                    break;
                case HILLSHADE:
                    calculateHillshade(raster, result, cellWidth, cellHeight, params);
                    break;
                case HYDROLOGY:
                    calculateFlowDirection(raster, result);
                    break;
                case TRI:
                    calculateTRI(raster, result);
                    break;
                case CURVATURE:
                    calculateCurvature(raster, result, cellWidth, cellHeight);
                    break;
                case MULTI_HILLSHADE:
                    calculateMultiHillshade(raster, result, cellWidth, cellHeight, params);
                    break;
                case FLOW_ACCUMULATION:
                    calculateFlowAccumulation(raster, result);
                    break;
            }

            coverage.dispose(true);
            return result;
        } catch (Exception e) {
            System.err.println("ERROR in RasterAnalysis: " + e.getMessage());
            return null;
        }
    }

    private void calculateSlope(Raster src, BufferedImage dest, double dx, double dy, double zFactor) {
        int w = src.getWidth();
        int h = src.getHeight();
        
        for (int y = 1; y < h - 1; y++) {
            for (int x = 1; x < w - 1; x++) {
                double a = src.getSampleDouble(x - 1, y - 1, 0) * zFactor;
                double b = src.getSampleDouble(x, y - 1, 0) * zFactor;
                double c = src.getSampleDouble(x + 1, y - 1, 0) * zFactor;
                double d = src.getSampleDouble(x - 1, y, 0) * zFactor;
                double f = src.getSampleDouble(x + 1, y, 0) * zFactor;
                double g = src.getSampleDouble(x - 1, y + 1, 0) * zFactor;
                double i = src.getSampleDouble(x + 1, y + 1, 0) * zFactor;
                double h_val = src.getSampleDouble(x, y + 1, 0) * zFactor;

                if (isInvalid(a, b, c, d, f, g, i, h_val)) {
                    dest.setRGB(x, y, 0x00000000);
                    continue;
                }

                double dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx);
                double dzdy = ((g + 2 * h_val + i) - (a + 2 * b + c)) / (8 * dy);
                
                double slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * (180.0 / Math.PI);
                
                // Map 0-90 degrees to color (red is steep, green is flat)
                float norm = (float) Math.min(1.0, slope / 45.0); // 45 degrees is very steep for terrain
                dest.setRGB(x, y, 0xFF000000 | (clamp((int)(norm * 255)) << 16) | (clamp((int)((1 - norm) * 255)) << 8));
            }
        }
    }

    private void calculateAspect(Raster src, BufferedImage dest, double dx, double dy) {
        int w = src.getWidth();
        int h = src.getHeight();
        
        for (int y = 1; y < h - 1; y++) {
            for (int x = 1; x < w - 1; x++) {
                double a = src.getSampleDouble(x - 1, y - 1, 0);
                double b = src.getSampleDouble(x, y - 1, 0);
                double c = src.getSampleDouble(x + 1, y - 1, 0);
                double d = src.getSampleDouble(x - 1, y, 0);
                double f = src.getSampleDouble(x + 1, y, 0);
                double g = src.getSampleDouble(x - 1, y + 1, 0);
                double i = src.getSampleDouble(x + 1, y + 1, 0);
                double h_val = src.getSampleDouble(x, y + 1, 0);

                if (isInvalid(a, b, c, d, f, g, i, h_val)) {
                    dest.setRGB(x, y, 0x00000000);
                    continue;
                }

                double dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx);
                double dzdy = ((g + 2 * h_val + i) - (a + 2 * b + c)) / (8 * dy);
                
                if (dzdx == 0 && dzdy == 0) {
                    dest.setRGB(x, y, 0xFF888888); // Flat
                } else {
                    double aspect = 180.0 - Math.toDegrees(Math.atan2(dzdy, -dzdx)) + 90.0;
                    if (aspect > 360.0) aspect -= 360.0;
                    
                    // Map 0-360 to a rainbow/compass color scheme
                    float hue = (float) (aspect / 360.0);
                    dest.setRGB(x, y, Color.HSBtoRGB(hue, 0.8f, 0.8f));
                }
            }
        }
    }

    private void calculateHillshade(Raster src, BufferedImage dest, double dx, double dy, AnalysisParams params) {
        int w = src.getWidth();
        int h = src.getHeight();
        
        // Light source parameters
        double azimuth = params.azimuth;
        double altitude = params.altitude;
        double zFactor = params.zFactor;
        
        double zenith_rad = Math.toRadians(90.0 - altitude);
        double azimuth_rad = Math.toRadians(360.0 - azimuth + 90.0);

        for (int y = 1; y < h - 1; y++) {
            for (int x = 1; x < w - 1; x++) {
                double a = src.getSampleDouble(x - 1, y - 1, 0) * zFactor;
                double b = src.getSampleDouble(x, y - 1, 0) * zFactor;
                double c = src.getSampleDouble(x + 1, y - 1, 0) * zFactor;
                double d = src.getSampleDouble(x - 1, y, 0) * zFactor;
                double f = src.getSampleDouble(x + 1, y, 0) * zFactor;
                double g = src.getSampleDouble(x - 1, y + 1, 0) * zFactor;
                double i = src.getSampleDouble(x + 1, y + 1, 0) * zFactor;
                double h_val = src.getSampleDouble(x, y + 1, 0) * zFactor;

                if (isInvalid(a, b, c, d, f, g, i, h_val)) {
                    dest.setRGB(x, y, 0x00000000);
                    continue;
                }

                double dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx);
                double dzdy = ((g + 2 * h_val + i) - (a + 2 * b + c)) / (8 * dy);
                
                double slope_rad = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
                double aspect_rad = Math.atan2(dzdy, -dzdx);
                if (aspect_rad < 0) aspect_rad += 2 * Math.PI;

                double shade = 255.0 * ((Math.cos(zenith_rad) * Math.cos(slope_rad)) + 
                                       (Math.sin(zenith_rad) * Math.sin(slope_rad) * Math.cos(azimuth_rad - aspect_rad)));
                
                int val = clamp((int) shade);
                dest.setRGB(x, y, 0xFF000000 | (val << 16) | (val << 8) | val);
            }
        }
    }

    private void calculateFlowDirection(Raster src, BufferedImage dest) {
        int w = src.getWidth();
        int h = src.getHeight();
        
        // D8 Algorithm: Flow goes to the neighbor with the steepest drop
        for (int y = 1; y < h - 1; y++) {
            for (int x = 1; x < w - 1; x++) {
                double center = src.getSampleDouble(x, y, 0);
                if (center <= -9999) { dest.setRGB(x, y, 0x00000000); continue; }

                double maxDrop = 0;
                int dir = 0; // 1:E, 2:SE, 4:S, 8:SW, 16:W, 32:NW, 64:N, 128:NE
                
                int[] dxs = {1, 1, 0, -1, -1, -1, 0, 1};
                int[] dys = {0, 1, 1, 1, 0, -1, -1, -1};
                int[] codes = {1, 2, 4, 8, 16, 32, 64, 128};

                for (int k = 0; k < 8; k++) {
                    double neighbor = src.getSampleDouble(x + dxs[k], y + dys[k], 0);
                    if (neighbor <= -9999) continue;
                    
                    double drop = center - neighbor;
                    if (k % 2 != 0) drop /= 1.4142; // Adjust for diagonal distance
                    
                    if (drop > maxDrop) {
                        maxDrop = drop;
                        dir = codes[k];
                    }
                }

                if (dir == 0) dest.setRGB(x, y, 0xFF000000); // Sink
                else {
                    // Color code the direction
                    float hue = (float) (Math.log(dir) / Math.log(2) / 8.0);
                    dest.setRGB(x, y, Color.HSBtoRGB(hue, 0.7f, 0.9f));
                }
            }
        }
    }

    private boolean isInvalid(double... vals) {
        for (double v : vals) {
            if (Double.isNaN(v) || v <= -9999) return true;
        }
        return false;
    }

    private int clamp(int v) { return v < 0 ? 0 : Math.min(v, 255); }

    private void calculateTRI(Raster src, BufferedImage dest) {
        int w = src.getWidth(), h = src.getHeight();
        for (int y = 1; y < h - 1; y++) {
            for (int x = 1; x < w - 1; x++) {
                double c = src.getSampleDouble(x, y, 0);
                if (c <= -9999) { dest.setRGB(x, y, 0); continue; }
                double sum = 0;
                for (int dy=-1; dy<=1; dy++) {
                    for (int dx=-1; dx<=1; dx++) {
                        if (dx==0 && dy==0) continue;
                        double val = src.getSampleDouble(x+dx, y+dy, 0);
                        if (val > -9999) sum += Math.abs(c - val);
                    }
                }
                double tri = sum / 8.0;
                int val = clamp((int) (tri * 5)); // Scale for visibility
                dest.setRGB(x, y, 0xFF000000 | (val << 16) | (val << 8) | val);
            }
        }
    }

    private void calculateCurvature(Raster src, BufferedImage dest, double dx, double dy) {
        int w = src.getWidth(), h = src.getHeight();
        for (int y = 1; y < h - 1; y++) {
            for (int x = 1; x < w - 1; x++) {
                double z1 = src.getSampleDouble(x-1, y-1, 0), z2 = src.getSampleDouble(x, y-1, 0), z3 = src.getSampleDouble(x+1, y-1, 0);
                double z4 = src.getSampleDouble(x-1, y, 0),   z5 = src.getSampleDouble(x, y, 0),   z6 = src.getSampleDouble(x+1, y, 0);
                double z7 = src.getSampleDouble(x-1, y+1, 0), z8 = src.getSampleDouble(x, y+1, 0), z9 = src.getSampleDouble(x+1, y+1, 0);
                
                if (isInvalid(z1,z2,z3,z4,z5,z6,z7,z8,z9)) { dest.setRGB(x, y, 0); continue; }
                
                double d = ((z4 + z6) / 2 - z5) / (dx * dx);
                double e = ((z2 + z8) / 2 - z5) / (dy * dy);
                double curv = -2 * (d + e);
                
                int r=0, g=0, b=0;
                if (curv > 0) { r = clamp((int) (curv * 20000)); } // Convex
                else { b = clamp((int) (-curv * 20000)); } // Concave
                dest.setRGB(x, y, 0xFF000000 | (r << 16) | (g << 8) | b);
            }
        }
    }

    private void calculateMultiHillshade(Raster src, BufferedImage dest, double dx, double dy, AnalysisParams params) {
        int w = src.getWidth(), h = src.getHeight();
        double[] azimuths = {225, 270, 315, 360};
        
        for (int y = 1; y < h - 1; y++) {
            for (int x = 1; x < w - 1; x++) {
                double total = 0;
                int count = 0;
                for (double az : azimuths) {
                    double hs = getHillshadeValue(src, x, y, dx, dy, az, params.altitude, params.zFactor);
                    if (hs >= 0) { total += hs; count++; }
                }
                if (count == 0) { dest.setRGB(x, y, 0); continue; }
                int val = clamp((int) (total / count));
                dest.setRGB(x, y, 0xFF000000 | (val << 16) | (val << 8) | val);
            }
        }
    }

    private double getHillshadeValue(Raster src, int x, int y, double dx, double dy, double azimuth, double altitude, double zFactor) {
        double a = src.getSampleDouble(x-1, y-1, 0) * zFactor, b = src.getSampleDouble(x, y-1, 0) * zFactor, c = src.getSampleDouble(x+1, y-1, 0) * zFactor;
        double d = src.getSampleDouble(x-1, y, 0) * zFactor, f = src.getSampleDouble(x+1, y, 0) * zFactor;
        double g = src.getSampleDouble(x-1, y+1, 0) * zFactor, i = src.getSampleDouble(x+1, y+1, 0) * zFactor, h_val = src.getSampleDouble(x, y+1, 0) * zFactor;
        
        if (isInvalid(a,b,c,d,f,g,h_val,i)) return -1;

        double dzdx = ((c + 2*f + i) - (a + 2*d + g)) / (8 * dx);
        double dzdy = ((g + 2*h_val + i) - (a + 2*b + c)) / (8 * dy);
        double slope_rad = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
        double aspect_rad = Math.atan2(dzdy, -dzdx);
        if (aspect_rad < 0) aspect_rad += 2 * Math.PI;
        
        double zenith_rad = Math.toRadians(90.0 - altitude);
        double azimuth_rad = Math.toRadians(360.0 - azimuth + 90.0);
        double hs = (Math.cos(zenith_rad) * Math.cos(slope_rad)) + (Math.sin(zenith_rad) * Math.sin(slope_rad) * Math.cos(azimuth_rad - aspect_rad));
        return Math.max(0, hs * 255);
    }

    private void calculateFlowAccumulation(Raster src, BufferedImage dest) {
        int w = src.getWidth(), h = src.getHeight();
        int[][] acc = new int[w][h];
        for (int y=0; y<h; y++) for (int x=0; x<w; x++) acc[x][y] = 1;

        for (int iter=0; iter<8; iter++) {
            for (int y = 1; y < h - 1; y++) {
                for (int x = 1; x < w - 1; x++) {
                    double center = src.getSampleDouble(x, y, 0);
                    if (center <= -9999) continue;
                    int targetX = -1, targetY = -1;
                    double maxDrop = 0;
                    for (int dy=-1; dy<=1; dy++) {
                        for (int dx=-1; dx<=1; dx++) {
                            if (dx==0 && dy==0) continue;
                            double drop = center - src.getSampleDouble(x+dx, y+dy, 0);
                            if (dx!=0 && dy!=0) drop /= 1.414;
                            if (drop > maxDrop) { maxDrop = drop; targetX = x+dx; targetY = y+dy; }
                        }
                    }
                    if (targetX != -1) acc[targetX][targetY] += acc[x][y];
                }
            }
        }

        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if (src.getSampleDouble(x, y, 0) <= -9999) { dest.setRGB(x, y, 0); continue; }
                int val = clamp((int) (Math.log1p(acc[x][y]) * 45));
                dest.setRGB(x, y, 0xFF000000 | (val << 16) | (val << 8) | val);
            }
        }
    }
}

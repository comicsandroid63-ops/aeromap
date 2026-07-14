package com.aeromap.service;

import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.coverage.grid.io.AbstractGridFormat;
import org.geotools.coverage.grid.io.GridCoverage2DReader;
import org.geotools.coverage.grid.io.GridFormatFinder;
import org.geotools.gce.geotiff.GeoTiffReader;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.geotools.util.factory.Hints;

import javax.imageio.ImageIO;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;

/**
 * GeoTIFF service with ZERO JAI runtime dependency.
 *
 * Key design decisions:
 * - USE_JAI_IMAGEREAD = FALSE → GeoTools uses pure-Java ImageIO (jai-imageio-core-1.4.0)
 * - GridCoverageRenderer is NOT used (it calls JAI.create() internally → crash in jpackage)
 * - All rendering is done pixel-by-pixel via java.awt.image.Raster
 * - Both RGB/RGBA and single-band (DEM/grayscale) are handled natively
 */
public class GeoTiffService {

    static {
        // Must be first: prevents javax.media.jai.JAI from loading native medialib.
        System.setProperty("com.sun.media.jai.disableMediaLib", "true");
        System.setProperty("javax.media.jai.imageiocache", "false");
        System.setProperty("com.sun.media.imageio.disableNativeCode", "true");
        
        // FORCE X,Y (Longitude, Latitude) axis order globally in GeoTools
        System.setProperty("org.geotools.referencing.forceXY", "true");
        Hints.putSystemDefault(Hints.FORCE_LONGITUDE_FIRST_AXIS_ORDER, Boolean.TRUE);
    }

    public enum ColorScheme {
        GRAYSCALE("Grayscale"),
        ELEVATION("Elevation (DEM)"),
        VIRIDIS("Viridis (Scientific)"),
        PLASMA("Plasma (Scientific)"),
        INFERNO("Inferno (Scientific)"),
        MAGMA("Magma (Scientific)"),
        CIVIDIS("Cividis (Scientific)"),
        TURBO("Turbo (High Contrast)"),
        RAINBOW("Rainbow"),
        OCEAN("Ocean Blues"),
        FOREST("Forest Greens"),
        FIRE("Fire (Heat)"),
        EARTH("Earth Tones"),
        CINEMATIC_WARM("Cinematic Warm"),
        CINEMATIC_COOL("Cinematic Cool"),
        CINEMATIC_TEAL_ORANGE("Cinematic Teal & Orange"),
        CINEMATIC_NOIR("Cinematic Noir (B&W)"),
        CINEMATIC_VINTAGE("Cinematic Vintage"),
        CINEMATIC_BLOCKBUSTER("Cinematic Blockbuster"),
        CINEMATIC_DRAMATIC("Cinematic Dramatic");

        private final String displayName;

        ColorScheme(String displayName) {
            this.displayName = displayName;
        }

        public String getDisplayName() {
            return displayName;
        }
    }

    public static class RasterData {
        public GridCoverage2DReader reader;
        public ReferencedEnvelope envelope;
        public String name;
        public boolean isColorized = false;
        public double globalMin = Double.NaN;
        public double globalMax = Double.NaN;
        public BufferedImage cachedOverview;
        public ReferencedEnvelope overviewEnvelope;
        public ColorScheme colorScheme = ColorScheme.ELEVATION;

        public RasterData(GridCoverage2DReader reader, ReferencedEnvelope envelope, String name) {
            this.reader = reader;
            this.envelope = envelope;
            this.name = name;
        }
    }

    public RasterData loadTiff(File file) throws IOException {
        System.err.println("DEBUG: Starting loadTiff for " + file.getAbsolutePath());

        ClassLoader cl = Thread.currentThread().getContextClassLoader();
        try {
            Thread.currentThread().setContextClassLoader(getClass().getClassLoader());
            ImageIO.scanForPlugins();
        } catch (Throwable t) {
            System.err.println("DEBUG: scanForPlugins warning: " + t.getMessage());
        } finally {
            Thread.currentThread().setContextClassLoader(cl);
        }

        Hints hints = new Hints();
        hints.put(Hints.FORCE_LONGITUDE_FIRST_AXIS_ORDER, Boolean.TRUE);
        hints.put(Hints.USE_JAI_IMAGEREAD, Boolean.FALSE);

        GridCoverage2DReader reader = null;
        try {
            reader = new GeoTiffReader(file, hints);
            System.err.println("DEBUG: GeoTiffReader initialized for " + file.getName());
        } catch (Throwable e) {
            System.err.println("DEBUG: GeoTiffReader failed, trying fallback: " + e.getMessage());
            try {
                AbstractGridFormat format = GridFormatFinder.findFormat(file);
                if (format != null) reader = format.getReader(file, hints);
            } catch (Throwable t) {
                System.err.println("DEBUG: Fallback also failed: " + t.getMessage());
            }
        }

        if (reader == null) {
            throw new IOException("No suitable reader found for " + file.getName());
        }

        org.geotools.coverage.grid.GridGeometry2D gg = new org.geotools.coverage.grid.GridGeometry2D(
            reader.getOriginalGridRange(),
            reader.getOriginalEnvelope()
        );
        org.opengis.referencing.crs.CoordinateReferenceSystem crs = gg.getCoordinateReferenceSystem();
        
        System.err.println("DEBUG: Loading GeoTIFF: " + file.getName());
        System.err.println("DEBUG: Pixel to World (GridToCRS): " + gg.getGridToCRS2D());
        
        if (crs != null) {
            System.err.println("DEBUG: Detected CRS: " + crs.getName().getCode());
            // Log axis order to help debug swaps
            for (int i = 0; i < crs.getCoordinateSystem().getDimension(); i++) {
                org.opengis.referencing.cs.CoordinateSystemAxis axis = crs.getCoordinateSystem().getAxis(i);
                System.err.println("DEBUG: Axis " + i + ": " + axis.getName().getCode() + " (" + axis.getDirection() + ")");
            }
        }

        ReferencedEnvelope envelope = new ReferencedEnvelope(gg.getEnvelope2D());
        
        // --- SMART CRS DETECTION ---
        if (crs == null) {
            double minX = envelope.getMinX();
            double maxX = envelope.getMaxX();
            double minY = envelope.getMinY();
            double maxY = envelope.getMaxY();
            
            // If coordinates are in Lat/Lon range, assume WGS84
            if (minX >= -180.1 && maxX <= 180.1 && minY >= -90.1 && maxY <= 90.1) {
                try {
                    crs = org.geotools.referencing.crs.DefaultGeographicCRS.WGS84;
                    envelope = new ReferencedEnvelope(envelope, crs);
                    System.err.println("DEBUG: No CRS found, but coordinates look like WGS84. Auto-assigning EPSG:4326.");
                } catch (Exception e) {}
            }
        }
        
        // Final sanity check: if CRS exists but axis order is Lat/Lon, we might need a hint
        if (crs != null && crs.getCoordinateSystem().getDimension() >= 2) {
            org.opengis.referencing.cs.AxisDirection dir0 = crs.getCoordinateSystem().getAxis(0).getDirection();
            if (dir0.equals(org.opengis.referencing.cs.AxisDirection.NORTH) || dir0.equals(org.opengis.referencing.cs.AxisDirection.UP)) {
                System.err.println("DEBUG: WARNING - This CRS seems to be Latitude-First or North-First. GeoTools will attempt to reorder it via Hints.");
            }
        }

        RasterData data = new RasterData(reader, envelope, file.getName());

        try {
            org.opengis.parameter.ParameterValueGroup readParams = reader.getFormat().getReadParameters();
            int overviewSize = 2048;
            org.geotools.coverage.grid.GridGeometry2D gridGeom = new org.geotools.coverage.grid.GridGeometry2D(
                new org.geotools.coverage.grid.GeneralGridEnvelope(new Rectangle(0, 0, overviewSize, overviewSize)),
                envelope
            );
            readParams.parameter(AbstractGridFormat.READ_GRIDGEOMETRY2D.getName().getCode()).setValue(gridGeom);
            GridCoverage2D overview = reader.read(
                readParams.values().toArray(new org.opengis.parameter.GeneralParameterValue[0])
            );
            if (overview != null) {
                java.awt.image.RenderedImage renderedImg = overview.getRenderedImage();
                int imgOffX = renderedImg.getMinX(), imgOffY = renderedImg.getMinY();
                int rW = renderedImg.getWidth(), rH = renderedImg.getHeight();
                int numBands = renderedImg.getSampleModel().getNumBands();

                int analyseBands = Math.min(3, numBands);
                double[] pixel = new double[numBands];
                double absMin = Double.MAX_VALUE, absMax = -Double.MAX_VALUE;
                int HIST_BINS = 10000;
                int[][] histograms = new int[analyseBands][HIST_BINS];
                long totalPixels = 0;

                int minTileX = renderedImg.getMinTileX();
                int numXTiles = renderedImg.getNumXTiles();
                int minTileY = renderedImg.getMinTileY();
                int numYTiles = renderedImg.getNumYTiles();
                for (int ti = 0; ti < numXTiles; ti++) {
                    for (int tj = 0; tj < numYTiles; tj++) {
                        java.awt.image.Raster tile = renderedImg.getTile(minTileX + ti, minTileY + tj);
                        if (tile == null) continue;
                        int tMinX = Math.max(tile.getMinX(), imgOffX);
                        int tMinY = Math.max(tile.getMinY(), imgOffY);
                        int tMaxX = Math.min(tile.getMinX() + tile.getWidth(), imgOffX + rW);
                        int tMaxY = Math.min(tile.getMinY() + tile.getHeight(), imgOffY + rH);
                        for (int y = tMinY; y < tMaxY; y++) {
                            for (int x = tMinX; x < tMaxX; x++) {
                                tile.getPixel(x, y, pixel);
                                for (int b = 0; b < analyseBands; b++) {
                                    double val = pixel[b];
                                    if (Double.isNaN(val) || val == -9999 || val <= -1_000_000 || val > 1_000_000) continue;
                                    if (val < absMin) absMin = val;
                                    if (val > absMax) absMax = val;
                                }
                                if (analyseBands > 0) totalPixels++;
                            }
                        }
                    }
                }

                if (absMin < absMax && totalPixels > 0) {
                    double hRange = absMax - absMin;
                    if (hRange <= 0) hRange = 1;
                    for (int b = 0; b < analyseBands; b++) java.util.Arrays.fill(histograms[b], 0);
                    for (int ti = 0; ti < numXTiles; ti++) {
                        for (int tj = 0; tj < numYTiles; tj++) {
                            java.awt.image.Raster tile = renderedImg.getTile(minTileX + ti, minTileY + tj);
                            if (tile == null) continue;
                            int tMinX = Math.max(tile.getMinX(), imgOffX);
                            int tMinY = Math.max(tile.getMinY(), imgOffY);
                            int tMaxX = Math.min(tile.getMinX() + tile.getWidth(), imgOffX + rW);
                            int tMaxY = Math.min(tile.getMinY() + tile.getHeight(), imgOffY + rH);
                            for (int y = tMinY; y < tMaxY; y++) {
                                for (int x = tMinX; x < tMaxX; x++) {
                                    tile.getPixel(x, y, pixel);
                                    for (int b = 0; b < analyseBands; b++) {
                                        double val = pixel[b];
                                        if (Double.isNaN(val) || val == -9999 || val <= -1_000_000 || val > 1_000_000) continue;
                                        int bin = (int) ((val - absMin) / hRange * (HIST_BINS - 1));
                                        if (bin < 0) bin = 0;
                                        if (bin >= HIST_BINS) bin = HIST_BINS - 1;
                                        histograms[b][bin]++;
                                    }
                                }
                            }
                        }
                    }

                    long cum = 0;
                    long clipLow = (long) (totalPixels * 0.05);
                    long clipHigh = (long) (totalPixels * 0.99);
                    int lowBin = 0, highBin = HIST_BINS - 1;
                    for (int i = 0; i < HIST_BINS; i++) {
                        cum += histograms[0][i];
                        if (cum >= clipLow) { lowBin = i; break; }
                    }
                    cum = 0;
                    for (int i = 0; i < HIST_BINS; i++) {
                        cum += histograms[0][i];
                        if (cum >= clipHigh) { highBin = i; break; }
                    }
                    data.globalMin = absMin + (lowBin / (double) (HIST_BINS - 1)) * hRange;
                    data.globalMax = absMin + (highBin / (double) (HIST_BINS - 1)) * hRange;
                } else {
                    data.globalMin = absMin;
                    data.globalMax = absMax;
                }

                data.cachedOverview = renderOverviewToImage(overview, data);
                data.overviewEnvelope = envelope;
                overview.dispose(true);
            }
        } catch (Exception e) {
            System.err.println("DEBUG: Could not calculate global min/max: " + e.getMessage());
        }

        return data;
    }

    public BufferedImage renderTile(RasterData data, ReferencedEnvelope tileEnvelope, int renderW, int renderH) {
        return renderTile(data, tileEnvelope, renderW, renderH, null);
    }

    public BufferedImage renderTile(RasterData data, ReferencedEnvelope tileEnvelope, int renderW, int renderH, org.locationtech.jts.geom.Envelope clipEnv) {
        if (data.reader == null && data.cachedOverview == null) return null;
        if (data.cachedOverview != null && data.overviewEnvelope != null) {
            return renderTileFromOverview(data, tileEnvelope, renderW, renderH, clipEnv);
        }
        return renderTileFromReader(data, tileEnvelope, renderW, renderH);
    }

    private BufferedImage renderTileFromOverview(RasterData data, ReferencedEnvelope tileEnvelope, int renderW, int renderH, org.locationtech.jts.geom.Envelope clipEnv) {
        try {
            BufferedImage overview = data.cachedOverview;
            int oW = overview.getWidth(), oH = overview.getHeight();
            ReferencedEnvelope oEnv = data.overviewEnvelope;

            double tileMinX = tileEnvelope.getMinX(), tileMaxX = tileEnvelope.getMaxX();
            double tileMinY = tileEnvelope.getMinY(), tileMaxY = tileEnvelope.getMinY(); // WAIT: FIXED LATER
            tileMaxY = tileEnvelope.getMaxY();

            double oW_ = oEnv.getWidth(), oH_ = oEnv.getHeight();
            BufferedImage tile = new BufferedImage(renderW, renderH, BufferedImage.TYPE_INT_ARGB);

            double cMinX = clipEnv != null ? clipEnv.getMinX() : oEnv.getMinX();
            double cMaxX = clipEnv != null ? clipEnv.getMaxX() : oEnv.getMaxX();
            double cMinY = clipEnv != null ? clipEnv.getMinY() : oEnv.getMinY();
            double cMaxY = clipEnv != null ? clipEnv.getMaxY() : oEnv.getMaxY();

            for (int ty = 0; ty < renderH; ty++) {
                for (int tx = 0; tx < renderW; tx++) {
                    double wx = tileMinX + ((tx + 0.5) / (double) renderW) * (tileMaxX - tileMinX);
                    double wy = tileMaxY - ((ty + 0.5) / (double) renderH) * (tileMaxY - tileMinY);

                    if (wx < cMinX || wx > cMaxX || wy < cMinY || wy > cMaxY) {
                        tile.setRGB(tx, ty, 0x00000000);
                        continue;
                    }

                    double fx = (wx - oEnv.getMinX()) / oW_ * oW;
                    double fy = (oEnv.getMaxY() - wy) / oH_ * oH;
                    if (fx < 0) fx = 0; if (fx > oW - 1) fx = oW - 1;
                    if (fy < 0) fy = 0; if (fy > oH - 1) fy = oH - 1;
                    int x0 = (int) fx, y0 = (int) fy;
                    int x1 = Math.min(x0 + 1, oW - 1), y1 = Math.min(y0 + 1, oH - 1);
                    double fracX = fx - x0, fracY = fy - y0;
                    int c00 = overview.getRGB(x0, y0), c10 = overview.getRGB(x1, y0);
                    int c01 = overview.getRGB(x0, y1), c11 = overview.getRGB(x1, y1);
                    double w00 = ((c00>>24)&0xFF) > 0 ? (1-fracX)*(1-fracY) : 0;
                    double w10 = ((c10>>24)&0xFF) > 0 ? fracX*(1-fracY) : 0;
                    double w01 = ((c01>>24)&0xFF) > 0 ? (1-fracX)*fracY : 0;
                    double w11 = ((c11>>24)&0xFF) > 0 ? fracX*fracY : 0;
                    double wSum = w00 + w10 + w01 + w11;
                    if (wSum > 0) {
                        double r = (((c00>>16)&0xFF)*w00 + ((c10>>16)&0xFF)*w10 + ((c01>>16)&0xFF)*w01 + ((c11>>16)&0xFF)*w11) / wSum;
                        double g = (((c00>>8)&0xFF)*w00 + ((c10>>8)&0xFF)*w10 + ((c01>>8)&0xFF)*w01 + ((c11>>8)&0xFF)*w11) / wSum;
                        double b = (((c00)&0xFF)*w00 + ((c10)&0xFF)*w10 + ((c01)&0xFF)*w01 + ((c11)&0xFF)*w11) / wSum;
                        tile.setRGB(tx, ty, 0xFF000000 | (clamp((int)r)<<16) | (clamp((int)g)<<8) | clamp((int)b));
                    } else {
                        tile.setRGB(tx, ty, 0x00000000);
                    }
                }
            }
            return tile;
        } catch (Exception e) {
            System.err.println("ERROR rendering tile from overview: " + e.getMessage());
            return null;
        }
    }

    private BufferedImage renderTileFromReader(RasterData data, ReferencedEnvelope tileEnvelope, int renderW, int renderH) {
        try {
            org.opengis.parameter.ParameterValueGroup readParams = data.reader.getFormat().getReadParameters();
            org.geotools.coverage.grid.GridGeometry2D gridGeom = new org.geotools.coverage.grid.GridGeometry2D(
                new org.geotools.coverage.grid.GeneralGridEnvelope(new Rectangle(0, 0, renderW, renderH)),
                tileEnvelope
            );
            readParams.parameter(AbstractGridFormat.READ_GRIDGEOMETRY2D.getName().getCode()).setValue(gridGeom);
            GridCoverage2D coverage = data.reader.read(readParams.values().toArray(new org.opengis.parameter.GeneralParameterValue[0]));
            if (coverage == null) return null;
            BufferedImage image = new BufferedImage(renderW, renderH, BufferedImage.TYPE_INT_ARGB);
            if (coverage.getNumSampleDimensions() >= 3) renderRGBManually(coverage, image, data, renderW, renderH);
            else renderSingleBandManually(coverage, image, data, renderW, renderH);
            coverage.dispose(true);
            return image;
        } catch (Exception e) {
            return null;
        }
    }

    private void renderRGBManually(GridCoverage2D coverage, BufferedImage dest, RasterData data, int renderW, int renderH) {
        try {
            java.awt.image.Raster raster = coverage.getRenderedImage().getData();
            int rW = raster.getWidth(), rH = raster.getHeight(), bands = raster.getNumBands();
            int dataType = raster.getDataBuffer().getDataType();
            double defaultMax = (dataType == java.awt.image.DataBuffer.TYPE_BYTE) ? 255.0 : 65535.0;
            double min = Double.isNaN(data.globalMin) ? 0 : data.globalMin;
            double max = Double.isNaN(data.globalMax) ? defaultMax : data.globalMax;
            double range = (max - min); if (range <= 0) range = 1;
            double[] pixel = new double[bands];
            for (int ty = 0; ty < renderH; ty++) {
                for (int tx = 0; tx < renderW; tx++) {
                    int rx = Math.min((int) ((tx / (double) renderW) * rW), rW - 1);
                    int ry = Math.min((int) ((ty / (double) renderH) * rH), rH - 1);
                    raster.getPixel(rx, ry, pixel);
                    int r = clamp((int) ((pixel[0] - min) / range * 255.0));
                    int g = clamp((int) ((pixel[1] - min) / range * 255.0));
                    int b = clamp((int) ((pixel[2] - min) / range * 255.0));
                    dest.setRGB(tx, ty, 0xFF000000 | (r << 16) | (g << 8) | b);
                }
            }
        } catch (Exception e) {}
    }

    private void renderSingleBandManually(GridCoverage2D coverage, BufferedImage dest, RasterData data, int renderW, int renderH) {
        try {
            java.awt.image.Raster raster = coverage.getRenderedImage().getData();
            int rW = raster.getWidth(), rH = raster.getHeight();
            int dataType = raster.getDataBuffer().getDataType();
            double defaultMax = (dataType == java.awt.image.DataBuffer.TYPE_BYTE) ? 255.0 : 65535.0;
            double min = Double.isNaN(data.globalMin) ? 0 : data.globalMin;
            double max = Double.isNaN(data.globalMax) ? defaultMax : data.globalMax;
            double range = max - min; if (range <= 0) range = 1;
            double[] pixel = new double[1];
            for (int ty = 0; ty < renderH; ty++) {
                for (int tx = 0; tx < renderW; tx++) {
                    int rx = Math.min((int) ((tx / (double) renderW) * rW), rW - 1);
                    int ry = Math.min((int) ((ty / (double) renderH) * rH), rH - 1);
                    raster.getPixel(rx, ry, pixel);
                    double val = pixel[0];
                    if (Double.isNaN(val) || val == -9999 || val <= -1_000_000) {
                        dest.setRGB(tx, ty, 0x00000000); continue;
                    }
                    double norm = Math.max(0.0, Math.min(1.0, (val - min) / range));
                    int argb = data.isColorized ? applyColorScheme(norm, data.colorScheme) : (0xFF000000 | (((int)(norm*255))<<16) | (((int)(norm*255))<<8) | ((int)(norm*255)));
                    dest.setRGB(tx, ty, argb);
                }
            }
        } catch (Exception e) {}
    }

    public static int applyColorScheme(double norm, ColorScheme scheme) {
        norm = Math.max(0.0, Math.min(1.0, norm));
        
        switch (scheme) {
            case GRAYSCALE:
                int gray = (int) (norm * 255);
                return 0xFF000000 | (gray << 16) | (gray << 8) | gray;
                
            case ELEVATION:
                return elevationToColor(norm);
                
            case VIRIDIS:
                return viridisColor(norm);
                
            case PLASMA:
                return plasmaColor(norm);
                
            case INFERNO:
                return infernoColor(norm);
                
            case MAGMA:
                return magmaColor(norm);
                
            case CIVIDIS:
                return cividisColor(norm);
                
            case TURBO:
                return turboColor(norm);
                
            case RAINBOW:
                return rainbowColor(norm);
                
            case OCEAN:
                return oceanColor(norm);
                
            case FOREST:
                return forestColor(norm);
                
            case FIRE:
                return fireColor(norm);
                
            case EARTH:
                return earthColor(norm);
                
            case CINEMATIC_WARM:
                return cinematicWarmColor(norm);
                
            case CINEMATIC_COOL:
                return cinematicCoolColor(norm);
                
            case CINEMATIC_TEAL_ORANGE:
                return cinematicTealOrangeColor(norm);
                
            case CINEMATIC_NOIR:
                return cinematicNoirColor(norm);
                
            case CINEMATIC_VINTAGE:
                return cinematicVintageColor(norm);
                
            case CINEMATIC_BLOCKBUSTER:
                return cinematicBlockbusterColor(norm);
                
            case CINEMATIC_DRAMATIC:
                return cinematicDramaticColor(norm);
                
            default:
                return elevationToColor(norm);
        }
    }

    // Scientific colormaps - perceptually uniform
    private static int viridisColor(double t) {
        // Viridis: dark blue -> teal -> green -> yellow
        double r = 0.26700401 + t * (0.23069454 + t * (-3.60685727 + t * (11.41727671 + t * (-12.97030702 + t * 5.07444249))));
        double g = 0.00441502 + t * (2.10588539 + t * (-10.72730271 + t * (19.92897817 + t * (-13.87162850 + t * 3.56081157))));
        double b = 0.33420363 + t * (0.09355208 + t * (3.46442251 + t * (-9.80812118 + t * (8.62173393 + t * -2.57103070))));
        return 0xFF000000 | (clamp((int)(r * 255)) << 16) | (clamp((int)(g * 255)) << 8) | clamp((int)(b * 255));
    }

    private static int plasmaColor(double t) {
        // Plasma: dark blue -> magenta -> orange -> yellow
        double r = 0.050383 + t * (2.373386 + t * (-5.099294 + t * (4.158434 + t * (-1.318268 + t * 0.035405))));
        double g = 0.029803 + t * (0.184271 + t * (0.483570 + t * (-1.443859 + t * (1.103907 + t * -0.368690))));
        double b = 0.527975 + t * (0.933703 + t * (-4.395601 + t * (5.171865 + t * (-2.324775 + t * 0.087823))));
        return 0xFF000000 | (clamp((int)(r * 255)) << 16) | (clamp((int)(g * 255)) << 8) | clamp((int)(b * 255));
    }

    private static int infernoColor(double t) {
        // Inferno: black -> red -> orange -> yellow -> white
        double r = 0.001462 + t * (0.000466 + t * (1.293481 + t * (-1.522347 + t * (1.120543 + t * -0.393142))));
        double g = 0.000466 + t * (0.023456 + t * (0.136889 + t * (0.061865 + t * (-0.211983 + t * -0.009693))));
        double b = 0.013866 + t * (0.374183 + t * (0.017834 + t * (-1.035953 + t * (0.799420 + t * -0.169153))));
        return 0xFF000000 | (clamp((int)(r * 255)) << 16) | (clamp((int)(g * 255)) << 8) | clamp((int)(b * 255));
    }

    private static int magmaColor(double t) {
        // Magma: black -> purple -> pink -> white
        double r = 0.001392 + t * (0.022831 + t * (1.306495 + t * (-2.145386 + t * (1.682990 + t * -0.867669))));
        double g = 0.000269 + t * (0.078218 + t * (-0.076909 + t * (0.201284 + t * (-0.170164 + t * -0.032717))));
        double b = 0.173828 + t * (1.041902 + t * (-0.802493 + t * (0.965634 + t * (-1.185983 + t * 0.807357))));
        return 0xFF000000 | (clamp((int)(r * 255)) << 16) | (clamp((int)(g * 255)) << 8) | clamp((int)(b * 255));
    }

    private static int cividisColor(double t) {
        // Cividis: dark blue -> greenish -> yellow (colorblind friendly)
        double r = 0.000000 + t * (0.077564 + t * (0.153690 + t * (0.057426 + t * (0.112575 + t * -0.401254))));
        double g = 0.134692 + t * (0.559325 + t * (-0.156666 + t * (-0.042185 + t * (0.103355 + t * -0.598121))));
        double b = 0.201849 + t * (0.649616 + t * (-1.006398 + t * (0.793349 + t * (-0.348053 + t * -0.190361))));
        return 0xFF000000 | (clamp((int)(r * 255)) << 16) | (clamp((int)(g * 255)) << 8) | clamp((int)(b * 255));
    }

    private static int turboColor(double t) {
        // Turbo: rainbow with more distinct colors
        double r = 0.135721 + t * (3.304927 + t * (-16.825693 + t * (29.543067 + t * (-23.591292 + t * 6.813617))));
        double g = 0.128239 + t * (0.808403 + t * (2.334442 + t * (-8.135202 + t * (7.056313 + t * -2.094003))));
        double b = 0.306379 + t * (4.186113 + t * (-13.567568 + t * (16.570627 + t * (-8.939110 + t * 1.643556))));
        return 0xFF000000 | (clamp((int)(r * 255)) << 16) | (clamp((int)(g * 255)) << 8) | clamp((int)(b * 255));
    }

    private static int rainbowColor(double t) {
        // Classic rainbow
        int r = (int) (255 * Math.sin(t * Math.PI * 2 + 0) * 0.5 + 127.5);
        int g = (int) (255 * Math.sin(t * Math.PI * 2 + 2.094) * 0.5 + 127.5);
        int b = (int) (255 * Math.sin(t * Math.PI * 2 + 4.189) * 0.5 + 127.5);
        return 0xFF000000 | (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
    }

    private static int oceanColor(double t) {
        // Ocean: dark blue -> light blue -> cyan -> white
        int[][] stops = {{0, 0, 50}, {0, 50, 150}, {0, 100, 200}, {100, 200, 255}, {200, 240, 255}};
        double[] positions = {0.0, 0.25, 0.5, 0.75, 1.0};
        return interpolateColor(t, stops, positions);
    }

    private static int forestColor(double t) {
        // Forest: dark green -> green -> lime -> yellow-green
        int[][] stops = {{10, 30, 10}, {20, 80, 20}, {50, 150, 50}, {100, 200, 80}, {180, 255, 120}};
        double[] positions = {0.0, 0.25, 0.5, 0.75, 1.0};
        return interpolateColor(t, stops, positions);
    }

    private static int fireColor(double t) {
        // Fire: black -> red -> orange -> yellow -> white
        int[][] stops = {{0, 0, 0}, {128, 0, 0}, {255, 0, 0}, {255, 128, 0}, {255, 255, 0}, {255, 255, 255}};
        double[] positions = {0.0, 0.2, 0.4, 0.6, 0.8, 1.0};
        return interpolateColor(t, stops, positions);
    }

    private static int earthColor(double t) {
        // Earth: dark brown -> brown -> tan -> light tan
        int[][] stops = {{60, 40, 20}, {120, 80, 40}, {180, 140, 100}, {220, 200, 160}, {245, 235, 210}};
        double[] positions = {0.0, 0.25, 0.5, 0.75, 1.0};
        return interpolateColor(t, stops, positions);
    }

    // Cinematic color grades
    private static int cinematicWarmColor(double t) {
        // Warm cinematic: shadows cool, highlights warm
        int[][] stops = {{30, 40, 60}, {80, 70, 60}, {160, 120, 80}, {220, 180, 120}, {255, 230, 180}};
        double[] positions = {0.0, 0.25, 0.5, 0.75, 1.0};
        return interpolateColor(t, stops, positions);
    }

    private static int cinematicCoolColor(double t) {
        // Cool cinematic: teal shadows, blue highlights
        int[][] stops = {{10, 30, 50}, {30, 70, 100}, {60, 120, 160}, {120, 180, 220}, {200, 230, 255}};
        double[] positions = {0.0, 0.25, 0.5, 0.75, 1.0};
        return interpolateColor(t, stops, positions);
    }

    private static int cinematicTealOrangeColor(double t) {
        // Teal & Orange: classic Hollywood look
        int[][] stops = {{10, 30, 40}, {20, 60, 80}, {40, 100, 120}, {180, 120, 60}, {255, 200, 150}};
        double[] positions = {0.0, 0.25, 0.5, 0.75, 1.0};
        return interpolateColor(t, stops, positions);
    }

    private static int cinematicNoirColor(double t) {
        // Noir: high contrast black and white with slight blue tint
        double adjusted = Math.pow(t, 1.5);
        int gray = (int) (adjusted * 255);
        // Slight blue tint in shadows
        int b = gray + (int) ((1 - t) * 15);
        return 0xFF000000 | (gray << 16) | (gray << 8) | clamp(b);
    }

    private static int cinematicVintageColor(double t) {
        // Vintage/sepia: aged film look
        int[][] stops = {{30, 25, 20}, {80, 60, 40}, {140, 110, 70}, {200, 170, 120}, {245, 220, 180}};
        double[] positions = {0.0, 0.25, 0.5, 0.75, 1.0};
        int color = interpolateColor(t, stops, positions);
        // Add slight vignette effect simulation
        return color;
    }

    private static int cinematicBlockbusterColor(double t) {
        // Blockbuster: saturated look with crushed blacks
        double crushed = Math.max(0, (t - 0.1) / 0.9);
        int[][] stops = {{20, 20, 30}, {60, 50, 70}, {140, 100, 80}, {220, 160, 100}, {255, 220, 180}};
        double[] positions = {0.0, 0.25, 0.5, 0.75, 1.0};
        return interpolateColor(crushed, stops, positions);
    }

    private static int cinematicDramaticColor(double t) {
        // Dramatic: high contrast with deep shadows
        double contrast = Math.pow(t - 0.5, 3) * 4 + 0.5;
        contrast = Math.max(0, Math.min(1, contrast));
        int[][] stops = {{5, 5, 10}, {40, 30, 35}, {100, 70, 60}, {180, 140, 100}, {255, 220, 180}};
        double[] positions = {0.0, 0.25, 0.5, 0.75, 1.0};
        return interpolateColor(contrast, stops, positions);
    }

    private static int elevationToColor(double norm) {
        int[][] stops = {{0, 0, 200}, {0, 180, 0}, {255, 220, 0}, {139, 69, 19}, {255, 255, 255}};
        double[] positions = {0.0, 0.25, 0.55, 0.80, 1.0};
        return interpolateColor(norm, stops, positions);
    }

    private static int interpolateColor(double t, int[][] stops, double[] positions) {
        int idx = stops.length - 2;
        for (int i = 0; i < positions.length - 1; i++) {
            if (t <= positions[i + 1]) {
                idx = i;
                break;
            }
        }
        double range = positions[idx + 1] - positions[idx];
        double localT = range > 0 ? (t - positions[idx]) / range : 0;
        localT = Math.max(0, Math.min(1, localT));
        
        int r = (int) (stops[idx][0] + localT * (stops[idx + 1][0] - stops[idx][0]));
        int g = (int) (stops[idx][1] + localT * (stops[idx + 1][1] - stops[idx][1]));
        int b = (int) (stops[idx][2] + localT * (stops[idx + 1][2] - stops[idx][2]));
        return 0xFF000000 | (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
    }

    private static int clamp(int v) { return v < 0 ? 0 : Math.min(v, 255); }

    private BufferedImage renderOverviewToImage(GridCoverage2D coverage, RasterData data) {
        try {
            java.awt.image.RenderedImage renderedImg = coverage.getRenderedImage();
            int imgOffX = renderedImg.getMinX(), imgOffY = renderedImg.getMinY();
            int rW = renderedImg.getWidth(), rH = renderedImg.getHeight(), bands = renderedImg.getSampleModel().getNumBands();
            BufferedImage out = new BufferedImage(rW, rH, BufferedImage.TYPE_INT_ARGB);
            double defaultMax = (renderedImg.getSampleModel().getDataType() == java.awt.image.DataBuffer.TYPE_BYTE) ? 255.0 : 65535.0;
            double min = Double.isNaN(data.globalMin) ? 0 : data.globalMin;
            double max = Double.isNaN(data.globalMax) ? defaultMax : data.globalMax;
            double range = (max - min); if (range <= 0) range = 1;
            double[] pixel = new double[bands];
            int useBands = Math.min(3, bands);
            int minTileX = renderedImg.getMinTileX(), numXTiles = renderedImg.getNumXTiles();
            int minTileY = renderedImg.getMinTileY(), numYTiles = renderedImg.getNumYTiles();
            for (int ti = 0; ti < numXTiles; ti++) {
                for (int tj = 0; tj < numYTiles; tj++) {
                    java.awt.image.Raster tile = renderedImg.getTile(minTileX + ti, minTileY + tj);
                    if (tile == null) continue;
                    int tMinX = Math.max(tile.getMinX(), imgOffX), tMinY = Math.max(tile.getMinY(), imgOffY);
                    int tMaxX = Math.min(tile.getMinX() + tile.getWidth(), imgOffX + rW), tMaxY = Math.min(tile.getMinY() + tile.getHeight(), imgOffY + rH);
                    for (int y = tMinY; y < tMaxY; y++) {
                        for (int x = tMinX; x < tMaxX; x++) {
                            tile.getPixel(x, y, pixel);
                            int ox = x - imgOffX, oy = y - imgOffY;
                            if (useBands >= 3) {
                                int r = clamp((int) ((pixel[0] - min) / range * 255.0));
                                int g = clamp((int) ((pixel[1] - min) / range * 255.0));
                                int b = clamp((int) ((pixel[2] - min) / range * 255.0));
                                out.setRGB(ox, oy, 0xFF000000 | (r << 16) | (g << 8) | b);
                            } else {
                                double val = pixel[0];
                                if (Double.isNaN(val) || val == -9999 || val <= -1_000_000) out.setRGB(ox, oy, 0x00000000);
                                else {
                                    double norm = Math.max(0.0, Math.min(1.0, (val - min) / range));
                                    int argb = data.isColorized ? applyColorScheme(norm, data.colorScheme) : 
                                        (0xFF000000 | (((int)(norm*255))<<16) | (((int)(norm*255))<<8) | ((int)(norm*255)));
                                    out.setRGB(ox, oy, argb);
                                }
                            }
                        }
                    }
                }
            }
            return out;
        } catch (Exception e) { return null; }
    }

    public static double getMetersPerDegreeLongitude(double latitude) {
        return 111320.0 * Math.cos(Math.toRadians(latitude));
    }

    public static double getMetersPerDegreeLatitude() {
        return 111320.0;
    }

    public static boolean isGeographic(org.opengis.referencing.crs.CoordinateReferenceSystem crs) {
        if (crs == null) return false;
        // Check if it's a Geographic CRS or looks like EPSG:4326
        return crs instanceof org.opengis.referencing.crs.GeographicCRS || 
               crs.getName().getCode().contains("4326") || 
               crs.getName().getCode().contains("WGS 84");
    }
}

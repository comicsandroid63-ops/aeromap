package com.aeromap.service;

import javafx.application.Platform;
import javafx.embed.swing.SwingFXUtils;
import javafx.scene.image.Image;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class BaseMapService {

    private static final String TILE_URL = "https://tile.openstreetmap.org/%d/%d/%d.png";
    private static final String USER_AGENT = "AeroMapGIS/3.0";

    private final ConcurrentHashMap<String, BufferedImage> tileCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Boolean> pendingTiles = new ConcurrentHashMap<>();
    private final ExecutorService fetcher = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "basemap-fetcher");
        t.setDaemon(true);
        return t;
    });

    private volatile Runnable onTileLoaded;

    public void setOnTileLoaded(Runnable r) {
        this.onTileLoaded = r;
    }

    public Image renderReprojected(org.locationtech.jts.geom.Envelope viewport, int imgW, int imgH) {
        if (imgW <= 0 || imgH <= 0) return null;

        double viewW = viewport.getWidth();
        double viewH = viewport.getHeight();
        if (viewW <= 0 || viewH <= 0) return null;

        double degPerPx = viewW / imgW;
        int zoom = (int) Math.round(Math.log(360.0 / (degPerPx * 256)) / Math.log(2));
        zoom = Math.max(0, Math.min(zoom, 19));

        double n = Math.pow(2, zoom);

        int minTileX = (int) Math.floor((viewport.getMinX() + 180) / 360 * n);
        int maxTileX = (int) Math.floor((viewport.getMaxX() + 180) / 360 * n);
        int minTileY = (int) Math.floor(tileYFromLat(viewport.getMaxY(), zoom));
        int maxTileY = (int) Math.floor(tileYFromLat(viewport.getMinY(), zoom));

        minTileX = Math.max(0, Math.min(minTileX, (int) n - 1));
        maxTileX = Math.max(0, Math.min(maxTileX, (int) n - 1));
        minTileY = Math.max(0, Math.min(minTileY, (int) n - 1));
        maxTileY = Math.max(0, Math.min(maxTileY, (int) n - 1));

        if (minTileX > maxTileX || minTileY > maxTileY) return null;

        // Fetch uncached tiles asynchronously
        for (int tx = minTileX; tx <= maxTileX; tx++) {
            for (int ty = minTileY; ty <= maxTileY; ty++) {
                String key = zoom + "/" + tx + "/" + ty;
                if (!tileCache.containsKey(key) && !pendingTiles.containsKey(key)) {
                    pendingTiles.put(key, true);
                    fetchTileAsync(key, zoom, tx, ty);
                }
            }
        }

        // We no longer return null if tiles are missing. 
        // We will draw what we have and fill the rest with transparent/background.
        boolean allCached = true;
        for (int tx = minTileX; tx <= maxTileX; tx++) {
            for (int ty = minTileY; ty <= maxTileY; ty++) {
                if (!tileCache.containsKey(zoom + "/" + tx + "/" + ty)) allCached = false;
            }
        }

        // Pre-compute per-row tile Y and fractional offset
        int[] tileIndices = new int[imgH];
        double[] tileFracs = new double[imgH];
        for (int py = 0; py < imgH; py++) {
            double lat = viewport.getMaxY() - (py / (double) imgH) * viewH;
            double tileY = tileYFromLat(lat, zoom);
            int ti = (int) Math.floor(tileY);
            tileIndices[py] = Math.max(minTileY, Math.min(ti, maxTileY));
            tileFracs[py] = tileY - ti;
        }

        BufferedImage out = new BufferedImage(imgW, imgH, BufferedImage.TYPE_INT_ARGB);

        for (int py = 0; py < imgH; py++) {
            int ty = tileIndices[py];
            double fy = tileFracs[py];

            for (int px = 0; px < imgW; px++) {
                double lon = viewport.getMinX() + (px / (double) imgW) * viewW;
                double tileX = (lon + 180) / 360 * n;
                int tx = (int) Math.floor(tileX);
                if (tx < minTileX || tx > maxTileX) {
                    out.setRGB(px, py, 0x00000000);
                    continue;
                }
                double fx = tileX - tx;

                String key = zoom + "/" + tx + "/" + ty;
                BufferedImage tile = tileCache.get(key);
                if (tile == null) {
                    out.setRGB(px, py, 0x00000000);
                    continue;
                }

                int tw = tile.getWidth(), th = tile.getHeight();
                int sx0 = Math.max(0, Math.min((int) (fx * tw), tw - 1));
                int sx1 = Math.min(sx0 + 1, tw - 1);
                int sy0 = Math.max(0, Math.min((int) (fy * th), th - 1));
                int sy1 = Math.min(sy0 + 1, th - 1);
                double fxFrac = fx * tw - sx0;
                double fyFrac = fy * th - sy0;

                int c00 = tile.getRGB(sx0, sy0);
                int c10 = tile.getRGB(sx1, sy0);
                int c01 = tile.getRGB(sx0, sy1);
                int c11 = tile.getRGB(sx1, sy1);

                int r = bilinear(c00, c10, c01, c11, 16, fxFrac, fyFrac);
                int g = bilinear(c00, c10, c01, c11, 8, fxFrac, fyFrac);
                int b = bilinear(c00, c10, c01, c11, 0, fxFrac, fyFrac);
                out.setRGB(px, py, 0xFF000000 | (clamp(r) << 16) | (clamp(g) << 8) | clamp(b));
            }
        }

        return SwingFXUtils.toFXImage(out, null);
    }

    private static int bilinear(int c00, int c10, int c01, int c11, int shift, double fx, double fy) {
        double v00 = (c00 >> shift) & 0xFF;
        double v10 = (c10 >> shift) & 0xFF;
        double v01 = (c01 >> shift) & 0xFF;
        double v11 = (c11 >> shift) & 0xFF;
        return (int) (v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy)
                + v01 * (1 - fx) * fy + v11 * fx * fy);
    }

    private static int clamp(int v) {
        return v < 0 ? 0 : Math.min(v, 255);
    }

    private void fetchTileAsync(String key, int z, int x, int y) {
        fetcher.submit(() -> {
            try {
                String urlStr = String.format(TILE_URL, z, x, y);
                URL url = new URL(urlStr);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestProperty("User-Agent", USER_AGENT);
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(10000);
                BufferedImage bi = ImageIO.read(conn.getInputStream());
                if (bi != null) {
                    tileCache.put(key, bi);
                }
                pendingTiles.remove(key);
                if (onTileLoaded != null) {
                    Platform.runLater(onTileLoaded);
                }
            } catch (Exception e) {
                pendingTiles.remove(key);
            }
        });
    }

    private static double tileYFromLat(double lat, int zoom) {
        double latRad = Math.toRadians(lat);
        double n = Math.pow(2, zoom);
        return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    }

    public void clearCache() {
        tileCache.clear();
    }
}

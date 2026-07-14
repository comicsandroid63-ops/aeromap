package com.aeromap.service;

import javafx.geometry.BoundingBox;
import javafx.geometry.Bounds;
import javafx.scene.text.TextAlignment;
import org.locationtech.jts.geom.*;
import org.geotools.geometry.jts.ReferencedEnvelope;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

public class LabelService {

    public static class LabelConfig {
        public String expression = "";
        public String fontFamily = "Sans-Serif";
        public double fontSize = 12.0;
        public javafx.scene.paint.Color color = javafx.scene.paint.Color.BLACK;
        public javafx.scene.paint.Color haloColor = javafx.scene.paint.Color.WHITE;
        public double haloRadius = 2.0;
        public double bufferX = 5.0;
        public double bufferY = 3.0;
        public boolean bold = false;
        public boolean italic = false;
        public LabelPlacement placement = LabelPlacement.CENTROID;
        public double minScale = 0.0;
        public double maxScale = Double.MAX_VALUE;
        public int priority = 0;
        public boolean enabled = false;
    }

    public enum LabelPlacement {
        CENTROID,
        CENTROID_INSIDE,
        LINE_CENTER,
        LINE_START,
        LINE_END,
        BOUNDARY_NORTH,
        BOUNDARY_SOUTH,
        BOUNDARY_EAST,
        BOUNDARY_WEST,
        BEST_EDGE
    }

    public static class LabelCandidate {
        public Geometry geometry;
        public Map<String, Object> attributes;
        public String text;
        public double worldX, worldY;
        public double screenX, screenY;
        public double width, height;
        public Bounds screenBounds;
        public int priority;
        public LabelPlacement placement;
        public boolean placed = false;
        public LabelConfig config;

        public double penalty = 0.0;

        public LabelCandidate(Geometry g, Map<String, Object> attrs, String txt, int prio, LabelConfig config) {
            this.geometry = g;
            this.attributes = attrs;
            this.text = txt;
            this.priority = prio;
            this.config = config;
        }
    }

    public static class LabelResult {
        public List<LabelCandidate> placedLabels = new ArrayList<>();
        public List<LabelCandidate> rejectedLabels = new ArrayList<>();
        public int totalCandidates;
        public int conflictCount;
    }

    private final Pattern exprPattern = Pattern.compile("\\[(<)?([a-zA-Z_][a-zA-Z0-9_]*)(>)?\\]|([^{}]+)");

    public String evaluateExpression(String expression, Map<String, Object> attributes) {
        if (expression == null || expression.isEmpty()) return "";
        StringBuilder result = new StringBuilder();

        Matcher matcher = exprPattern.matcher(expression);
        while (matcher.find()) {
            if (matcher.group(2) != null) {
                String fieldName = matcher.group(2);
                Object value = attributes.get(fieldName);
                result.append(value != null ? value.toString() : "");
            } else if (matcher.group(4) != null) {
                result.append(matcher.group(4));
            }
        }
        return result.toString().trim();
    }

    public List<LabelPlacement> getPreferredPlacements(Geometry g) {
        List<LabelPlacement> placements = new ArrayList<>();
        if (g instanceof Point || g instanceof MultiPoint) {
            placements.add(LabelPlacement.CENTROID);
            placements.add(LabelPlacement.CENTROID_INSIDE);
        } else if (g instanceof LineString || g instanceof MultiLineString) {
            placements.add(LabelPlacement.LINE_CENTER);
            placements.add(LabelPlacement.CENTROID);
            placements.add(LabelPlacement.LINE_START);
            placements.add(LabelPlacement.LINE_END);
        } else if (g instanceof Polygon || g instanceof MultiPolygon) {
            placements.add(LabelPlacement.CENTROID_INSIDE);
            placements.add(LabelPlacement.CENTROID);
            placements.add(LabelPlacement.BOUNDARY_NORTH);
            placements.add(LabelPlacement.BOUNDARY_SOUTH);
            placements.add(LabelPlacement.BOUNDARY_EAST);
            placements.add(LabelPlacement.BOUNDARY_WEST);
        }
        return placements;
    }

    public List<Coordinate> getLabelPointsForGeometry(Geometry g, LabelPlacement placement) {
        List<Coordinate> points = new ArrayList<>();
        switch (placement) {
            case CENTROID:
                points.add(g.getCentroid().getCoordinate());
                break;
            case CENTROID_INSIDE:
                if (g instanceof Polygon) {
                    Point labelPoint = ((Polygon) g).getInteriorPoint();
                    points.add(labelPoint.getCoordinate());
                } else {
                    points.add(g.getCentroid().getCoordinate());
                }
                break;
            case LINE_CENTER:
                if (g instanceof LineString) {
                    LineString ls = (LineString) g;
                    int mid = ls.getNumPoints() / 2;
                    points.add(ls.getCoordinateN(mid));
                } else if (g instanceof MultiLineString) {
                    for (int i = 0; i < g.getNumGeometries(); i++) {
                        Geometry child = g.getGeometryN(i);
                        if (child instanceof LineString) {
                            LineString ls = (LineString) child;
                            int mid = ls.getNumPoints() / 2;
                            points.add(ls.getCoordinateN(mid));
                        }
                    }
                } else {
                    points.add(g.getCentroid().getCoordinate());
                }
                break;
            case LINE_START:
                if (g instanceof LineString) {
                    points.add(((LineString) g).getCoordinateN(0));
                } else if (g instanceof MultiLineString) {
                    Geometry first = g.getGeometryN(0);
                    if (first instanceof LineString) points.add(((LineString) first).getCoordinateN(0));
                } else {
                    points.add(g.getCentroid().getCoordinate());
                }
                break;
            case LINE_END:
                if (g instanceof LineString) {
                    LineString ls = (LineString) g;
                    points.add(ls.getCoordinateN(ls.getNumPoints() - 1));
                } else if (g instanceof MultiLineString) {
                    Geometry last = g.getGeometryN(g.getNumGeometries() - 1);
                    if (last instanceof LineString) {
                        LineString ls = (LineString) last;
                        points.add(ls.getCoordinateN(ls.getNumPoints() - 1));
                    }
                } else {
                    points.add(g.getCentroid().getCoordinate());
                }
                break;
            case BOUNDARY_NORTH:
            case BOUNDARY_SOUTH:
            case BOUNDARY_EAST:
            case BOUNDARY_WEST:
            case BEST_EDGE:
                points.add(g.getCentroid().getCoordinate());
                break;
        }
        return points;
    }

    public double[] getLabelAnchorOffset(LabelPlacement placement) {
        switch (placement) {
            case CENTROID:
            case CENTROID_INSIDE:
            case LINE_CENTER:
                return new double[]{0.5, 0.5};
            case LINE_START:
                return new double[]{0.0, 0.5};
            case LINE_END:
                return new double[]{1.0, 0.5};
            case BOUNDARY_NORTH:
                return new double[]{0.5, 1.0};
            case BOUNDARY_SOUTH:
                return new double[]{0.5, 0.0};
            case BOUNDARY_EAST:
                return new double[]{0.0, 0.5};
            case BOUNDARY_WEST:
                return new double[]{1.0, 0.5};
            default:
                return new double[]{0.5, 0.5};
        }
    }

    public LabelResult placeLabels(
            List<VectorService.VectorData> vectorLayers,
            java.util.Map<VectorService.VectorData, LabelConfig> labelConfigs,
            ReferencedEnvelope viewport,
            double canvasWidth,
            double canvasHeight,
            java.util.function.BiFunction<Double, Double, Double> worldToScreenX,
            java.util.function.BiFunction<Double, Double, Double> worldToScreenY) {

        LabelResult result = new LabelResult();
        List<LabelCandidate> allCandidates = new ArrayList<>();

        double scale = canvasWidth / viewport.getWidth();

        for (VectorService.VectorData vd : vectorLayers) {
            LabelConfig config = labelConfigs.get(vd);
            if (config == null || !config.enabled) continue;
            if (scale < config.minScale || scale > config.maxScale) continue;

            Envelope viewEnv = new Envelope(
                    viewport.getMinX(), viewport.getMaxX(),
                    viewport.getMinY(), viewport.getMaxY());

            List<Geometry> visible = vd.spatialIndex.query(viewEnv);

            for (int i = 0; i < visible.size(); i++) {
                Geometry g = visible.get(i);
                Map<String, Object> attrs = vd.geomToAttrs != null ? vd.geomToAttrs.getOrDefault(g, new HashMap<>()) : new HashMap<>();

                String text = evaluateExpression(config.expression, attrs);
                if (text == null || text.isEmpty()) continue;

                List<LabelPlacement> placements = getPreferredPlacements(g);
                for (LabelPlacement pl : placements) {
                    List<Coordinate> labelPoints = getLabelPointsForGeometry(g, pl);
                    for (Coordinate c : labelPoints) {
                        LabelCandidate candidate = new LabelCandidate(g, attrs, text, config.priority, config);
                        candidate.worldX = c.x;
                        candidate.worldY = c.y;
                        candidate.screenX = worldToScreenX.apply(c.x, c.y);
                        candidate.screenY = worldToScreenY.apply(c.x, c.y);
                        candidate.placement = pl;
                        allCandidates.add(candidate);
                    }
                }
            }
        }

        result.totalCandidates = allCandidates.size();

        allCandidates.sort((a, b) -> {
            int p = Integer.compare(b.priority, a.priority);
            if (p != 0) return p;
            return Double.compare(a.text.length(), b.text.length());
        });

        Set<Bounds> occupiedBounds = new HashSet<>();
        Set<String> occupiedGridKeys = new HashSet<>();
        int gridCellSize = 20;

        for (LabelCandidate candidate : allCandidates) {
            LabelConfig cfg = candidate.config;
            double bufferPixels = Math.max(cfg.bufferX, cfg.bufferY);
            double halo = cfg.haloRadius;

            double estWidth = candidate.text.length() * cfg.fontSize * 0.6 + halo * 2 + bufferPixels;
            double estHeight = cfg.fontSize * 1.4 + halo * 2 + bufferPixels;

            candidate.width = estWidth;
            candidate.height = estHeight;
            candidate.screenX = worldToScreenX.apply(candidate.worldX, candidate.worldY);
            candidate.screenY = worldToScreenY.apply(candidate.worldY, candidate.worldY);

            double bx = candidate.screenX - estWidth / 2;
            double by = candidate.screenY - estHeight / 2;

            Bounds candidateBounds = new BoundingBox(bx, by, estWidth, estHeight);

            boolean hasConflict = false;

            for (Bounds occupied : occupiedBounds) {
                if (boundsIntersect(candidateBounds, occupied, -2)) {
                    hasConflict = true;
                    result.conflictCount++;
                    break;
                }
            }

            if (!hasConflict && gridCellSize > 0) {
                int minGX = (int) (bx / gridCellSize);
                int maxGX = (int) ((bx + estWidth) / gridCellSize);
                int minGY = (int) (by / gridCellSize);
                int maxGY = (int) ((by + estHeight) / gridCellSize);

                for (int gx = minGX; gx <= maxGX; gx++) {
                    for (int gy = minGY; gy <= maxGY; gy++) {
                        String key = gx + ":" + gy;
                        if (occupiedGridKeys.contains(key)) {
                            hasConflict = true;
                            result.conflictCount++;
                            break;
                        }
                    }
                    if (hasConflict) break;
                }
            }

            if (!hasConflict) {
                occupiedBounds.add(candidateBounds);
                if (gridCellSize > 0) {
                    int minGX = (int) (bx / gridCellSize);
                    int maxGX = (int) ((bx + estWidth) / gridCellSize);
                    int minGY = (int) (by / gridCellSize);
                    int maxGY = (int) ((by + estHeight) / gridCellSize);
                    for (int gx = minGX; gx <= maxGX; gx++) {
                        for (int gy = minGY; gy <= maxGY; gy++) {
                            occupiedGridKeys.add(gx + ":" + gy);
                        }
                    }
                }
                candidate.placed = true;
                candidate.screenBounds = candidateBounds;
                result.placedLabels.add(candidate);
            } else {
                candidate.penalty = calculatePenalty(candidate, result.placedLabels);
                result.rejectedLabels.add(candidate);
            }
        }

        return result;
    }

    private boolean boundsIntersect(Bounds a, Bounds b, double margin) {
        return !(a.getMaxX() - margin < b.getMinX() ||
                a.getMinX() + margin > b.getMaxX() ||
                a.getMaxY() - margin < b.getMinY() ||
                a.getMinY() + margin > b.getMaxY());
    }

    private double calculatePenalty(LabelCandidate rejected, List<LabelCandidate> placed) {
        double minDist = Double.MAX_VALUE;
        for (LabelCandidate placed_candidate : placed) {
            double dx = rejected.screenX - placed_candidate.screenX;
            double dy = rejected.screenY - placed_candidate.screenY;
            double dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) minDist = dist;
        }
        return minDist;
    }

    public LabelResult resolveConflicts(
            List<LabelCandidate> candidates,
            double canvasWidth,
            double canvasHeight,
            int maxIterations,
            double convergenceThreshold) {

        LabelResult result = new LabelResult();
        result.totalCandidates = candidates.size();

        for (LabelCandidate c : candidates) {
            c.placed = false;
            c.screenBounds = null;
        }

        candidates.sort((a, b) -> Integer.compare(b.priority, a.priority));

        Set<Bounds> occupied = new HashSet<>();

        for (LabelCandidate candidate : candidates) {
            double halo = 2.0;
            double bx = candidate.screenX - candidate.width / 2 - halo;
            double by = candidate.screenY - candidate.height / 2 - halo;
            Bounds candidateBounds = new BoundingBox(bx, by, candidate.width + halo * 2, candidate.height + halo * 2);

            boolean conflict = false;
            for (Bounds b : occupied) {
                if (boundsIntersect(candidateBounds, b, -1)) {
                    conflict = true;
                    break;
                }
            }

            if (!conflict) {
                occupied.add(candidateBounds);
                candidate.placed = true;
                candidate.screenBounds = candidateBounds;
                result.placedLabels.add(candidate);
            } else {
                result.rejectedLabels.add(candidate);
                result.conflictCount++;
            }
        }

        return result;
    }

    public void renderLabels(
            javafx.scene.canvas.GraphicsContext gc,
            List<LabelCandidate> labels) {

        for (LabelCandidate label : labels) {
            if (!label.placed || label.text.isEmpty()) continue;

            LabelConfig config = label.config;
            if (config == null) continue;

            gc.save();

            double halo = config.haloRadius;
            if (halo > 0) {
                gc.setFill(config.haloColor);
                gc.fillRect(
                        label.screenX - label.width / 2 - halo,
                        label.screenY - label.height / 2 - halo,
                        label.width + halo * 2,
                        label.height + halo * 2);
            }

            gc.setFont(javafx.scene.text.Font.font(
                    config.fontFamily,
                    config.bold ? javafx.scene.text.FontWeight.BOLD : javafx.scene.text.FontWeight.NORMAL,
                    config.italic ? javafx.scene.text.FontPosture.ITALIC : javafx.scene.text.FontPosture.REGULAR,
                    config.fontSize));
            gc.setFill(config.color);
            gc.setStroke(null);

            double textX = label.screenX - label.width / 2 + halo;
            double textY = label.screenY + config.fontSize * 0.35;

            gc.fillText(label.text, textX, textY);

            gc.restore();
        }
    }

    public static class LabelStyle {
        public javafx.scene.text.Font font;
        public javafx.scene.paint.Color color;
        public javafx.scene.paint.Color haloColor;
        public double haloRadius;
    }

    public LabelStyle createLabelStyle(LabelConfig config) {
        LabelStyle style = new LabelStyle();
        style.font = javafx.scene.text.Font.font(
                config.fontFamily,
                config.bold ? javafx.scene.text.FontWeight.BOLD : javafx.scene.text.FontWeight.NORMAL,
                config.italic ? javafx.scene.text.FontPosture.ITALIC : javafx.scene.text.FontPosture.REGULAR,
                config.fontSize);
        style.color = config.color;
        style.haloColor = config.haloColor;
        style.haloRadius = config.haloRadius;
        return style;
    }
}
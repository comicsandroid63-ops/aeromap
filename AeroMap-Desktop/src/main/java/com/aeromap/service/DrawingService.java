package com.aeromap.service;

import org.locationtech.jts.geom.*;

import java.util.ArrayList;
import java.util.List;

public class DrawingService {

    public enum Mode {
        NONE, LINE, POLYGON, GROUP
    }

    private Mode currentMode = Mode.NONE;
    private final List<Coordinate> currentPoints = new ArrayList<>();
    private final List<Geometry> completedGeometries = new ArrayList<>();
    private final GeometryFactory gf = new GeometryFactory();

    public void setMode(Mode mode) {
        this.currentMode = mode;
        if (mode == Mode.NONE) {
            currentPoints.clear();
            completedGeometries.clear();
        }
    }

    public Mode getCurrentMode() {
        return currentMode;
    }

    public boolean isActive() {
        return currentMode != Mode.NONE;
    }

    public void addPoint(double x, double y) {
        if (!isActive()) return;
        currentPoints.add(new Coordinate(x, y));
    }

    public List<Coordinate> getCurrentPoints() {
        return currentPoints;
    }

    public Geometry finishShape() {
        if (currentPoints.size() < 2) return null;

        Geometry shape;
        if (currentMode == Mode.POLYGON) {
            List<Coordinate> closed = new ArrayList<>(currentPoints);
            if (!closed.get(0).equals(closed.get(closed.size() - 1))) {
                closed.add(new Coordinate(closed.get(0)));
            }
            shape = gf.createPolygon(closed.toArray(new Coordinate[0]));
        } else {
            shape = gf.createLineString(currentPoints.toArray(new Coordinate[0]));
        }

        currentPoints.clear();

        if (currentMode == Mode.GROUP) {
            completedGeometries.add(shape);
            return null;
        }

        return shape;
    }

    public Geometry finishGroup() {
        if (completedGeometries.isEmpty()) return null;

        Geometry result;
        if (completedGeometries.size() == 1) {
            result = completedGeometries.get(0);
        } else {
            result = gf.createGeometryCollection(completedGeometries.toArray(new Geometry[0]));
        }

        completedGeometries.clear();
        return result;
    }

    public void cancel() {
        currentPoints.clear();
        completedGeometries.clear();
    }

    public int getCompletedCount() {
        return completedGeometries.size();
    }

    public List<Geometry> getCompletedGeometries() {
        return completedGeometries;
    }
}
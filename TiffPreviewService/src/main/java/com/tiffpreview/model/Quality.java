package com.tiffpreview.model;

public enum Quality {
    LOW(50, 0.5f),
    MID(75, 0.75f),
    HI(90, 1.0f);

    private final int jpegQuality;
    private final float compressionRatio;

    Quality(int jpegQuality, float compressionRatio) {
        this.jpegQuality = jpegQuality;
        this.compressionRatio = compressionRatio;
    }

    public int jpegQuality() {
        return jpegQuality;
    }

    public float compressionRatio() {
        return compressionRatio;
    }

    public boolean requiresDithering() {
        return this == LOW;
    }
}

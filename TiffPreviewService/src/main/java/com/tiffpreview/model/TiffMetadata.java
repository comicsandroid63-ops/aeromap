package com.tiffpreview.model;

import java.util.Optional;

public record TiffMetadata(
        int width,
        int height,
        int pageCount,
        String compression,
        boolean hasEmbeddedThumbnail,
        Optional<byte[]> thumbnailBytes,
        boolean hasPyramidLevels,
        Integer recommendedLevel) {

    public TiffMetadata {
        if (width <= 0) throw new IllegalArgumentException("width must be > 0");
        if (height <= 0) throw new IllegalArgumentException("height must be > 0");
        if (pageCount <= 0) throw new IllegalArgumentException("pageCount must be > 0");
    }

    public static TiffMetadata empty(int w, int h, int pages) {
        return new TiffMetadata(w, h, pages, "unknown", false,
                Optional.empty(), false, null);
    }

    public int maxDimension() {
        return Math.max(width, height);
    }

    public double aspectRatio() {
        return (double) width / height;
    }
}

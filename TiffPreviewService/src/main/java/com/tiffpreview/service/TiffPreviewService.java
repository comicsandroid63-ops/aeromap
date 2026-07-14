package com.tiffpreview.service;

import com.github.benmanes.caffeine.cache.Cache;
import com.tiffpreview.model.Quality;
import com.tiffpreview.model.TiffMetadata;
import org.springframework.stereotype.Service;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.ImageReadParam;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageInputStream;
import javax.imageio.stream.ImageOutputStream;
import java.awt.image.BufferedImage;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;

@Service
public class TiffPreviewService {

    private static final int MAX_PREVIEW_DIM = 512;
    private static final int TIMEOUT_SECONDS = 10;
    private static final String WEBP_FORMAT = "webp";
    private static final String JPEG_FORMAT = "jpeg";
    private static final int[] IFD_TAGS_TO_READ = {256, 257, 258, 259, 330, 34665};

    private final ConcurrentHashMap<String, byte[]> l1Cache;
    private final Cache<String, byte[]> l2Cache;
    private final Semaphore semaphore;
    private final ExecutorService ioExecutor;

    public TiffPreviewService(ConcurrentHashMap<String, byte[]> l1Cache,
                              Cache<String, byte[]> l2Cache,
                              Semaphore semaphore,
                              ExecutorService ioExecutor) {
        this.l1Cache = l1Cache;
        this.l2Cache = l2Cache;
        this.semaphore = semaphore;
        this.ioExecutor = ioExecutor;
    }

    public TiffMetadata extractMetadata(Path tiffPath) {
        try (RandomAccessFile raf = new RandomAccessFile(tiffPath.toFile(), "r");
             FileChannel channel = raf.getChannel()) {

            byte[] header = new byte[8];
            raf.readFully(header);

            if (header[0] != 'I' && header[0] != 'M') {
                throw new IllegalArgumentException("Not a valid TIFF file");
            }
            boolean littleEndian = header[0] == 'I';
            ByteOrder byteOrder = littleEndian ? ByteOrder.LITTLE_ENDIAN : ByteOrder.BIG_ENDIAN;

            int firstIfdOffset = readIntBacked(header, 4, byteOrder);
            if (firstIfdOffset <= 0 || firstIfdOffset >= raf.length()) {
                return fallbackMetadata(tiffPath);
            }

            int width = 0, height = 0;
            int compression = 1;
            boolean hasEmbeddedThumbnail = false;
            Optional<byte[]> thumbnailBytes = Optional.empty();
            boolean hasPyramidLevels = false;
            Integer recommendedLevel = null;
            int pageCount = 0;

            int ifdOffset = firstIfdOffset;
            while (ifdOffset > 0 && ifdOffset < raf.length() - 2) {
                pageCount++;

                long mapEnd = Math.min(ifdOffset + 65536, raf.length());
                long mapLen = mapEnd - ifdOffset;
                ByteBuffer entriesBuf = channel.map(FileChannel.MapMode.READ_ONLY, ifdOffset, (int) mapLen);
                entriesBuf.order(byteOrder);

                int entryCount = Short.toUnsignedInt(entriesBuf.getShort());
                if (entryCount < 1 || entryCount > 65535) break;

                for (int i = 0; i < entryCount; i++) {
                    if (entriesBuf.remaining() < 12) break;
                    int tag = Short.toUnsignedInt(entriesBuf.getShort());
                    int type = Short.toUnsignedInt(entriesBuf.getShort());
                    int count = (int) entriesBuf.getInt();
                    int valOrOffset = entriesBuf.getInt();

                    int dataSize = count * typeSize(type);
                    long actualValue;
                    if (dataSize <= 4) {
                        actualValue = switch (type) {
                            case 1, 6 -> Byte.toUnsignedInt((byte) valOrOffset);
                            case 3, 8 -> Short.toUnsignedInt((short) valOrOffset);
                            case 4, 9, 13 -> Integer.toUnsignedLong(valOrOffset);
                            default -> Integer.toUnsignedLong(valOrOffset);
                        };
                    } else {
                        actualValue = Integer.toUnsignedLong(valOrOffset);
                    }

                    switch (tag) {
                        case 256 -> width = (int) actualValue;
                        case 257 -> height = (int) actualValue;
                        case 259 -> compression = (int) actualValue;
                        case 330 -> {
                            hasEmbeddedThumbnail = true;
                            if (actualValue > 0 && actualValue < raf.length()) {
                                thumbnailBytes = extractSubIfdThumbnail(
                                        channel, byteOrder, (int) actualValue);
                            }
                        }
                        default -> { }
                    }
                }

                int nextOffPos = 2 + entryCount * 12;
                if (nextOffPos + 4 <= entriesBuf.limit()) {
                    int nextIfdOffset = entriesBuf.getInt(nextOffPos);
                    if (nextIfdOffset > 0 && nextIfdOffset < raf.length() - 2
                            && nextIfdOffset > ifdOffset) {
                        ifdOffset = nextIfdOffset;
                    } else {
                        ifdOffset = 0;
                    }
                } else {
                    ifdOffset = 0;
                }
            }

            if (width > 0 && height > 0) {
                if (hasEmbeddedThumbnail && thumbnailBytes.isEmpty()) {
                    hasEmbeddedThumbnail = false;
                }
                return new TiffMetadata(width, height, pageCount,
                        compressionName(compression), hasEmbeddedThumbnail,
                        thumbnailBytes, hasPyramidLevels, recommendedLevel);
            }

            return fallbackMetadata(tiffPath);

        } catch (Exception e) {
            return fallbackMetadata(tiffPath);
        }
    }

    private TiffMetadata fallbackMetadata(Path tiffPath) {
        try (ImageInputStream iis = ImageIO.createImageInputStream(tiffPath.toFile())) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
            if (readers.hasNext()) {
                ImageReader reader = readers.next();
                try {
                    reader.setInput(iis, false, true);
                    int w = reader.getWidth(0);
                    int h = reader.getHeight(0);
                    int pages;
                    try {
                        pages = reader.getNumImages(true);
                    } catch (Exception e) {
                        pages = 1;
                    }
                    return TiffMetadata.empty(w, h, Math.max(1, pages));
                } finally {
                    reader.dispose();
                }
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to extract TIFF metadata: " + e.getMessage(), e);
        }
        throw new RuntimeException("Cannot read TIFF file");
    }

    private Optional<byte[]> extractSubIfdThumbnail(FileChannel channel,
                                                     ByteOrder byteOrder,
                                                     int subIfdOffset) {
        try {
            ByteBuffer buf = channel.map(FileChannel.MapMode.READ_ONLY, subIfdOffset, 1024);
            buf.order(byteOrder);
            int entryCount = Short.toUnsignedInt(buf.getShort());
            buf.position(2);

            long stripOffset = -1, stripByteCount = -1;
            int thumbWidth = 0, thumbHeight = 0, bitsPerSample = 8, samplesPerPixel;

            for (int i = 0; i < entryCount && buf.remaining() >= 12; i++) {
                int tag = Short.toUnsignedInt(buf.getShort());
                buf.getShort();
                int count = buf.getInt();
                long valOrOffset = Integer.toUnsignedLong(buf.getInt());

                switch (tag) {
                    case 256:
                        thumbWidth = (int) valOrOffset;
                        break;
                    case 257:
                        thumbHeight = (int) valOrOffset;
                        break;
                    case 273:
                        stripOffset = valOrOffset;
                        break;
                    case 279:
                        stripByteCount = valOrOffset;
                        break;
                }
            }

            if (stripOffset > 0 && stripByteCount > 0
                    && stripByteCount < 10_000_000
                    && thumbWidth > 0 && thumbHeight > 0) {
                long size = channel.size();
                if (stripOffset + stripByteCount <= size) {
                    ByteBuffer data = channel.map(FileChannel.MapMode.READ_ONLY,
                            stripOffset, (int) stripByteCount);
                    data.order(byteOrder);
                    byte[] raw = new byte[(int) stripByteCount];
                    data.get(raw);
                    return Optional.of(raw);
                }
            }
        } catch (Exception e) {
        }
        return Optional.empty();
    }

    public byte[] generatePreview(Path path, int page, Quality quality) {
        String cacheKey = cacheKey(path, page, quality);

        byte[] cached = l1Cache.get(cacheKey);
        if (cached != null) return cached;

        cached = l2Cache.getIfPresent(cacheKey);
        if (cached != null) {
            l1Cache.put(cacheKey, cached);
            return cached;
        }

        try {
            if (!semaphore.tryAcquire(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                throw new RuntimeException("Preview generation timed out waiting for semaphore");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("Interrupted while waiting for semaphore", e);
        }

        try {
            byte[] result = CompletableFuture
                    .supplyAsync(() -> doGeneratePreview(path, page, quality), ioExecutor)
                    .orTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
                    .join();

            l2Cache.put(cacheKey, result);
            l1Cache.put(cacheKey, result);
            return result;
        } finally {
            semaphore.release();
        }
    }

    public void streamPreview(Path path, int page, OutputStream out) {
        byte[] previewBytes = generatePreview(path, page, Quality.MID);
        try {
            out.write(previewBytes);
            out.flush();
        } catch (Exception e) {
            throw new RuntimeException("Failed to stream preview", e);
        }
    }

    private byte[] doGeneratePreview(Path path, int page, Quality quality) {
        TiffMetadata meta = extractMetadata(path);

        if (meta.hasEmbeddedThumbnail() && meta.thumbnailBytes().isPresent()) {
            byte[] thumbResult = encodeFromThumbnail(meta.thumbnailBytes().get(), quality,
                    meta.width(), meta.height());
            if (thumbResult != null && thumbResult.length > 0) {
                return thumbResult;
            }
        }

        return encodeFromDecodedRegion(path, page, quality, meta);
    }

    private byte[] encodeFromThumbnail(byte[] rawThumbData, Quality quality,
                                        int originalW, int originalH) {
        try {
            BufferedImage thumb = decodeRawTiffThumbnail(rawThumbData);
            if (thumb == null) return null;

            return encodeImage(thumb, quality, false);
        } catch (Exception e) {
            return null;
        }
    }

    private BufferedImage decodeRawTiffThumbnail(byte[] rawData) {
        try {
            java.io.ByteArrayInputStream bais = new java.io.ByteArrayInputStream(rawData);
            try (ImageInputStream iis = ImageIO.createImageInputStream(bais)) {
                Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
                if (readers.hasNext()) {
                    ImageReader reader = readers.next();
                    try {
                        reader.setInput(iis, false, false);
                        return reader.read(0);
                    } finally {
                        reader.dispose();
                    }
                }
            }
        } catch (Exception e) {
        }

        try {
            return ImageIO.read(new java.io.ByteArrayInputStream(rawData));
        } catch (Exception e) {
        }

        return null;
    }

    private byte[] encodeFromDecodedRegion(Path path, int page, Quality quality,
                                            TiffMetadata meta) {
        try (ImageInputStream iis = ImageIO.createImageInputStream(path.toFile())) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
            if (!readers.hasNext()) {
                throw new RuntimeException("No TIFF reader available");
            }

            ImageReader reader = readers.next();
            try {
                reader.setInput(iis, false, false);

                int numImages;
                try {
                    numImages = reader.getNumImages(true);
                } catch (Exception e) {
                    numImages = meta.pageCount();
                }
                if (page < 0 || (numImages > 0 && page >= numImages)) {
                    page = 0;
                }

                int srcW = meta.width();
                int srcH = meta.height();

                int subX = Math.max(1, (int) Math.ceil((double) srcW / MAX_PREVIEW_DIM));
                int subY = Math.max(1, (int) Math.ceil((double) srcH / MAX_PREVIEW_DIM));

                ImageReadParam param = reader.getDefaultReadParam();
                param.setSourceRegion(new java.awt.Rectangle(0, 0, srcW, srcH));
                param.setSourceSubsampling(subX, subY, 0, 0);

                BufferedImage sampled = reader.read(page, param);

                int sampledW = (int) Math.ceil((double) srcW / subX);
                int sampledH = (int) Math.ceil((double) srcH / subY);
                if (sampledW > MAX_PREVIEW_DIM || sampledH > MAX_PREVIEW_DIM) {
                    double scale = computeScale(sampledW, sampledH, MAX_PREVIEW_DIM);
                    int targetW = Math.max(1, (int) (sampledW * scale));
                    int targetH = Math.max(1, (int) (sampledH * scale));
                    BufferedImage scaled = new BufferedImage(targetW, targetH,
                            sampled.getType() == BufferedImage.TYPE_CUSTOM
                                    ? BufferedImage.TYPE_INT_RGB
                                    : sampled.getType());
                    java.awt.Graphics2D g = scaled.createGraphics();
                    g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION,
                            java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                    g.drawImage(sampled, 0, 0, targetW, targetH, null);
                    g.dispose();
                    sampled = scaled;
                }

                return encodeImage(sampled, quality, quality.requiresDithering());

            } finally {
                reader.dispose();
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to encode preview: " + e.getMessage(), e);
        }
    }

    private byte[] encodeImage(BufferedImage image, Quality quality, boolean dither) {
        if (image == null) {
            throw new IllegalArgumentException("Image cannot be null");
        }

        BufferedImage safe = ensureRgb(image);

        if (dither) {
            applyFloydSteinbergDithering(safe);
        }

        try {
            byte[] webpBytes = encodeWebP(safe, quality);
            if (webpBytes != null) return webpBytes;
        } catch (Exception ignored) {
        }

        return encodeJpeg(safe, quality.jpegQuality());
    }

    private BufferedImage ensureRgb(BufferedImage src) {
        if (src.getType() == BufferedImage.TYPE_INT_RGB
                || src.getType() == BufferedImage.TYPE_3BYTE_BGR) {
            return src;
        }
        BufferedImage rgb = new BufferedImage(src.getWidth(), src.getHeight(),
                BufferedImage.TYPE_INT_RGB);
        java.awt.Graphics2D g = rgb.createGraphics();
        g.drawImage(src, 0, 0, null);
        g.dispose();
        return rgb;
    }

    private byte[] encodeWebP(BufferedImage image, Quality quality) {
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName(WEBP_FORMAT);
        if (!writers.hasNext()) return null;

        ImageWriter writer = writers.next();
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(baos)) {
            writer.setOutput(ios);
            ImageWriteParam param = writer.getDefaultWriteParam();
            if (param.canWriteCompressed()) {
                param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
                param.setCompressionQuality(quality.jpegQuality() / 100f);
            }
            writer.write(null, new IIOImage(image, null, null), param);
            writer.dispose();
        } catch (Exception e) {
            return null;
        } finally {
            writer.dispose();
        }
        return baos.toByteArray();
    }

    private byte[] encodeJpeg(BufferedImage image, float jpegQuality) {
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName(JPEG_FORMAT);
        if (!writers.hasNext()) {
            writers = ImageIO.getImageWritersByFormatName("jpg");
        }
        if (!writers.hasNext()) {
            throw new RuntimeException("No JPEG encoder available");
        }

        ImageWriter writer = writers.next();
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(baos)) {
            writer.setOutput(ios);
            ImageWriteParam param = writer.getDefaultWriteParam();
            param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            param.setCompressionQuality(jpegQuality / 100f);
            writer.write(null, new IIOImage(image, null, null), param);
        } catch (Exception e) {
            throw new RuntimeException("JPEG encoding failed", e);
        } finally {
            writer.dispose();
        }
        return baos.toByteArray();
    }

    private void applyFloydSteinbergDithering(BufferedImage image) {
        int w = image.getWidth();
        int h = image.getHeight();
        for (int y = 0; y < h - 1; y++) {
            for (int x = 1; x < w - 1; x++) {
                int oldRgb = image.getRGB(x, y);
                int r = (oldRgb >> 16) & 0xFF;
                int g = (oldRgb >> 8) & 0xFF;
                int b = oldRgb & 0xFF;
                int newR = ((r + 64) / 128) * 128;
                int newG = ((g + 64) / 128) * 128;
                int newB = ((b + 64) / 128) * 128;
                int newRgb = (0xFF << 24) | (Math.min(255, newR) << 16)
                        | (Math.min(255, newG) << 8) | Math.min(255, newB);
                image.setRGB(x, y, newRgb);

                int errR = r - newR;
                int errG = g - newG;
                int errB = b - newB;
                distributeError(image, x + 1, y, errR, errG, errB, 7.0 / 16);
                distributeError(image, x - 1, y + 1, errR, errG, errB, 3.0 / 16);
                distributeError(image, x, y + 1, errR, errG, errB, 5.0 / 16);
                distributeError(image, x + 1, y + 1, errR, errG, errB, 1.0 / 16);
            }
        }
    }

    private void distributeError(BufferedImage image, int x, int y,
                                  int errR, int errG, int errB, double factor) {
        if (x < 0 || x >= image.getWidth() || y < 0 || y >= image.getHeight()) return;
        int rgb = image.getRGB(x, y);
        int r = Math.min(255, Math.max(0, ((rgb >> 16) & 0xFF) + (int) (errR * factor)));
        int g = Math.min(255, Math.max(0, ((rgb >> 8) & 0xFF) + (int) (errG * factor)));
        int b = Math.min(255, Math.max(0, (rgb & 0xFF) + (int) (errB * factor)));
        image.setRGB(x, y, (rgb & 0xFF000000) | (r << 16) | (g << 8) | b);
    }

    static double computeScale(int srcW, int srcH, int maxDim) {
        double scale = (double) maxDim / Math.max(srcW, srcH);
        return Math.min(1.0, scale);
    }

    static String cacheKey(Path path, int page, Quality quality) {
        String raw = path.toAbsolutePath() + "#" + page + "#" + quality.name();
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(raw.getBytes());
            return HexFormat.of().formatHex(digest);
        } catch (Exception e) {
            return Integer.toHexString(raw.hashCode());
        }
    }

    private static int readIntBacked(byte[] buf, int offset, ByteOrder order) {
        ByteBuffer bb = ByteBuffer.wrap(buf, offset, 4).order(order);
        return bb.getInt();
    }

    private static int typeSize(int type) {
        return switch (type) {
            case 1, 2, 6, 7 -> 1;
            case 3, 8 -> 2;
            case 4, 9, 11, 13 -> 4;
            case 5, 10, 12 -> 8;
            default -> 4;
        };
    }

    private static String compressionName(int code) {
        return switch (code) {
            case 1 -> "None";
            case 2 -> "CCITT Huffman RLE";
            case 3 -> "CCITT Group 3 Fax";
            case 4 -> "CCITT Group 4 Fax";
            case 5 -> "LZW";
            case 6 -> "JPEG (old)";
            case 7 -> "JPEG";
            case 8 -> "Deflate";
            case 32773 -> "PackBits";
            case 32946 -> "Deflate (new)";
            default -> "Unknown(" + code + ")";
        };
    }
}

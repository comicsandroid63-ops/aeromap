package com.tiffpreview.service;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.tiffpreview.model.Quality;
import com.tiffpreview.model.TiffMetadata;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.FileVisitResult;
import java.nio.file.FileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

@DisplayName("TiffPreviewService")
class TiffPreviewServiceTest {

    private static Path staticTempDir;

    private ConcurrentHashMap<String, byte[]> l1Cache;
    private Cache<String, byte[]> l2Cache;
    private Semaphore semaphore;
    private ExecutorService ioExecutor;
    private TiffPreviewService service;

    private Path testTiffPath;

    @BeforeAll
    static void setUpClass() throws Exception {
        staticTempDir = Files.createTempDirectory("tiff-test-");
    }

    @AfterAll
    static void tearDownClass() throws Exception {
        for (int i = 0; i < 3; i++) {
            System.gc();
            System.runFinalization();
            try { Thread.sleep(200); } catch (InterruptedException e) { }
        }
        try {
            Files.walkFileTree(staticTempDir, new FileVisitor<Path>() {
                @Override public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) { return FileVisitResult.CONTINUE; }
                @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    try { Files.deleteIfExists(file); } catch (Exception ignored) { }
                    return FileVisitResult.CONTINUE;
                }
                @Override public FileVisitResult visitFileFailed(Path file, java.io.IOException exc) { return FileVisitResult.CONTINUE; }
                @Override public FileVisitResult postVisitDirectory(Path dir, java.io.IOException exc) {
                    try { Files.deleteIfExists(dir); } catch (Exception ignored) { }
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (Exception ignored) { }
    }

    @BeforeEach
    void setUp() throws Exception {
        l1Cache = new ConcurrentHashMap<>();
        l2Cache = Caffeine.newBuilder()
                .maximumSize(50)
                .expireAfterAccess(30, TimeUnit.MINUTES)
                .build();
        semaphore = new Semaphore(4);
        ioExecutor = Executors.newFixedThreadPool(4);
        service = new TiffPreviewService(l1Cache, l2Cache, semaphore, ioExecutor);

        testTiffPath = staticTempDir.resolve("test-" + System.nanoTime() + ".tiff");
        createTestTiff(testTiffPath, 800, 600);
    }

    private void createTestTiff(Path path, int w, int h) throws Exception {
        BufferedImage image = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        java.awt.Graphics2D g = image.createGraphics();
        g.setColor(java.awt.Color.RED);
        g.fillRect(0, 0, w / 2, h / 2);
        g.setColor(java.awt.Color.BLUE);
        g.fillRect(w / 2, 0, w / 2, h / 2);
        g.setColor(java.awt.Color.GREEN);
        g.fillRect(0, h / 2, w / 2, h / 2);
        g.setColor(java.awt.Color.YELLOW);
        g.fillRect(w / 2, h / 2, w / 2, h / 2);
        g.dispose();

        ImageIO.write(image, "tiff", path.toFile());
    }

    @Nested
    @DisplayName("extractMetadata()")
    class ExtractMetadata {

        @Test
        @DisplayName("Should extract correct dimensions from TIFF")
        void shouldExtractCorrectDimensions() {
            TiffMetadata meta = service.extractMetadata(testTiffPath);

            assertEquals(800, meta.width(), "width");
            assertEquals(600, meta.height(), "height");
            assertTrue(meta.pageCount() >= 1, "pageCount");
        }

        @Test
        @DisplayName("Should detect compression type")
        void shouldDetectCompression() {
            TiffMetadata meta = service.extractMetadata(testTiffPath);
            assertNotNull(meta.compression());
            assertFalse(meta.compression().isBlank());
        }

        @Test
        @DisplayName("Should reject non-TIFF files")
        void shouldRejectNonTiffFiles() throws Exception {
            Path textFile = staticTempDir.resolve("not-tiff-" + System.nanoTime() + ".txt");
            Files.writeString(textFile, "This is not a TIFF");

            assertThrows(RuntimeException.class,
                    () -> service.extractMetadata(textFile));
        }

        @Test
        @DisplayName("Should handle empty files gracefully")
        void shouldHandleEmptyFiles() throws Exception {
            Path emptyFile = staticTempDir.resolve("empty-" + System.nanoTime() + ".tiff");
            Files.write(emptyFile, new byte[0]);

            assertThrows(RuntimeException.class,
                    () -> service.extractMetadata(emptyFile));
        }
    }

    @Nested
    @DisplayName("generatePreview()")
    class GeneratePreview {

        @Test
        @DisplayName("Should generate non-null, non-empty preview bytes")
        void shouldGeneratePreviewBytes() {
            byte[] result = service.generatePreview(testTiffPath, 0, Quality.MID);

            assertNotNull(result, "result should not be null");
            assertTrue(result.length > 0, "result should not be empty");

            boolean isJpeg = result.length >= 2
                    && (result[0] & 0xFF) == 0xFF
                    && (result[1] & 0xFF) == 0xD8;
            boolean isWebP = result.length >= 4
                    && result[0] == 'R' && result[1] == 'I'
                    && result[2] == 'F' && result[3] == 'F';
            assertTrue(isJpeg || isWebP,
                    "Preview should be JPEG or WebP, got magic bytes: "
                            + Integer.toHexString(result[0] & 0xFF));
        }

        @Test
        @DisplayName("Should cache and return same bytes on second call")
        void shouldCacheResults() {
            byte[] first = service.generatePreview(testTiffPath, 0, Quality.MID);
            byte[] second = service.generatePreview(testTiffPath, 0, Quality.MID);

            assertArrayEquals(first, second, "Cached result should be identical");
        }

        @Test
        @DisplayName("Different quality yields different cache keys")
        void differentQualityYieldsDifferentCache() {
            var lowKey = TiffPreviewService.cacheKey(testTiffPath, 0, Quality.LOW);
            var hiKey = TiffPreviewService.cacheKey(testTiffPath, 0, Quality.HI);
            assertNotEquals(lowKey, hiKey,
                    "Different qualities should produce different cache keys");
        }

        @Test
        @DisplayName("Semaphore exhaustion should timeout")
        void semaphoreExhaustionShouldTimeout() {
            Semaphore tinySemaphore = new Semaphore(0);
            TiffPreviewService limitedService = new TiffPreviewService(
                    l1Cache, l2Cache, tinySemaphore, ioExecutor);

            assertThrows(RuntimeException.class,
                    () -> limitedService.generatePreview(testTiffPath, 0, Quality.MID));
        }

        @Test
        @DisplayName("L1 cache hit bypasses L2")
        void l1CacheHitBypassesL2() {
            byte[] mockBytes = new byte[]{1, 2, 3, 4};
            String key = TiffPreviewService.cacheKey(testTiffPath, 0, Quality.MID);
            l1Cache.put(key, mockBytes);

            byte[] result = service.generatePreview(testTiffPath, 0, Quality.MID);
            assertArrayEquals(mockBytes, result, "L1 cache hit should return cached bytes");
        }

        @Test
        @DisplayName("Should handle multiple concurrent requests")
        void shouldHandleConcurrentRequests() throws Exception {
            int threads = 3;
            CountDownLatch latch = new CountDownLatch(threads);
            ExecutorService executor = Executors.newFixedThreadPool(threads);
            AtomicReference<Exception> error = new AtomicReference<>();

            for (int i = 0; i < threads; i++) {
                executor.submit(() -> {
                    try {
                        byte[] result = service.generatePreview(testTiffPath, 0, Quality.MID);
                        assertNotNull(result);
                        assertTrue(result.length > 0);
                    } catch (Exception e) {
                        error.set(e);
                    } finally {
                        latch.countDown();
                    }
                });
            }

            assertTrue(latch.await(15, TimeUnit.SECONDS), "Concurrent requests timed out");
            executor.shutdownNow();
            assertNull(error.get(), "No errors in concurrent execution: " + error.get());
        }
    }

    @Nested
    @DisplayName("streamPreview()")
    class StreamPreview {

        @Test
        @DisplayName("Should stream bytes to OutputStream")
        void shouldStreamBytesToOutputStream() throws Exception {
            java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
            service.streamPreview(testTiffPath, 0, baos);

            byte[] result = baos.toByteArray();
            assertNotNull(result);
            assertTrue(result.length > 0);
        }
    }

    @Nested
    @DisplayName("computeScale()")
    class ComputeScale {

        @Test
        @DisplayName("Should return 1.0 when image is smaller than max")
        void shouldReturnOneForSmallImage() {
            double scale = TiffPreviewService.computeScale(256, 256, 512);
            assertEquals(1.0, scale, 0.001);
        }

        @Test
        @DisplayName("Should downscale when width exceeds max")
        void shouldDownscaleWhenWidthExceedsMax() {
            double scale = TiffPreviewService.computeScale(2000, 1000, 512);
            assertTrue(scale < 1.0, "Scale should be < 1 for larger image");
            assertEquals(0.256, scale, 0.01);
        }

        @Test
        @DisplayName("Should downscale when height exceeds max")
        void shouldDownscaleWhenHeightExceedsMax() {
            double scale = TiffPreviewService.computeScale(1000, 2000, 512);
            assertTrue(scale < 1.0);
            assertEquals(0.256, scale, 0.01);
        }
    }

    @Nested
    @DisplayName("cacheKey()")
    class CacheKey {

        @Test
        @DisplayName("Same inputs produce same key")
        void sameInputsProduceSameKey() {
            String k1 = TiffPreviewService.cacheKey(testTiffPath, 0, Quality.MID);
            String k2 = TiffPreviewService.cacheKey(testTiffPath, 0, Quality.MID);
            assertEquals(k1, k2);
        }

        @Test
        @DisplayName("Different page produces different key")
        void differentPageProducesDifferentKey() {
            String k1 = TiffPreviewService.cacheKey(testTiffPath, 0, Quality.MID);
            String k2 = TiffPreviewService.cacheKey(testTiffPath, 1, Quality.MID);
            assertNotEquals(k1, k2);
        }

        @Test
        @DisplayName("Key is valid hex SHA-256")
        void keyIsValidHexSha256() {
            String key = TiffPreviewService.cacheKey(testTiffPath, 0, Quality.MID);
            assertEquals(64, key.length(), "SHA-256 hex should be 64 chars");
            assertTrue(key.matches("^[0-9a-f]+$"), "Key should be hexadecimal");
        }
    }
}

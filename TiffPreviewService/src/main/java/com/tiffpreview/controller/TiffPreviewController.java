package com.tiffpreview.controller;

import com.tiffpreview.model.Quality;
import com.tiffpreview.model.TiffMetadata;
import com.tiffpreview.service.TiffPreviewService;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.HexFormat;

@RestController
@RequestMapping("/api/tiff")
public class TiffPreviewController {

    private final TiffPreviewService tiffPreviewService;

    public TiffPreviewController(TiffPreviewService tiffPreviewService) {
        this.tiffPreviewService = tiffPreviewService;
    }

    @GetMapping("/metadata")
    public ResponseEntity<TiffMetadata> metadata(@RequestParam String fileId) {
        Path tiffPath = resolveSecurePath(fileId);
        TiffMetadata meta = tiffPreviewService.extractMetadata(tiffPath);
        return ResponseEntity.ok(meta);
    }

    @GetMapping("/preview")
    public ResponseEntity<StreamingResponseBody> preview(
            @RequestParam String fileId,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "mid") String quality) {

        Path tiffPath = resolveSecurePath(fileId);
        Quality q = parseQuality(quality);
        String contentType = detectContentType();
        String etag = computeEtag(tiffPath, page, q);

        StreamingResponseBody body = out ->
                tiffPreviewService.streamPreview(tiffPath, page, out);

        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(contentType))
                .eTag(etag)
                .header("Cache-Control", "max-age=3600, public")
                .body(body);
    }

    private Quality parseQuality(String quality) {
        try {
            return Quality.valueOf(quality.toUpperCase());
        } catch (IllegalArgumentException e) {
            return Quality.MID;
        }
    }

    private String detectContentType() {
        try {
            var writers = javax.imageio.ImageIO.getImageWritersByFormatName("webp");
            if (writers.hasNext()) {
                return "image/webp";
            }
        } catch (Exception ignored) {
        }
        return "image/jpeg";
    }

    private String computeEtag(Path tiffPath, int page, Quality quality) {
        try {
            String raw = tiffPath.toAbsolutePath() + "|" + tiffPath.toFile().lastModified()
                    + "|" + page + "|" + quality.name();
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(raw.getBytes());
            return '"' + HexFormat.of().formatHex(digest).substring(0, 16) + '"';
        } catch (Exception e) {
            return '"' + Integer.toHexString(tiffPath.hashCode() ^ page) + '"';
        }
    }

    private Path resolveSecurePath(String fileId) {
        String sanitized = fileId.replace('\\', '/')
                .replace("..", "")
                .replace("\0", "");

        Path resolved = Paths.get(sanitized).toAbsolutePath().normalize();

        if (!Files.isRegularFile(resolved) || !Files.isReadable(resolved)) {
            throw new IllegalArgumentException("File not found or not readable: " + sanitized);
        }

        String name = resolved.getFileName().toString().toLowerCase();
        if (!(name.endsWith(".tif") || name.endsWith(".tiff"))) {
            throw new IllegalArgumentException("Not a TIFF file: " + sanitized);
        }

        long fileSize;
        try {
            fileSize = Files.size(resolved);
        } catch (Exception e) {
            throw new IllegalArgumentException("Cannot determine file size", e);
        }
        if (fileSize == 0) {
            throw new IllegalArgumentException("File is empty: " + sanitized);
        }

        return resolved;
    }
}

# TIFF Médico — Imágenes de Microscopía y WSI

## Tipos de TIFF médicos
- **WSI (Whole Slide Image)**: Láminas histológicas digitalizadas (1–40 GB típicamente)
- **TIFF multi-resolución (pirámide)**: Múltiples niveles de zoom en un solo archivo
- **BigTIFF**: Extensión del formato para archivos > 4 GB
- **OME-TIFF**: TIFF con metadatos de microscopía (Open Microscopy Environment)

## OpenSlide — Para WSI en Java

OpenSlide es la librería estándar para leer WSI. Requiere binarios nativos.

```xml
<!-- openslide-java — binding JNI para OpenSlide -->
<dependency>
    <groupId>io.github.openimaj</groupId>
    <artifactId>openimaj-image-processing</artifactId>
    <version>1.3.10</version>
</dependency>
```

### Alternativa: Instalar OpenSlide nativo + JNI wrapper

```bash
# Ubuntu/Debian
sudo apt-get install libopenslide-dev

# En Java, usar openslide-java:
# https://github.com/openslide/openslide-java
```

```java
import org.openslide.OpenSlide;

public class WSIService {
    public BufferedImage readRegion(String slidePath, int level, 
                                    long x, long y, int width, int height) 
            throws Exception {
        try (OpenSlide slide = new OpenSlide(new File(slidePath))) {
            // level 0 = resolución completa
            // level 1, 2... = niveles reducidos (más rápido)
            BufferedImage img = new BufferedImage(width, height, 
                                                   BufferedImage.TYPE_INT_ARGB);
            slide.paintRegionARGB(img.getData().getDataBuffer(), x, y, level, width, height);
            return img;
        }
    }

    public long[] getDimensions(String slidePath) throws Exception {
        try (OpenSlide slide = new OpenSlide(new File(slidePath))) {
            return new long[]{ 
                slide.getLevel0Width(), 
                slide.getLevel0Height(),
                slide.getLevelCount()
            };
        }
    }
}
```

## Visor con Deep Zoom + OpenSeadragon

Para WSI > 50 MB, el patrón correcto es:
1. Servidor genera tiles bajo demanda (IIIF Image API o Deep Zoom)
2. OpenSeadragon consume los tiles progresivamente

### Endpoint de tiles (Spring Boot)

```java
@GetMapping("/api/tiff/tile/{file}/{level}/{x}/{y}")
public ResponseEntity<byte[]> getTile(
        @PathVariable String file,
        @PathVariable int level,
        @PathVariable int x,
        @PathVariable int y) throws Exception {
    
    int tileSize = 256;
    long pixelX = (long) x * tileSize;
    long pixelY = (long) y * tileSize;
    
    byte[] tileBytes = wsiService.renderTile(file, level, pixelX, pixelY, tileSize);
    
    return ResponseEntity.ok()
        .header(HttpHeaders.CONTENT_TYPE, "image/png")
        .header(HttpHeaders.CACHE_CONTROL, "public, max-age=604800") // 1 semana
        .body(tileBytes);
}
```

### Frontend OpenSeadragon

```html
<script src="https://cdn.jsdelivr.net/npm/openseadragon@4.1/build/openseadragon/openseadragon.min.js"></script>
<div id="openseadragon-viewer" style="width: 100%; height: 600px;"></div>
<script>
OpenSeadragon({
    id: "openseadragon-viewer",
    prefixUrl: "https://cdn.jsdelivr.net/npm/openseadragon@4.1/build/openseadragon/images/",
    tileSources: {
        type: "legacy-image-pyramid",
        levels: [
            { url: "/api/tiff/tile/slide.tif/3/", width: 1024, height: 768 },
            { url: "/api/tiff/tile/slide.tif/2/", width: 2048, height: 1536 },
            { url: "/api/tiff/tile/slide.tif/1/", width: 8192, height: 6144 },
        ]
    },
    // Rendimiento
    imageLoaderLimit: 6,
    maxImageCacheCount: 500,
    animationTime: 0.3,
    blendTime: 0.1,
    immediateRender: false,
    minZoomImageRatio: 0.1,
    maxZoomPixelRatio: 4,
});
</script>
```

## IIIF Image API (estándar para museos/medicina)

Si el proyecto necesita interoperabilidad, implementar IIIF:
- URL pattern: `/iiif/2/{identifier}/{region}/{size}/{rotation}/{quality}.{format}`
- Librerías Java: **Cantaloupe** (servidor IIIF listo para producción)
- Cantaloupe soporta TIFF nativo + pirámide + caché de tiles

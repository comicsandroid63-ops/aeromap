---
name: tiff-java-web
description: >
  Skill especializada para trabajar con archivos TIFF en aplicaciones web Java.
  Prioridad máxima en: (1) visualización rápida del TIFF en el navegador y (2) optimización del tiempo de carga.
  Usar esta skill siempre que el usuario mencione: TIFF, .tif, imágenes médicas DICOM-TIFF, GeoTIFF, multi-página TIFF,
  conversión TIFF a web, streaming de imágenes TIFF, visor de TIFF, thumbnail TIFF, o cualquier tarea de procesamiento
  de imágenes TIFF con Java (Spring Boot, Jakarta EE, Servlet). También activar para preguntas sobre librerías como
  TwelveMonkeys, ImageIO TIFF, JAI, Apache Commons Imaging cuando el contexto sea web.
---

# TIFF Java Web — Skill

## Objetivo principal
Visualizar archivos TIFF en el navegador lo más rápido posible, minimizando el tiempo hasta el primer píxel visible.

---

## Stack recomendado

### Backend (Java)
| Librería | Uso | Maven/Gradle |
|---|---|---|
| **TwelveMonkeys ImageIO** | Lectura/escritura TIFF con soporte completo (compresión LZW, CCITT, multi-página) | `com.twelvemonkeys.imageio:imageio-tiff:3.10.1` |
| **ImageIO estándar** | API base de Java — siempre disponible | JDK nativo |
| **Thumbnailator** | Redimensionado rápido + thumbnails | `net.coobird:thumbnailator:0.4.20` |
| **Apache Commons Imaging** | Metadatos TIFF avanzados (DPI, GPS, ICC) | `org.apache.commons:commons-imaging:1.0.0-alpha3` |

### Frontend (JavaScript)
| Librería | Uso | Cuándo |
|---|---|---|
| **UTIF.js** | Decode TIFF directo en browser (WebAssembly-free, ligero) | TIFF simples/pequeños |
| **GeoTIFF.js** | TIFF grandes, Cloud Optimized GeoTIFF (COG), streaming tiled | TIFF > 5 MB o GeoTIFF |
| **OpenSeadragon** | Visor tile-based para TIFF gigantes (láminas histológicas, satélite) | TIFF > 50 MB |

---

## Decisión de arquitectura: ¿Convertir en servidor o decodificar en cliente?

```
¿Tamaño del TIFF?
│
├─ < 2 MB ──► Convertir a PNG/WebP en servidor → enviar imagen final
│              (más simple, compatible con todos los navegadores)
│
├─ 2–50 MB ──► Streaming progresivo + conversión lazy por página/región
│              (Spring Boot con @Async o WebFlux reactive)
│
└─ > 50 MB ──► Tiling en servidor (IIIF / Deep Zoom) + OpenSeadragon
               (Cloud Optimized GeoTIFF si es raster geoespacial)
```

---

## Implementaciones clave

### 1. Dependencias Maven (pom.xml)

```xml
<!-- TwelveMonkeys — soporte TIFF completo para ImageIO -->
<dependency>
    <groupId>com.twelvemonkeys.imageio</groupId>
    <artifactId>imageio-tiff</artifactId>
    <version>3.10.1</version>
</dependency>

<!-- Thumbnailator — redimensionado eficiente -->
<dependency>
    <groupId>net.coobird</groupId>
    <artifactId>thumbnailator</artifactId>
    <version>0.4.20</version>
</dependency>

<!-- Para metadatos TIFF opcionales -->
<dependency>
    <groupId>org.apache.commons</groupId>
    <artifactId>commons-imaging</artifactId>
    <version>1.0.0-alpha3</version>
</dependency>
```

### 2. Servicio de conversión TIFF → WebP/PNG

```java
import com.twelvemonkeys.imageio.plugins.tiff.TIFFImageReader;
import net.coobird.thumbnailator.Thumbnails;
import javax.imageio.*;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.*;
import java.util.*;

@Service
public class TiffConversionService {

    /**
     * Convierte TIFF a WebP (o PNG como fallback) para visualización web.
     * Prioriza velocidad: usa calidad reducida para preview rápido,
     * luego carga la versión completa en background.
     */
    public byte[] convertToWebP(InputStream tiffStream, int pageIndex,
                                  int maxWidth, float quality) throws IOException {
        // TwelveMonkeys se registra automáticamente en ImageIO al estar en classpath
        try (ImageInputStream iis = ImageIO.createImageInputStream(tiffStream)) {
            Iterator<ImageReader> readers = ImageIO.getImageReadersByFormatName("tiff");
            if (!readers.hasNext()) {
                throw new IllegalStateException("No TIFF reader disponible. ¿Está TwelveMonkeys en el classpath?");
            }

            ImageReader reader = readers.next();
            reader.setInput(iis, false); // false = permite múltiples páginas

            // Leer parámetros sin cargar pixels — rápido
            int numPages = reader.getNumImages(true);
            int page = Math.min(pageIndex, numPages - 1);

            // Para TIFFs grandes: leer solo subsampling para preview
            ImageReadParam param = reader.getDefaultReadParam();
            int subsample = calculateSubsample(reader.getWidth(page), reader.getHeight(page), maxWidth);
            if (subsample > 1) {
                param.setSourceSubsampling(subsample, subsample, 0, 0);
            }

            BufferedImage image = reader.read(page, param);
            reader.dispose();

            // Convertir a RGB si es necesario (TIFF puede ser CMYK, Grayscale, etc.)
            image = ensureRGB(image);

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            
            // Intentar WebP (requiere Java 17+ o plugin); fallback a PNG
            if (canWriteWebP()) {
                Thumbnails.of(image)
                    .size(maxWidth, maxWidth * image.getHeight() / image.getWidth())
                    .outputFormat("webp")
                    .outputQuality(quality)
                    .toOutputStream(out);
            } else {
                // PNG: sin pérdida, mejor para TIFF médicos/técnicos
                Thumbnails.of(image)
                    .size(maxWidth, maxWidth * image.getHeight() / image.getWidth())
                    .outputFormat("png")
                    .toOutputStream(out);
            }

            return out.toByteArray();
        }
    }

    /**
     * Obtiene metadatos sin leer los píxeles — muy rápido.
     */
    public TiffMetadata getMetadata(InputStream tiffStream) throws IOException {
        try (ImageInputStream iis = ImageIO.createImageInputStream(tiffStream)) {
            ImageReader reader = ImageIO.getImageReadersByFormatName("tiff").next();
            reader.setInput(iis, false);

            int pages = reader.getNumImages(true);
            int width = reader.getWidth(0);
            int height = reader.getHeight(0);
            reader.dispose();

            return new TiffMetadata(pages, width, height);
        }
    }

    private int calculateSubsample(int origW, int origH, int targetW) {
        if (origW <= targetW) return 1;
        int ratio = origW / targetW;
        // Subsample solo en potencias de 2 para calidad óptima
        if (ratio >= 8) return 8;
        if (ratio >= 4) return 4;
        if (ratio >= 2) return 2;
        return 1;
    }

    private BufferedImage ensureRGB(BufferedImage img) {
        if (img.getType() == BufferedImage.TYPE_INT_RGB ||
            img.getType() == BufferedImage.TYPE_INT_ARGB) {
            return img;
        }
        BufferedImage rgb = new BufferedImage(img.getWidth(), img.getHeight(),
                                              BufferedImage.TYPE_INT_RGB);
        rgb.createGraphics().drawImage(img, 0, 0, null);
        return rgb;
    }

    private boolean canWriteWebP() {
        return ImageIO.getImageWritersByFormatName("webp").hasNext();
    }

    public record TiffMetadata(int pages, int width, int height) {}
}
```

### 3. Controller REST — Endpoints para visualización

```java
@RestController
@RequestMapping("/api/tiff")
public class TiffViewController {

    @Autowired
    private TiffConversionService tiffService;

    /**
     * Thumbnail rápido — para galería o preview inicial.
     * Prioridad: velocidad máxima.
     * GET /api/tiff/thumbnail?file=ruta&size=300
     */
    @GetMapping("/thumbnail")
    public ResponseEntity<byte[]> getThumbnail(
            @RequestParam String file,
            @RequestParam(defaultValue = "300") int size) throws IOException {

        byte[] imageBytes;
        try (InputStream is = resolveFile(file)) {
            // Calidad baja = carga ultra-rápida para preview
            imageBytes = tiffService.convertToWebP(is, 0, size, 0.7f);
        }

        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_TYPE, "image/png")
            .header(HttpHeaders.CACHE_CONTROL, "public, max-age=86400") // cache 1 día
            .header("X-Tiff-Source", "converted")
            .body(imageBytes);
    }

    /**
     * Página completa — calidad alta.
     * GET /api/tiff/page?file=ruta&page=0&width=1920
     */
    @GetMapping("/page")
    public ResponseEntity<byte[]> getPage(
            @RequestParam String file,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "1920") int width) throws IOException {

        byte[] imageBytes;
        try (InputStream is = resolveFile(file)) {
            imageBytes = tiffService.convertToWebP(is, page, width, 0.92f);
        }

        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_TYPE, "image/png")
            .header(HttpHeaders.CACHE_CONTROL, "public, max-age=3600")
            .body(imageBytes);
    }

    /**
     * Metadatos — sin leer píxeles.
     * GET /api/tiff/info?file=ruta
     */
    @GetMapping("/info")
    public ResponseEntity<TiffConversionService.TiffMetadata> getInfo(
            @RequestParam String file) throws IOException {

        try (InputStream is = resolveFile(file)) {
            return ResponseEntity.ok(tiffService.getMetadata(is));
        }
    }

    private InputStream resolveFile(String fileParam) throws IOException {
        // SEGURIDAD: sanitizar la ruta — nunca usar directamente el param del usuario
        Path base = Path.of(System.getProperty("tiff.basedir", "/data/tiff"));
        Path resolved = base.resolve(fileParam).normalize();
        if (!resolved.startsWith(base)) {
            throw new SecurityException("Path traversal detectado");
        }
        return Files.newInputStream(resolved);
    }
}
```

### 4. Caché con Spring Cache (Redis o en memoria)

```java
@Configuration
@EnableCaching
public class TiffCacheConfig {

    @Bean
    public CacheManager cacheManager() {
        // Caché en memoria para thumbnails — evita re-procesar TIFFs
        CaffeineCacheManager manager = new CaffeineCacheManager("tiff-thumbnails", "tiff-pages");
        manager.setCaffeine(Caffeine.newBuilder()
            .expireAfterWrite(1, TimeUnit.HOURS)
            .maximumSize(500)          // máx 500 imágenes en memoria
            .recordStats());           // métricas de hit/miss
        return manager;
    }
}

// En el servicio, agregar:
@Cacheable(value = "tiff-thumbnails", key = "#filePath + '_' + #pageIndex + '_' + #maxWidth")
public byte[] convertToWebP(String filePath, int pageIndex, int maxWidth, float quality) {
    // ... implementación
}
```

---

## Estrategia de carga progresiva (UX optimizado)

### Patrón: Blur → Thumbnail → Full Resolution

```
Tiempo 0ms:   Mostrar placeholder blur (CSS/base64 10px)
Tiempo ~50ms: Cargar thumbnail (300px) ──► primer píxel visible
Tiempo ~500ms: Cargar imagen completa en background
Tiempo ~?:    Reemplazar thumbnail con full res (sin parpadeo)
```

### Frontend HTML/JS

```html
<!-- Visor TIFF con carga progresiva -->
<div id="tiff-viewer" class="tiff-container">
  <img id="tiff-preview" 
       src="/api/tiff/thumbnail?file=imagen.tif&size=300"
       alt="Cargando..."
       style="filter: blur(0px); transition: filter 0.3s;">
  
  <div id="tiff-controls">
    <button onclick="prevPage()">◀</button>
    <span id="page-info">Página 1 / ?</span>
    <button onclick="nextPage()">▶</button>
  </div>
</div>

<script>
class TiffViewer {
  constructor(file, containerId) {
    this.file = file;
    this.container = document.getElementById(containerId);
    this.currentPage = 0;
    this.totalPages = 1;
    this.init();
  }

  async init() {
    // 1. Obtener metadatos (sin cargar imagen)
    const meta = await fetch(`/api/tiff/info?file=${this.file}`).then(r => r.json());
    this.totalPages = meta.pages;
    document.getElementById('page-info').textContent = `Página 1 / ${meta.pages}`;

    // 2. Mostrar thumbnail inmediatamente (ya está en el HTML src)
    
    // 3. Cargar versión completa en background
    this.loadFullRes(0);
  }

  async loadFullRes(pageIndex) {
    const img = document.getElementById('tiff-preview');
    
    // Precargar en objeto Image oculto
    const fullImage = new Image();
    fullImage.onload = () => {
      // Transición suave al reemplazar
      img.style.filter = 'blur(2px)';
      setTimeout(() => {
        img.src = fullImage.src;
        img.style.filter = 'blur(0px)';
      }, 150);
    };
    fullImage.src = `/api/tiff/page?file=${this.file}&page=${pageIndex}&width=1920`;
  }

  async goToPage(pageIndex) {
    if (pageIndex < 0 || pageIndex >= this.totalPages) return;
    this.currentPage = pageIndex;
    
    // Mostrar thumbnail rápido mientras carga la versión completa
    const img = document.getElementById('tiff-preview');
    img.src = `/api/tiff/thumbnail?file=${this.file}&page=${pageIndex}&size=300`;
    
    document.getElementById('page-info').textContent = 
      `Página ${pageIndex + 1} / ${this.totalPages}`;
    
    this.loadFullRes(pageIndex);
  }
}

// Inicializar
const viewer = new TiffViewer('mi-imagen.tif', 'tiff-viewer');
</script>
```

---

## Optimizaciones de rendimiento — Checklist

### Servidor
- [ ] **Subsampling inteligente**: Leer solo 1/8 de los píxeles para thumbnails (ver `calculateSubsample`)
- [ ] **Caché de conversiones**: Cachear PNG/WebP resultado — no volver a procesar el mismo TIFF
- [ ] **Procesamiento async**: Usar `@Async` o WebFlux para no bloquear threads HTTP
- [ ] **ETag y Cache-Control**: Headers correctos para que el browser cachee las imágenes
- [ ] **Compresión HTTP**: `gzip`/`br` para las respuestas JSON de metadatos
- [ ] **Precalentar caché**: Pre-convertir thumbnails al arrancar la app si los TIFFs son conocidos

### Frontend  
- [ ] **Lazy loading**: `loading="lazy"` en `<img>` para galerías
- [ ] **Intersection Observer**: Cargar imágenes solo cuando entran al viewport
- [ ] **Preload link**: `<link rel="preload" as="image" href="/api/tiff/thumbnail?...">` para imágenes críticas
- [ ] **Service Worker**: Cachear imágenes convertidas en el browser (offline + velocidad)

---

## Casos especiales

### TIFF Multi-página (ej. documentos escaneados)
Ver sección "page" del controller — parámetro `page=N`. El visor JS ya maneja navegación.

### GeoTIFF (imágenes satelitales, mapas)
Usar **GeoTIFF.js** en el frontend + **gdal4j** o **GeoTools** en el backend.
Consultar `references/geotiff.md` para más detalles.

### TIFF médico (DICOM-TIFF, histología WSI)
Para Whole Slide Images (> 1 GB): usar **OpenSlide** vía JNI o **IIIF Image API**.
Consultar `references/medical-tiff.md`.

### TIFF con transparencia (RGBA)
TwelveMonkeys soporta canal alpha. Usar `TYPE_INT_ARGB` y formato PNG (WebP también soporta alpha).

---

## Errores comunes

| Error | Causa | Solución |
|---|---|---|
| `No TIFF reader available` | TwelveMonkeys no en classpath | Agregar dependencia Maven/Gradle |
| Imagen en blanco / negra | TIFF en CMYK o 16-bit | Usar `ensureRGB()` del servicio |
| `OutOfMemoryError` en TIFF grande | Carga completa en memoria | Usar subsampling + streaming |
| Compresión LZW no soportada | ImageIO nativo sin TwelveMonkeys | TwelveMonkeys resuelve esto |
| Lentitud en primer request | Sin caché | Activar Spring Cache + Caffeine |

---

## Referencias adicionales

- `references/geotiff.md` — GeoTIFF y mapas raster
- `references/medical-tiff.md` — Imágenes médicas, WSI, OpenSlide
- `references/performance-benchmarks.md` — Comparativa de librerías y tiempos medidos

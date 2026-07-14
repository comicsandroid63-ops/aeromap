# Benchmarks de Rendimiento — TIFF Java Web

## Tiempos de conversión típicos (servidor moderno, 4 cores)

### TIFF → PNG (sin caché)

| Tamaño TIFF | Resolución | TwelveMonkeys | Commons Imaging |
|---|---|---|---|
| 500 KB | 800×600 | ~15 ms | ~22 ms |
| 2 MB | 2000×1500 | ~45 ms | ~80 ms |
| 10 MB | 5000×4000 | ~180 ms | ~320 ms |
| 50 MB | 10000×8000 | ~900 ms | timeout |

### Subsampling (leer 1/4 de píxeles para thumbnail)

| TIFF original | Sin subsampling | Con subsampling x4 | Con subsampling x8 |
|---|---|---|---|
| 10 MB | 180 ms | 50 ms | 28 ms |
| 50 MB | 900 ms | 230 ms | 120 ms |

**Conclusión: El subsampling reduce el tiempo 4–8x. Siempre usarlo para thumbnails.**

## Impacto del caché

| Escenario | Primer request | Requests siguientes |
|---|---|---|
| Sin caché | 180 ms | 180 ms |
| Caché en memoria (Caffeine) | 180 ms | < 1 ms |
| Caché en disco (archivos PNG) | 180 ms | ~5 ms (I/O) |
| Caché Redis | 180 ms | ~2 ms |

**Recomendación**: Caffeine para < 1000 imágenes únicas, Redis para clusters o > 1000.

## Formatos de salida — Comparativa

| Formato | Tamaño salida | Tiempo encode | Calidad visual | Compatibilidad |
|---|---|---|---|---|
| PNG | 100% (referencia) | 100% | Lossless | Universal |
| WebP lossless | ~70% | ~130% | Lossless | Chrome, Firefox, Safari 14+ |
| WebP lossy (q=85) | ~35% | ~90% | Muy buena | Chrome, Firefox, Safari 14+ |
| JPEG (q=85) | ~30% | ~60% | Buena | Universal |
| AVIF (q=85) | ~25% | ~300% | Excelente | Chrome, Firefox (Safari 16+) |

**Recomendación para imágenes médicas/técnicas**: PNG (sin pérdida)
**Recomendación para imágenes naturales/fotos**: WebP lossy

## Configuración JVM para rendimiento máximo

```bash
# Opciones JVM recomendadas para procesamiento de imágenes
JAVA_OPTS="-Xmx4g \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=200 \
  -Djava.awt.headless=true \
  -Dsun.java2d.opengl=false \
  -Dfile.encoding=UTF-8"
```

### `java.awt.headless=true` es OBLIGATORIO en servidores
Sin esta opción, ImageIO puede fallar o ser muy lento en entornos sin pantalla (Docker, CI/CD).

## Thread Pool para procesamiento async

```java
@Configuration
public class AsyncConfig implements AsyncConfigurer {
    
    @Override
    public Executor getAsyncExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);       // threads siempre activos
        executor.setMaxPoolSize(16);       // máximo bajo carga
        executor.setQueueCapacity(100);   // cola antes de rechazar
        executor.setThreadNamePrefix("tiff-conv-");
        executor.initialize();
        return executor;
    }
}
```

## Monitoreo de rendimiento — Actuator + Micrometer

```java
// En el servicio, medir tiempo de conversión
@Autowired
private MeterRegistry meterRegistry;

public byte[] convertToWebP(...) {
    return meterRegistry.timer("tiff.conversion")
        .record(() -> {
            // ... lógica de conversión
        });
}
```

```yaml
# application.yml — exponer métricas
management:
  endpoints:
    web:
      exposure:
        include: health, metrics, prometheus
  metrics:
    distribution:
      percentiles-histogram:
        tiff.conversion: true
```

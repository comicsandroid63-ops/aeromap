# GeoTIFF — Referencia para Java Web

## ¿Qué es GeoTIFF?
TIFF con metadatos geoespaciales embebidos (sistema de coordenadas, georeferenciación).
Usado en: imágenes satelitales, mapas de elevación, ortofotografías.

## Stack recomendado

```xml
<!-- GeoTools para GeoTIFF en Java -->
<dependency>
    <groupId>org.geotools</groupId>
    <artifactId>gt-geotiff</artifactId>
    <version>30.0</version>
</dependency>

<!-- GeoTools repositorio (agregar en pom.xml) -->
<!-- 
<repository>
    <id>osgeo</id>
    <url>https://repo.osgeo.org/repository/release/</url>
</repository>
-->
```

## Frontend: GeoTIFF.js + Leaflet

```html
<link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css">
<script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
<script src="https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js"></script>

<div id="map" style="height: 500px;"></div>
<script>
async function loadGeoTIFF(url) {
    const tiff = await GeoTIFF.fromUrl(url);
    const image = await tiff.getImage();
    
    // Obtener bounding box
    const bbox = image.getBoundingBox();
    const [west, south, east, north] = bbox;

    // Leer datos raster
    const data = await image.readRasters({ interleave: true });
    
    // Crear canvas con los datos
    const canvas = document.createElement('canvas');
    canvas.width = image.getWidth();
    canvas.height = image.getHeight();
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(image.getWidth(), image.getHeight());
    
    for (let i = 0; i < data.length / 3; i++) {
        imgData.data[i * 4]     = data[i * 3];      // R
        imgData.data[i * 4 + 1] = data[i * 3 + 1];  // G
        imgData.data[i * 4 + 2] = data[i * 3 + 2];  // B
        imgData.data[i * 4 + 3] = 255;               // A
    }
    ctx.putImageData(imgData, 0, 0);

    // Mostrar en Leaflet
    const map = L.map('map').fitBounds([[south, west], [north, east]]);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    L.imageOverlay(canvas.toDataURL(), [[south, west], [north, east]]).addTo(map);
}

loadGeoTIFF('/api/tiff/geotiff-file.tif');
</script>
```

## Cloud Optimized GeoTIFF (COG)
Para GeoTIFFs grandes: usar COG que permite streaming por tiles HTTP Range requests.
- Crear COG: `gdal_translate -of COG -co COMPRESS=LZW input.tif output_cog.tif`
- GeoTIFF.js lo soporta automáticamente si el servidor acepta Range requests
- Spring Boot ya soporta Range requests — verificar que no haya proxy que los bloquee

## Lectura de metadatos GeoTIFF en Java

```java
import org.geotools.gce.geotiff.GeoTiffReader;
import org.geotools.coverage.grid.GridCoverage2D;

public GeoTiffInfo readGeoTiff(File tiffFile) throws Exception {
    GeoTiffReader reader = new GeoTiffReader(tiffFile);
    GridCoverage2D coverage = reader.read(null);
    
    // Bounding box
    var envelope = coverage.getEnvelope2D();
    double minX = envelope.getMinX();
    double minY = envelope.getMinY();
    double maxX = envelope.getMaxX();
    double maxY = envelope.getMaxY();
    
    // Sistema de referencia de coordenadas
    String crs = coverage.getCoordinateReferenceSystem().getName().toString();
    
    reader.dispose();
    return new GeoTiffInfo(minX, minY, maxX, maxY, crs);
}
```

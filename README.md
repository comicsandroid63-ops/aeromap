# 🗺️ AeroMap - Professional GIS Editor

Editor SIG profesional con soporte para upload de Shapefiles, visualización de TIFF, análisis multispectral y más.

## 📋 Características

- ✅ **Editor de Mapas Interactivo** - Basado en Leaflet.js
- ✅ **Soporte para Shapefiles** - Carga y edición de capas vectoriales
- ✅ **Imágenes Raster (GeoTIFF)** - Soporte multibanda con renderizado en tiempo real
- ✅ **Tabla de Atributos** - Visualiza y edita datos vectoriales
- ✅ **Análisis Multispectral** - Simula Landsat 7/8, Sentinel-2
- ✅ **Visualización 3D** - Generador de modelos de terreno (DEM)
- ✅ **Simbología Avanzada** - Colores graduados, clasificación por categorías
- ✅ **Diseño de Impresión** - Compositor QGIS-style
- ✅ **Importación Excel/CSV** - Con soporte para múltiples CRS

## 🚀 Instalación Local

### Requisitos
- Node.js 14+ 
- npm o yarn

### Configuración

1. **Descargar el proyecto**
```bash
cd "c:\Users\HOME\Documents\Pagina 2"
```

2. **Instalar dependencias**
```bash
npm install
```

3. **Ejecutar en desarrollo**
```bash
npm run dev
```

El servidor estará disponible en `http://localhost:3000`

### Estructura de carpetas
```
.
├── public/
│   └── index.html          # Interfaz principal
├── uploads/                # Almacenamiento temporal de archivos
├── server.js               # Servidor Express
├── package.json            # Dependencias
└── .gitignore              # Archivos ignorados
```

## 🌐 Despliegue en la Web

### Opción 1: Vercel (Recomendado - Gratis)

1. **Crear cuenta en Vercel**
   - Ir a https://vercel.com/signup
   - Conectar con GitHub/GitLab

2. **Subir proyecto a GitHub**
```bash
git init
git add .
git commit -m "Initial commit: AeroMap"
git branch -M main
git remote add origin https://github.com/tu-usuario/aeromap.git
git push -u origin main
```

3. **Importar en Vercel**
   - Click en "New Project"
   - Seleccionar el repositorio
   - Framework: Node.js
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Click "Deploy"

**Ventajas:**
- Dominio HTTPS gratis
- Escalado automático
- Máximo 500MB de almacenamiento (uploads limitado)

### Opción 2: Railway (Excelente para datos)

1. **Crear cuenta en Railway**
   - Ir a https://railway.app

2. **Conectar repositorio GitHub**
   - Click "New Project"
   - Connect GitHub
   - Seleccionar repositorio

3. **Configurar variables de entorno**
   - PORT → 3000 (automático)

4. **Deploy automático**

**Ventajas:**
- Almacenamiento más generoso
- Mejor para archivos grandes
- $5 USD/mes starter

### Opción 3: Heroku (Simple, requiere tarjeta)

1. **Instalar Heroku CLI**
```bash
npm install -g heroku
```

2. **Conectar y desplegar**
```bash
heroku login
heroku create aeromap-app
git push heroku main
```

### Opción 4: Azure App Service

1. **Crear App Service en Azure Portal**
2. **Conectar con GitHub**
3. **Configurar:**
   - Runtime: Node 18 LTS
   - Startup Command: `npm start`

## 📤 Uso del Uploader de Shapefiles

### Desde la interfaz web:

1. **Arrastra archivos ZIP** que contengan:
   - `nombre.shp` (geometría)
   - `nombre.dbf` (atributos)
   - `nombre.prj` (proyección - opcional)

2. **O carga archivos individuales:**
   - Formato SHP + DBF + PRJ

3. **Automáticamente:**
   - Se detectan las capas
   - Se muestran en la lista de capas
   - Se puede acceder a la tabla de atributos

### API REST para upload programático:

```bash
# Upload archivo
curl -X POST -F "files=@data.zip" http://localhost:3000/api/upload

# Listar archivos subidos
curl http://localhost:3000/api/files

# Descargar archivo
curl -O http://localhost:3000/api/download/archivo.zip

# Eliminar archivo
curl -X DELETE http://localhost:3000/api/files/archivo.zip
```

## 🛠️ Configuración Avanzada

### Variables de Entorno

Crear archivo `.env`:
```env
PORT=3000
NODE_ENV=production
MAX_FILE_SIZE=500000000
```

### Límites de Upload

Editar en `server.js`:
```javascript
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB
  }
});
```

## 🎯 Funcionalidades por Tipo de Dato

| Tipo | Formato | Acciones |
|------|---------|----------|
| **Raster** | GeoTIFF, TIF | Visualizar, AdjusteRGB, 3D DEM |
| **Vector** | SHP, GeoJSON | Editar, Atributos, Etiquetas |
| **Tabular** | XLS, CSV, XLSX | Geocodificar, Importar |
| **Multibanda** | GeoTIFF 4+ bands | Compuesto RGB, NDVI |

## 📊 Sistemas de Coordenadas Soportados

- ✅ WGS84 (EPSG:4326) - Geográficas
- ✅ Web Mercator (EPSG:3857) - Google Maps
- ✅ UTM (Universal Transverse Mercator)
- ✅ MAGNA-SIRGAS (Colombia)
- ✅ Cualquier proyección via archivo PRJ

## 🐛 Troubleshooting

### "Archivo muy grande"
```javascript
// Aumentar límite en server.js
fileSize: 1000 * 1024 * 1024 // 1GB
```

### "Worker no responde"
- Utilizar archivo ZIP de menores dimensiones
- Dividir shapefile en múltiples archivos
- Usar CSV en lugar de XLS

### Shapefiles no se cargan
- Verificar que existe archivo `.shp`
- Asegurar que `.dbf` está en el mismo ZIP
- Incluir `.prj` para reproyección automática

## 📞 Soporte

Para reportar errores o sugerencias:
1. Abrir Issue en GitHub
2. Incluir archivo problemático (si es pequeño)
3. Describir pasos para reproducir

## 📄 Licencia

MIT - Libre para uso comercial y personal

## 🔄 Actualizaciones

Ejecutar en producción:
```bash
npm update
npm start
```

Para resetear uploads y cache:
```bash
rm -rf uploads/*
```

---

**Última actualización:** Marzo 2026
**Versión:** 3.0.1
**Autor:** AeroMap Development Team

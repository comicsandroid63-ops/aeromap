# Configuración de Supabase para AeroMap

## Paso 1: Crear cuenta en Supabase
1. Ve a https://supabase.com
2. Regístrate con GitHub (es gratis)
3. Crea un nuevo proyecto:
   - Nombre: `aeromap-shapefiles`
   - Base de datos: PostgreSQL (por defecto)
   - Región: Elige la más cercana (ej: us-east-1)
   - Contraseña: Elige una segura

## Paso 2: Esperar inicialización
- Supabase tomará 2-3 minutos en crear el proyecto
- Verás el dashboard cuando esté listo

## Paso 3: Crear bucket de almacenamiento
1. En el dashboard, ve a "Storage" (izquierda)
2. Click "Create bucket"
3. Nombre: `shapefiles`
4. Marca "Public bucket" (para que los archivos sean accesibles)
5. Click "Create bucket"

## Paso 4: Obtener credenciales
1. Ve a "Settings" → "API"
2. Copia estos valores:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon public key**: (empieza con `eyJ...`)

## Paso 5: Configurar en el código
Una vez tengas las credenciales, envíamelas y yo actualizo el código automáticamente.

## Paso 6: Probar
- Sube un archivo ZIP con Shapefile
- Debería aparecer en "Cargas en la nube"
- Click "Ver/Descargar" para cargar como capa

## Notas importantes
- El plan gratuito incluye 500MB de storage
- Los archivos son públicos (accesibles por URL)
- Para producción, considera usar una función serverless para ocultar las claves

¡Avísame cuando tengas las credenciales listas!
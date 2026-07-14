@echo off
echo ====================================================
echo   AEROMAP GIS - GENERADOR DE EJECUTABLE (.EXE)
echo ====================================================
echo.

rem Asegurar que la aplicacion no este corriendo
taskkill /F /IM AeroMapGIS.exe /T >nul 2>&1

set APP_NAME=AeroMapGIS
set VERSION=1.0
set MAIN_JAR=aeromap-desktop-1.0-SNAPSHOT.jar
set MAVEN_BIN=%~dp0maven_portable\apache-maven-3.9.6\bin\mvn.cmd

echo [1/3] Compilando el proyecto con Maven...
call "%MAVEN_BIN%" clean package
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: No se pudo compilar el proyecto.
    exit /b %ERRORLEVEL%
)

echo.
echo [2/3] Los JARs JAI se mantienen porque GeoTiffReader e imageio-ext-tiff
echo   necesitan jai_core (ImageLayout, Interpolation) y jai_imageio
echo   (BogusColorSpace). El codigo nativo se desactiva via propiedades JVM.

echo.
echo [3/3] Creando el ejecutable (.exe) con jpackage...
echo Esto incluira un Java Runtime interno optimizado.

rem Limpiar carpeta dist
if exist dist (
    echo [Limpiando carpeta dist...]
    rmdir /s /q dist || (
        echo ERROR: No se pudo limpiar la carpeta 'dist'.
        echo Asegurate de que AeroMapGIS.exe no este abierto.
        exit /b 1
    )
)

jpackage ^
  --type app-image ^
  --dest dist ^
  --name "%APP_NAME%" ^
  --input target\package ^
  --main-jar "%MAIN_JAR%" ^
  --main-class com.aeromap.Launcher ^
  --app-version %VERSION% ^
  --vendor "AeroMap" ^
  --copyright "Copyright 2026 AeroMap" ^
  --win-console ^
  --java-options "-Dcom.sun.media.jai.disableMediaLib=true" ^
  --java-options "-Dorg.geotools.referencing.forceXY=true" ^
  --java-options "-Djava.awt.headless=false" ^
  --java-options "--add-opens=java.desktop/javax.imageio.spi=ALL-UNNAMED" ^
  --java-options "--add-opens=java.desktop/com.sun.imageio.plugins.tiff=ALL-UNNAMED" ^
  --java-options "-Dsun.java2d.noddraw=true" ^
  --verbose

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ====================================================
    echo   EXITO: Ejecutable creado en 'dist\AeroMapGIS'
    echo ====================================================
    echo Intenta ejecutar: dist\AeroMapGIS\AeroMapGIS.exe
) else (
    echo.
    echo ERROR: Ocurrio un problema al generar el ejecutable.
)

rem pause

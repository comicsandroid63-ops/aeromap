@echo off
REM Conectar AeroMap a GitHub
REM Este script configura la conexion con un repositorio GitHub

setlocal enabledelayedexpansion

echo.
echo ╔════════════════════════════════════════════════════════════════╗
echo ║            Conectar AeroMap a GitHub Automáticamente            ║
echo ╚════════════════════════════════════════════════════════════════╝
echo.

REM Pedirle al usuario su nombre de usuario de GitHub
set /p GITHUB_USER="Ingresa tu nombre de usuario de GitHub (ej: jhondoe): "

if "!GITHUB_USER!"=="" (
    echo ❌ Error: Nombre de usuario vacío
    pause
    exit /b 1
)

REM Nombre del repositorio - usar nombre de la carpeta
set REPO_NAME=aeromap

echo.
echo 📋 Próximos pasos:
echo 1. Entra en GitHub.com
echo 2. Click en el '+' (esquina superior derecha)
echo 3. Click en "New repository"
echo 4. Nombre: %REPO_NAME%
echo 5. Descripción: "Professional GIS Editor with Shapefile Support"
echo 6. Selecciona: Public (si quieres que sea visible)
echo 7. NO inicialices con README (ya tenemos contenido)
echo 8. Click en "Create repository"
echo.
echo Presiona ENTER cuando hayas creado el repositorio en GitHub...
pause

REM Ahora conectar el repositorio local con GitHub
set GITHUB_URL=https://github.com/!GITHUB_USER!/!REPO_NAME!.git

echo.
echo 🔗 Conectando a: !GITHUB_URL!
echo.

cd /d "c:\Users\HOME\Documents\Pagina 2"

REM Agregar el remote
"C:\Program Files\Git\bin\git.exe" remote add origin !GITHUB_URL!

REM Renombrar rama (en caso de que sea main en GitHub)
"C:\Program Files\Git\bin\git.exe" branch -M main

REM Hacer push inicial
echo.
echo 📤 Haciendo push al repositorio...
"C:\Program Files\Git\bin\git.exe" push -u origin main

if !ERRORLEVEL! EQU 0 (
    echo.
    echo ✅ ¡ÉXITO! Tu repositorio está conectado a GitHub
    echo.
    echo 🌐 Accede a: !GITHUB_URL!
    echo.
    echo 📝 Para futuras actualizaciones, usa:
    echo    git add .
    echo    git commit -m "Tu mensaje"
    echo    git push
    echo.
) else (
    echo.
    echo ⚠️  Hubo un error. Es normal si:
    echo    - No autorizo GitHub (se abre navegador)
    echo    - El nombre de repo ya existe
    echo    - Sin conexión a internet
    echo.
    echo Solución: Abre GitHub, crea el repo manualmente, y ejecuta:
    echo   git push -u origin main
    echo.
)

pause

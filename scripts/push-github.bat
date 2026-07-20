@echo off
REM Script para hacer push a GitHub después de crear el repositorio

setlocal enabledelayedexpansion

echo.
echo ╔════════════════════════════════════════════════════════════════╗
echo ║                    Push a GitHub - AeroMap                     ║
echo ╚════════════════════════════════════════════════════════════════╝
echo.
echo Usuario de GitHub: comicsandroid63-ops
echo Repositorio: aeromap
echo URL: https://github.com/comicsandroid63-ops/aeromap
echo.
echo ✅ ANTES de continuar, asegúrate de:
echo    1. Haber creado el repositorio en GitHub
echo    2. Iniciar sesión (se abrirá navegador)
echo.
echo Presiona ENTER para continuar...
pause

cd /d "c:\Users\HOME\Documents\Pagina 2"

echo.
echo 📤 Haciendo push a GitHub...
"C:\Program Files\Git\bin\git.exe" push -u origin main

if !ERRORLEVEL! EQU 0 (
    echo.
    echo ✅ ¡ÉXITO! Tu código está en GitHub
    echo.
    echo 🌐 Repositorio: https://github.com/comicsandroid63-ops/aeromap
    echo.
    echo 📱 Próximos pasos:
    echo    - Entra en tu repositorio en GitHub
    echo    - Copia la URL para deployar en Vercel
    echo.
) else (
    echo.
    echo ⚠️  Error al hacer push. Verifica:
    echo    1. Que el repositorio exista en GitHub
    echo    2. Tu autenticación (GitHub debe abrir navegador)
    echo    3. Conexión a internet
    echo.
)

pause

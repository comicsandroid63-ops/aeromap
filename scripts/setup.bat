@echo off
REM AeroMap Quick Start - Windows

cls
echo.
echo ===========================================
echo       AeroMap - Quick Start Setup
echo ===========================================
echo.

REM Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: Node.js no esta instalado
    echo Descarga desde: https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=*" %%A in ('node -v') do set NODE_VERSION=%%A
echo OK Node.js detectado: %NODE_VERSION%

for /f "tokens=*" %%A in ('npm -v') do set NPM_VERSION=%%A
echo OK NPM detectado: %NPM_VERSION%
echo.

REM Install dependencies
echo Instalando dependencias...
call npm install

REM Create uploads folder
if not exist "uploads" (
    echo Creando carpeta de uploads...
    mkdir uploads
)

echo.
echo ===========================================
echo         OK Listo para ejecutar!
echo ===========================================
echo.
echo Inicio del servidor:
echo   npm run dev    (Desarrollo)
echo   npm start      (Produccion)
echo.
echo Abre tu navegador en:
echo   http://localhost:3000
echo.
echo Para desplegar en la web, lee:
echo   DEPLOYMENT.md
echo.
pause

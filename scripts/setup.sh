#!/bin/bash

# 🚀 Quick Start Script para AeroMap

echo "╔═══════════════════════════════════════╗"
echo "║      AeroMap - Quick Start Setup       ║"
echo "╚═══════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js no está instalado"
    echo "   Descarga desde: https://nodejs.org"
    exit 1
fi

echo "✅ Node.js detectado: $(node -v)"
echo "✅ NPM detectado: $(npm -v)"
echo ""

# Install dependencies
echo "📦 Instalando dependencias..."
npm install

# Create uploads folder
if [ ! -d "uploads" ]; then
    echo "📁 Creando carpeta de uploads..."
    mkdir uploads
fi

echo ""
echo "╔═══════════════════════════════════════╗"
echo "║        ✅ Listo para ejecutar!        ║"
echo "╚═══════════════════════════════════════╝"
echo ""
echo "🚀 Para iniciar el servidor:"
echo "   npm run dev    (Desarrollo)"
echo "   npm start      (Producción)"
echo ""
echo "🌐 Abre tu navegador en:"
echo "   http://localhost:3000"
echo ""
echo "📝 Para desplegar en la web, lee:"
echo "   DEPLOYMENT.md"
echo ""

#!/bin/bash
# =============================================================================
#  Race Control Server — Script de actualización rápida
# =============================================================================

if [ "$EUID" -ne 0 ]; then
  echo "❌ Error: Ejecuta este script con sudo."
  echo "👉  sudo bash actualizar.sh"
  exit 1
fi

APP_DIR="/opt/race-control"
cd "$APP_DIR" || exit 1

echo "🔄 Descargando la última versión desde GitHub..."
git pull origin main

echo "⚙️  Instalando dependencias de Node.js..."
npm install --omit=dev

echo "🚀 Reiniciando servicio de Race Control..."
systemctl daemon-reload
systemctl reset-failed race-control
systemctl restart race-control

echo "✅ Servidor actualizado y corriendo correctamente."
systemctl status race-control --no-pager -n 5

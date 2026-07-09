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

echo "🚀 Aplicando reglas de posicionamiento nativas multi-pantalla en Openbox..."
RC_USER="racecontrol"
RC_HOME="/home/$RC_USER"
XML_FILE="$RC_HOME/.config/openbox/rc.xml"

if [ -f "$XML_FILE" ]; then
    # Limpiar reglas antiguas de racecontrol si las hubiera
    sed -i '/racecontrolgrabador/d; /racecontrolmonitor/d; /class="epiphany"/d; /class="Epiphany"/d' "$XML_FILE"
    
    # Inyectar reglas en la sección <applications>
    if grep -q "</applications>" "$XML_FILE"; then
        sed -i '/<\/applications>/i \    <application class="racecontrolgrabador">\n      <decor>no</decor>\n      <fullscreen>yes</fullscreen>\n      <maximized>true</maximized>\n      <head>1</head>\n    </application>\n    <application class="racecontrolmonitor">\n      <decor>no</decor>\n      <fullscreen>yes</fullscreen>\n      <maximized>true</maximized>\n      <head>2</head>\n    </application>' "$XML_FILE"
    fi
    chown $RC_USER:$RC_USER "$XML_FILE"
fi

# Actualizar el script de autoarranque local para asociar la clase al grabador principal
KIOSK_SCRIPT="$RC_HOME/.config/race-control/launch_kiosk.sh"
if [ -f "$KIOSK_SCRIPT" ]; then
    sed -i 's/firefox-esr --kiosk/firefox-esr --class racecontrolgrabador --kiosk/g' "$KIOSK_SCRIPT"
    chown $RC_USER:$RC_USER "$KIOSK_SCRIPT"
fi

# Forzar recarga de Openbox para aplicar las nuevas reglas de ventanas en caliente
sudo -u $RC_USER DISPLAY=:0 openbox --reconfigure 2>/dev/null || true

echo "🚀 Reiniciando servicio de Race Control..."
systemctl daemon-reload
systemctl reset-failed race-control
systemctl restart race-control

echo "✅ Servidor actualizado y corriendo correctamente."
systemctl status race-control --no-pager -n 5

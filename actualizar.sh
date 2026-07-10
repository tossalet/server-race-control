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

# Forzamos la restauración de la plantilla limpia de fábrica de Debian para curar cualquier corrupción XML previa
echo "🧹 Limpiando y restaurando rc.xml desde la plantilla del sistema /etc/xdg/openbox/rc.xml..."
mkdir -p "$RC_HOME/.config/openbox"
cp /etc/xdg/openbox/rc.xml "$XML_FILE"

# Inyección segura en el rc.xml usando awk para situarlo exactamente antes de la etiqueta </applications>
tmpfile=$(mktemp)
awk '
/<\/applications>/ {
    print "    <application class=\"racecontrolgrabador\">"
    print "      <decor>no</decor>"
    print "      <fullscreen>yes</fullscreen>"
    print "      <maximized>true</maximized>"
    print "      <position force=\"yes\">"
    print "        <x>0</x>"
    print "        <y>0</y>"
    print "      </position>"
    print "    </application>"
    print "    <application class=\"racecontrolmonitor\">"
    print "      <decor>no</decor>"
    print "      <fullscreen>yes</fullscreen>"
    print "      <maximized>true</maximized>"
    print "      <position force=\"yes\">"
    print "        <x>1920</x>"
    print "        <y>0</y>"
    print "      </position>"
    print "    </application>"
}
{ print }
' "$XML_FILE" > "$tmpfile"
mv "$tmpfile" "$XML_FILE"
chown $RC_USER:$RC_USER "$XML_FILE"

# Actualizar el script de autoarranque local para asociar la clase al grabador principal
KIOSK_SCRIPT="$RC_HOME/.config/race-control/launch_kiosk.sh"
if [ -f "$KIOSK_SCRIPT" ]; then
    sed -i 's/firefox-esr --kiosk/firefox-esr --class racecontrolgrabador --kiosk/g' "$KIOSK_SCRIPT"
    chown $RC_USER:$RC_USER "$KIOSK_SCRIPT"
fi

# Forzar recarga de Openbox para aplicar las nuevas reglas de ventanas en caliente
sudo -u $RC_USER DISPLAY=:0 openbox --reconfigure 2>/dev/null || true

echo "🚀 Reiniciando servicio de Race Control..."
systemctl stop race-control 2>/dev/null || true
killall -9 node 2>/dev/null || true
sleep 1
systemctl daemon-reload
systemctl reset-failed race-control
systemctl start race-control

echo "✅ Servidor actualizado y corriendo correctamente."
systemctl status race-control --no-pager -n 5

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

# En este entorno copiamos directamente los archivos locales, omitimos git pull y npm install.

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

# Actualizar el script de autoarranque local con supervisión continua y autorestart anti-cuelgues
KIOSK_SCRIPT="$RC_HOME/.config/race-control/launch_kiosk.sh"
echo "🖥️  Actualizando script supervisor de Kiosko ($KIOSK_SCRIPT)..."
cat > "$KIOSK_SCRIPT" << 'KIOSK_EOF'
#!/bin/bash
LOGFILE="/tmp/kiosk.log"
exec > >(tee -a "$LOGFILE") 2>&1
echo "=== Kiosk Supervisor Started at $(date) ==="

# Teclado y configuración X11
setxkbmap es 2>/dev/null || setxkbmap us 2>/dev/null || true
unclutter -idle 3 &
xset s noblank
xset s off
xset -dpms

# Fondo de pantalla
if [ -f "/usr/share/plymouth/themes/racecontrol/bg.png" ]; then
    feh --bg-scale /usr/share/plymouth/themes/racecontrol/bg.png &
fi

# Leer puerto del .env
ENV_PORT=$(grep '^PORT=' /opt/race-control/.env 2>/dev/null | cut -d'=' -f2)
PORT=${ENV_PORT:-3000}
echo "window.KIOSK_CONFIG = { port: '$PORT' };" > /opt/race-control/public/config.js

# Apagar Plymouth
command -v plymouth &>/dev/null && sudo plymouth quit 2>/dev/null || true

# Configurar preferencias en los perfiles de Firefox para evitar cuelgues, diálogos de bloqueo y desbordamiento de caché
mkdir -p "$HOME/.mozilla/firefox"
for pdir in $(find "$HOME/.mozilla/firefox" -maxdepth 1 -type d); do
    if [ -d "$pdir" ] && [ "$pdir" != "$HOME/.mozilla/firefox" ]; then
        cat > "$pdir/user.js" << 'USERJS_EOF'
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.sessionstore.interval", 86400000);
user_pref("toolkit.startup.max_resumed_crashes", -1);
user_pref("browser.cache.disk.enable", false);
user_pref("browser.cache.memory.enable", true);
user_pref("browser.cache.memory.capacity", 65536);
user_pref("dom.ipc.processHangMonitor", false);
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.enabled.user-gestures-needed", false);
USERJS_EOF
    fi
done

# Helper de foco y pantalla completa inicial en segundo plano
(
    sleep 3
    for i in $(seq 1 20); do
        WID=$(xdotool search --onlyvisible --class "firefox" 2>/dev/null | head -n 1)
        if [ -n "$WID" ]; then
            xdotool windowactivate "$WID" 2>/dev/null
            xdotool windowfocus "$WID" 2>/dev/null
            break
        fi
        sleep 1
    done
) &

# BUCLE INFINITO DE SUPERVISIÓN: Si Firefox se cierra o crashea, se relanza automáticamente
while true; do
    echo "[$(date)] Iniciando Firefox ESR en modo Kiosk..."
    find "$HOME/.mozilla" -name ".parentlock" -delete 2>/dev/null || true
    
    firefox-esr --class racecontrolgrabador --kiosk "file:///opt/race-control/public/splash.html"
    
    EXIT_CODE=$?
    echo "[$(date)] ⚠️ AVISO: Firefox ESR se cerró con código $EXIT_CODE. Relanzando en 1 segundo..."
    sleep 1
done
KIOSK_EOF

chmod +x "$KIOSK_SCRIPT"
chown $RC_USER:$RC_USER "$KIOSK_SCRIPT"

# Asegurar que el perfil temporal de Firefox para el monitor tiene los permisos correctos
mkdir -p "$RC_HOME/.config/firefox_monitor"
chown -R $RC_USER:$RC_USER "$RC_HOME/.config/firefox_monitor"

# Limpiar bloqueos parentlock de Firefox para evitar cuelgues al arrancar
echo "🧹 Limpiando bloqueos zombis de Firefox..."
pkill -f "launch_kiosk.sh" 2>/dev/null || true
killall -q -9 firefox firefox-esr 2>/dev/null || true
find "$RC_HOME/.mozilla" -name ".parentlock" -delete 2>/dev/null || true
find "$RC_HOME/.config/firefox_monitor" -name ".parentlock" -delete 2>/dev/null || true

# Proteger contra el OOM killer asegurando al menos 4GB de SWAP en disco
SWAP_TOTAL=$(free -m | awk '/^Swap:/ {print $2}')
if [ -z "$SWAP_TOTAL" ] || [ "$SWAP_TOTAL" -lt 2000 ]; then
    echo "💾 Configurando archivo de SWAP de 4GB para blindar contra el OOM Killer..."
    if [ ! -f /swapfile ]; then
        fallocate -l 4G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=4096
        chmod 600 /swapfile
        mkswap /swapfile 2>/dev/null || true
    fi
    swapon /swapfile 2>/dev/null || true
    grep -q "/swapfile" /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

# Conservar el botón de encendido/apagado físico funcional para apagar la máquina
rm -f /etc/systemd/logind.conf.d/race-control.conf 2>/dev/null || true
systemctl restart systemd-logind 2>/dev/null || true

# Forzar recarga de Openbox para aplicar las nuevas reglas de ventanas en caliente
sudo -u $RC_USER DISPLAY=:0 openbox --reconfigure 2>/dev/null || true

echo "🚀 Reiniciando servicio de Race Control..."
systemctl stop race-control 2>/dev/null || true
killall -9 node 2>/dev/null || true
sleep 0.5
systemctl daemon-reload
systemctl reset-failed race-control
systemctl start race-control

# Relanzar el kiosko inmediatamente en la sesión activa si X11 está corriendo
if pgrep -x "Xorg" >/dev/null || pgrep -x "X" >/dev/null; then
    echo "🖥️  Relanzando Kiosko en pantalla activa (DISPLAY=:0)..."
    sudo -u $RC_USER DISPLAY=:0 nohup bash "$KIOSK_SCRIPT" >/dev/null 2>&1 &
fi

echo "✅ Servidor actualizado y corriendo correctamente."
systemctl status race-control --no-pager -n 5

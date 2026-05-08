#!/bin/bash

# Este script configura el modo Kiosko para 2 monitores en Raspberry Pi OS o Ubuntu (X11)
# Asegúrate de ejecutarlo sin sudo (como el usuario que inicia sesión automáticamente, normalmente 'pi' o tu usuario)

if [ "$EUID" -eq 0 ]; then
  echo "Por favor, NO ejecutes este script como root (sudo). Ejecútalo como tu usuario normal."
  exit 1
fi

echo "📦 Instalando dependencias para Kiosk..."
sudo apt-get update
sudo apt-get install -y chromium-browser unclutter xdotool || sudo apt-get install -y chromium unclutter xdotool

# Averiguar el puerto del .env o usar 3000 por defecto
PORT=3000
if [ -f "/opt/race-control/.env" ]; then
    ENV_PORT=$(grep PORT /opt/race-control/.env | cut -d '=' -f2)
    if [ ! -z "$ENV_PORT" ]; then
        PORT=$ENV_PORT
    fi
elif [ -f "./.env" ]; then
    ENV_PORT=$(grep PORT ./.env | cut -d '=' -f2)
    if [ ! -z "$ENV_PORT" ]; then
        PORT=$ENV_PORT
    fi
fi

echo "🚀 Configurando Auto-Arranque Gráfico (Kiosk) en el puerto $PORT..."

# Crear el script de lanzamiento
mkdir -p ~/.config/race-control
cat <<EOF > ~/.config/race-control/launch_kiosk.sh
#!/bin/bash

# Ocultar el cursor del ratón cuando no se mueva
unclutter -idle 3 &

# Desactivar el salvapantallas y el modo de energía de la pantalla
xset s noblank
xset s off
xset -dpms

# Esperar a que el servidor de Node responda
echo "Esperando al Servidor Node en el puerto $PORT..."
while ! curl -s http://localhost:$PORT > /dev/null; do
    sleep 2
done
echo "Servidor listo, lanzando pantallas..."

# Monitor 1 (Principal): App Grabador
# Lanzamos con un user-data-dir específico para evitar conflictos de sesión y forzar ventana nueva
chromium-browser \\
    --noerrdialogs \\
    --disable-infobars \\
    --disable-features=Translate \\
    --no-first-run \\
    --check-for-update-interval=31536000 \\
    --kiosk \\
    --window-position=0,0 \\
    --user-data-dir=/tmp/chromium_kiosk_1 \\
    "http://localhost:$PORT/grabador" &

# Dar tiempo a que abra
sleep 5

# Monitor 2 (Secundario): App Monitor
chromium-browser \\
    --noerrdialogs \\
    --disable-infobars \\
    --disable-features=Translate \\
    --no-first-run \\
    --check-for-update-interval=31536000 \\
    --kiosk \\
    --window-position=1920,0 \\
    --user-data-dir=/tmp/chromium_kiosk_2 \\
    "http://localhost:$PORT/grabador/?monitor=1#monitor" &

EOF

chmod +x ~/.config/race-control/launch_kiosk.sh

# Agregar al autostart de LXDE (Raspberry Pi OS) o similar
AUTOSTART_DIR="$HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"

cat <<EOF > "$AUTOSTART_DIR/race-control-kiosk.desktop"
[Desktop Entry]
Type=Application
Name=Race Control Kiosk
Exec=$HOME/.config/race-control/launch_kiosk.sh
X-GNOME-Autostart-enabled=true
EOF

# También para Raspberry Pi OS clásico (LXDE-pi)
PI_AUTOSTART="$HOME/.config/lxsession/LXDE-pi"
if [ -d "$PI_AUTOSTART" ]; then
    grep -q "launch_kiosk.sh" "$PI_AUTOSTART/autostart" || echo "@bash $HOME/.config/race-control/launch_kiosk.sh" >> "$PI_AUTOSTART/autostart"
fi

echo "✅ Configuración de monitores finalizada."
echo "La próxima vez que inicies sesión en el escritorio, se abrirán los dos monitores en pantalla completa."

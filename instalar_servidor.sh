#!/bin/bash

# Comprobar root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Error: Por favor, ejecuta este instalador con permisos de administrador."
  echo "👉 Usa el comando: sudo bash instalar_servidor.sh"
  exit
fi

# Detectar el usuario real que ejecutó el sudo para configurar el Kiosko en su cuenta
if [ -n "$SUDO_USER" ]; then
    REAL_USER="$SUDO_USER"
else
    REAL_USER=$(id -un 1000 2>/dev/null)
    if [ -z "$REAL_USER" ]; then
        REAL_USER="root"
    fi
fi
REAL_HOME=$(eval echo ~$REAL_USER)

# Instalar whiptail por si no está
apt-get update -qq
apt-get install -y whiptail

# Bienvenida
whiptail --title "Instalador Máster: Race Control" --msgbox "Bienvenido al Instalador Todo-en-Uno de Race Control Server.\n\nEste script se encargará de configurar tu Raspberry Pi o PC (i7) al completo:\n- Limpiará instalaciones antiguas.\n- Instalará el software y sus dependencias.\n- Configurará la animación de arranque (Plymouth).\n- Configurará las pantallas automáticas (Kiosko)." 16 65

# Preguntar Puertos
WEB_PORT=$(whiptail --title "Configuración" --inputbox "Introduce el PUERTO en el que deseas visualizar el Panel de Control Web:\n\n(Ejemplo: 3000, 80, 8080)" 12 60 "3000" 3>&1 1>&2 2>&3)
if [ -z "$WEB_PORT" ]; then WEB_PORT=3000; fi

SRT_PORT=$(whiptail --title "Configuración" --inputbox "Introduce el PUERTO BASE para la recepción de señal SRT:\n\n(Ejemplo: 8000)" 12 60 "8000" 3>&1 1>&2 2>&3)
if [ -z "$SRT_PORT" ]; then SRT_PORT=8000; fi

# Confirmación Final
whiptail --title "Resumen de Instalación" --yesno "Se procederá a instalar con la siguiente configuración:\n\n- Panel Web: Puerto $WEB_PORT\n- Señal SRT: Puerto Base $SRT_PORT\n- Usuario Principal (Kiosko): $REAL_USER\n\n¿Deseas iniciar la instalación global ahora?" 15 60
if [ $? -ne 0 ]; then
    clear
    echo "Instalación cancelada por el usuario."
    exit 1
fi

clear
echo "🧹 1. Limpiando instalaciones antiguas y servicios fantasmas..."
systemctl stop tsst-srt.service 2>/dev/null
systemctl disable tsst-srt.service 2>/dev/null
systemctl stop race-control.service 2>/dev/null
systemctl disable race-control.service 2>/dev/null
systemctl stop race-control-kiosk.service 2>/dev/null
systemctl disable race-control-kiosk.service 2>/dev/null
rm -rf /opt/race-control

echo "🛠️ 2. Instalando dependencias del sistema operativo..."
# Añadimos X11 y Openbox para sistemas Server/Lite sin entorno gráfico
apt-get install -y ffmpeg curl software-properties-common wget build-essential git ntfs-3g exfatprogs udevil plymouth plymouth-themes xserver-xorg x11-xserver-utils xinit openbox
# Intentar instalar chromium-browser o chromium
apt-get install -y chromium-browser unclutter xdotool || apt-get install -y chromium unclutter xdotool

echo "📦 3. Instalando Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo " USB 4. Activando Auto-Montador de discos duros..."
systemctl enable devmon@root
systemctl start devmon@root

echo "📂 5. Descargando el código del servidor..."
APP_DIR="/opt/race-control"
mkdir -p $APP_DIR
GITHUB_REPO="https://github.com/tossalet/server-race-control.git"
git clone $GITHUB_REPO $APP_DIR
cd $APP_DIR

echo "⚙️ 6. Instalando dependencias de Node (npm)..."
npm install --omit=dev

echo "📝 7. Configurando variables de entorno (.env)..."
echo "PORT=$WEB_PORT" > .env
echo "SRT_BASE_PORT=$SRT_PORT" >> .env

echo "🚀 8. Creando servicio central (race-control.service)..."
cat <<EOF > /etc/systemd/system/race-control.service
[Unit]
Description=Race Control Server
After=network.target

[Service]
ExecStart=/usr/bin/node $APP_DIR/server.js
WorkingDirectory=$APP_DIR
Restart=always
User=root
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production
EnvironmentFile=$APP_DIR/.env

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable race-control.service
systemctl start race-control.service

echo "🎬 9. Instalando animación de arranque (Plymouth)..."
THEME_DIR="/usr/share/plymouth/themes/racecontrol"
mkdir -p "$THEME_DIR"
cp -r $APP_DIR/boot-theme/* "$THEME_DIR/" 2>/dev/null
chmod -R 755 "$THEME_DIR"
if [ -f "$THEME_DIR/racecontrol.script" ]; then
    plymouth-set-default-theme -R racecontrol
    
    # Modificar cmdline.txt si existe (Raspberry Pi)
    CMDLINE_PATH="/boot/firmware/cmdline.txt"
    if [ ! -f "$CMDLINE_PATH" ]; then CMDLINE_PATH="/boot/cmdline.txt"; fi
    if [ -f "$CMDLINE_PATH" ]; then
        if ! grep -q "splash" "$CMDLINE_PATH"; then
            sed -i 's/$/ quiet splash/' "$CMDLINE_PATH"
        fi
    fi
    # Modificar GRUB si existe (Ubuntu/Debian i7)
    if [ -f "/etc/default/grub" ]; then
        sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"/' /etc/default/grub
        update-grub 2>/dev/null
    fi
fi

echo "🖥️ 10. Configurando pantallas automáticas (Modo Kiosko para Server/Lite)..."
# Crear el servicio de sistema para arrancar el motor gráfico X11
cat <<EOF > /etc/systemd/system/race-control-kiosk.service
[Unit]
Description=Race Control Graphical Kiosk
After=systemd-user-sessions.service network.target race-control.service

[Service]
User=$REAL_USER
Group=$REAL_USER
PAMName=login
Type=simple
Environment=DISPLAY=:0
ExecStart=/usr/bin/startx /usr/bin/openbox-session -- :0 -nocursor -s off -dpms
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable race-control-kiosk.service

# Script de lanzamiento para Openbox (arranque de ventanas)
mkdir -p $REAL_HOME/.config/openbox
cat <<'EOF' > $REAL_HOME/.config/openbox/autostart
# Hide mouse and disable screensaver
unclutter -idle 3 &
xset s noblank
xset s off
xset -dpms

ENV_PORT=$(grep '^PORT=' /opt/race-control/.env | cut -d '=' -f2)
PORT=${ENV_PORT:-3000}

# Wait for server
while ! curl -s http://localhost:$PORT > /dev/null; do sleep 2; done

BROWSER="chromium-browser"
if ! command -v chromium-browser &> /dev/null; then
    if command -v chromium &> /dev/null; then BROWSER="chromium"
    elif command -v google-chrome &> /dev/null; then BROWSER="google-chrome"
    fi
fi

# App Grabador (Monitor 1)
$BROWSER \
    --noerrdialogs --disable-infobars --disable-features=Translate \
    --no-first-run --check-for-update-interval=31536000 \
    --kiosk --window-position=0,0 \
    --user-data-dir=/tmp/chromium_kiosk_1 \
    "http://localhost:$PORT/grabador" &

sleep 5

# Monitor Output (Monitor 2)
$BROWSER \
    --noerrdialogs --disable-infobars --disable-features=Translate \
    --no-first-run --check-for-update-interval=31536000 \
    --kiosk --window-position=1920,0 \
    --user-data-dir=/tmp/chromium_kiosk_2 \
    "http://localhost:$PORT/grabador/?monitor=1#monitor" &
EOF

# Arreglar permisos para que el usuario real sea el dueño de su config
chown -R $REAL_USER:$REAL_USER $REAL_HOME/.config/openbox

LOCAL_IP=$(hostname -I | awk '{print $1}')

whiptail --title "¡Instalación Maestra Completada!" --msgbox "Race Control Server se ha instalado y configurado al 100%.\n\nTodo ha quedado limpio y unificado en un solo instalador.\n\n👉 Ya puedes reiniciar la máquina y disfrutar.\nPanel Web: http://$LOCAL_IP:$WEB_PORT" 15 65

clear
echo "✅ ¡Instalación Finalizada con éxito!"
echo "🔄 RECOMENDACIÓN: Ejecuta 'sudo reboot' para probar todo."

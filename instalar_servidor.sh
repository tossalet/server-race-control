#!/bin/bash
# =============================================================================
#  Race Control Server — Instalador Todo-en-Uno
#  Uso: sudo bash instalar_servidor.sh
#  Compatible con: Raspberry Pi OS (bookworm), Ubuntu 22/24 LTS
# =============================================================================

# ── Comprobación de root ──────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  echo "❌ Error: Por favor, ejecuta este instalador con permisos de administrador."
  echo "👉 Usa el comando: sudo bash instalar_servidor.sh"
  exit 1
fi

# ── Detectar usuario real (para configurar el kiosko en su cuenta) ────────────
if [ -n "$SUDO_USER" ]; then
    REAL_USER="$SUDO_USER"
else
    REAL_USER=$(id -un 1000 2>/dev/null)
    [ -z "$REAL_USER" ] && REAL_USER="root"
fi
REAL_HOME=$(eval echo ~$REAL_USER)

APP_DIR="/opt/race-control"
MOUNT_POINT="/mnt/recordings"

# ── Instalar whiptail si no está ──────────────────────────────────────────────
apt-get update -qq
apt-get install -y -qq whiptail

# ── Bienvenida ────────────────────────────────────────────────────────────────
whiptail --title "Instalador Máster: Race Control" --msgbox \
"Bienvenido al Instalador Todo-en-Uno de Race Control Server.

Este script configurará tu máquina al completo:
 - Limpiará instalaciones antiguas.
 - Instalará el software y dependencias.
 - Detectará y montará discos externos automáticamente.
 - Configurará la animación de arranque (Plymouth).
 - Configurará las pantallas automáticas (Kiosko)." 18 65

# ── Configuración de puertos ──────────────────────────────────────────────────
WEB_PORT=$(whiptail --title "Configuración" --inputbox \
"Puerto del Panel de Control Web:\n\n(Por defecto: 3000)" \
10 60 "3000" 3>&1 1>&2 2>&3)
[ -z "$WEB_PORT" ] && WEB_PORT=3000

SRT_PORT=$(whiptail --title "Configuración" --inputbox \
"Puerto base para recepción SRT:\n\n(Por defecto: 8000)" \
10 60 "8000" 3>&1 1>&2 2>&3)
[ -z "$SRT_PORT" ] && SRT_PORT=8000

# ── Confirmación ──────────────────────────────────────────────────────────────
whiptail --title "Resumen de Instalación" --yesno \
"Configuración seleccionada:

 - Panel Web:      Puerto $WEB_PORT
 - Señal SRT:      Puerto Base $SRT_PORT
 - Usuario Kiosko: $REAL_USER

¿Iniciar instalación ahora?" 14 55
[ $? -ne 0 ] && clear && echo "Instalación cancelada." && exit 1

clear

# ── 1. Limpiar instalaciones antiguas ─────────────────────────────────────────
echo "🧹 1. Limpiando instalaciones antiguas..."
for svc in tsst-srt race-control race-control-kiosk; do
    systemctl stop    $svc.service 2>/dev/null || true
    systemctl disable $svc.service 2>/dev/null || true
done

# Preservar datos antes de borrar el directorio
[ -f "$APP_DIR/.env"               ] && cp "$APP_DIR/.env"               /tmp/rc_env_backup
[ -f "$APP_DIR/data/race-control.db" ] && cp "$APP_DIR/data/race-control.db" /tmp/rc_db_backup

rm -rf "$APP_DIR"

# ── 2. Dependencias del sistema ───────────────────────────────────────────────
echo "🛠️  2. Instalando dependencias del sistema..."
apt-get install -y \
    ffmpeg curl git build-essential \
    ntfs-3g exfatprogs udevil udisks2 \
    plymouth plymouth-themes \
    xserver-xorg openbox lightdm feh \
    unclutter xdotool 2>/dev/null || true

# Chromium (nombre varía según distro)
apt-get install -y chromium-browser 2>/dev/null || apt-get install -y chromium 2>/dev/null || true

# ── 3. Node.js 20 LTS ────────────────────────────────────────────────────────
echo "📦 3. Verificando Node.js..."
NODE_OK=false
if command -v node &>/dev/null; then
    node -e "process.exit(parseInt(process.version.slice(1)) >= 18 ? 0 : 1)" 2>/dev/null && NODE_OK=true
fi
if [ "$NODE_OK" = false ]; then
    echo "   Instalando Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
echo "   Node.js: $(node --version)"

# ── 4. Auto-montador de discos USB ────────────────────────────────────────────
echo "💾 4. Activando auto-montador de discos..."
# devmon@root (udevil) — monta automáticamente en /media
systemctl enable devmon@root 2>/dev/null && systemctl start devmon@root 2>/dev/null || true
# udisks2 — alternativa moderna (Ubuntu/Debian desktop)
systemctl enable udisks2 2>/dev/null && systemctl start udisks2 2>/dev/null || true

# ── 5. Clonar repositorio ─────────────────────────────────────────────────────
echo "📂 5. Descargando código del servidor..."
git clone https://github.com/tossalet/server-race-control.git "$APP_DIR"
cd "$APP_DIR"

# Restaurar datos preservados
mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
[ -f /tmp/rc_env_backup ] && cp /tmp/rc_env_backup "$APP_DIR/.env"    && echo "   .env restaurado."
[ -f /tmp/rc_db_backup  ] && cp /tmp/rc_db_backup  "$APP_DIR/data/race-control.db" && echo "   Base de datos restaurada."

# ── 6. Dependencias Node ──────────────────────────────────────────────────────
echo "⚙️  6. Instalando dependencias Node.js..."
npm install --omit=dev

# ── 7. Detectar y montar disco externo ───────────────────────────────────────
echo "💽 7. Detectando disco externo para grabaciones..."
SYSTEM_DEV=$(lsblk -no PKNAME $(findmnt -n -o SOURCE /) 2>/dev/null | head -1 || lsblk -no PKNAME / 2>/dev/null | head -1)
EXT_PART=""

while IFS= read -r line; do
    DEV=$(echo "$line" | awk '{print $1}')
    TYPE=$(echo "$line" | awk '{print $4}')
    MOUNT=$(echo "$line" | awk '{print $5}')
    PKNAME=$(lsblk -no PKNAME "/dev/$DEV" 2>/dev/null | head -1)
    [ "$TYPE" != "part" ] && continue
    [ -n "$MOUNT" ] && continue
    [ "$PKNAME" = "$SYSTEM_DEV" ] && continue
    [[ "$DEV" == loop* || "$DEV" == zram* ]] && continue
    EXT_PART="/dev/$DEV"
    echo "   Encontrado: $EXT_PART"
    break
done < <(lsblk -o NAME,SIZE,RM,TYPE,MOUNTPOINT -rn 2>/dev/null)

MEDIA_ROOT=""
if [ -n "$EXT_PART" ]; then
    mkdir -p "$MOUNT_POINT"
    if ! mountpoint -q "$MOUNT_POINT"; then
        mount "$EXT_PART" "$MOUNT_POINT" 2>/dev/null && echo "   Montado en $MOUNT_POINT" || echo "   No se pudo montar — se configurará manualmente."
    fi
    if mountpoint -q "$MOUNT_POINT"; then
        MEDIA_ROOT="$MOUNT_POINT"
        UUID=$(blkid -s UUID -o value "$EXT_PART" 2>/dev/null || true)
        FSTYPE=$(blkid -s TYPE -o value "$EXT_PART" 2>/dev/null || echo auto)
        if [ -n "$UUID" ] && ! grep -q "$UUID" /etc/fstab; then
            echo "UUID=$UUID  $MOUNT_POINT  $FSTYPE  defaults,nofail  0  2" >> /etc/fstab
            echo "   Montaje permanente añadido a /etc/fstab"
        fi
    fi
else
    echo "   No se encontró disco externo. Conéctalo y selecciónalo desde Ajustes en el frontend."
fi

# ── 8. Fichero .env ───────────────────────────────────────────────────────────
echo "📝 8. Configurando variables de entorno..."
# Solo crear si no fue restaurado (para no perder configuración previa)
if [ ! -f "$APP_DIR/.env" ]; then
    cat > "$APP_DIR/.env" << EOF
PORT=$WEB_PORT
SRT_BASE_PORT=$SRT_PORT
NODE_ENV=production
EOF
else
    # Asegurarse de que NODE_ENV está presente
    grep -q "^NODE_ENV=" "$APP_DIR/.env" || echo "NODE_ENV=production" >> "$APP_DIR/.env"
fi

# Añadir MEDIA_ROOT si se detectó disco
if [ -n "$MEDIA_ROOT" ] && ! grep -q "^MEDIA_ROOT=" "$APP_DIR/.env"; then
    echo "MEDIA_ROOT=$MEDIA_ROOT" >> "$APP_DIR/.env"
    echo "   MEDIA_ROOT=$MEDIA_ROOT → añadido al .env"
fi

# ── 9. Servicio systemd ───────────────────────────────────────────────────────
echo "🚀 9. Creando servicio race-control..."
cat > /etc/systemd/system/race-control.service << EOF
[Unit]
Description=Race Control Server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node $APP_DIR/server.js
WorkingDirectory=$APP_DIR
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=0
User=root
Environment=PATH=/usr/bin:/usr/local/bin
EnvironmentFile=$APP_DIR/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable race-control.service
systemctl start race-control.service

# ── 10. Plymouth (animación de arranque) ──────────────────────────────────────
echo "🎬 10. Instalando animación de arranque (Plymouth)..."
THEME_DIR="/usr/share/plymouth/themes/racecontrol"
mkdir -p "$THEME_DIR"
cp -r "$APP_DIR/boot-theme/"* "$THEME_DIR/" 2>/dev/null || true
chmod -R 755 "$THEME_DIR"
if [ -f "$THEME_DIR/racecontrol.script" ]; then
    plymouth-set-default-theme -R racecontrol
    # Raspberry Pi
    for CMDLINE in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
        if [ -f "$CMDLINE" ]; then
            command -v raspi-config >/dev/null && raspi-config nonint do_boot_splash 0 2>/dev/null || true
            for word in "quiet" "splash" "plymouth.ignore-serial-consoles" "vt.global_cursor_default=0"; do
                grep -q "$word" "$CMDLINE" || sed -i "s/$/ $word/" "$CMDLINE"
            done
        fi
    done
    # Ubuntu/i7 con GRUB
    if [ -f "/etc/default/grub" ]; then
        sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="quiet splash plymouth.ignore-serial-consoles vt.global_cursor_default=0"/' /etc/default/grub
        update-grub 2>/dev/null || true
    fi
    update-initramfs -u 2>/dev/null || true
fi

# ── 11. Modo Kiosko (LightDM + Openbox + Chromium) ───────────────────────────
echo "🖥️  11. Configurando modo Kiosko..."
# Autologin en LightDM
if [ -f "/etc/lightdm/lightdm.conf" ]; then
    sed -i "s/^#autologin-user=.*/autologin-user=$REAL_USER/" /etc/lightdm/lightdm.conf
    sed -i "s/^#autologin-user-timeout=.*/autologin-user-timeout=0/" /etc/lightdm/lightdm.conf
fi
echo -e "[Desktop]\nSession=openbox" > "/var/lib/AccountsService/users/$REAL_USER" 2>/dev/null || true

# Script de arranque de Openbox
mkdir -p "$REAL_HOME/.config/openbox"
cat > "$REAL_HOME/.config/openbox/autostart" << 'KIOSK_EOF'
# Desactivar salvapantallas y ahorro de energía
xset s noblank
xset s off
xset -dpms

# Fondo de pantalla (transición suave desde Plymouth)
[ -f "/usr/share/plymouth/themes/racecontrol/bg.png" ] && feh --bg-scale /usr/share/plymouth/themes/racecontrol/bg.png

# Limpiar bloqueos de sesiones anteriores de Chromium
rm -rf /tmp/chromium_kiosk_*

# Leer puerto del .env
ENV_PORT=$(grep '^PORT=' /opt/race-control/.env | cut -d'=' -f2)
PORT=${ENV_PORT:-3000}

# Esperar a que el servidor esté listo (máx 20s)
for i in $(seq 1 10); do
    curl -s "http://localhost:$PORT" > /dev/null && break
    sleep 2
done

# Detectar navegador disponible
BROWSER="chromium-browser"
command -v chromium-browser &>/dev/null || { command -v chromium &>/dev/null && BROWSER="chromium"; } || { command -v google-chrome &>/dev/null && BROWSER="google-chrome"; }

# Monitor 1 — App Grabador
$BROWSER \
    --noerrdialogs --disable-infobars --disable-features=Translate \
    --no-first-run --ignore-gpu-blocklist --enable-gpu-rasterization \
    --enable-zero-copy --kiosk --window-position=0,0 \
    --user-data-dir=/tmp/chromium_kiosk_1 \
    "http://localhost:$PORT/grabador" &

sleep 5

# Monitor 2 — Solo si hay 2 monitores conectados
NUM_MONITORS=$(xrandr --listactivemonitors 2>/dev/null | head -n 1 | awk '{print $2}')
if [ "${NUM_MONITORS:-1}" -gt 1 ]; then
    $BROWSER \
        --noerrdialogs --disable-infobars --disable-features=Translate \
        --no-first-run --ignore-gpu-blocklist --enable-gpu-rasterization \
        --enable-zero-copy --kiosk --window-position=1920,0 \
        --user-data-dir=/tmp/chromium_kiosk_2 \
        "http://localhost:$PORT/grabador/?monitor=1#monitor" &
fi
KIOSK_EOF

chown -R "$REAL_USER:$REAL_USER" "$REAL_HOME/.config/openbox"
systemctl enable lightdm 2>/dev/null || true

# ── 12. Verificación final ────────────────────────────────────────────────────
sleep 4
LOCAL_IP=$(hostname -I | awk '{print $1}')

if systemctl is-active --quiet race-control.service; then
    DISK_MSG=""
    [ -n "$MEDIA_ROOT" ] && DISK_MSG="\n - Disco grabación: $MEDIA_ROOT" || DISK_MSG="\n - Sin disco externo (configura desde Ajustes)"
    whiptail --title "¡Instalación Completada!" --msgbox \
"Race Control Server instalado y en marcha.

 - Panel Web: http://$LOCAL_IP:$WEB_PORT$DISK_MSG

Reinicia la máquina para activar el Kiosko y Plymouth.
👉 sudo reboot" 16 65
else
    whiptail --title "⚠️ Advertencia" --msgbox \
"El servidor no arrancó correctamente.
Revisa los logs con:

  sudo journalctl -u race-control.service -n 30" 12 55
fi

clear
echo "✅ ¡Instalación finalizada!"
echo "🔄 Ejecuta 'sudo reboot' para aplicar todos los cambios."

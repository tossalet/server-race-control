#!/bin/bash
# =============================================================================
#  Race Control Server — Instalador Todo-en-Uno
#  Incluye: servidor, disco externo, Plymouth, Kiosko multi-monitor
#  Uso: sudo bash instalar_servidor.sh
#  Compatible: Raspberry Pi OS (bookworm), Ubuntu 22/24 LTS, Debian 12 (Bookworm)
# =============================================================================

# ── Detectar distribución ────────────────────────────────────────────────────
DISTRO_ID=$(grep '^ID=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"')
DISTRO_VER=$(grep '^VERSION_CODENAME=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"')
echo "   Distribución detectada: ${DISTRO_ID} ${DISTRO_VER}"

# ── Comprobación de root ──────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  echo "❌ Error: Ejecuta con permisos de administrador."
  echo "👉  sudo bash instalar_servidor.sh"
  exit 1
fi

# ── Usuario real (para el kiosko) ─────────────────────────────────────────────
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
apt-get update -qq && apt-get install -y -qq whiptail

# ── Bienvenida ────────────────────────────────────────────────────────────────
whiptail --title "Instalador Máster: Race Control" --msgbox \
"Bienvenido al Instalador Todo-en-Uno de Race Control Server.

Este script configurará tu máquina al completo:
 ✔ Limpia instalaciones antiguas.
 ✔ Instala todas las dependencias del sistema.
 ✔ Detecta y monta discos externos automáticamente.
 ✔ Configura la animación de arranque (Plymouth).
 ✔ Configura las pantallas en modo Kiosko.
 ✔ Inicia el servidor como servicio del sistema." 18 65

# ── Configuración interactiva ─────────────────────────────────────────────────
WEB_PORT=$(whiptail --title "Configuración" --inputbox \
"Puerto del Panel de Control Web:\n(Por defecto: 3000)" \
10 55 "3000" 3>&1 1>&2 2>&3)
[ -z "$WEB_PORT" ] && WEB_PORT=3000

SRT_PORT=$(whiptail --title "Configuración" --inputbox \
"Puerto base para recepción de señal SRT:\n(Por defecto: 8000)" \
10 55 "8000" 3>&1 1>&2 2>&3)
[ -z "$SRT_PORT" ] && SRT_PORT=8000

whiptail --title "Resumen de Instalación" --yesno \
"Configuración seleccionada:

 - Panel Web:      Puerto $WEB_PORT
 - Señal SRT:      Puerto Base $SRT_PORT
 - Usuario Kiosko: $REAL_USER

¿Iniciar la instalación ahora?" 14 55
[ $? -ne 0 ] && clear && echo "Instalación cancelada." && exit 1

clear

# =============================================================================
#  PASO 1 — Limpiar instalaciones anteriores
# =============================================================================
echo "🧹 1/11 — Limpiando instalaciones antiguas..."
for svc in tsst-srt race-control race-control-kiosk; do
    systemctl stop    "$svc.service" 2>/dev/null || true
    systemctl disable "$svc.service" 2>/dev/null || true
done

# Preservar datos antes de borrar
[ -f "$APP_DIR/.env"                 ] && cp "$APP_DIR/.env"                 /tmp/rc_env_backup
[ -f "$APP_DIR/data/race-control.db" ] && cp "$APP_DIR/data/race-control.db" /tmp/rc_db_backup

rm -rf "$APP_DIR"

# =============================================================================
#  PASO 2 — Dependencias del sistema
# =============================================================================
echo "🛠️  2/11 — Instalando dependencias del sistema..."

# ── Paquetes base comunes ─────────────────────────────────────────────────────
apt-get install -y \
    ffmpeg curl git build-essential rsync \
    ntfs-3g udevil udisks2 \
    plymouth plymouth-themes \
    xserver-xorg openbox lightdm feh \
    unclutter xdotool 2>/dev/null || true

# ── Epiphany Browser (Soporte H.265 nativo sin transcodificar) ────────────────
echo "🌐 2.1/11 — Instalando Epiphany Browser para soporte H.265 nativo..."
if ! apt-get install -y epiphany-browser 2>/dev/null; then
    echo "   ⚠️  Instalación estándar de Epiphany falló. Intentando resolver conflictos con aptitude..."
    apt-get install -y aptitude 2>/dev/null || true
    if command -v aptitude &>/dev/null; then
        # Correr aptitude en modo no-interactivo para resolver dependencias y forzar la instalación
        # -y: si, -o Aptitude::Keep-Failed-Dependencies=false resolverá el problema
        # Le enviamos una opción predeterminada para que elija la solución que instala/actualiza en vez de mantener rotos
        echo "   Ejecutando aptitude para resolver dependencias..."
        aptitude install -y -o Aptitude::ProblemResolver::StepLimit=1000 -o Aptitude::Keep-Failed-Dependencies=false epiphany-browser 2>/dev/null || true
    else
        echo "   ❌ No se pudo instalar aptitude para resolver conflictos. Se continuará con otros navegadores."
    fi
else
    echo "   ✔ Epiphany Browser instalado correctamente."
fi

# ── Soporte exFAT: exfatprogs (kernel nativo) con fallback a exfat-fuse ───────
if apt-get install -y exfatprogs 2>/dev/null; then
    echo "   exFAT: exfatprogs instalado (driver kernel nativo)"
elif apt-get install -y exfat-fuse exfat-utils 2>/dev/null; then
    echo "   exFAT: exfat-fuse instalado (FUSE)"
else
    echo "   ⚠️  exFAT: no se pudo instalar soporte exFAT"
fi

# ── VAAPI (aceleración hardware Intel iGPU) ───────────────────────────────────
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
    # Intel 6ª gen+ (Skylake → Alder Lake): intel-media-va-driver
    # Intel ≤5ª gen (Broadwell y anteriores): i965-va-driver
    apt-get install -y vainfo intel-media-va-driver 2>/dev/null || \
    apt-get install -y vainfo i965-va-driver         2>/dev/null || true
    echo "   VAAPI: driver Intel instalado"
fi

# ── Navegador para Kiosko ─────────────────────────────────────────────────────
#  - x86_64 (i7): Google Chrome primero (H.264 nativo, aceleración HW)
#  - ARM (Raspberry Pi): Chromium + codecs extra
if [ "$ARCH" = "x86_64" ]; then
    if ! command -v google-chrome &>/dev/null && ! command -v google-chrome-stable &>/dev/null; then
        echo "   Descargando Google Chrome para x86_64..."
        curl -fsSL -o /tmp/google-chrome.deb \
            "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" 2>/dev/null && \
            apt-get install -y /tmp/google-chrome.deb 2>/dev/null && \
            rm -f /tmp/google-chrome.deb || \
            echo "   Chrome no disponible, usando Chromium."
    fi
    # Debian: paquete se llama 'chromium' (no 'chromium-browser')
    apt-get install -y chromium 2>/dev/null || \
    apt-get install -y chromium-browser 2>/dev/null || true
else
    # Raspberry Pi / ARM: Chromium + códecs H.264
    apt-get install -y chromium-browser chromium-codecs-ffmpeg-extra 2>/dev/null || \
    apt-get install -y chromium 2>/dev/null || true
fi

# =============================================================================
#  PASO 3 — Node.js 20 LTS
# =============================================================================
echo "📦 3/11 — Verificando Node.js..."
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

# =============================================================================
#  PASO 4 — Auto-montador de discos USB
# =============================================================================
echo "💾 4/11 — Activando auto-montador de discos..."
systemctl enable devmon@root 2>/dev/null && systemctl start devmon@root 2>/dev/null || true
systemctl enable udisks2     2>/dev/null && systemctl start udisks2     2>/dev/null || true

# =============================================================================
#  PASO 5 — Configurar código del servidor
# =============================================================================
echo "📂 5/11 — Configurando código del servidor..."
# Obtener el directorio absoluto del script actual
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$APP_DIR"

# Si hay package.json local, ofrecer usarlo
USE_LOCAL=false
if [ -f "$SCRIPT_DIR/package.json" ]; then
    if whiptail --title "Código local detectado" --yesno \
        "Se ha detectado el código del servidor en esta carpeta local ($SCRIPT_DIR).\n\n¿Quieres usar estos archivos locales en lugar de descargar de GitHub?" 10 65; then
        USE_LOCAL=true
    fi
fi

if [ "$USE_LOCAL" = true ]; then
    echo "   Usando archivos locales..."
    if command -v rsync &>/dev/null; then
        rsync -a --exclude='node_modules' --exclude='logs' --exclude='media' --exclude='.git' "$SCRIPT_DIR/" "$APP_DIR/" 2>/dev/null
    else
        cp -r "$SCRIPT_DIR/"* "$APP_DIR/" 2>/dev/null || true
        rm -rf "$APP_DIR/node_modules" "$APP_DIR/logs" "$APP_DIR/media" "$APP_DIR/.git"
    fi
else
    # Ofrecer opciones de descarga desde GitHub
    GIT_CHOICE=$(whiptail --title "Método de descarga desde GitHub" --menu \
        "El repositorio 'tossalet/server-race-control' es privado. ¿Cómo deseas descargarlo?" 15 65 4 \
        "1" "HTTPS estándar (público o pidiendo credenciales)" \
        "2" "Token de Acceso Personal (GitHub PAT)" \
        "3" "SSH (requiere clave SSH configurada en tu GitHub)" \
        "4" "URL Git personalizada" 3>&1 1>&2 2>&3)
        
    case "$GIT_CHOICE" in
        2)
            PAT=$(whiptail --title "Token de Acceso Personal (PAT)" --inputbox \
                "Introduce tu Token de Acceso de GitHub (PAT) con permisos de lectura:" 10 65 3>&1 1>&2 2>&3)
            if [ -n "$PAT" ]; then
                echo "   Descargando con token PAT..."
                git clone "https://${PAT}@github.com/tossalet/server-race-control.git" "$APP_DIR"
            else
                echo "   No se introdujo token, usando HTTPS por defecto..."
                git clone "https://github.com/tossalet/server-race-control.git" "$APP_DIR"
            fi
            ;;
        3)
            echo "   Descargando vía SSH..."
            git clone "git@github.com:tossalet/server-race-control.git" "$APP_DIR"
            ;;
        4)
            CUSTOM_URL=$(whiptail --title "URL de Git Personalizada" --inputbox \
                "Introduce la URL de clonado completa (ej: https://usuario:token@github.com/...):" 10 65 3>&1 1>&2 2>&3)
            if [ -n "$CUSTOM_URL" ]; then
                echo "   Descargando desde URL personalizada..."
                git clone "$CUSTOM_URL" "$APP_DIR"
            else
                echo "   No se introdujo URL, usando HTTPS por defecto..."
                git clone "https://github.com/tossalet/server-race-control.git" "$APP_DIR"
            fi
            ;;
        *)
            echo "   Descargando vía HTTPS estándar..."
            git clone "https://github.com/tossalet/server-race-control.git" "$APP_DIR"
            ;;
    esac
fi

cd "$APP_DIR"

mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
[ -f /tmp/rc_env_backup ] && cp /tmp/rc_env_backup "$APP_DIR/.env"                 && echo "   .env restaurado."
[ -f /tmp/rc_db_backup  ] && cp /tmp/rc_db_backup  "$APP_DIR/data/race-control.db" && echo "   Base de datos restaurada."

# =============================================================================
#  PASO 6 — npm install
# =============================================================================
echo "⚙️  6/11 — Instalando dependencias Node.js..."
# Asegurar que npm install corre SIEMPRE en el directorio correcto
cd /opt/race-control
npm install --omit=dev
# Garantía extra: instalar dotenv y ws explícitamente (evita errores de directorio)
npm install dotenv ws --save 2>/dev/null || true

# =============================================================================
#  PASO 7 — Detectar y montar partición de grabaciones
# =============================================================================
echo "💽 7/11 — Detectando partición de grabaciones..."
SYSTEM_DEV=$(lsblk -no PKNAME "$(findmnt -n -o SOURCE /)" 2>/dev/null | head -1 || echo "")
EXT_PART=""
EXT_PART_SIZE=0

# Buscar la partición no-sistema más grande disponible (sin montar y con sistema de archivos de datos)
# Esto maneja el caso del NVMe con Windows (~100GB) + partición de grabaciones (~400GB)
# La lógica toma la más grande para evitar elegir la de Windows o la de EFI
while IFS= read -r line; do
    DEV=$(echo "$line"  | awk '{print $1}')
    SIZE=$(echo "$line" | awk '{print $2}')
    TYPE=$(echo "$line" | awk '{print $4}')
    MOUNT=$(echo "$line" | awk '{print $5}')
    PKNAME=$(lsblk -no PKNAME "/dev/$DEV" 2>/dev/null | head -1)

    [ "$TYPE" != "part" ] && continue
    # Saltar particiones ya montadas en rutas del sistema
    if [ -n "$MOUNT" ]; then
        echo "$MOUNT" | grep -qE '^(/|/boot|/efi|/home|/usr|/var|/opt|/snap)' && continue
    fi
    [[ "$DEV" == loop* || "$DEV" == zram* ]] && continue

    # Obtener sistema de archivos
    FSTYPE=$(blkid -s TYPE -o value "/dev/$DEV" 2>/dev/null || echo "")
    # Solo particiones de datos (excluir EFI, swap, etc.)
    echo "$FSTYPE" | grep -qiE '^(ext4|ext3|ext2|vfat|exfat|ntfs|xfs|btrfs|f2fs)$' || continue

    # Convertir tamaño a bytes para comparar (lsblk devuelve cosas como "400G", "27G")
    SIZE_BYTES=$(lsblk -b -no SIZE "/dev/$DEV" 2>/dev/null | head -1 || echo 0)
    [ -z "$SIZE_BYTES" ] && SIZE_BYTES=0

    if [ "$SIZE_BYTES" -gt "$EXT_PART_SIZE" ]; then
        EXT_PART_SIZE=$SIZE_BYTES
        EXT_PART="/dev/$DEV"
        echo "   Candidato: $EXT_PART ($SIZE, $FSTYPE)"
    fi
done < <(lsblk -o NAME,SIZE,RM,TYPE,MOUNTPOINT -rn 2>/dev/null)

MEDIA_ROOT=""
if [ -n "$EXT_PART" ]; then
    echo "   Seleccionada para grabaciones: $EXT_PART"
    mkdir -p "$MOUNT_POINT"
    if ! mountpoint -q "$MOUNT_POINT"; then
        # Intentar montar; ntfs-3g para particiones NTFS de Windows
        FSTYPE_REAL=$(blkid -s TYPE -o value "$EXT_PART" 2>/dev/null || echo auto)
        if echo "$FSTYPE_REAL" | grep -qi ntfs; then
            mount -t ntfs-3g "$EXT_PART" "$MOUNT_POINT" 2>/dev/null \
                || mount "$EXT_PART" "$MOUNT_POINT" 2>/dev/null \
                && echo "   Montado (NTFS) en $MOUNT_POINT" \
                || echo "   No se pudo montar — configura desde Ajustes del panel web."
        else
            mount "$EXT_PART" "$MOUNT_POINT" 2>/dev/null \
                && echo "   Montado en $MOUNT_POINT" \
                || echo "   No se pudo montar — configura desde Ajustes del panel web."
        fi
    fi
    if mountpoint -q "$MOUNT_POINT"; then
        MEDIA_ROOT="$MOUNT_POINT"
        UUID=$(blkid -s UUID -o value "$EXT_PART" 2>/dev/null || true)
        FSTYPE=$(blkid -s TYPE -o value "$EXT_PART" 2>/dev/null || echo auto)
        if [ -n "$UUID" ] && ! grep -q "$UUID" /etc/fstab; then
            echo "UUID=$UUID  $MOUNT_POINT  $FSTYPE  defaults,nofail  0  2" >> /etc/fstab
            echo "   Montaje permanente añadido a /etc/fstab (UUID=$UUID)"
        fi
    fi
else
    echo "   Sin partición de datos externa detectada — configura desde Ajustes del panel web."
fi

# =============================================================================
#  PASO 8 — Fichero .env
# =============================================================================
echo "📝 8/11 — Configurando variables de entorno..."
if [ ! -f "$APP_DIR/.env" ]; then
    cat > "$APP_DIR/.env" << EOF
PORT=$WEB_PORT
SRT_BASE_PORT=$SRT_PORT
NODE_ENV=production
EOF
else
    grep -q "^NODE_ENV=" "$APP_DIR/.env" || echo "NODE_ENV=production" >> "$APP_DIR/.env"
fi
if [ -n "$MEDIA_ROOT" ] && ! grep -q "^MEDIA_ROOT=" "$APP_DIR/.env"; then
    echo "MEDIA_ROOT=$MEDIA_ROOT" >> "$APP_DIR/.env"
fi

# =============================================================================
#  PASO 9 — Servicio systemd
# =============================================================================
echo "🚀 9/11 — Creando servicio race-control..."
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

# =============================================================================
#  PASO 10 — Plymouth (animación de arranque)
# =============================================================================
echo "🎬 10/11 — Instalando animación de arranque (Plymouth)..."
THEME_DIR="/usr/share/plymouth/themes/racecontrol"
mkdir -p "$THEME_DIR"

# Intentar copiar desde varias rutas posibles
cp -r "$APP_DIR/boot-theme/"* "$THEME_DIR/" 2>/dev/null || \
cp -r /opt/srt-server/boot-theme/*    "$THEME_DIR/" 2>/dev/null || \
cp -r ./boot-theme/*                  "$THEME_DIR/" 2>/dev/null || true
chmod -R 755 "$THEME_DIR"

if [ -f "$THEME_DIR/racecontrol.script" ]; then
    plymouth-set-default-theme -R racecontrol

    # Raspberry Pi — backup + modificar cmdline.txt
    for CMDLINE in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
        [ -f "$CMDLINE" ] || continue
        cp "$CMDLINE" "${CMDLINE}.bak" 2>/dev/null || true
        command -v raspi-config >/dev/null 2>&1 && raspi-config nonint do_boot_splash 0 2>/dev/null || true
        for WORD in "quiet" "splash" "plymouth.ignore-serial-consoles" "vt.global_cursor_default=0"; do
            grep -q "$WORD" "$CMDLINE" || sed -i "s/$/ $WORD/" "$CMDLINE"
        done
    done

    # Ubuntu / i7 con GRUB
    if [ -f "/etc/default/grub" ]; then
        sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="quiet splash plymouth.ignore-serial-consoles vt.global_cursor_default=0"/' /etc/default/grub
        update-grub 2>/dev/null || true
    fi

    # Cargar el driver gráfico i915 al principio del arranque para evitar parpadeos y letras tipo matriz
    if [ -f "/etc/initramfs-tools/modules" ]; then
        if ! grep -q "i915" /etc/initramfs-tools/modules; then
            echo -e "\n# Forzar carga temprana de graficos Intel para Plymouth\ni915" >> /etc/initramfs-tools/modules
        fi
    fi

    update-initramfs -u 2>/dev/null || true
    echo "   Tema Plymouth instalado y initramfs configurado."
else
    echo "   Sin tema Plymouth (carpeta boot-theme no encontrada)."
fi

# =============================================================================
#  PASO 11 — Modo Kiosko (LightDM + Openbox + Chromium)
# =============================================================================
echo "🖥️  11/11 — Configurando modo Kiosko (multi-monitor)..."

# Autologin en LightDM
if [ -f "/etc/lightdm/lightdm.conf" ]; then
    sed -i "s/^#\?autologin-user=.*/autologin-user=$REAL_USER/"         /etc/lightdm/lightdm.conf
    sed -i "s/^#\?autologin-user-timeout=.*/autologin-user-timeout=0/" /etc/lightdm/lightdm.conf
fi
echo -e "[Desktop]\nSession=openbox" > "/var/lib/AccountsService/users/$REAL_USER" 2>/dev/null || true

# Script de kiosko independiente (también puede lanzarse manualmente)
mkdir -p "$REAL_HOME/.config/race-control"
cat > "$REAL_HOME/.config/race-control/launch_kiosk.sh" << 'KIOSK_EOF'
#!/bin/bash
# Ocultar cursor tras 3s de inactividad
unclutter -idle 3 &

# Desactivar salvapantallas y ahorro de energía
xset s noblank
xset s off
xset -dpms

# Fondo de pantalla (transición suave desde Plymouth)
[ -f "/usr/share/plymouth/themes/racecontrol/bg.png" ] && \
    feh --bg-scale /usr/share/plymouth/themes/racecontrol/bg.png

# Limpiar bloqueos de sesiones anteriores
rm -rf /tmp/chromium_kiosk*

# Leer puerto del .env
ENV_PORT=$(grep '^PORT=' /opt/race-control/.env 2>/dev/null | cut -d'=' -f2)
PORT=${ENV_PORT:-3000}

# Esperar al servidor (máx 30s)
echo "Esperando al servidor Race Control en puerto $PORT..."
for i in $(seq 1 15); do
    curl -s "http://localhost:$PORT" > /dev/null && break
    sleep 2
done

# Detectar navegador disponible
# Prioridad: Google Chrome > chromium-browser > chromium
BROWSER=""
# Detectar navegador disponible
# Prioridad: epiphany > google-chrome-stable > google-chrome > chromium-browser > chromium
BROWSER=""
for B in epiphany google-chrome-stable google-chrome chromium-browser chromium; do
    command -v "$B" &>/dev/null && BROWSER="$B" && break
done
[ -z "$BROWSER" ] && BROWSER="epiphany"  # fallback

if [ "$BROWSER" = "epiphany" ]; then
    echo "Iniciando Kiosko con Epiphany (Soporte H.265 Nativo completo)..."
    # Monitor 1 — App Grabador
    epiphany --kiosk "http://localhost:$PORT/grabador?force_transcode=0" &
    
    sleep 5
    
    # Monitor 2 — Solo si hay 2 o más monitores conectados
    NUM_MONITORS=$(xrandr --listactivemonitors 2>/dev/null | head -n 1 | awk '{print $2}')
    if [ "${NUM_MONITORS:-1}" -gt 1 ]; then
        epiphany --kiosk "http://localhost:$PORT/grabador/?monitor=1&force_transcode=0#monitor" &
    fi
else
    echo "Iniciando Kiosko con Chrome/Chromium..."
    # Monitor 1 — App Grabador
    $BROWSER \
        --noerrdialogs --disable-infobars --disable-features=Translate \
        --no-first-run --check-for-update-interval=31536000 \
        --autoplay-policy=no-user-gesture-required \
        --enable-features=VaapiVideoDecoder,VaapiIgnoreDriverChecks \
        --ignore-gpu-blocklist \
        --enable-zero-copy \
        --use-gl=desktop \
        --kiosk --window-position=0,0 \
        --user-data-dir=/tmp/chromium_kiosk \
        "http://localhost:$PORT/grabador?force_transcode=1" &

    sleep 5

    # Monitor 2 — Solo si hay 2 o más monitores conectados
    NUM_MONITORS=$(xrandr --listactivemonitors 2>/dev/null | head -n 1 | awk '{print $2}')
    if [ "${NUM_MONITORS:-1}" -gt 1 ]; then
        $BROWSER \
            --noerrdialogs --disable-infobars --disable-features=Translate \
            --no-first-run --check-for-update-interval=31536000 \
            --autoplay-policy=no-user-gesture-required \
            --enable-features=VaapiVideoDecoder,VaapiIgnoreDriverChecks \
            --ignore-gpu-blocklist \
            --enable-zero-copy \
            --use-gl=desktop \
            --kiosk --window-position=1920,0 \
            --user-data-dir=/tmp/chromium_kiosk \
            "http://localhost:$PORT/grabador/?monitor=1&force_transcode=1#monitor" &
    fi
fi
KIOSK_EOF
chmod +x "$REAL_HOME/.config/race-control/launch_kiosk.sh"

# Openbox autostart
mkdir -p "$REAL_HOME/.config/openbox"
echo "bash $REAL_HOME/.config/race-control/launch_kiosk.sh &" > "$REAL_HOME/.config/openbox/autostart"

# .desktop para GNOME/XFCE/KDE autostart
mkdir -p "$REAL_HOME/.config/autostart"
cat > "$REAL_HOME/.config/autostart/race-control-kiosk.desktop" << EOF
[Desktop Entry]
Type=Application
Name=Race Control Kiosk
Exec=$REAL_HOME/.config/race-control/launch_kiosk.sh
X-GNOME-Autostart-enabled=true
EOF

# LXDE-pi (Raspberry Pi OS clásico con escritorio)
LXDE_CFG="$REAL_HOME/.config/lxsession/LXDE-pi"
if [ -d "$LXDE_CFG" ]; then
    grep -q "launch_kiosk.sh" "$LXDE_CFG/autostart" 2>/dev/null || \
        echo "@bash $REAL_HOME/.config/race-control/launch_kiosk.sh" >> "$LXDE_CFG/autostart"
fi

chown -R "$REAL_USER:$REAL_USER" \
    "$REAL_HOME/.config/race-control" \
    "$REAL_HOME/.config/openbox" \
    "$REAL_HOME/.config/autostart" 2>/dev/null || true

systemctl enable lightdm 2>/dev/null || true

# =============================================================================
#  VERIFICACIÓN FINAL
# =============================================================================
sleep 4
LOCAL_IP=$(hostname -I | awk '{print $1}')

if systemctl is-active --quiet race-control.service; then
    DISK_MSG=""
    [ -n "$MEDIA_ROOT" ] \
        && DISK_MSG="\n - Disco grabación: $MEDIA_ROOT" \
        || DISK_MSG="\n - Sin disco externo (conéctalo y selecciónalo desde Ajustes)"

    whiptail --title "✅ ¡Instalación Completada!" --msgbox \
"Race Control Server instalado y en marcha.

 - Panel Web:  http://$LOCAL_IP:$WEB_PORT$DISK_MSG

Reinicia la máquina para activar el Kiosko y Plymouth.
👉  sudo reboot" 16 65
else
    whiptail --title "⚠️  Advertencia" --msgbox \
"El servidor no arrancó correctamente.
Revisa los logs con:

  sudo journalctl -u race-control.service -n 30 --no-pager" 12 60
fi

clear
echo "✅ ¡Instalación finalizada!"
echo "🔄  Ejecuta 'sudo reboot' para aplicar todos los cambios."

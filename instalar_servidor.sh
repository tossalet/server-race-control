#!/bin/bash
# =============================================================================
#  Race Control Server — Instalador Todo-en-Uno
#  Incluye: servidor, disco externo, Plymouth, Kiosko multi-monitor
#  Uso: sudo bash instalar_servidor.sh
#  Compatible: Raspberry Pi OS (bookworm), Ubuntu 22/24 LTS, Debian 12/13 (Bookworm/Trixie)
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
if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
    REAL_USER="$SUDO_USER"
else
    # Intentar buscar el usuario real con ID 1000, o por carpetas en /home
    REAL_USER=$(id -un 1000 2>/dev/null)
    if [ -z "$REAL_USER" ] || [ "$REAL_USER" = "root" ]; then
        REAL_USER=$(ls /home/ | head -n 1)
    fi
    [ -z "$REAL_USER" ] && REAL_USER="racecontrol"
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
echo "🧹 1/11 — Limpiando servicios antiguos..."
for svc in tsst-srt race-control race-control-kiosk; do
    systemctl stop    "$svc.service" 2>/dev/null || true
    systemctl disable "$svc.service" 2>/dev/null || true
done

# Preservar datos antes de borrar
[ -f "$APP_DIR/.env"                 ] && cp "$APP_DIR/.env"                 /tmp/rc_env_backup
[ -f "$APP_DIR/data/race-control.db" ] && cp "$APP_DIR/data/race-control.db" /tmp/rc_db_backup

# Evitar borrar el directorio completo si ya contiene el código actual (ej: clonado por Git previamente)
if [ -f "$APP_DIR/server.js" ] || [ -f "$APP_DIR/package.json" ]; then
    echo "   Directorio existente detectado. Conservando el código para evitar pérdidas..."
else
    rm -rf "$APP_DIR"
fi

# =============================================================================
#  PASO 2 — Dependencias del sistema
# =============================================================================
# ── Purgar Chrome/Chromium para evitar conflictos ─────────────────────────────
echo "🧹 2.0/11 — Eliminando Chrome/Chromium del sistema..."
for pkg in google-chrome-stable google-chrome-beta google-chrome-unstable \
           chromium chromium-browser chromium-browser-l10n chromium-codecs-ffmpeg; do
    dpkg -l "$pkg" 2>/dev/null | grep -q '^ii' && apt-get purge -y "$pkg" 2>/dev/null || true
done
# Eliminar repos de Google Chrome si existen
rm -f /etc/apt/sources.list.d/google-chrome*.list 2>/dev/null || true
rm -f /etc/apt/trusted.gpg.d/google-chrome*.gpg 2>/dev/null || true
apt-get autoremove -y 2>/dev/null || true
echo "   ✔ Chrome/Chromium eliminados."

# ── Paquetes base comunes ─────────────────────────────────────────────────────
apt-get install -y \
    ffmpeg curl git build-essential rsync \
    ntfs-3g udevil udisks2 \
    plymouth plymouth-themes \
    xserver-xorg openbox lightdm feh \
    unclutter xdotool wmctrl x11-xserver-utils firefox-esr

# Purgar Epiphany Browser para limpiar el sistema y liberar recursos
echo "🌐 2.1/11 — Desinstalando Epiphany Browser..."
apt-get purge -y epiphany-browser epiphany-browser-data 2>/dev/null || true
apt-get autoremove -y 2>/dev/null || true

# ── Establecer Firefox como navegador por defecto ────────────────────────────
echo "🌐 2.2/11 — Configurando Firefox como navegador por defecto..."
if command -v firefox-esr &>/dev/null; then
    su - "$REAL_USER" -c "xdg-settings set default-web-browser firefox-esr.desktop 2>/dev/null" || true
    xdg-settings set default-web-browser firefox-esr.desktop 2>/dev/null || true
    update-alternatives --set x-www-browser /usr/bin/firefox-esr 2>/dev/null || true
    update-alternatives --set gnome-www-browser /usr/bin/firefox-esr 2>/dev/null || true
    echo "   ✔ Firefox configurado como navegador por defecto."
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
    apt-get install -y vainfo intel-media-va-driver 2>/dev/null || \
    apt-get install -y vainfo i965-va-driver         2>/dev/null || true
    echo "   VAAPI: driver Intel instalado"
fi

# ── NVIDIA GPU (aceleración NVENC para transcodificación H.265→H.264) ─────────
if [ "$ARCH" = "x86_64" ]; then
    # Detectar si hay una GPU NVIDIA en el sistema (lspci)
    if lspci 2>/dev/null | grep -qi 'nvidia'; then
        echo "🎮 2.3/11 — GPU NVIDIA detectada. Instalando drivers propietarios..."
        
        # Habilitar repositorios non-free si no están habilitados
        # Debian Trixie (13): sources.list usa 'main non-free-firmware' por defecto
        if grep -q 'main non-free-firmware' /etc/apt/sources.list 2>/dev/null && \
           ! grep -q 'contrib non-free non-free-firmware' /etc/apt/sources.list 2>/dev/null; then
            echo "   Habilitando repositorios contrib + non-free..."
            sed -i 's/main non-free-firmware/main contrib non-free non-free-firmware/g' /etc/apt/sources.list
            apt-get update -qq
        fi
        # Debian Bookworm (12): sources.list usa 'main' por defecto
        if grep -q 'bookworm main$' /etc/apt/sources.list 2>/dev/null; then
            echo "   Habilitando repositorios contrib + non-free (Bookworm)..."
            sed -i 's/bookworm main$/bookworm main contrib non-free non-free-firmware/' /etc/apt/sources.list
            apt-get update -qq
        fi
        # deb822 format (Debian Trixie alternativo)
        if [ -f /etc/apt/sources.list.d/debian.sources ]; then
            if ! grep -q 'non-free' /etc/apt/sources.list.d/debian.sources 2>/dev/null; then
                echo "   Habilitando non-free en debian.sources (deb822)..."
                sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources
                apt-get update -qq
            fi
        fi

        # Instalar headers del kernel + driver NVIDIA
        apt-get install -y linux-headers-$(uname -r) 2>/dev/null || true
        if apt-get install -y nvidia-driver firmware-misc-nonfree 2>/dev/null; then
            echo "   ✔ Driver NVIDIA instalado. NVENC disponible para FFmpeg."
            
            # ── DESBLOQUEAR LÍMITE DE STREAMS (nvidia-patch) ──
            echo "   🔓 Aplicando parche nvidia-patch para eliminar el límite de streams simultáneos de la GPU..."
            # Asegurar dependencias necesarias para descargar y compilar
            apt-get install -y git wget 2>/dev/null || true
            
            # Descargar y aplicar el parche de forma temporal
            TEMP_PATCH_DIR=$(mktemp -d)
            if git clone https://github.com/keylase/nvidia-patch.git "$TEMP_PATCH_DIR" --depth=1 2>/dev/null; then
                # Ejecutar el script parcheador oficial de keylase
                bash "$TEMP_PATCH_DIR/patch.sh" -s || true
                rm -rf "$TEMP_PATCH_DIR"
                echo "   ✔ Límite de codificación simultánea NVENC eliminado con éxito."
            else
                echo "   ⚠️ No se pudo descargar el parche. Se mantendrán las restricciones por defecto de la GPU."
            fi
            
            echo "   ⚠️  Se requiere reinicio para activar el driver NVIDIA y los cambios."
            NVIDIA_INSTALLED=true
        else
            echo "   ⚠️  No se pudo instalar el driver NVIDIA. Transcodificación usará CPU."
            NVIDIA_INSTALLED=false
        fi
    else
        echo "   No se detectó GPU NVIDIA. Transcodificación usará CPU (libx264)."
        NVIDIA_INSTALLED=false
    fi
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

# ── OPTIMIZACIÓN DE RED PARA VIDEO (Evita pixelaciones/macrobloques por pérdida de paquetes UDP) ──
echo "⚡ 4.1/11 — Optimizando buffers de red de Linux (sysctl)..."
cat > /etc/sysctl.d/99-racecontrol-network.conf << EOF
# Incrementar el buffer de recepción y envío máximo del socket a 16MB
net.core.rmem_max=16777216
net.core.wmem_max=16777216
# Incrementar el buffer por defecto a 4MB
net.core.rmem_default=4194304
net.core.wmem_default=4194304
# Cola de recepción del adaptador de red (evita descartes en ráfagas de datos)
net.core.netdev_max_backlog=10000
# Evitar que TCP colisione con el buffer UDP
net.ipv4.udp_rmem_min=16384
EOF
sysctl -p /etc/sysctl.d/99-racecontrol-network.conf 2>/dev/null || true

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
    # Si ya se está ejecutando desde el directorio de destino final, forzar local de forma no-interactiva
    if [ "$SCRIPT_DIR" = "$APP_DIR" ]; then
        USE_LOCAL=true
    elif whiptail --title "Código local detectado" --yesno \
        "Se ha detectado el código del servidor en esta carpeta local ($SCRIPT_DIR).\n\n¿Quieres usar estos archivos locales en lugar de descargar de GitHub?" 10 65; then
        USE_LOCAL=true
    fi
fi

if [ "$USE_LOCAL" = true ]; then
    echo "   Usando archivos locales..."
    # Si ya estamos en la carpeta destino, solo aseguramos directorios y no copiamos sobre nosotros mismos
    if [ "$SCRIPT_DIR" != "$APP_DIR" ]; then
        if command -v rsync &>/dev/null; then
            rsync -a --exclude='node_modules' --exclude='logs' --exclude='media' --exclude='.git' "$SCRIPT_DIR/" "$APP_DIR/" 2>/dev/null
        else
            cp -r "$SCRIPT_DIR/"* "$APP_DIR/" 2>/dev/null || true
            rm -rf "$APP_DIR/node_modules" "$APP_DIR/logs" "$APP_DIR/media" "$APP_DIR/.git"
        fi
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
echo "🎬 10/11 — Configurando animación de arranque (Plymouth)..."
THEME_DIR="/usr/share/plymouth/themes/racecontrol"
mkdir -p "$THEME_DIR"

# Copiar archivos del tema
cp -r "$APP_DIR/boot-theme/"* "$THEME_DIR/" 2>/dev/null || true
chmod -R 755 "$THEME_DIR"

if [ -f "$THEME_DIR/racecontrol.script" ]; then
    plymouth-set-default-theme -R racecontrol 2>/dev/null || true

    # Configuración de GRUB para PC UEFI/BIOS
    if [ -f "/etc/default/grub" ]; then
        # Asegurar quiet splash, loglevel=3 para silenciar VMX/SGX, y blacklist de i915
        sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="quiet splash nvidia-drm.modeset=1 module_blacklist=i915 initcall_blacklist=syscon_init loglevel=3 systemd.show_status=false plymouth.ignore-serial-consoles vt.global_cursor_default=0"/' /etc/default/grub
        update-grub 2>/dev/null || true
    fi

    # Cargar los drivers gráficos de NVIDIA tempranamente para Plymouth en initramfs
    if [ -f "/etc/initramfs-tools/modules" ]; then
        # Eliminar posibles drivers antiguos que entren en conflicto
        sed -i '/i915/d' /etc/initramfs-tools/modules
        sed -i '/nouveau/d' /etc/initramfs-tools/modules
        
        # Añadir drivers propietarios de NVIDIA para KMS temprano
        for mod in nvidia nvidia_modeset nvidia_uvm nvidia_drm; do
            grep -q "$mod" /etc/initramfs-tools/modules || echo "$mod" >> /etc/initramfs-tools/modules
        done
    fi

    # Evitar que systemd y los display managers detengan Plymouth de forma automática.
    # Enmascaramos físicamente los servicios apuntándolos a /dev/null
    systemctl stop plymouth-quit.service 2>/dev/null || true
    systemctl disable plymouth-quit.service 2>/dev/null || true
    systemctl mask plymouth-quit.service 2>/dev/null || true
    
    systemctl stop plymouth-quit-active.service 2>/dev/null || true
    systemctl disable plymouth-quit-active.service 2>/dev/null || true
    systemctl mask plymouth-quit-active.service 2>/dev/null || true
    
    # Sobreescribir las directivas de conflictos de systemd para que LightDM no dependa de quit-plymouth
    mkdir -p /etc/systemd/system/lightdm.service.d
    cat > /etc/systemd/system/lightdm.service.d/override.conf << EOF
[Unit]
Conflicts=
Conflicts=shutdown.target
EOF
    systemctl daemon-reload 2>/dev/null || true

    # Permitir al usuario kiosk apagar Plymouth al abrir el navegador
    echo "$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/plymouth" > /etc/sudoers.d/racecontrol-plymouth
    chmod 440 /etc/sudoers.d/racecontrol-plymouth

    # Copiar la imagen de fondo bg.png a la carpeta public de la app
    # Esto asegura que el splash.html tenga acceso al fondo nativo de inmediato
    if [ -f "$APP_DIR/boot-theme/bg.png" ]; then
        cp "$APP_DIR/boot-theme/bg.png" "$APP_DIR/public/bg.png"
        chmod 644 "$APP_DIR/public/bg.png"
    fi

    update-initramfs -u 2>/dev/null || true
    echo "   ✔ Animación Plymouth configurada (Drivers KMS NVIDIA cargados en Initramfs)."
else
    echo "   ⚠️  Sin tema Plymouth (directorio boot-theme no encontrado o vacío)."
fi

# =============================================================================
#  PASO 11 — Modo Kiosko (LightDM + Openbox + Chromium)
# =============================================================================
echo "🖥️  11/11 — Configurando modo Kiosko (multi-monitor)..."

# Autologin en LightDM
if [ -f "/etc/lightdm/lightdm.conf" ]; then
    sed -i "s/^#\?autologin-user=.*/autologin-user=$REAL_USER/"         /etc/lightdm/lightdm.conf
    sed -i "s/^#\?autologin-user-timeout=.*/autologin-user-timeout=0/" /etc/lightdm/lightdm.conf
    # Evitar que LightDM mate a Plymouth de forma anticipada
    if ! grep -q "plymouth-left-active" /etc/lightdm/lightdm.conf; then
        sed -i 's/\[LightDM\]/\[LightDM\]\nplymouth-left-active=true/' /etc/lightdm/lightdm.conf
    else
        sed -i 's/^#\?plymouth-left-active=.*/plymouth-left-active=true/' /etc/lightdm/lightdm.conf
    fi
fi
mkdir -p /var/lib/AccountsService/users
echo -e "[Desktop]\nSession=openbox" > "/var/lib/AccountsService/users/$REAL_USER" 2>/dev/null || true

# Script de kiosko independiente (también puede lanzarse manualmente)
mkdir -p "$REAL_HOME/.config/race-control"
cat > "$REAL_HOME/.config/race-control/launch_kiosk.sh" << 'KIOSK_EOF'
#!/bin/bash
# Redirigir toda la salida a un archivo de log para facilitar el diagnóstico
exec > /tmp/kiosk.log 2>&1
echo "=== Kiosk Launch at $(date) ==="

# Cargar el mapa de teclado X11 estándar de forma explícita
# Esto previene que xdotool no encuentre o ignore la asignación de F11 física
setxkbmap es 2>/dev/null || setxkbmap us 2>/dev/null || true

# Ocultar cursor tras 3s de inactividad
unclutter -idle 3 &

# Desactivar salvapantallas y ahorro de energía
xset s noblank
xset s off
xset -dpms

# Fondo de pantalla (detrás de las ventanas)
if [ -f "/usr/share/plymouth/themes/racecontrol/bg.png" ]; then
    feh --bg-scale /usr/share/plymouth/themes/racecontrol/bg.png
fi

# Leer puerto del .env
ENV_PORT=$(grep '^PORT=' /opt/race-control/.env 2>/dev/null | cut -d'=' -f2)
PORT=${ENV_PORT:-3000}

# Escribir el puerto en config.js dinámicamente para que el splash sepa a dónde redirigir
echo "window.KIOSK_CONFIG = { port: '$PORT' };" > /opt/race-control/public/config.js

# Apagar Plymouth de inmediato porque el navegador va a pintar su propio splash idéntico
if command -v plymouth &>/dev/null; then
    sudo plymouth quit 2>/dev/null || true
fi

# Forzar a nivel de GSettings que Epiphany se inicie maximizado y sin barras
# Esto se ejecuta directamente en la sesión gráfica activa
gsettings set org.gnome.Epiphany.state window-maximized true 2>/dev/null || true
gsettings set org.gnome.Epiphany.ui keep-present-bars false 2>/dev/null || true
gsettings set org.gnome.Epiphany.ui navbar-visible false 2>/dev/null || true
gsettings set org.gnome.Epiphany.ui expand-tabs-bar false 2>/dev/null || true
gsettings set org.gnome.Epiphany.ui tabs-bar-visibility-policy 'never' 2>/dev/null || true

# Obtener resolución de pantalla para forzar geometría
SCREEN_RES=$(xdpyinfo 2>/dev/null | grep dimensions | awk '{print $2}')
SCREEN_W=$(echo "$SCREEN_RES" | cut -d'x' -f1)
SCREEN_H=$(echo "$SCREEN_RES" | cut -d'x' -f2)

# Abrir Firefox ESR en modo Kiosko nativo (oculta al 100% barras de direcciones y marcos por diseño)
# Asignamos la clase "racecontrolgrabador" para que Openbox la posicione en el Monitor 1
firefox-esr --class racecontrolgrabador --kiosk "file:///opt/race-control/public/splash.html" &
FIREFOX_PID=$!

# Esperar a que la ventana de Firefox aparezca (xdotool --sync)
echo "Esperando a que la ventana de Firefox aparezca (xdotool --sync)..."
WID=$(xdotool search --sync --onlyvisible --class "firefox" 2>/dev/null | head -n 1)

if [ -z "$WID" ]; then
    for i in $(seq 1 30); do
        WID=$(xdotool search --name "Mozilla" 2>/dev/null | head -n 1 \
           || xdotool search --name "Race" 2>/dev/null | head -n 1 \
           || xdotool search --class "firefox" 2>/dev/null | head -n 1)
        [ -n "$WID" ] && break
        sleep 1
    done
fi

if [ -n "$WID" ]; then
    echo "Ventana encontrada: $WID. Asegurando foco..."
    xdotool windowactivate "$WID" 2>/dev/null
    xdotool windowfocus "$WID" 2>/dev/null
else
    echo "ERROR: No se encontró la ventana del navegador."
fi

echo "=== Kiosk setup finalizado a $(date) ==="
KIOSK_EOF
chmod +x "$REAL_HOME/.config/race-control/launch_kiosk.sh"

# ── Openbox: autostart ──
mkdir -p "$REAL_HOME/.config/openbox"
echo "bash $REAL_HOME/.config/race-control/launch_kiosk.sh &" > "$REAL_HOME/.config/openbox/autostart"

# ── Openbox: rc.xml con regla de fullscreen ──
# Forzar a nivel de Openbox que el navegador Epiphany y Firefox se dibujen sin decoraciones (bordes) 
# y se posicionen en sus respectivos monitores de forma nativa.
if [ -f /etc/xdg/openbox/rc.xml ]; then
    cp /etc/xdg/openbox/rc.xml "$REAL_HOME/.config/openbox/rc.xml"
    
    # Limpiar reglas antiguas de racecontrol si las hubiera
    sed -i '/racecontrolgrabador/d; /racecontrolmonitor/d; /class="racecontrolgrabador"/,/<\/application>/d; /class="racecontrolmonitor"/,/<\/application>/d' "$REAL_HOME/.config/openbox/rc.xml"
    
    # Inyección segura usando awk antes de </applications>
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
        print "        <x>-1920</x>"
        print "        <y>0</y>"
        print "      </position>"
        print "    </application>"
    }
    { print }
    ' "$REAL_HOME/.config/openbox/rc.xml" > "$tmpfile"
    mv "$tmpfile" "$REAL_HOME/.config/openbox/rc.xml"
else
    # Crear rc.xml mínimo con las reglas nativas multi-pantalla
    cat > "$REAL_HOME/.config/openbox/rc.xml" << 'XML_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc" xmlns:xi="http://www.w3.org/2001/XInclude">
  <resistance><strength>10</strength><screen_edge_strength>20</screen_edge_strength></resistance>
  <focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus>
  <theme><name>Clearlooks</name></theme>
  <desktops><number>1</number></desktops>
  <keyboard/>
  <mouse/>
  <applications>
    <application class="racecontrolgrabador">
      <decor>no</decor>
      <fullscreen>yes</fullscreen>
      <maximized>true</maximized>
      <position force="yes">
        <x>0</x>
        <y>0</y>
      </position>
    </application>
    <application class="racecontrolmonitor">
      <decor>no</decor>
      <fullscreen>yes</fullscreen>
      <maximized>true</maximized>
      <position force="yes">
        <x>-1920</x>
        <y>0</y>
      </position>
    </application>
  </applications>
</openbox_config>
XML_EOF
fi

# ── .desktop para GNOME/XFCE/KDE autostart ──
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
    "$REAL_HOME/.config/autostart" \
    "$APP_DIR" 2>/dev/null || true

# Asegurar permisos de lectura y ejecucion correctos para toda la aplicacion en /opt/race-control
chmod -R 755 "$APP_DIR"

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

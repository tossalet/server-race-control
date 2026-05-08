#!/bin/bash

# Comprobar root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Error: Por favor, ejecuta este instalador con permisos de administrador."
  echo "👉 Usa el comando: sudo bash instalar_splash.sh"
  exit
fi

echo "📦 Instalando motor de animaciones Plymouth..."
apt-get update -qq
apt-get install -y plymouth plymouth-themes

echo "📂 Creando e instalando el tema de Race Control..."
THEME_DIR="/usr/share/plymouth/themes/racecontrol"
mkdir -p "$THEME_DIR"

# Copiar los archivos desde la carpeta del repositorio
cp -r /opt/race-control/boot-theme/* "$THEME_DIR/" 2>/dev/null || cp -r /opt/srt-server/boot-theme/* "$THEME_DIR/" 2>/dev/null || cp -r ./boot-theme/* "$THEME_DIR/"

# Dar permisos
chmod -R 755 "$THEME_DIR"

echo "⚙️ Configurando el tema como predeterminado..."
plymouth-set-default-theme -R racecontrol

echo "🚀 Modificando el arranque de Linux para ocultar las letras..."
# Backup del archivo original
cp /boot/cmdline.txt /boot/cmdline.txt.bak 2>/dev/null
cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak 2>/dev/null

# Intentar modificar cmdline.txt en Raspberry Pi OS
CMDLINE_PATH="/boot/firmware/cmdline.txt"
if [ ! -f "$CMDLINE_PATH" ]; then
    CMDLINE_PATH="/boot/cmdline.txt"
fi

if [ -f "$CMDLINE_PATH" ]; then
    # Añadir quiet y splash si no existen
    if ! grep -q "splash" "$CMDLINE_PATH"; then
        sed -i 's/$/ quiet splash/' "$CMDLINE_PATH"
    fi
fi

# Intentar modificar GRUB para Ubuntu/Debian i7
if [ -f "/etc/default/grub" ]; then
    sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"/' /etc/default/grub
    update-grub 2>/dev/null
fi

echo "✅ ¡Animación de arranque instalada con éxito!"
echo "La próxima vez que reinicies el servidor, verás la animación de Race Control en lugar del texto."

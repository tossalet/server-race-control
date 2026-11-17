#!/bin/bash
# =============================================================================
#  Race Control — Tema Plymouth también al apagar / reiniciar
# =============================================================================
#  Lo llaman instalar_servidor.sh y actualizar.sh (como root).
#  Al reiniciar salía el texto de systemd ("Stopping…", "[ OK ] Stopped…") en vez del tema:
#   1. Silencia los mensajes de estado de systemd y del kernel aunque falte el parámetro en
#      GRUB (systemd.show_status=false solo actúa si la línea de GRUB se aplicó).
#   2. Antes de lanzar el splash de apagado cierra cualquier plymouthd que siga vivo desde
#      el arranque: ese proceso perdió la pantalla al arrancar X y, si sigue ahí, el
#      plymouthd nuevo de apagado no llega a pintar.
#   3. Copia el tema actualizado al sistema.
# =============================================================================

APP_DIR="${APP_DIR:-/opt/race-control}"
THEME_DIR="/usr/share/plymouth/themes/racecontrol"

command -v plymouth &>/dev/null || { echo "   ⚠️  Plymouth no instalado: se omite el tema de apagado."; exit 0; }

# ── Tema ─────────────────────────────────────────────────────────────────────
THEME_CHANGED=0
if [ -d "$APP_DIR/boot-theme" ]; then
    mkdir -p "$THEME_DIR"
    for f in racecontrol.script racecontrol.plymouth bg.png box.png; do
        [ -f "$APP_DIR/boot-theme/$f" ] || continue
        cmp -s "$APP_DIR/boot-theme/$f" "$THEME_DIR/$f" || THEME_CHANGED=1
    done
    cp -r "$APP_DIR/boot-theme/"* "$THEME_DIR/" 2>/dev/null || true
    chmod -R 755 "$THEME_DIR"
fi
CURRENT_THEME=$(plymouth-set-default-theme 2>/dev/null)
if [ -f "$THEME_DIR/racecontrol.script" ]; then
    if [ "$CURRENT_THEME" != "racecontrol" ]; then
        plymouth-set-default-theme -R racecontrol 2>/dev/null || true
    elif [ $THEME_CHANGED = 1 ]; then
        # El tema del arranque va dentro del initramfs: regenerarlo si cambió
        update-initramfs -u 2>/dev/null || true
    fi
fi

# ── Servicios de splash de apagado (los del sistema) ─────────────────────────
for svc in plymouth-reboot plymouth-poweroff plymouth-halt plymouth-kexec; do
    [ -f "/lib/systemd/system/$svc.service" ] || [ -f "/usr/lib/systemd/system/$svc.service" ] || continue
    systemctl unmask "$svc.service" 2>/dev/null || true
    mkdir -p "/etc/systemd/system/$svc.service.d"
    cat > "/etc/systemd/system/$svc.service.d/racecontrol.conf" << 'EOF'
[Service]
# Un plymouthd del arranque que siga vivo ya no tiene la pantalla: cerrarlo para que el
# de apagado arranque limpio y pinte el tema.
ExecStartPre=-/bin/sh -c '/usr/bin/plymouth --ping && /usr/bin/plymouth quit; exit 0'
EOF
done

# ── Silencio en consola durante el apagado ───────────────────────────────────
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/racecontrol-silencio.conf << 'EOF'
[Manager]
ShowStatus=no
EOF

# Debian sube el nivel de mensajes del kernel en consola (10-console-messages.conf = 4).
# Lo dejamos en 3 (solo errores críticos), igual que loglevel=3 del GRUB.
echo "kernel.printk = 3 4 1 3" > /etc/sysctl.d/90-racecontrol-consola.conf
sysctl -q -p /etc/sysctl.d/90-racecontrol-consola.conf 2>/dev/null || true

# Asegurar los parámetros de GRUB si faltan (sin pisar el resto de la línea)
if [ -f /etc/default/grub ]; then
    CHANGED=0
    for p in quiet splash loglevel=3 systemd.show_status=false vt.global_cursor_default=0; do
        if ! grep -E '^GRUB_CMDLINE_LINUX_DEFAULT=' /etc/default/grub | grep -qw -- "$p"; then
            sed -i "s/^GRUB_CMDLINE_LINUX_DEFAULT=\"\(.*\)\"/GRUB_CMDLINE_LINUX_DEFAULT=\"\1 $p\"/" /etc/default/grub
            CHANGED=1
        fi
    done
    [ $CHANGED = 1 ] && update-grub 2>/dev/null || true
fi

systemctl daemon-reload 2>/dev/null || true
echo "   ✔ Tema Plymouth activado también para apagar y reiniciar."

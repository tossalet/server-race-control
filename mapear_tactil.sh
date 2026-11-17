#!/bin/bash
# =============================================================================
#  Race Control — Pantalla táctil solo en el monitor del panel (monitor 1)
# =============================================================================
#  Con dos monitores, X reparte la táctil por todo el escritorio: el dedo mueve el
#  puntero por las dos pantallas y los toques caen desplazados. Esto la limita a la
#  pantalla del panel.
#
#  Lo lanza el kiosko al arrancar y lo repite cada 30 s (un reenganche del USB de la
#  táctil o un cambio de pantallas borra el mapeo). Para aplicarlo a mano:
#      sudo -u racecontrol DISPLAY=:0 bash /opt/race-control/mapear_tactil.sh
#
#  Pantalla: TOUCH_OUTPUT en /opt/race-control/.env (p. ej. TOUCH_OUTPUT=HDMI-0); si no,
#  la que está en la posición 0,0 (donde Openbox coloca el panel); si no, la principal.
#  --quiet: solo escribe si cambia algo (para la repetición periódica).
# =============================================================================

export DISPLAY="${DISPLAY:-:0}"
if [ -z "$XAUTHORITY" ] && [ -f "$HOME/.Xauthority" ]; then export XAUTHORITY="$HOME/.Xauthority"; fi

QUIET=0
[ "$1" = "--quiet" ] && QUIET=1
STATE_FILE="/tmp/race-control-touch.state"
say() { echo "[$(date '+%F %T')] [TÁCTIL] $*"; }

XRANDR=$(xrandr --query 2>/dev/null)
OUT=$(grep '^TOUCH_OUTPUT=' /opt/race-control/.env 2>/dev/null | cut -d'=' -f2 | tr -d '\r" ')
[ -z "$OUT" ] && OUT=$(echo "$XRANDR" | awk '/ connected/ && /[0-9]+x[0-9]+\+0\+0/ {print $1; exit}')
[ -z "$OUT" ] && OUT=$(echo "$XRANDR" | awk '/ connected primary/ {print $1; exit}')
[ -z "$OUT" ] && OUT=HDMI-0

# Táctiles: punteros con matriz de calibración de libinput (solo la tienen las pantallas
# táctiles y las tabletas) o con "touch" en el nombre. Antes se buscaba solo por nombre.
IDS=""
NAMES=""
for id in $(xinput list --short 2>/dev/null | grep -i 'slave \+pointer' | grep -oP 'id=\K[0-9]+'); do
    name=$(xinput list --name-only "$id" 2>/dev/null)
    if xinput list-props "$id" 2>/dev/null | grep -q 'libinput Calibration Matrix' || echo "$name" | grep -qi 'touch'; then
        IDS="$IDS $id"
        NAMES="$NAMES [$id] $name;"
    fi
done
IDS="${IDS# }"

if [ -z "$IDS" ]; then
    if [ $QUIET = 0 ] || [ "$(cat "$STATE_FILE" 2>/dev/null)" != "none" ]; then
        say "No se encuentra ninguna pantalla táctil. Punteros conectados:"
        xinput list --short 2>/dev/null | grep -i 'slave \+pointer' | sed 's/^/    /'
    fi
    echo "none" > "$STATE_FILE"
    exit 1
fi

if ! echo "$XRANDR" | grep -q "^$OUT connected"; then
    say "⚠️ La pantalla $OUT no está conectada. Pantallas: $(echo "$XRANDR" | awk '/ connected/ {printf "%s ", $1}')"
    say "   Fija la correcta con TOUCH_OUTPUT=<nombre> en /opt/race-control/.env"
    exit 1
fi

FAILED=0
for id in $IDS; do
    xinput map-to-output "$id" "$OUT" 2>/dev/null || { FAILED=1; say "⚠️ No se pudo mapear el dispositivo $id a $OUT"; }
done

STATE="$OUT $IDS"
if [ $QUIET = 0 ] || [ "$(cat "$STATE_FILE" 2>/dev/null)" != "$STATE" ]; then
    say "Pantalla táctil →$NAMES limitada a $OUT"
fi
echo "$STATE" > "$STATE_FILE"
exit $FAILED

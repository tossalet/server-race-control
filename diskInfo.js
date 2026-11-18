/* =============================================================================
 *  Información de los discos de grabación
 * =============================================================================
 *  Tipo real de cada disco (USB o interno) según cómo está conectado, espacio libre y nivel
 *  de aviso para el panel. Antes se deducía del nombre: todo "sdX" salía como USB, también
 *  un disco SATA montado dentro del equipo.
 * ========================================================================== */
const { execFile } = require('child_process');

const DISK_LOW_GB = 50;       // aviso naranja
const DISK_CRITICAL_GB = 10;  // aviso rojo
const DISK_FULL_GB = 1;       // ya no se puede grabar
const COMMAND_TIMEOUT_MS = 2500;

function diskLevel(freeGB) {
    if (freeGB === null || freeGB === undefined || Number.isNaN(Number(freeGB))) return 'ok';
    const free = Number(freeGB);
    if (free < DISK_FULL_GB) return 'full';
    if (free < DISK_CRITICAL_GB) return 'critical';
    if (free < DISK_LOW_GB) return 'low';
    return 'ok';
}

const isTrue = (v) => v === true || v === 1 || v === '1';

function describeDevice(dev, parent) {
    const tran = String(dev.tran || (parent && parent.tran) || '').toLowerCase();
    const removable = isTrue(dev.rm) || isTrue(parent && parent.rm);
    const rotational = isTrue(dev.rota) || isTrue(parent && parent.rota);
    const model = String(dev.model || (parent && parent.model) || '').trim();
    const name = String(dev.name || '');

    let kind = 'unknown', typeLabel = 'Disco';
    if (tran === 'usb' || removable) {
        kind = 'usb';
        typeLabel = 'USB externo';
    } else if (tran === 'nvme' || name.startsWith('nvme')) {
        kind = 'internal';
        typeLabel = 'Interno NVMe';
    } else if (tran === 'sata' || tran === 'ata') {
        kind = 'internal';
        typeLabel = `Interno SATA ${rotational ? 'HDD' : 'SSD'}`;
    }
    return { kind, typeLabel, model, volumeLabel: String(dev.label || '').trim() };
}

// Salida de `lsblk -J` → Map de "/dev/xxx" a su descripción (las particiones heredan del disco)
function parseLsblk(data) {
    const out = new Map();
    const walk = (dev, parent) => {
        if (dev.path) out.set(dev.path, describeDevice(dev, parent));
        const inherited = parent ? { ...parent, ...stripEmpty(dev) } : dev;
        for (const child of dev.children || []) walk(child, inherited);
    };
    for (const dev of (data && data.blockdevices) || []) walk(dev, null);
    return out;
}

function stripEmpty(obj) {
    const out = {};
    for (const k of Object.keys(obj)) if (obj[k] !== null && obj[k] !== undefined && obj[k] !== '') out[k] = obj[k];
    return out;
}

// Respuesta garantizada aunque el comando se quede colgado en un disco muerto
function runCommand(cmd, args) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), COMMAND_TIMEOUT_MS);
        execFile(cmd, args, { timeout: COMMAND_TIMEOUT_MS }, (err, stdout) => {
            clearTimeout(timer);
            resolve(err ? null : stdout);
        });
    });
}

async function readDiskTypes() {
    const stdout = await runCommand('lsblk', ['-J', '-b', '-o', 'NAME,PATH,LABEL,TRAN,RM,ROTA,MODEL']);
    if (!stdout) return new Map();
    try { return parseLsblk(JSON.parse(stdout)); } catch (e) { return new Map(); }
}

async function readDiskSpace(mountPoint) {
    const stdout = await runCommand('df', ['-B1', '--output=size,avail', mountPoint]);
    const line = stdout ? stdout.trim().split('\n')[1] : null;
    const [size, avail] = line ? line.trim().split(/\s+/).map(Number) : [];
    if (!Number.isFinite(size) || !Number.isFinite(avail)) return { sizeGB: null, freeGB: null };
    return { sizeGB: (size / 1e9).toFixed(0), freeGB: (avail / 1e9).toFixed(1) };
}

module.exports = { diskLevel, parseLsblk, readDiskTypes, readDiskSpace, DISK_LOW_GB, DISK_CRITICAL_GB, DISK_FULL_GB };

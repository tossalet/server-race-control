require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const db = require('./db');
const streamManager = require('./streamManager');
const sysMonitor = require('./sysMonitor');
const si = require('systeminformation');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
streamManager.setIo(io);
sysMonitor.setIo(io);

const { WebSocketServer } = require('ws');
// WSS comparte el servidor HTTP (puerto 4000) — sin puerto extra que pueda colisionar
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
    const match = req.url.match(/\/live\/(\d+)/);
    if (!match) return ws.close();
    
    const channel = match[1];
    
    let attempts = 0;
    const checkInterval = setInterval(() => {
        if (streamManager.activeInputs[channel] && streamManager.activeInputs[channel].router && streamManager.activeInputs[channel].router.port) {
            clearInterval(checkInterval);
            const net = require('net');
            const localPort = streamManager.activeInputs[channel].router.port;
            
            const tcpSocket = net.createConnection(localPort, '127.0.0.1', () => {
                console.log(`[WS] Client subscribed to LIVE channel ${channel} via TCP ${localPort}`);
                streamManager.activeInputs[channel].router.subscribers.add(tcpSocket);
            });

            tcpSocket.on('data', (data) => {
                if (ws.readyState === ws.OPEN) {
                    ws.send(data);
                }
            });

            tcpSocket.on('error', (err) => {
                console.log(`[WS] TCP Socket error for live channel ${channel}: ${err.message}`);
            });

            tcpSocket.on('close', () => ws.close());
            ws.on('close', () => {
                if (streamManager.activeInputs[channel] && streamManager.activeInputs[channel].router) {
                    streamManager.activeInputs[channel].router.subscribers.delete(tcpSocket);
                }
                tcpSocket.destroy();
                console.log(`[WS] Client unsubscribed from LIVE channel ${channel}`);
            });
        } else {
            attempts++;
            if (attempts > 20) { // 10 seconds max wait
                clearInterval(checkInterval);
                console.log(`[WS] Rejecting connection to /live/${channel}: Router not active after 10s.`);
                ws.close();
            }
        }
    }, 500);
});

const util = require('util');

// Custom System Logger
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch (e) {}
}
const logFile = path.join(logsDir, 'server.log');

const logHistory = [];
function getTimestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function broadCastLog(level, message) {
    const logEntry = { timestamp: getTimestamp(), level, message };
    if (io) io.emit('server_log', logEntry);
    logHistory.push(logEntry);
    if (logHistory.length > 500) logHistory.shift(); // Keep last 500 lines in memory
    fs.appendFile(logFile, `[${logEntry.timestamp}] [${level}] ${message}\n`, () => {});
}

// Intercept Console
const originalLog = console.log;
console.log = function(...args) {
    const msg = util.format(...args);
    originalLog.apply(console, args);
    broadCastLog('INFO', msg);
};

const originalError = console.error;
console.error = function(...args) {
    const msg = util.format(...args);
    originalError.apply(console, args);
    broadCastLog('ERROR', msg);
};

// ── Preview Root: archivos HLS temporales en disco del sistema ─────────────
const previewRoot = process.platform === 'win32'
    ? path.join(__dirname, 'public', 'preview')
    : '/tmp/race-control-preview';
if (!fs.existsSync(previewRoot)) {
    try { fs.mkdirSync(previewRoot, { recursive: true }); } catch (e) {}
}

// ── Media Root: grabaciones en disco externo / NVMe ──────────────────────────
// Prioridad: 1) MEDIA_ROOT del .env  2) Auto-detect por /proc/mounts  3) null (bloqueado)
function detectExternalDisk() {
    if (process.env.MEDIA_ROOT) return process.env.MEDIA_ROOT;
    if (process.platform === 'win32') return path.join(__dirname, 'media');

    // Linux: leer /proc/mounts es lo más fiable — captura todos los mount points
    // sin importar si el distro usa /media/pi, /media/racecontrol, /run/media, /mnt…
    const SKIP_FS   = new Set(['tmpfs','devtmpfs','sysfs','proc','devpts','cgroup',
                                'cgroup2','overlay','squashfs','udev','securityfs',
                                'fusectl','pstore','efivarfs','debugfs','tracefs',
                                'hugetlbfs','mqueue','ramfs','bpf','configfs']);
    const SKIP_PFX  = ['/', '/boot', '/sys', '/proc', '/dev', '/run/user',
                       '/run/lock', '/run/systemd', '/run/credentials',
                       '/snap', '/usr', '/var', '/opt', '/etc', '/home'];

    try {
        const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
        for (const line of mounts) {
            const [device, mountPoint, fsType] = line.split(' ');
            if (!device || !mountPoint || !fsType) continue;
            if (SKIP_FS.has(fsType))  continue;
            if (!device.startsWith('/dev/')) continue;
            // Sólo particiones de datos (ext4, vfat, ntfs, exfat, xfs, btrfs…)
            if (!['ext4','ext3','ext2','vfat','exfat','ntfs','xfs','btrfs','f2fs'].includes(fsType)) continue;
            // Ignorar rutas del sistema
            if (SKIP_PFX.some(p => mountPoint === p || mountPoint.startsWith(p + '/'))) continue;
            // Aceptar cualquier punto externo: /media/*, /mnt/*, /run/media/*
            if (/^\/(media|mnt|run\/media)/.test(mountPoint) && fs.existsSync(mountPoint))
                return mountPoint;
        }
    } catch(e) { console.error('[STORAGE] /proc/mounts read error:', e.message); }

    return null;
}

// El disco de grabacion se inicializa a null; initMediaRoot() lo asigna desde DB o auto-detect
let mediaRoot = null;
let recordingDisabled = false;

// Helper para registrar el middleware de disco de grabaciones en Express
function registerMediaStatic(rootPath) {
    app.use('/media', express.static(rootPath, {
        setHeaders: (res, fp) => {
            if (fp.endsWith('.m3u8')) {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
            }
        }
    }));
}

// Inicializar disco: 1) Disco guardado en DB  2) Auto-detect  3) null
function initMediaRoot() {
    db.get("SELECT value FROM settings WHERE key = 'recording_disk'", (err, row) => {
        if (row && row.value === 'disabled') {
            mediaRoot = null;
            recordingDisabled = true;
            console.log(`[STORAGE] Disco de grabación desactivado por el usuario.`);
        } else if (row && row.value && fs.existsSync(row.value)) {
            mediaRoot = row.value;
            recordingDisabled = false;
            registerMediaStatic(mediaRoot);
            console.log(`[STORAGE] Disco cargado desde DB: ${mediaRoot}`);
        } else {
            // Fallback a auto-detect
            const detected = detectExternalDisk();
            if (detected) {
                const recDir = path.join(detected, 'recordings');
                try { fs.mkdirSync(recDir, { recursive: true }); } catch(e) {}
                mediaRoot = recDir;
                recordingDisabled = false;
                registerMediaStatic(mediaRoot);
                console.log(`[STORAGE] Disco detectado: ${mediaRoot}`);
            } else {
                console.log('[STORAGE] AVISO: No hay disco externo. Grabacion bloqueada hasta conectar uno.');
            }
        }
    });
}
initMediaRoot();


const thumbsDir = path.join(__dirname, 'public', 'thumbs');
if (!fs.existsSync(thumbsDir)) {
    try { fs.mkdirSync(thumbsDir, { recursive: true }); } catch(e){}
}
const thumbCache = {};      // channel -> Buffer (último JPEG válido)
const thumbCacheTs = {};     // channel -> timestamp de cuándo se cacheó
app.get('/thumbs/:filename', (req, res, next) => {
    const filename = req.params.filename;
    const match = filename.match(/^thumb_(\d+)\.jpg$/);
    if (!match) {
        return next();
    }
    const channel = parseInt(match[1]);
    const filePath = path.join(__dirname, 'public', 'thumbs', filename);

    // Comprobar si el canal está realmente online y activo (criterio idéntico al panel de control)
    const routerState = streamManager.activeInputs[channel];
    const isOnline = !!(routerState && !routerState.isStopping);

    const serveFallback = () => {
        const fallbackPath = path.join(__dirname, 'public', 'images', 'bars.svg');
        fs.readFile(fallbackPath, (err2, fallbackData) => {
            if (!err2) {
                res.setHeader('Content-Type', 'image/svg+xml');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                return res.status(404).send(fallbackData);
            }
            return res.status(404).send('Not found');
        });
    };

    if (!isOnline) {
        // Gracia: si hay caché reciente (< 30s), servirla aunque el canal esté offline
        // Esto cubre reinicios de ffmpeg durante REC/STOP y auto-restart (10s)
        if (thumbCache[channel]) {
            const cacheAge = Date.now() - (thumbCacheTs[channel] || 0);
            if (cacheAge < 30000) {
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                return res.send(thumbCache[channel]);
            }
            // Caché expirada → limpiar y servir barras
            delete thumbCache[channel];
            delete thumbCacheTs[channel];
        }
        fs.unlink(filePath, () => {});
        return serveFallback();
    }
    
    fs.readFile(filePath, (err, data) => {
        if (err) {
            // Archivo no disponible — intentar servir desde caché si es reciente
            if (thumbCache[channel]) {
                const cacheAge = Date.now() - (thumbCacheTs[channel] || 0);
                if (cacheAge > 30000) {
                    // Caché demasiado vieja (>30s) → servir barras para evitar frames obsoletos
                    delete thumbCache[channel];
                    delete thumbCacheTs[channel];
                    return serveFallback();
                }
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                return res.send(thumbCache[channel]);
            }
            return serveFallback();
        }
        
        // Verificar si es un JPEG válido:
        // - Debe empezar con SOI (0xFFD8) y terminar con EOI (0xFFD9)
        // - Tamaño mínimo 1KB (frames de transición de señal son más pequeños)
        // - Scan más amplio (512 bytes) para encontrar EOI de forma fiable
        let isValidJpeg = false;
        if (data.length > 1000) {
            const hasStart = data[0] === 0xFF && data[1] === 0xD8;
            if (hasStart) {
                const limit = Math.max(0, data.length - 512);
                for (let i = data.length - 2; i >= limit; i--) {
                    if (data[i] === 0xFF && data[i+1] === 0xD9) {
                        isValidJpeg = true;
                        break;
                    }
                }
            }
        }
        
        if (isValidJpeg) {
            thumbCache[channel] = data;
            thumbCacheTs[channel] = Date.now();
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return res.send(data);
        } else {
            // Si está incompleto o a medio escribir por FFmpeg, servimos el último válido de la caché
            if (thumbCache[channel]) {
                const cacheAge = Date.now() - (thumbCacheTs[channel] || 0);
                if (cacheAge > 30000) {
                    delete thumbCache[channel];
                    delete thumbCacheTs[channel];
                    return serveFallback();
                }
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                return res.send(thumbCache[channel]);
            }
            return serveFallback();
        }
    });
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// NOTA: /media se registra dinámicamente desde registerMediaStatic() al inicializar
// o al seleccionar un disco en /api/storage/select. No hay bloque estático aquí.
app.use('/preview', express.static(previewRoot, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.m3u8')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));



// Simple API status endpoint
app.get('/api/status', (req, res) => {
    res.json({ online: true, app: 'Race Control Server', version: '1.0.0' });
});

// Storage status — informa al frontend si hay disco de grabacion disponible
app.get('/api/storage/status', (req, res) => {
    // Re-detectar por si el disco se conectó después de arrancar (solo si no está deshabilitado)
    if (!mediaRoot && !recordingDisabled) {
        const detected = detectExternalDisk();
        if (detected) {
            const recDir = path.join(detected, 'recordings');
            try { fs.mkdirSync(recDir, { recursive: true }); } catch(e) {}
            mediaRoot = recDir;
            console.log(`[STORAGE] Disco detectado en caliente: ${mediaRoot}`);
        }
    }
    if (!mediaRoot) {
        return res.json({ available: false, path: null, message: recordingDisabled ? 'Grabación en disco desactivada por el usuario.' : 'No hay disco externo conectado. Conecta un USB o configura MEDIA_ROOT en .env' });
    }
    try {
        const stat = fs.statfsSync ? fs.statfsSync(mediaRoot) : null;
        const freeGB = stat ? ((stat.bfree * stat.bsize) / 1e9).toFixed(1) : null;
        res.json({ available: true, path: mediaRoot, freeGB });
    } catch(e) {
        res.json({ available: true, path: mediaRoot, freeGB: null });
    }
});

// Lista todas las particiones disponibles (montadas o detectables) para selección manual
app.get('/api/storage/list', (req, res) => {
    if (process.platform === 'win32') {
        return res.json([{ device: 'local', mountPoint: path.join(__dirname, 'media'), fsType: 'local', sizeGB: null, freeGB: null, label: 'Carpeta local (Windows dev)' }]);
    }

    const DATA_FS = new Set(['ext4','ext3','ext2','vfat','exfat','ntfs','xfs','btrfs','f2fs']);
    const SKIP_FS = new Set(['tmpfs','devtmpfs','sysfs','proc','devpts','cgroup','cgroup2',
                             'overlay','squashfs','udev','securityfs','fusectl','pstore',
                             'efivarfs','debugfs','tracefs','hugetlbfs','mqueue','ramfs','bpf','configfs']);
    // Puntos de montaje del sistema a ignorar
    const SKIP_PFX = ['/', '/boot', '/sys', '/proc', '/dev', '/run/user', '/run/lock',
                      '/run/systemd', '/run/credentials', '/snap', '/usr', '/var', '/opt', '/etc', '/home'];

    const partitions = [];

    try {
        const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
        for (const line of mounts) {
            const [device, mountPoint, fsType] = line.split(' ');
            if (!device || !mountPoint || !fsType) continue;
            if (SKIP_FS.has(fsType)) continue;
            if (!device.startsWith('/dev/')) continue;
            if (!DATA_FS.has(fsType)) continue;
            // Ignorar rutas del sistema operativo
            if (SKIP_PFX.some(p => mountPoint === p || mountPoint.startsWith(p + '/'))) continue;
            if (!fs.existsSync(mountPoint)) continue;

            let sizeGB = null, freeGB = null;
            try {
                const stat = fs.statfsSync(mountPoint);
                sizeGB = ((stat.blocks * stat.bsize) / 1e9).toFixed(0);
                freeGB = ((stat.bfree  * stat.bsize) / 1e9).toFixed(1);
            } catch(e) {}

            // Intentar obtener label del dispositivo
            let label = '';
            try {
                const { execSync } = require('child_process');
                label = execSync(`blkid -s LABEL -o value ${device} 2>/dev/null`, { timeout: 2000 }).toString().trim();
            } catch(e) {}

            partitions.push({ device, mountPoint, fsType, sizeGB, freeGB, label });
        }
    } catch(e) {
        console.error('[STORAGE] Error leyendo /proc/mounts:', e.message);
    }

    // También incluir particiones no montadas del NVMe/USB (lsblk)
    try {
        const { execSync } = require('child_process');
        const lsblk = execSync('lsblk -J -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINT,TYPE 2>/dev/null', { timeout: 3000 }).toString();
        const data = JSON.parse(lsblk);
        const systemDev = execSync('lsblk -no PKNAME $(findmnt -n -o SOURCE /) 2>/dev/null | head -1', { timeout: 2000 }).toString().trim();

        function walkBlk(items, parentDisk) {
            for (const item of (items || [])) {
                const disk = item.type === 'disk' ? item.name : parentDisk;
                if (item.type === 'part' && item.fstype && DATA_FS.has(item.fstype)) {
                    const alreadyListed = partitions.some(p => p.device === `/dev/${item.name}`);
                    const isMounted = item.mountpoint && SKIP_PFX.some(p => item.mountpoint === p || item.mountpoint.startsWith(p + '/'));
                    if (!alreadyListed && !isMounted) {
                        partitions.push({
                            device: `/dev/${item.name}`,
                            mountPoint: item.mountpoint || null,
                            fsType: item.fstype,
                            sizeGB: item.size ? parseFloat(item.size).toFixed(0) : null,
                            freeGB: null,
                            label: item.label || '',
                            unmounted: !item.mountpoint
                        });
                    }
                }
                if (item.children) walkBlk(item.children, disk);
            }
        }
        walkBlk(data.blockdevices, '');
    } catch(e) {
        // lsblk JSON puede no estar disponible en todos los sistemas — silencioso
    }

    res.json(partitions);
});

// Seleccionar partición de grabaciones y guardarla en DB
app.post('/api/storage/select', (req, res) => {
    const { mountPoint, device } = req.body;
    if (!mountPoint && !device) return res.status(400).json({ error: 'Falta mountPoint o device' });

    let targetMount = mountPoint;

    // Si la partición no está montada, montarla primero en /mnt/recordings
    if (!targetMount && device) {
        const { execSync } = require('child_process');
        const mntPoint = '/mnt/recordings';
        try {
            fs.mkdirSync(mntPoint, { recursive: true });
            execSync(`mount ${device} ${mntPoint} 2>/dev/null || mount -t ntfs-3g ${device} ${mntPoint}`, { timeout: 10000 });
            console.log(`[STORAGE] Montada ${device} en ${mntPoint}`);

            // Añadir a fstab para persistencia
            const uuid = execSync(`blkid -s UUID -o value ${device} 2>/dev/null`, { timeout: 2000 }).toString().trim();
            const fstype = execSync(`blkid -s TYPE -o value ${device} 2>/dev/null`, { timeout: 2000 }).toString().trim() || 'auto';
            if (uuid && !fs.readFileSync('/etc/fstab', 'utf8').includes(uuid)) {
                fs.appendFileSync('/etc/fstab', `\nUUID=${uuid}  ${mntPoint}  ${fstype}  defaults,nofail  0  2\n`);
                console.log(`[STORAGE] Montaje permanente añadido a /etc/fstab (UUID=${uuid})`);
            }
            targetMount = mntPoint;
        } catch(e) {
            console.error('[STORAGE] Error montando partición:', e.message);
            return res.status(500).json({ error: `No se pudo montar ${device}: ${e.message}` });
        }
    }

    if (!targetMount || !fs.existsSync(targetMount)) {
        return res.status(400).json({ error: `Ruta no existe: ${targetMount}` });
    }

    // Crear subdirectorio recordings dentro del punto de montaje si no existe
    const recDir = path.join(targetMount, 'recordings');
    try { fs.mkdirSync(recDir, { recursive: true }); } catch(e) {}

    const finalPath = recDir;

    // Guardar en DB
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('recording_disk', ?)", [finalPath], (err) => {
        if (err) return res.status(500).json({ error: err.message });

        // Actualizar en caliente
        mediaRoot = finalPath;
        registerMediaStatic(mediaRoot);
        console.log(`[STORAGE] Disco de grabación seleccionado: ${mediaRoot}`);

        let freeGB = null;
        try {
            const stat = fs.statfsSync(targetMount);
            freeGB = ((stat.bfree * stat.bsize) / 1e9).toFixed(1);
        } catch(e) {}

        res.json({ ok: true, path: mediaRoot, freeGB });
    });
});


/* =======================================
 *  API: LANZAR MONITOR EN SEGUNDO DISPLAY (Linux)
 * ======================================= */
app.post('/api/monitor/open', (req, res) => {
    const { exec, spawn } = require('child_process');
    const monitorUrl = `http://localhost:${process.env.PORT || 4000}/monitor.html`;

    // 1. Detectar displays conectados con xrandr
    exec('xrandr --query', (err, stdout) => {
        let secondaryDisplay = null;

        if (!err && stdout) {
            // Parsear líneas del tipo: "HDMI-1 connected 1920x1080+1920+0 ..."
            const lines = stdout.split('\n');
            const displays = [];
            lines.forEach(line => {
                const m = line.match(/^(\S+)\s+connected\s+(?:primary\s+)?(\d+)x(\d+)\+(\d+)\+(\d+)/);
                if (m) {
                    displays.push({
                        name:   m[1],
                        width:  parseInt(m[2]),
                        height: parseInt(m[3]),
                        x:      parseInt(m[4]),
                        y:      parseInt(m[5]),
                        primary: line.includes(' primary ')
                    });
                }
            });

            console.log(`[MONITOR] Displays detectados: ${displays.map(d => d.name + '@' + d.x + ',' + d.y).join(' | ')}`);

            // Preferir el display con offset X o Y distinto de 0 (no-primario)
            secondaryDisplay = displays.find(d => !d.primary && (d.x > 0 || d.y > 0))
                            || displays.find(d => !d.primary)
                            || (displays.length > 1 ? displays[1] : null);
        }

        if (!secondaryDisplay) {
            console.log('[MONITOR] xrandr no detectó segundo monitor. Usando fallback de navegador.');
            return res.json({ ok: false, reason: 'no_secondary_display', fallback: true });
        }

        console.log(`[MONITOR] Abriendo en display secundario: ${secondaryDisplay.name} (${secondaryDisplay.width}x${secondaryDisplay.height}+${secondaryDisplay.x}+${secondaryDisplay.y})`);

        // 2. Lanzar navegador en el display secundario (Firefox prioritario para modo kiosk real)
        const candidates = [
            'firefox',
            'firefox-esr',
            'epiphany-browser',
            'epiphany'
        ];

        const isFirefox = (bin) => bin.startsWith('firefox');
        const isEpiphany = (bin) => bin.startsWith('epiphany');

        function tryLaunch(index) {
            if (index >= candidates.length) {
                console.log('[MONITOR] No se encontró ningún navegador instalado.');
                return res.json({ ok: false, reason: 'no_browser', fallback: true });
            }
            const bin = candidates[index];
            // Verificar si existe antes de lanzar
            exec(`which ${bin}`, (werr, wout) => {
                if (werr || !wout.trim()) return tryLaunch(index + 1);

                let args;
                if (isFirefox(bin)) {
                    args = [`--new-window`, monitorUrl, `--kiosk`];
                } else if (isEpiphany(bin)) {
                    args = [`--new-window`, monitorUrl];
                } else {
                    args = [monitorUrl];
                }

                console.log(`[MONITOR] Lanzando ${bin} ${args.join(' ')}`);
                const child = spawn(bin, args, {
                    detached: true,
                    stdio: 'ignore',
                    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' }
                });
                child.unref();

                // Para Epiphany: mover la ventana al display secundario y poner fullscreen con xdotool/wmctrl
                if (isEpiphany(bin)) {
                    setTimeout(() => {
                        // Buscar la ventana de Epiphany recién abierta y moverla al segundo display
                        const moveCmd = `xdotool search --name "RACE CONTROL" | tail -1 | xargs -I{} sh -c "xdotool windowmove {} ${secondaryDisplay.x} ${secondaryDisplay.y} && xdotool windowsize {} ${secondaryDisplay.width} ${secondaryDisplay.height} && xdotool windowactivate {} && xdotool key F11"`;
                        exec(moveCmd, (err) => {
                            if (err) {
                                // Fallback con wmctrl
                                exec(`wmctrl -r :ACTIVE: -e 0,${secondaryDisplay.x},${secondaryDisplay.y},${secondaryDisplay.width},${secondaryDisplay.height} && wmctrl -r :ACTIVE: -b add,fullscreen`, () => {});
                            }
                        });
                    }, 2500);
                }

                res.json({ ok: true, browser: bin, display: secondaryDisplay });
            });
        }

        tryLaunch(0);
    });
});

const os = require('os');
app.get('/api/server-ip', (req, res) => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return res.json({ ip: iface.address });
            }
        }
    }
    res.json({ ip: '127.0.0.1' });
});

// Endpoint para consultar estadísticas del sistema (CPU, RAM, GPU) en tiempo real
app.get('/api/system/stats', (req, res) => {
    res.json(sysMonitor.lastStats);
});

app.get('/api/logs', (req, res) => {
    res.json(logHistory);
});

app.get('/api/logs/download', (req, res) => {
    if (fs.existsSync(logFile)) {
        res.download(logFile, 'server_log.txt');
    } else {
        res.status(404).send("No log file found.");
    }
});

/* =======================================
 *  REST API: INPUTS
 * ======================================= */
app.get('/api/inputs', (req, res) => {
    db.all('SELECT * FROM inputs ORDER BY channel ASC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const decorated = rows.map(row => {
            const state = streamManager.activeInputs[row.channel];
            const isRunning = state && !state.isStopping;
            return {
                ...row,
                online: !!isRunning,
                codec: isRunning ? (state.codec || '') : ''
            };
        });
        res.json(decorated);
    });
});

app.post('/api/inputs', (req, res) => {
    const { url, name, provider, location, remote, audiowtdg, wtdgsecs, enabled, buffer, ptz_enabled, ptz_ip, ptz_user, ptz_pass } = req.body;
    
    // Asignar Udpsrv respetando los límites de Firewall (Settings)
    db.get('SELECT udpMin, udpMax FROM ports LIMIT 1', [], (err, ports) => {
        let udpsrv = req.body.udpsrv;
        if (!udpsrv) {
            const min = ports ? ports.udpMin : 10000;
            const max = ports ? ports.udpMax : 30000;
            udpsrv = Math.floor(Math.random() * (max - min + 1)) + min;
        }
        
        const query = `INSERT INTO inputs (url, name, provider, location, remote, enabled, udpsrv, preview_enabled, buffer, ptz_enabled, ptz_ip, ptz_user, ptz_pass) 
                       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`;
        const params = [ url || '', name || 'Stream', provider || 'TodoStreaming', location || '', remote || '', 
                         enabled !== false ? 1 : 0, udpsrv, buffer || 0, ptz_enabled || 0, ptz_ip || '', ptz_user || '', ptz_pass || '' ];
        
        db.run(query, params, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const channelId = this.lastID;
            res.status(201).json({ channel: channelId });
            io.emit('db_update', { event: 'inputs_changed' });

            // If enabled, auto-start stream Manager
            if (enabled !== false) {
                db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, row) => {
                    if (row) streamManager.startInput(row);
                });
            }
        });
    });
});

// For simplicity, a toggle endpoint
app.post('/api/inputs/:channel/toggle', (req, res) => {
    const channelId = req.params.channel;
    db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newEnabled = row.enabled ? 0 : 1;
        db.run('UPDATE inputs SET enabled = ? WHERE channel = ?', [newEnabled, channelId], function(err) {
            io.emit('db_update', { event: 'input_toggled', channel: channelId, enabled: newEnabled });
            res.json({ enabled: newEnabled });
            if (newEnabled) {
                // Must get updated row to spawn
                db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, newRow) => {
                   if (newRow) streamManager.startInput(newRow);
                });
                
                // Memory Feature: Restore previously active outputs
                db.all('SELECT * FROM outputs WHERE channel = ? AND was_enabled = 1', [channelId], (err, outputs) => {
                    if (outputs && outputs.length > 0) {
                        db.run('UPDATE outputs SET enabled = 1, was_enabled = 0 WHERE channel = ? AND was_enabled = 1', [channelId], () => {
                            io.emit('db_update', { event: 'outputs_changed' });
                            // The startOutput will fail if input isn't fully bound yet, but streamManager auto-recovers orphaned outputs!
                            // Actually streamManager startOutput waits 1.5s then connects to input router, so it works.
                            outputs.forEach(outRow => streamManager.startOutput(outRow));
                        });
                    }
                });
            } else {
                streamManager.stopInput(channelId);
                
                // Memory Feature: Save active outputs and disable them
                db.all('SELECT * FROM outputs WHERE channel = ? AND enabled = 1', [channelId], (err, outputs) => {
                    if (outputs && outputs.length > 0) {
                        db.run('UPDATE outputs SET was_enabled = 1, enabled = 0 WHERE channel = ? AND enabled = 1', [channelId], () => {
                            io.emit('db_update', { event: 'outputs_changed' });
                            outputs.forEach(outRow => streamManager.stopOutput(outRow.id));
                        });
                    }
                });
            }
        });
    });
});

app.post('/api/inputs/:channel/preview', (req, res) => {
    const channelId = req.params.channel;
    db.get('SELECT preview_enabled FROM inputs WHERE channel = ?', [channelId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newState = row.preview_enabled ? 0 : 1;
        db.run('UPDATE inputs SET preview_enabled = ? WHERE channel = ?', [newState, channelId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('db_update', { event: 'preview_changed', channel: channelId, preview_enabled: newState });
            
            // Start or stop the actual visual ffmpeg processor independently 
            if (newState === 1) {
                streamManager.startPreview(channelId);
            } else {
                streamManager.stopPreview(channelId);
                // Extraer un fotograma congelado al pararlo
                setTimeout(() => streamManager.startPreview(channelId, true), 1000);
            }
            res.json({ preview_enabled: newState });
        });
    });
});

app.post('/api/inputs/:channel/snapshot', (req, res) => {
    const channelId = req.params.channel;
    streamManager.startPreview(channelId, true);
    res.json({ status: 'Snapshot requested' });
});

app.put('/api/inputs/:channel', (req, res) => {
    const channelId = req.params.channel;
    const { url, name, buffer, ptz_enabled, ptz_ip, ptz_user, ptz_pass } = req.body;
    const query = `UPDATE inputs SET url = ?, name = ?, buffer = ?, ptz_enabled = ?, ptz_ip = ?, ptz_user = ?, ptz_pass = ? WHERE channel = ?`;
    
    db.run(query, [url, name, buffer || 0, ptz_enabled || 0, ptz_ip || '', ptz_user || '', ptz_pass || '', channelId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Restart the process if it was running with new data
        streamManager.stopInput(channelId);
        db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, row) => {
            if (row && row.enabled) streamManager.startInput(row);
            io.emit('db_update', { event: 'inputs_changed' });
            res.json({ updated: this.changes });
        });
    });
});

app.delete('/api/inputs/:channel', (req, res) => {
    const channelId = req.params.channel;
    streamManager.stopInput(channelId);

    db.run('DELETE FROM inputs WHERE channel = ?', [channelId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Stop related outputs
        db.all('SELECT id FROM outputs WHERE channel = ?', [channelId], (err, rows) => {
            if (rows) rows.forEach(r => streamManager.stopOutput(r.id));
            db.run('DELETE FROM outputs WHERE channel = ?', [channelId], () => {
                res.json({ deleted: true });
                io.emit('db_update', { event: 'inputs_changed' });
            });
        });
    });
});

/* =======================================
 *  REST API: PTZ CONTROL
 * ======================================= */
const onvif = require('onvif');

app.post('/api/ptz/:channel/move', (req, res) => {
    const channelId = req.params.channel;
    const { command } = req.body; // 'Up', 'Down', 'Left', 'Right', 'ZoomTele', 'ZoomWide', 'Stop'
    
    db.get('SELECT ptz_enabled, ptz_ip, ptz_user, ptz_pass FROM inputs WHERE channel = ?', [channelId], (err, row) => {
        if (err || !row || !row.ptz_enabled || !row.ptz_ip) {
            return res.status(400).json({ error: 'PTZ no configurado o deshabilitado para este canal' });
        }
        
        const ipParts = row.ptz_ip.split(':');
        const host = ipParts[0];
        const port = ipParts.length > 1 ? parseInt(ipParts[1]) : 80;

        const cam = new onvif.Cam({
            hostname: host,
            username: row.ptz_user,
            password: row.ptz_pass,
            port: port
        }, function(err) {
            if (err) return res.status(500).json({ error: 'No se pudo conectar a la cámara: ' + err.message });
            
            if (command === 'Stop') {
                cam.stop({}, () => res.json({ success: true }));
                return;
            }
            
            // Mapeo de comandos a ONVIF continuousMove
            let x = 0, y = 0, z = 0;
            const speed = 0.5;
            
            if (command === 'Left') x = -speed;
            if (command === 'Right') x = speed;
            if (command === 'Up') y = speed;
            if (command === 'Down') y = -speed;
            if (command === 'ZoomTele') z = speed;
            if (command === 'ZoomWide') z = -speed;
            
            // Dahua/X-Security cameras often silently ignore continuousMove if timeout is not specified
            cam.continuousMove({ x: x, y: y, zoom: z, timeout: 5000 }, function(err) {
                if (err) return res.status(500).json({ error: 'Error enviando comando: ' + err.message });
                res.json({ success: true });
            });
        });
    });
});

app.get('/api/ptz/:channel/stream', (req, res) => {
    const channelId = req.params.channel;
    
    db.get('SELECT ptz_enabled, ptz_ip, ptz_user, ptz_pass, url FROM inputs WHERE channel = ?', [channelId], (err, row) => {
        if (err || !row || !row.ptz_enabled || !row.ptz_ip) {
            return res.status(404).send('PTZ not configured');
        }
        
        // Extract IP and Port from the main input URL if it's RTSP, otherwise fallback to ptz_ip
        let host = row.ptz_ip.split(':')[0];
        let port = '554';
        try {
            if (row.url && row.url.startsWith('rtsp://')) {
                const urlObj = new URL(row.url);
                host = urlObj.hostname;
                if (urlObj.port) port = urlObj.port;
            }
        } catch(e) {}
        
        // Construct RTSP substream URL for Dahua/X-Security
        const user = row.ptz_user ? encodeURIComponent(row.ptz_user) : '';
        const pass = row.ptz_pass ? encodeURIComponent(row.ptz_pass) : '';
        const auth = (user && pass) ? `${user}:${pass}@` : '';
        const rtspUrl = `rtsp://${auth}${host}:${port}/cam/realmonitor?channel=1&subtype=1&unicast=true`;
        
        res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
            'Cache-Control': 'no-cache',
            'Connection': 'close',
            'Pragma': 'no-cache'
        });
        
        const { spawn } = require('child_process');
        const ffmpegCmd = streamManager.getFFmpegPath();
        
        const args = [
            '-hide_banner', '-y',
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-f', 'mpjpeg',
            '-r', '15', // 15 fps for smooth PTZ preview without high bandwidth
            '-q:v', '5', // Quality (lower is better, 5 is a good balance)
            'pipe:1'
        ];
        
        const child = spawn(ffmpegCmd, args);
        
        child.stdout.pipe(res);
        
        child.stderr.on('data', (data) => {
            // Uncomment for debugging if needed: console.log(`[PTZ-MJPEG] ${data.toString()}`);
        });
        
        res.on('close', () => {
            console.log(`[PTZ-MJPEG] Client disconnected, killing ffmpeg for channel ${channelId}`);
            child.kill('SIGKILL');
        });
        
        child.on('error', (err) => {
            console.error(`[PTZ-MJPEG] FFmpeg error: ${err.message}`);
            if (!res.headersSent) res.status(500).end();
        });
    });
});

/* =======================================
 *  REST API: OUTPUTS
 * ======================================= */
app.get('/api/outputs', (req, res) => {
    db.all('SELECT * FROM outputs', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/outputs', (req, res) => {
    const { channel, url, location, remote, enabled, vcodec } = req.body;
    if (!channel) return res.status(400).json({ error: "Input 'channel' is required" });
    
    // We need the udpsrv of the parent channel to link them
    db.get('SELECT udpsrv FROM inputs WHERE channel = ?', [channel], (err, parentRaw) => {
        if (err || !parentRaw) return res.status(400).json({ error: "Parent input not found" });

        const udpsrv = parentRaw.udpsrv;
        const query = `INSERT INTO outputs (channel, url, location, remote, enabled, udpsrv, vcodec) 
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const params = [ channel, url || '', location || '', remote || '', enabled !== false ? 1 : 0, udpsrv, vcodec || 'copy' ];
        
        db.run(query, params, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const outId = this.lastID;
            res.status(201).json({ id: outId });
            io.emit('db_update', { event: 'outputs_changed' });
            
            if (enabled !== false) {
                db.get('SELECT * FROM outputs WHERE id = ?', [outId], (err, row) => {
                    if (row) streamManager.startOutput(row);
                });
            }
        });
    });
});

app.post('/api/outputs/:id/toggle', (req, res) => {
    const id = req.params.id;
    db.get('SELECT * FROM outputs WHERE id = ?', [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newEnabled = row.enabled ? 0 : 1;
        db.run('UPDATE outputs SET enabled = ?, was_enabled = 0 WHERE id = ?', [newEnabled, id], function(err) {
            io.emit('db_update', { event: 'output_toggled', id: id, enabled: newEnabled });
            res.json({ enabled: newEnabled });
            if (newEnabled) {
                db.get('SELECT * FROM outputs WHERE id = ?', [id], (err, newRow) => {
                   if (newRow) streamManager.startOutput(newRow);
                });
            } else {
                streamManager.stopOutput(id);
            }
        });
    });
});

app.put('/api/outputs/:id', (req, res) => {
    const id = req.params.id;
    const { url, location, vcodec } = req.body;
    db.run(`UPDATE outputs SET url = ?, location = ?, vcodec = ? WHERE id = ?`, [url, location, vcodec || 'copy', id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Restart the process if it was running with new data
        streamManager.stopOutput(id);
        db.get('SELECT o.*, i.udpsrv FROM outputs o JOIN inputs i ON o.channel = i.channel WHERE o.id = ?', [id], (err, row) => {
            if (row && row.enabled) streamManager.startOutput(row);
            io.emit('db_update', { event: 'outputs_changed' });
            res.json({ updated: this.changes });
        });
    });
});

app.delete('/api/outputs/:id', (req, res) => {
    const id = req.params.id;
    streamManager.stopOutput(id);

    db.run('DELETE FROM outputs WHERE id = ?', [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: this.changes });
        io.emit('db_update', { event: 'outputs_changed' });
    });
});
/* =======================================
 *  REST API: RECORDING SESSIONS & MARKERS
 * ======================================= */

// In-memory map of active recording FFmpeg processes { sessionId -> [childProcess, ...] }
const activeRecordingProcs = {};

// Endpoint para comprobar si hay una sesión grabando activamente (procesos FFmpeg en memoria)
app.get('/api/recordings/active', (req, res) => {
    const activeSessions = Object.keys(activeRecordingProcs);
    if (activeSessions.length === 0) {
        return res.json({ active: false, session_id: null });
    }
    // Devolver la sesión más reciente que tenga procesos vivos
    const sessionId = activeSessions[activeSessions.length - 1];
    const procs = activeRecordingProcs[sessionId] || [];
    const aliveCount = procs.filter(p => p.exitCode === null).length;
    if (aliveCount === 0) {
        // Todos los procesos terminaron — limpiar
        delete activeRecordingProcs[sessionId];
        return res.json({ active: false, session_id: null });
    }
    res.json({ active: true, session_id: sessionId, alive_processes: aliveCount });
});

// Helper: kill ALL active recording processes (used before starting a new session)
function stopAllRecordings() {
    const activeSessions = Object.keys(activeRecordingProcs);
    activeSessions.forEach(sid => {
        const procs = activeRecordingProcs[sid] || [];
        procs.forEach(child => {
            try { child.stdin.write('q'); } catch (e) {}
            try { child.kill('SIGTERM'); } catch (e) {}
        });
        delete activeRecordingProcs[sid];
        console.log(`[REC] Stopped previous session ${sid} (${procs.length} processes)`);
    });
    return activeSessions.length;
}

app.post('/api/recordings/start', (req, res) => {
    // ── Verificar disco de grabacion disponible ──
    if (!mediaRoot) {
        // Intentar detectar en caliente
        const detected = detectExternalDisk();
        if (detected) {
            const recDir = path.join(detected, 'recordings');
            try { fs.mkdirSync(recDir, { recursive: true }); } catch(e) {}
            mediaRoot = recDir;
            // Registrar la ruta de media en express (hot-add)
            app.use('/media', express.static(mediaRoot, {
                setHeaders: (res, fp) => {
                    if (fp.endsWith('.m3u8')) {
                        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    }
                }
            }));
            console.log(`[STORAGE] Disco detectado al grabar: ${mediaRoot}`);
        } else {
            return res.status(503).json({ error: 'No hay disco externo disponible para grabar. Conecta un USB.' });
        }
    }

    // Parar grabaciones anteriores ANTES de iniciar una nueva
    const stopped = stopAllRecordings();
    if (stopped > 0) {
        console.log(`[REC] Parando ${stopped} sesión(es) activa(s) antes de nueva grabación`);
    }

    const sessionId = Date.now().toString();
    const startTime = new Date().toISOString();

    db.run('INSERT INTO recording_sessions (id, start_time, name) VALUES (?, ?, ?)',
        [sessionId, startTime, req.body.name || 'Global Session'], function(err) {
        if (err) return res.status(500).json({ error: err.message });

        db.all('SELECT * FROM inputs WHERE enabled = 1', [], (err, inputs) => {
            if (err || !inputs || inputs.length === 0)
                return res.status(400).json({ error: 'No active inputs found' });

            const { spawn } = require('child_process');
            const ffmpegCmd = streamManager.getFFmpegPath();

            const net = require('net');

            activeRecordingProcs[sessionId] = [];
            activeRecordingProcs[sessionId].sockets = []; // cleanup sockets on stop

            inputs.forEach(input => {
                // Verificar que el router del input está activo
                const inputState = streamManager.activeInputs[input.channel];
                if (!inputState || !inputState.router) {
                    console.log(`[REC] Ch${input.channel} router not active — skipping`);
                    return;
                }

                // ← Nombre de archivo consistente con lo que el frontend busca: CAM_{channel}_{sessionId}
                const hlsPath  = path.join(mediaRoot, `CAM_${input.channel}_${sessionId}.m3u8`);
                const mp4Path  = path.join(mediaRoot, `CAM_${input.channel}_${sessionId}.mp4`);

                // Puerto TCP local donde el FFmpeg de grabación escucha
                const recPort = 42000 + Math.floor(Math.random() * 15000);

                // FFmpeg lee del router (TCP local) en lugar de RTSP directo
                // Evita abrir una 2ª conexión RTSP a la cámara (que la rechazaría)
                const codec = inputState.codec || (streamManager.persistentCodecs && streamManager.persistentCodecs[input.channel]) || '';
                const isH265 = codec.toLowerCase().includes('265') || codec.toLowerCase().includes('hevc');
                const hlsCodecArgs = isH265
                    ? streamManager.getH264EncoderArgs({ scale: '-2:720', cq: 28 })
                    : [
                        '-c:v', 'copy',
                      ];

                const args = [
                    '-hide_banner', '-y',
                    '-fflags', '+genpts',
                    '-thread_queue_size', '4096'
                ];

                // Si es H.265 y la GPU NVIDIA está disponible, activar decodificación acelerada por hardware (NVIDIA CUDA)
                if (isH265 && streamManager.nvencAvailable) {
                    args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', 'hevc_cuvid');
                }

                args.push('-i', `tcp://127.0.0.1:${recPort}?listen`);

                // --- HLS output (transcodificado a H.264 si es H.265 para reproducción en navegador) ---
                const hlsOutArgs = [
                    '-map', '0:v?', '-map', '0:a?',
                    ...hlsCodecArgs,
                    '-c:a', 'aac', '-b:a', '128k',
                    '-bsf:a', 'aac_adtstoasc',
                    '-hls_time', '2',
                    '-hls_list_size', '0',
                    '-hls_segment_type', 'mpegts',
                    '-f', 'hls', hlsPath
                ];

                // --- MP4 output (siempre copia de flujo original para rendimiento y exportación ultrarrápida) ---
                // Para el output copia, necesitamos leer del stream mapeado (sin pasar por CUDA)
                const mp4OutArgs = [
                    '-map', '0:v?', '-map', '0:a?',
                    '-c', 'copy',
                    '-bsf:a', 'aac_adtstoasc',
                    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
                    '-f', 'mp4', mp4Path
                ];

                args.push(...hlsOutArgs, ...mp4OutArgs);

                console.log(`[REC-START] Session ${sessionId} ch${input.channel} via TCP router :${recPort}`);
                const child = spawn(ffmpegCmd, args);

                // Throttle stderr — solo errores reales, silenciar warnings de HEVC/AAC ya corregidos
                let lastRecLog = 0;
                child.stderr.on('data', d => {
                    const text = d.toString();
                    // Ignorar warnings conocidos y no críticos (PPS HEVC, NALU skip, AAC ya corregido, parsing NAL unit, hevc)
                    const isKnownNoise = /PPS id out of range|Skipping invalid undecodable NALU|aac_adtstoasc|Last message repeated|Malformed AAC|Error parsing NAL unit|hevc/i.test(text);
                    if (isKnownNoise) return;
                    const isImportant = /error|fail|unable|operation not permitted/i.test(text);
                    const now = Date.now();
                    if (isImportant) {
                        const line = text.split('\n')[0].trim();
                        if (line) broadCastLog('WARN', `[REC-${sessionId}|ch${input.channel}] ${line}`);
                    } else if (now - lastRecLog > 8000) {
                        lastRecLog = now;
                        // No loguear nada rutinario al servidor — reducir ruido
                    }
                });
                child.on('exit', code => {
                    broadCastLog('INFO', `[REC-${sessionId}] ch${input.channel} FFmpeg exited ${code}`);
                });

                activeRecordingProcs[sessionId].push(child);

                // Conectar al router 1.5s después de que FFmpeg esté en escucha
                setTimeout(() => {
                    if (child.exitCode !== null) return; // ya terminó
                    const routerState = streamManager.activeInputs[input.channel];
                    if (!routerState || !routerState.router) return;

                    const sock = net.createConnection(recPort, '127.0.0.1', () => {
                        routerState.router.subscribers.add(sock);
                        console.log(`[REC] Ch${input.channel} suscrito al router TCP :${recPort}`);
                    });
                    sock.on('error', err => originalLog(`[REC] sock error ch${input.channel}: ${err.message}`));
                    sock.on('close', () => {
                        if (streamManager.activeInputs[input.channel] && streamManager.activeInputs[input.channel].router) {
                            streamManager.activeInputs[input.channel].router.subscribers.delete(sock);
                        }
                    });
                    activeRecordingProcs[sessionId].sockets.push({ sock, channel: input.channel });
                }, 1500);

                // Guardar rutas de fichero para exportación
                db.run(`INSERT OR REPLACE INTO session_files
                    (session_id, channel, hls_path, mp4_path) VALUES (?,?,?,?)`,
                    [sessionId, input.channel, hlsPath, mp4Path]);
            });


            io.emit('db_update', { event: 'recordings_started', session_id: sessionId });
            res.json({ session_id: sessionId, start_time: startTime, message: `Started ${inputs.length} recordings.` });
        });
    });
});

app.post('/api/recordings/stop/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = activeRecordingProcs[sessionId] || [];
    const procs = Array.isArray(session) ? session : [];
    const sockets = session.sockets || [];

    // Desconectar sockets del router
    sockets.forEach(({ sock, channel }) => {
        try { sock.destroy(); } catch (e) {}
        if (streamManager.activeInputs[channel] && streamManager.activeInputs[channel].router) {
            streamManager.activeInputs[channel].router.subscribers.delete(sock);
        }
    });

    // Matar procesos FFmpeg
    procs.forEach(child => {
        try { child.stdin.write('q'); } catch (e) {}
        try { child.kill('SIGTERM'); } catch (e) {}
    });
    delete activeRecordingProcs[sessionId];

    // Update end_time
    const endTime = new Date().toISOString();
    db.run('UPDATE recording_sessions SET end_time = ? WHERE id = ?',
        [endTime, sessionId], function(err) {
            io.emit('db_update', { event: 'outputs_changed' });
            res.json({ stopped: procs.length, session_id: sessionId, end_time: endTime });
        });
});


// Export clip from MP4 using fast stream-copy (no re-encode)
app.post('/api/recordings/export', (req, res) => {
    const { spawn } = require('child_process');
    console.log('[EXPORT] ── Petición recibida ──');
    console.log('[EXPORT] Body:', JSON.stringify(req.body || {}));

    const { session_id, channel, start_time, end_time, label } = req.body || {};

    if (!session_id || start_time == null || end_time == null) {
        console.error('[EXPORT] Parámetros incompletos:', { session_id, channel, start_time, end_time });
        return res.status(400).json({ error: 'Faltan parámetros: session_id, start_time y end_time son obligatorios' });
    }

    if (!channel && channel !== 0) {
        console.error('[EXPORT] Canal no especificado');
        return res.status(400).json({ error: 'Falta el parámetro channel (canal de cámara)' });
    }

    // First try to get the MP4 path from session_files
    db.get('SELECT * FROM session_files WHERE session_id = ? AND channel = ?',
        [session_id, channel], (dbErr, fileRow) => {

        // ── try-catch que cubre todo el callback asíncrono ──
        try {
            if (dbErr) {
                console.error(`[EXPORT] DB error: ${dbErr.message}`);
                return res.status(500).json({ error: 'Error de base de datos: ' + dbErr.message });
            }

            console.log('[EXPORT] DB result:', fileRow ? `mp4=${fileRow.mp4_path}, hls=${fileRow.hls_path}` : 'SIN REGISTRO');

            // ── Resolver ruta del archivo fuente ──
            let sourcePath = null;

            if (fileRow && fileRow.mp4_path && fs.existsSync(fileRow.mp4_path)) {
                sourcePath = fileRow.mp4_path;
            } else if (fileRow && fileRow.hls_path && fs.existsSync(fileRow.hls_path)) {
                sourcePath = fileRow.hls_path;
            } else if (mediaRoot) {
                const guessedMp4 = path.join(mediaRoot, `CAM_${channel}_${session_id}.mp4`);
                if (fs.existsSync(guessedMp4)) sourcePath = guessedMp4;
            }

            if (!sourcePath) {
                const detail = fileRow
                    ? `MP4: ${fileRow.mp4_path || 'N/A'} (existe: ${fileRow.mp4_path ? fs.existsSync(fileRow.mp4_path) : 'N/A'}) | HLS: ${fileRow.hls_path || 'N/A'} (existe: ${fileRow.hls_path ? fs.existsSync(fileRow.hls_path) : 'N/A'})`
                    : `No hay registro en session_files para sesión ${session_id} canal ${channel}`;
                console.error(`[EXPORT] Archivo fuente no encontrado. ${detail}`);
                return res.status(404).json({ error: 'Archivo de grabación no encontrado en disco', detail });
            }

            console.log(`[EXPORT] Fuente: ${sourcePath}`);

            // ── Nombre del clip ──
            const now = new Date();
            const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
            const timeStr = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
            const clipLabel = (label || `clip_${Math.floor(start_time)}s`).replace(/[^a-zA-Z0-9_\- ]/g, '_').trim();
            const exportName = `${clipLabel}_${dateStr}_${timeStr}.mp4`;

            // ── Destino ──
            const baseDestDir = req.body.dest_path || mediaRoot;
            if (!baseDestDir) {
                console.error('[EXPORT] Sin disco de destino configurado');
                return res.status(503).json({ error: 'No hay disco de grabación configurado' });
            }

            const destDir = path.join(baseDestDir, 'clips');
            console.log(`[EXPORT] Destino: ${destDir}/${exportName}`);

            try {
                fs.mkdirSync(destDir, { recursive: true });
                fs.accessSync(destDir, fs.constants.W_OK);
            } catch(mkErr) {
                const isPermission = mkErr.code === 'EACCES' || mkErr.code === 'EPERM';
                const hint = isPermission
                    ? ' Ejecuta: sudo chmod 777 "' + baseDestDir + '" o comprueba que el disco no está montado como solo lectura.'
                    : '';
                console.error(`[EXPORT] No se puede crear/escribir en destino: ${mkErr.message}${hint}`);
                return res.status(500).json({
                    error: `No se puede escribir en el disco: ${mkErr.message}`,
                    hint: hint || undefined
                });
            }

            const exportPath = path.join(destDir, exportName);
            const isInternalDest = mediaRoot && (baseDestDir === mediaRoot || baseDestDir.startsWith(mediaRoot));

            // ── FFmpeg ──
            let ffmpegBin;
            try {
                ffmpegBin = streamManager.getFFmpegPath();
            } catch (e) {
                ffmpegBin = 'ffmpeg'; // fallback al PATH del sistema
            }
            console.log(`[EXPORT] FFmpeg: ${ffmpegBin}`);

            if (path.isAbsolute(ffmpegBin) && !fs.existsSync(ffmpegBin)) {
                console.error(`[EXPORT] FFmpeg no encontrado en: ${ffmpegBin}`);
                return res.status(500).json({ error: `FFmpeg no encontrado en: ${ffmpegBin}` });
            }

            const args = [
                '-hide_banner', '-y',
                '-ss', String(start_time),
                '-i', sourcePath,
                '-t', String(end_time - start_time),
                '-c', 'copy',
                '-movflags', '+faststart',
                exportPath
            ];

            console.log(`[EXPORT] Comando: ${ffmpegBin} ${args.join(' ')}`);

            let responded = false;
            const safeRespond = (fn) => {
                if (!responded && !res.headersSent) {
                    responded = true;
                    try { fn(); } catch(e) { console.error('[EXPORT] Error al enviar respuesta:', e.message); }
                }
            };

            let stderrLines = [];
            let child;
            try {
                child = spawn(ffmpegBin, args);
            } catch (spawnErr) {
                console.error(`[EXPORT] Error al lanzar FFmpeg: ${spawnErr.message}`);
                return res.status(500).json({ error: `No se pudo lanzar FFmpeg: ${spawnErr.message}` });
            }

            child.stderr.on('data', (d) => {
                const line = d.toString().trim();
                if (line) stderrLines.push(line);
                if (stderrLines.length > 20) stderrLines.shift();
            });

            child.on('error', (err) => {
                console.error(`[EXPORT] FFmpeg spawn error: ${err.message}`);
                safeRespond(() => res.status(500).json({ error: `FFmpeg no se pudo ejecutar: ${err.message}` }));
            });

            child.on('close', code => {
                try {
                    const lastErr = stderrLines.slice(-3).join(' | ');
                    if (code === 0) {
                        console.log(`[EXPORT] ✓ OK: ${exportName}`);
                        io.emit('server_log', { timestamp: new Date().toISOString(), level: 'INFO',
                            message: `✓ Clip exportado: ${exportName}` });
                        safeRespond(() => {
                            const response = { ok: true, filename: exportName, path: exportPath };
                            if (isInternalDest) {
                                response.downloadUrl = `/api/exports/download/${encodeURIComponent(exportName)}`;
                            }
                            res.json(response);
                        });
                    } else {
                        console.error(`[EXPORT] ✗ FALLO: ${exportName} (código ${code}) — ${lastErr}`);
                        io.emit('server_log', { timestamp: new Date().toISOString(), level: 'ERROR',
                            message: `✗ Export fallido (${code}): ${lastErr}` });
                        safeRespond(() => res.status(500).json({
                            error: `FFmpeg falló con código ${code}`,
                            detail: lastErr || 'Sin detalle disponible',
                            source: sourcePath,
                            dest: exportPath
                        }));
                    }
                } catch (closeErr) {
                    console.error(`[EXPORT] Error en close handler: ${closeErr.message}`);
                    safeRespond(() => res.status(500).json({ error: `Error procesando resultado: ${closeErr.message}` }));
                }
            });

            // Timeout de seguridad: si FFmpeg no responde en 120s, matar y devolver error
            setTimeout(() => {
                if (!responded) {
                    console.error(`[EXPORT] Timeout 120s — matando FFmpeg`);
                    try { child.kill('SIGKILL'); } catch (_) {}
                    safeRespond(() => res.status(504).json({
                        error: 'Tiempo de espera agotado (120s). El clip puede ser demasiado largo o el disco demasiado lento.',
                        detail: stderrLines.slice(-3).join(' | ')
                    }));
                }
            }, 120000);

        } catch (asyncErr) {
            console.error(`[EXPORT] Error inesperado en callback: ${asyncErr.stack || asyncErr.message}`);
            if (!res.headersSent) {
                res.status(500).json({ error: `Error inesperado: ${asyncErr.message}` });
            }
        }
    });
});

// ── Descarga HTTP de clips exportados al disco interno ──────────────────────
// Permite descargar al navegador los clips que se guardaron en mediaRoot/clips/
app.get('/api/exports/download/:filename', (req, res) => {
    const filename = req.params.filename;
    // Sanear nombre: no permitir path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Nombre de archivo inválido' });
    }
    if (!mediaRoot) {
        return res.status(503).json({ error: 'No hay disco de grabación configurado' });
    }
    const filePath = path.join(mediaRoot, 'clips', filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Archivo no encontrado: ' + filename });
    }
    // Forzar descarga con Content-Disposition
    res.download(filePath, filename, (err) => {
        if (err && !res.headersSent) {
            console.error(`[EXPORT-DOWNLOAD] Error descargando ${filename}: ${err.message}`);
            res.status(500).json({ error: 'Error al descargar: ' + err.message });
        }
    });
});

// ── Listar clips exportados disponibles para descarga ──────────────────────
app.get('/api/exports', (req, res) => {
    if (!mediaRoot) return res.json([]);
    const clipsDir = path.join(mediaRoot, 'clips');
    if (!fs.existsSync(clipsDir)) return res.json([]);
    try {
        const files = fs.readdirSync(clipsDir)
            .filter(f => f.endsWith('.mp4'))
            .map(f => {
                const stat = fs.statSync(path.join(clipsDir, f));
                return {
                    filename: f,
                    sizeMB: (stat.size / 1e6).toFixed(1),
                    created: stat.mtime.toISOString(),
                    downloadUrl: `/api/exports/download/${encodeURIComponent(f)}`
                };
            })
            .sort((a, b) => new Date(b.created) - new Date(a.created));
        res.json(files);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Clips (IN/OUT pairs) ────────────────────────────
app.get('/api/clips/:sessionId', (req, res) => {
    db.all('SELECT * FROM clips WHERE session_id = ? ORDER BY in_point ASC',
        [req.params.sessionId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/clips', (req, res) => {
    const { session_id, in_point, out_point, label, channels } = req.body;
    const baseLabel = label || 'Clip';
    
    // Si no envían canales, guardamos un clip genérico (comportamiento legacy)
    const chList = Array.isArray(channels) && channels.length > 0 ? channels : [null];
    
    let inserted = [];
    let errors = [];
    
    // Usamos Promesas para insertar múltiples clips
    const insertClip = (ch) => new Promise((resolve) => {
        const lbl = ch !== null ? `${baseLabel} - CH${ch}` : baseLabel;
        db.run('INSERT INTO clips (session_id, channel, in_point, out_point, label) VALUES (?,?,?,?,?)',
            [session_id, ch, in_point, out_point, lbl], function(err) {
            if (err) errors.push(err.message);
            else inserted.push({ id: this.lastID, session_id, channel: ch, in_point, out_point, label: lbl });
            resolve();
        });
    });

    Promise.all(chList.map(ch => insertClip(ch))).then(() => {
        if (errors.length > 0 && inserted.length === 0) return res.status(500).json({ error: errors.join(', ') });
        res.status(201).json({ success: true, clips: inserted });
    });
});

app.delete('/api/clips/:id', (req, res) => {
    db.run('DELETE FROM clips WHERE id = ?', [req.params.id], err => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: req.params.id });
    });
});

// Actualizar etiqueta de un clip (para edición inline del nombre)
app.put('/api/clips/:id', (req, res) => {
    const { label, in_point, out_point } = req.body;
    db.run('UPDATE clips SET label = COALESCE(?, label), in_point = COALESCE(?, in_point), out_point = COALESCE(?, out_point) WHERE id = ?',
        [label ?? null, in_point ?? null, out_point ?? null, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ updated: this.changes });
    });
});

// ── Recording Sessions ──────────────────────────────
app.get('/api/recordings', (req, res) => {
    db.all('SELECT * FROM recording_sessions ORDER BY start_time DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ── Markers ─────────────────────────────────────────
app.post('/api/markers', (req, res) => {
    const { session_id, timestamp_offset, label } = req.body;
    db.run('INSERT INTO markers (session_id, timestamp_offset, label) VALUES (?, ?, ?)',
        [session_id, timestamp_offset, label || 'Marca'], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const marker = { id: this.lastID, session_id, timestamp_offset, label };
        io.emit('marker_added', marker);
        res.status(201).json(marker);
    });
});

app.get('/api/markers/:sessionId', (req, res) => {
    db.all('SELECT * FROM markers WHERE session_id = ? ORDER BY timestamp_offset ASC',
        [req.params.sessionId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

/* =======================================
 *  REST API: SETTINGS / USERS / PORTS
 * ======================================= */
app.get('/api/users', (req, res) => {
    db.all('SELECT username, role, email FROM users', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/users', (req, res) => {
    const { username, password, role, email } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });
    db.run('INSERT INTO users (username, password, role, email) VALUES (?, ?, ?, ?)', [username, password, role || 2, email || ''], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ success: true });
    });
});

app.delete('/api/users/:username', (req, res) => {
    const user = req.params.username;
    if (user === 'admin') return res.status(403).json({ error: 'Cannot delete root admin' }); // Prevent lockout
    db.run('DELETE FROM users WHERE username = ?', [user], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: this.changes });
    });
});

/* =======================================
 *  REST API: FILES / STORAGE
 * ======================================= */
app.get('/api/disks', async (req, res) => {
    try {
        const drives = [];
        const seen   = new Set();

        // Helper para obtener espacio libre via df (Linux)
        const getDiskSpace = (mountPath) => {
            try {
                if (process.platform === 'win32') return { freeGB: null, totalGB: null, usedPct: null };
                const { execSync } = require('child_process');
                const dfOut = execSync(`df -B1 "${mountPath}" 2>/dev/null | tail -1`, { timeout: 3000 }).toString().trim();
                const parts = dfOut.split(/\s+/);
                return {
                    freeGB:  parts[3] ? (parseInt(parts[3]) / 1e9).toFixed(1) : null,
                    totalGB: parts[1] ? (parseInt(parts[1]) / 1e9).toFixed(1) : null,
                    usedPct: parts[4] ? parseInt(parts[4]) : null
                };
            } catch (_) { return { freeGB: null, totalGB: null, usedPct: null }; }
        };

        const addDrive = (mountPath, label, freeGB, totalGB, usedPct, isInternal = false) => {
            if (seen.has(mountPath)) return;
            seen.add(mountPath);
            drives.push({
                id:       mountPath.replace(/[:\\/]/g, '_'),
                name:     `[${label}] ${mountPath}`,
                path:     mountPath,
                freeGB:   freeGB  || null,
                totalGB:  totalGB || null,
                usedPct:  usedPct || null,
                internal: isInternal,
                active:   mediaRoot && (mediaRoot === mountPath || mediaRoot.startsWith(mountPath + '/') || mediaRoot.startsWith(mountPath + '\\'))
            });
        };

        // ── Fuente 0: Disco interno (mediaRoot / grabaciones) — SIEMPRE visible ──
        // El disco donde se graban las sesiones es el destino más natural para exportar clips.
        if (mediaRoot && fs.existsSync(mediaRoot)) {
            const space = getDiskSpace(mediaRoot);
            addDrive(mediaRoot, '💾 Disco de grabación', space.freeGB, space.totalGB, space.usedPct, true);
        }

        // ── Fuente 1: systeminformation (discos externos) ──
        try {
            const fsSizes = await si.fsSize();
            const EXT = ['/media', '/mnt', '/run/media'];
            fsSizes.forEach(f => {
                if (!f.mount) return;
                const isExt = process.platform === 'win32'
                    ? (f.mount !== 'C:\\' && f.mount !== 'C:' && /^[D-Z]/.test(f.mount))
                    : EXT.some(p => f.mount.startsWith(p));
                if (!isExt) return;
                const freeGB  = f.available ? (f.available / 1e9).toFixed(1) : null;
                const totalGB = f.size      ? (f.size      / 1e9).toFixed(1) : null;
                const usedPct = f.size && f.use ? Math.round(f.use) : null;
                addDrive(f.mount, f.fs || 'USB', freeGB, totalGB, usedPct, false);
            });
        } catch (_) {}

        // ── Fuente 2: /proc/mounts (Linux, más fiable en ARM/Raspberry) ──
        if (process.platform !== 'win32') {
            try {
                const DATA_FS = new Set(['ext4','ext3','ext2','vfat','exfat','ntfs','xfs','btrfs','f2fs','fuseblk']);
                const SKIP = ['/', '/boot', '/sys', '/proc', '/dev', '/run/user',
                              '/snap', '/usr', '/var', '/opt', '/etc', '/home',
                              '/run/lock', '/run/systemd', '/run/credentials'];
                const lines = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
                for (const line of lines) {
                    const [device, mount, fsType] = line.split(' ');
                    if (!device || !mount || !fsType) continue;
                    if (!device.startsWith('/dev/')) continue;
                    if (!DATA_FS.has(fsType)) continue;
                    if (SKIP.some(p => mount === p || mount.startsWith(p + '/'))) continue;
                    if (!/^\/(media|mnt|run\/media)/.test(mount)) continue;
                    if (!fs.existsSync(mount)) continue;
                    const space = getDiskSpace(mount);
                    addDrive(mount, `🔌 ${fsType.toUpperCase()}`, space.freeGB, space.totalGB, space.usedPct, false);
                }
            } catch (_) {}
        }

        res.json(drives);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Seleccionar disco de grabacion en caliente
app.post('/api/storage/select', (req, res) => {
    const { disk_path } = req.body;
    if (!disk_path) return res.status(400).json({ error: 'Missing disk_path' });

    if (disk_path === 'disabled' || disk_path === 'none') {
        mediaRoot = null;
        recordingDisabled = true;
        db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('recording_disk', 'disabled')", (err) => {
            if (err) console.error('[STORAGE] Error guardando disco en DB:', err.message);
        });
        console.log(`[STORAGE] Disco de grabación desactivado por el usuario.`);
        return res.json({ ok: true, path: null });
    }

    // Seguridad: no permitir disco del sistema
    const forbidden = ['/', '/boot', '/usr', '/etc', '/home', '/var', '/sys', '/proc', 'C:\\', 'C:'];
    if (forbidden.some(f => disk_path === f || disk_path.startsWith(f + '/'))) {
        return res.status(403).json({ error: 'Disco del sistema — no permitido' });
    }
    if (!fs.existsSync(disk_path)) {
        return res.status(404).json({ error: 'Ruta no encontrada: ' + disk_path });
    }

    // Crear carpeta recordings dentro del disco
    const recDir = path.join(disk_path, 'recordings');
    try { fs.mkdirSync(recDir, { recursive: true }); } catch(e) {
        return res.status(500).json({ error: 'No se puede escribir en el disco: ' + e.message });
    }

    // Actualizar mediaRoot en caliente
    mediaRoot = recDir;
    recordingDisabled = false;
    registerMediaStatic(mediaRoot);

    // Persistir en DB
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('recording_disk', ?)", [recDir], (err) => {
        if (err) console.error('[STORAGE] Error guardando disco en DB:', err.message);
    });

    console.log(`[STORAGE] Disco de grabacion cambiado a: ${mediaRoot}`);
    res.json({ ok: true, path: mediaRoot });
});



/* =======================================
 *  REST API: LIVE HLS PREVIEW (sin grabar)
 * ======================================= */
// Mapa en memoria de procesos de preview HLS activos (mantenido por compatibilidad)
const livePreviewProcs = {};

// Endpoint para obtener el flujo crudo MPEG-TS directamente del router TCP interno sin usar CPU
app.get('/api/preview/ts/:channel', (req, res) => {
    const channel = parseInt(req.params.channel);
    const routerState = streamManager.activeInputs[channel];
    
    if (!routerState || !routerState.router) {
        return res.status(503).send('Input not ready');
    }

    // Desactivar timeout del socket y habilitar keep-alive para mantener flujo continuo
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true, 5000);
    
    res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'Pragma': 'no-cache',
        'Transfer-Encoding': 'chunked',
        'X-Accel-Buffering': 'no', // Evita buffering de Nginx u otros proxies reversos
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
    });
    
    const { spawn } = require('child_process');
    const ffmpegCmd = streamManager.getFFmpegPath();
    
    const codec = routerState.codec || (streamManager.persistentCodecs && streamManager.persistentCodecs[channel]) || '';
    // Transcodificar H.265 -> H.264 bajo demanda (solo si el cliente lo solicita explícitamente por limitaciones de compatibilidad)
    const mustTranscode = codec === 'H.265' && (req.query.transcode === '1' || req.query.transcode === 'true');
    
    let args;
    if (mustTranscode) {
        const encoderType = streamManager.nvencAvailable ? 'GPU NVENC' : 'CPU libx264';
        originalLog(`[HTTP-TS-TRANSCODE] Ch${channel} transcodificando H.265 -> H.264 (${encoderType})`);
        const encoderArgs = streamManager.getH264EncoderArgs({ scale: '-2:720', cq: 28 });
        
        args = [
            '-hide_banner',
            '-y',
            '-fflags', '+genpts+discardcorrupt',
            '-err_detect', 'ignore_err',
            '-probesize', '100000',
            '-analyzeduration', '100000'
        ];

        // Decodificación acelerada por GPU si está disponible
        if (streamManager.nvencAvailable) {
            args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', 'hevc_cuvid');
        }

        args.push(
            '-f', 'mpegts',
            '-i', '-',
            '-map', '0:v?', '-map', '0:a?',
            ...encoderArgs,
            '-r', '30', // Limitar a 30fps para ahorrar recursos
            '-c:a', 'aac',
            '-b:a', '128k',
            '-f', 'mpegts',
            '-'
        );
    } else {
        originalLog(`[HTTP-TS-DIRECT] Ch${channel} streaming directo (con alineamiento FFmpeg, codec: ${codec || 'no detectado aún'})`);
        args = [
            '-hide_banner',
            '-y',
            '-fflags', '+genpts+discardcorrupt',
            '-err_detect', 'ignore_err',
            '-probesize', '100000',
            '-analyzeduration', '100000',
            '-f', 'mpegts',
            '-i', '-',
            '-map', '0:v?', '-map', '0:a?',
            '-c:v', 'copy',
            '-c:a', 'copy',
            '-f', 'mpegts',
            '-'
        ];
    }
    
    const child = spawn(ffmpegCmd, args);
    
    if (child.stdin) {
        child.stdin.on('error', (err) => {
            // Silenciar tuberías rotas
        });
    }
    child.on('error', (err) => {
        originalLog(`[HTTP-TS] Ch${channel} error de proceso FFmpeg: ${err.message}`);
    });
    
    const subObj = {
        writableLength: 0,
        write(chunk) {
            if (child.killed || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return;
            this.writableLength = child.stdin.writableLength;
            try {
                child.stdin.write(chunk);
            } catch (e) {}
        },
        destroy() {
            try { child.kill('SIGKILL'); } catch(e) {}
        }
    };
    
    routerState.router.subscribers.add(subObj);
    child.stdout.pipe(res);
    
    const cleanup = () => {
        if (routerState && routerState.router) {
            routerState.router.subscribers.delete(subObj);
        }
        try { child.kill('SIGKILL'); } catch(e) {}
        originalLog(`[HTTP-TS] Ch${channel} finalizado`);
    };
    
    req.on('close', cleanup);
    child.on('close', () => {
        if (!res.writableEnded) res.end();
    });
});

app.post('/api/preview/live/:channel', (req, res) => {
    const channel = parseInt(req.params.channel);
    const routerState = streamManager.activeInputs[channel];
    
    if (!routerState || !routerState.router) {
        return res.status(503).json({ error: 'Input not ready', reason: 'router_not_active' });
    }
    
    // Retornamos directamente el stream HTTP-TS sin arrancar FFmpeg extra
    return res.json({ url: `/api/preview/ts/${channel}`, previewId: `ts_ch${channel}`, isMpegTs: true });
});

app.delete('/api/preview/live/:channel', (req, res) => {
    res.json({ ok: true, success: true });
});



/* =======================================
 *  REST API: DISK WIPE (borrado rápido)
 * ======================================= */
app.post('/api/disks/wipe', (req, res) => {
    const { disk_path } = req.body;
    if (!disk_path) return res.status(400).json({ error: 'Missing disk_path' });
    
    // Protección: nunca borrar el disco del sistema operativo
    const forbidden = ['/', 'C:\\', 'C:', '/usr', '/etc', '/home', '/root', '/var', '/boot', '/sys', '/proc'];
    const isForbidden = forbidden.some(f => disk_path === f || disk_path.toLowerCase() === f.toLowerCase());
    if (isForbidden) return res.status(403).json({ error: 'Ruta del sistema protegida. Operación cancelada.' });

    // Es seguro: borrar contenido del disco
    try {
        if (!fs.existsSync(disk_path)) return res.status(404).json({ error: 'Ruta no encontrada' });
        const items = fs.readdirSync(disk_path);
        let removed = 0;
        for (const item of items) {
            const fullPath = path.join(disk_path, item);
            try {
                fs.rmSync(fullPath, { recursive: true, force: true });
                removed++;
            } catch(e) {
                // continue with next file
            }
        }
        res.json({ ok: true, removed });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});


app.get('/api/files', (req, res) => {
    const scanPath = req.query.disk;
    if (!scanPath) return res.json({ currentPath: null, parentPath: null, items: [] });
    
    let targetPath = req.query.path ? path.resolve(req.query.path) : path.resolve(scanPath);
    
    // Seguridad: asegurar que targetPath empieza con scanPath o está dentro de las rutas permitidas
    const resolvedScan = path.resolve(scanPath);
    const allowedRoots = ['/media', '/mnt', '/run/media'];
    
    const isAllowed = targetPath === resolvedScan || targetPath.startsWith(resolvedScan + path.sep) ||
                      allowedRoots.some(root => {
                          const resolvedRoot = path.resolve(root);
                          return targetPath === resolvedRoot || targetPath.startsWith(resolvedRoot + path.sep);
                      });
    
    if (!isAllowed) {
        return res.status(403).json({ error: 'Acceso denegado a la ruta especificada' });
    }
    
    if (!fs.existsSync(targetPath)) {
        return res.json({ currentPath: targetPath, parentPath: null, items: [] });
    }
    
    try {
        const items = fs.readdirSync(targetPath, { withFileTypes: true });
        const results = [];
        
        for (const item of items) {
            const absolutePath = path.join(targetPath, item.name);
            try {
                if (item.isDirectory()) {
                    if (item.name.startsWith('.')) continue;
                    results.push({
                        name: item.name,
                        isDir: true,
                        path: absolutePath
                    });
                } else if (item.isFile() && item.name.match(/\.(mp4|mkv|ts|flv|m3u8)$/i)) {
                    const stat = fs.statSync(absolutePath);
                    results.push({
                        name: item.name,
                        isDir: false,
                        size: stat.size,
                        date: stat.mtime,
                        url: `/api/media/play?path=${encodeURIComponent(absolutePath)}`,
                        absolutePath: absolutePath
                    });
                }
            } catch (statErr) {
                // Ignorar archivos inaccesibles
            }
        }
        
        const dirs = results.filter(r => r.isDir).sort((a, b) => a.name.localeCompare(b.name));
        const files = results.filter(r => !r.isDir).sort((a, b) => b.date - a.date);
        
        const isAtDiskRoot = targetPath === resolvedScan;
        const parentPath = isAtDiskRoot ? null : path.dirname(targetPath);
        
        res.json({
            currentPath: targetPath,
            parentPath: parentPath,
            items: [...dirs, ...files]
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Nuevo endpoint de copia asíncrona de archivos
app.post('/api/files/copy', (req, res) => {
    const { sourcePath, destDiskPath } = req.body;
    if (!sourcePath || !destDiskPath) {
        return res.status(400).json({ error: 'Faltan parámetros: sourcePath o destDiskPath' });
    }

    const resolvedSource = path.resolve(sourcePath);
    const resolvedDestDisk = path.resolve(destDiskPath);

    // Seguridad: verificar rutas permitidas
    const allowedRoots = ['/media', '/mnt', '/run/media'];
    const isSourceAllowed = allowedRoots.some(root => {
        const resolvedRoot = path.resolve(root);
        return resolvedSource.startsWith(resolvedRoot + path.sep);
    });
    const isDestAllowed = allowedRoots.some(root => {
        const resolvedRoot = path.resolve(root);
        return resolvedDestDisk === resolvedRoot || resolvedDestDisk.startsWith(resolvedRoot + path.sep);
    });

    if (!isSourceAllowed || !isDestAllowed) {
        return res.status(403).json({ error: 'Acceso denegado a las rutas de copia' });
    }

    if (!fs.existsSync(resolvedSource)) {
        return res.status(404).json({ error: 'El archivo de origen no existe' });
    }
    if (!fs.existsSync(resolvedDestDisk)) {
        return res.status(404).json({ error: 'El disco de destino no existe o no está montado' });
    }

    const filename = path.basename(resolvedSource);
    const targetDir = path.join(resolvedDestDisk, 'recordings');
    try {
        fs.mkdirSync(targetDir, { recursive: true });
    } catch (e) {
        // Ignorar si no se puede crear, usaremos la raíz del destino
    }
    
    const finalDestPath = path.join(fs.existsSync(targetDir) ? targetDir : resolvedDestDisk, filename);

    if (fs.existsSync(finalDestPath)) {
        return res.status(409).json({ error: 'El archivo ya existe en el destino' });
    }

    res.json({ success: true, message: 'Copia iniciada en segundo plano', filename });

    try {
        const stat = fs.statSync(resolvedSource);
        const totalBytes = stat.size;
        let copiedBytes = 0;
        let lastPercent = -1;

        const readStream = fs.createReadStream(resolvedSource);
        const writeStream = fs.createWriteStream(finalDestPath);

        io.emit('copy_progress', { filename, progress: 0, status: 'copiando', sourcePath: resolvedSource });

        readStream.on('data', (chunk) => {
            copiedBytes += chunk.length;
            const percent = Math.round((copiedBytes / totalBytes) * 100);
            if (percent !== lastPercent) {
                lastPercent = percent;
                io.emit('copy_progress', { filename, progress: percent, status: 'copiando', sourcePath: resolvedSource });
            }
        });

        writeStream.on('finish', () => {
            io.emit('copy_progress', { filename, progress: 100, status: 'completado', sourcePath: resolvedSource });
        });

        const handleCopyError = (err) => {
            console.error(`[COPY] Error copiando ${filename}:`, err.message);
            try { fs.unlinkSync(finalDestPath); } catch (_) {}
            io.emit('copy_progress', { filename, progress: 0, status: 'error', error: err.message, sourcePath: resolvedSource });
        };

        readStream.on('error', handleCopyError);
        writeStream.on('error', handleCopyError);

        readStream.pipe(writeStream);
    } catch (err) {
        console.error(`[COPY] Error inicializando copia para ${filename}:`, err.message);
        io.emit('copy_progress', { filename, progress: 0, status: 'error', error: err.message, sourcePath: resolvedSource });
    }
});

// Play endpoint para bypasear la restriccion del static de /media a carpetas absolutas del OS como /mnt/usb
app.get('/api/media/play', (req, res) => {
    const fpath = req.query.path;
    if (!fpath || !fs.existsSync(fpath)) return res.status(404).send('Not found');
    if (!fpath.includes(mediaRoot) && !fpath.includes('/media') && !fpath.includes('/mnt') && !fpath.includes('\\media')) return res.status(403).send('Forbidden area');
    res.sendFile(fpath);
});

app.post('/api/files/delete', (req, res) => {
    const { filepath } = req.body;
    
    // filepath podria venir como /api/media/play?path=...
    let absolutePath = filepath;
    if(filepath && filepath.includes('?path=')) {
        absolutePath = decodeURIComponent(filepath.split('?path=')[1]);
    }

    if (!absolutePath || !fs.existsSync(absolutePath)) return res.status(400).json({ error: 'Ruta invalida o no existe' });

    // Evita Path Traversal para proteger sistema
    if (!absolutePath.includes(mediaRoot) && !absolutePath.includes('/media') && !absolutePath.includes('/mnt') && !absolutePath.includes('\\media')) {
        return res.status(403).json({ error: 'Acceso denegado a esa ruta' });
    }

    try {
        fs.unlinkSync(absolutePath);
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/ports', (req, res) => {
    db.get('SELECT * FROM ports LIMIT 1', [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

app.put('/api/ports', (req, res) => {
    const { chanMin, chanMax, udpMin, udpMax } = req.body;
    
    db.run('UPDATE ports SET chanMin=?, chanMax=?, udpMin=?, udpMax=?', 
        [chanMin, chanMax, udpMin, udpMax], function(err) {
        
        if (err) return res.status(500).json({ error: err.message });
        res.json({ updated: true });
    });
});

app.get('/api/time', (req, res) => {
    const d = new Date();
    res.json({ 
        time: d.toISOString(),
        timezoneOffset: d.getTimezoneOffset()
    });
});

/* =======================================
 *  NETWORK MANAGEMENT (NMCLI)
 * ======================================= */
app.get('/api/network', (req, res) => {
    const { exec } = require('child_process');
    const os = require('os');
    const fs = require('fs');
    
    // Función de fallback para obtener datos de red reales en caso de que nmcli falle o no controle la interfaz
    const getFallbackNetworkData = (errorMsg) => {
        const interfaces = os.networkInterfaces();
        let ip = '';
        let cidr = '24';
        
        // Priorizar nombres de interfaz físicos reales (eth, eno, enp, ens, wlan, wlp)
        const keys = Object.keys(interfaces).sort((a, b) => {
            const aIsPhys = /^(eth|eno|enp|ens|wlan|wlp)/i.test(a);
            const bIsPhys = /^(eth|eno|enp|ens|wlan|wlp)/i.test(b);
            if (aIsPhys && !bIsPhys) return -1;
            if (!aIsPhys && bIsPhys) return 1;
            return 0;
        });

        for (const name of keys) {
            // Ignorar explícitamente loopback, docker y puentes virtuales
            if (name.startsWith('lo') || name.startsWith('docker') || name.startsWith('veth') || name.startsWith('br-')) {
                continue;
            }
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    ip = iface.address;
                    if (iface.cidr && iface.cidr.includes('/')) {
                        cidr = iface.cidr.split('/')[1];
                    } else if (iface.netmask) {
                        const maskParts = iface.netmask.split('.');
                        let count = 0;
                        for (let p of maskParts) {
                            const val = parseInt(p, 10);
                            count += val.toString(2).replace(/0/g, '').length;
                        }
                        cidr = count.toString();
                    }
                    break;
                }
            }
            if (ip) break;
        }
        
        let gateway = '';
        let dns = '';
        
        if (process.platform === 'linux') {
            try {
                if (fs.existsSync('/proc/net/route')) {
                    const routeContent = fs.readFileSync('/proc/net/route', 'utf8');
                    const lines = routeContent.split('\n');
                    for (let line of lines) {
                        const parts = line.split('\t');
                        if (parts.length > 2 && parts[1] === '00000000') {
                            const gwHex = parts[2];
                            const gwParts = [
                                parseInt(gwHex.substring(6, 8), 16),
                                parseInt(gwHex.substring(4, 6), 16),
                                parseInt(gwHex.substring(2, 4), 16),
                                parseInt(gwHex.substring(0, 2), 16)
                            ];
                            gateway = gwParts.join('.');
                            break;
                        }
                    }
                }
            } catch(e) {}
            
            try {
                if (fs.existsSync('/etc/resolv.conf')) {
                    const resolv = fs.readFileSync('/etc/resolv.conf', 'utf8');
                    const matches = resolv.match(/^nameserver\s+([^\s]+)/gm);
                    if (matches) {
                        dns = matches.map(m => m.replace('nameserver', '').trim()).join(', ');
                    }
                }
            } catch(e) {}
        }
        
        return {
            ok: true,
            connectionName: '',
            mode: 'auto',
            ip: ip || '127.0.0.1',
            cidr: cidr,
            gateway: gateway || '',
            dns: dns || '',
            isFallback: true,
            reason: errorMsg
        };
    };
    
    exec('nmcli -t -f NAME,DEVICE,TYPE con show --active', (err, stdout) => {
        if (err || !stdout) {
            return res.json(getFallbackNetworkData('NetworkManager no disponible o inactivo'));
        }
        
        const lines = stdout.trim().split('\n');
        let activeConn = null;
        let activeDev = null;
        
        // 1. Prioritize physical ethernet connection (excluding virtual interfaces)
        for (let line of lines) {
            const parts = line.split(':');
            if (parts.length >= 3) {
                const name = parts[0];
                const device = parts[1];
                const type = parts[2];
                if ((type === '802-3-ethernet' || type === 'ethernet') && 
                    !device.startsWith('veth') && !device.startsWith('docker') && !device.startsWith('br-') && device !== 'lo') {
                    activeConn = name;
                    activeDev = device;
                    break;
                }
            }
        }
        
        // 2. Fallback to WiFi
        if (!activeConn) {
            for (let line of lines) {
                const parts = line.split(':');
                if (parts.length >= 3) {
                    const name = parts[0];
                    const device = parts[1];
                    const type = parts[2];
                    if (type === '802-11-wireless' || type === 'wifi') {
                        activeConn = name;
                        activeDev = device;
                        break;
                    }
                }
            }
        }

        // 3. Fallback to Bridge (excluding docker / virtual bridges)
        if (!activeConn) {
            for (let line of lines) {
                const parts = line.split(':');
                if (parts.length >= 3) {
                    const name = parts[0];
                    const device = parts[1];
                    const type = parts[2];
                    if (type === 'bridge' && !device.startsWith('docker') && !device.startsWith('br-')) {
                        activeConn = name;
                        activeDev = device;
                        break;
                    }
                }
            }
        }
        
        if (!activeConn || !activeDev) {
            return res.json(getFallbackNetworkData('No se encontró conexión de red activa compatible con nmcli'));
        }
        
        // 1. Obtener la configuración del método (auto o manual) desde el perfil de conexión
        exec(`nmcli -t -f ipv4.method con show "${activeConn}"`, (err2, stdout2) => {
            let mode = 'auto';
            if (!err2 && stdout2) {
                const lines2 = stdout2.trim().split('\n');
                for (let l of lines2) {
                    if (l.startsWith('ipv4.method:')) {
                        const m = l.replace('ipv4.method:', '').trim();
                        if (m === 'manual') mode = 'manual';
                    }
                }
            }
            
            // 2. Obtener la IP, gateway y DNS activos reales del dispositivo en ejecución
            exec(`nmcli -t dev show "${activeDev}"`, (err3, stdout3) => {
                if (err3 || !stdout3) {
                    return res.json(getFallbackNetworkData('Error leyendo detalles del dispositivo con nmcli'));
                }
                
                const details = stdout3.trim().split('\n').reduce((acc, line) => {
                    const parts = line.split(':');
                    if (parts.length >= 2) {
                        const key = parts[0].trim().toUpperCase();
                        const val = parts.slice(1).join(':').replace(/\\/g, '').trim();
                        acc[key] = val;
                    }
                    return acc;
                }, {});
                
                let addressRaw = '';
                for (let k of Object.keys(details)) {
                    if (k.startsWith('IP4.ADDRESS')) {
                        addressRaw = details[k];
                        break;
                    }
                }
                
                const [ip, cidr] = addressRaw.split('/');
                
                let gateway = '';
                for (let k of Object.keys(details)) {
                    if (k.startsWith('IP4.GATEWAY')) {
                        gateway = details[k];
                        break;
                    }
                }
                
                const dnsList = [];
                for (let k of Object.keys(details)) {
                    if (k.startsWith('IP4.DNS')) {
                        dnsList.push(details[k]);
                    }
                }
                const dns = dnsList.join(', ');
                
                res.json({
                    ok: true,
                    connectionName: activeConn,
                    mode: mode,
                    ip: ip || '',
                    cidr: cidr || '24',
                    gateway: gateway || '',
                    dns: dns || '',
                    isFallback: false
                });
            });
        });
    });
});

app.post('/api/network', (req, res) => {
    const { exec } = require('child_process');
    const { connectionName, mode, ip, cidr, gateway, dns } = req.body;
    
    if (!connectionName) return res.status(400).json({ ok: false, error: 'Falta connectionName' });
    
    let cmd = '';
    if (mode === 'auto') {
        cmd = `nmcli con mod "${connectionName}" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns "" && nmcli con up "${connectionName}"`;
    } else {
        const dnsCmd = dns ? `ipv4.dns "${dns}"` : `ipv4.dns ""`;
        cmd = `nmcli con mod "${connectionName}" ipv4.method manual ipv4.addresses "${ip}/${cidr}" ipv4.gateway "${gateway}" ${dnsCmd} && nmcli con up "${connectionName}"`;
    }
    
    res.json({ ok: true, message: 'Aplicando configuración...' });
    
    setTimeout(() => {
        exec(cmd, (err) => {
            if (err) console.error('[NETWORK] Error applying config:', err.message);
            else console.log(`[NETWORK] Aplicado en ${connectionName}.`);
        });
    }, 1000);
});

app.post('/api/terminal/run', (req, res) => {
    const { exec } = require('child_process');
    const { command } = req.body;
    
    if (!command) {
        return res.status(400).json({ error: 'Falta el comando' });
    }
    
    // Filtro de seguridad básico: no permitir comandos destructivos críticos
    if (command.includes('rm -rf /') || command.includes('mkfs')) {
        return res.status(403).json({ error: 'Comando no permitido por seguridad' });
    }

    // Ejecuta el comando con límite de tiempo de 30 segundos
    exec(command, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        res.json({
            stdout: stdout || '',
            stderr: stderr || '',
            code: error ? error.code : 0
        });
    });
});

/* =======================================
 *  BOOT SEQUENCE & WEBSOCKETS
 * ======================================= */

// Boot active streams based on DB state (Resume capability)
function bootActiveStreams() {
    console.log("[BOOT] Iniciando secuencia de encendido escalonado de Streams...");
    setTimeout(() => {
        db.all('SELECT * FROM inputs WHERE enabled = 1', [], (err, rows) => {
            if(rows && rows.length > 0) {
                let delayAccumulator = 0;
                
                // Stagger inputs by 200ms each to prevent CPU max-out
                rows.forEach(r => {
                    setTimeout(() => streamManager.startInput(r), delayAccumulator);
                    delayAccumulator += 200;
                });
                
                // Wait for all inputs to bind their UDP ports, then stagger outputs
                db.all('SELECT * FROM outputs WHERE enabled = 1', [], (err, outRows) => {
                    if(outRows && outRows.length > 0) {
                        outRows.forEach(o => {
                            setTimeout(() => streamManager.startOutput(o), delayAccumulator);
                            delayAccumulator += 200;
                        });
                    }
                });
            }
        });
    }, 1000);
}
bootActiveStreams();

io.on('connection', (socket) => {
    console.log(`Frontend Connected: ${socket.id}`);
    
    // Al conectarse el frontend, le enviamos las estadísticas inmediatamente
    // a través del Socket.io global (sysMonitor lo emite automáticamente a todos los conectados)
});

// Redirigir el handshake WebSocket al wss (comparte puerto 4000)
// IMPORTANTE: NO destruir sockets no-/live/ — socket.io tiene su propio listener de upgrade
server.on('upgrade', (request, socket, head) => {
    if (request.url && request.url.startsWith('/live/')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    }
    // Si no es /live/, socket.io lo gestiona con su propio listener — no tocar
});

// Start Server
const PORT = process.env.PORT || 4000;
let _listenRetries = 0;
const _MAX_LISTEN_RETRIES = 15; // 15 x 4s = 60s máx

function startListen() {
    server.listen(PORT, '0.0.0.0', () => {
        _listenRetries = 0;
        console.log(`TSST SERVER running on port ${PORT}`);
    });
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        _listenRetries++;
        if (_listenRetries > _MAX_LISTEN_RETRIES) {
            originalLog(`[SERVER] Puerto ${PORT} no disponible tras ${_MAX_LISTEN_RETRIES} intentos.`);
            originalLog(`[SERVER] Asegúrate de que no hay otro proceso en el puerto ${PORT} y reinicia.`);
            process.exit(1);
        }
        originalLog(`[SERVER] Port ${PORT} busy (TIME_WAIT), retrying in 4s... (${_listenRetries}/${_MAX_LISTEN_RETRIES})`);
        setTimeout(startListen, 4000);
    } else {
        originalLog(`[SERVER] Fatal error: ${err.message}`);
        process.exit(1);
    }
});

startListen();


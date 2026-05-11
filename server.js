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
        if (row && row.value && fs.existsSync(row.value)) {
            mediaRoot = row.value;
            registerMediaStatic(mediaRoot);
            console.log(`[STORAGE] Disco cargado desde DB: ${mediaRoot}`);
        } else {
            // Fallback a auto-detect
            const detected = detectExternalDisk();
            if (detected) {
                const recDir = path.join(detected, 'recordings');
                try { fs.mkdirSync(recDir, { recursive: true }); } catch(e) {}
                mediaRoot = recDir;
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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    // Re-detectar por si el disco se conectó después de arrancar
    if (!mediaRoot) {
        const detected = detectExternalDisk();
        if (detected) {
            const recDir = path.join(detected, 'recordings');
            try { fs.mkdirSync(recDir, { recursive: true }); } catch(e) {}
            mediaRoot = recDir;
            console.log(`[STORAGE] Disco detectado en caliente: ${mediaRoot}`);
        }
    }
    if (!mediaRoot) {
        return res.json({ available: false, path: null, message: 'No hay disco externo conectado. Conecta un USB o configura MEDIA_ROOT en .env' });
    }
    try {
        const stat = fs.statfsSync ? fs.statfsSync(mediaRoot) : null;
        const freeGB = stat ? ((stat.bfree * stat.bsize) / 1e9).toFixed(1) : null;
        res.json({ available: true, path: mediaRoot, freeGB });
    } catch(e) {
        res.json({ available: true, path: mediaRoot, freeGB: null });
    }
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

        // 2. Intentar lanzar Chromium/Chrome en ese display
        const candidates = [
            'chromium-browser',
            'chromium',
            'google-chrome',
            'google-chrome-stable',
            'brave-browser',
            'firefox'  // fallback final
        ];

        const isFirefox = (bin) => bin === 'firefox';

        function tryLaunch(index) {
            if (index >= candidates.length) {
                console.log('[MONITOR] No se encontró ningún navegador instalado.');
                return res.json({ ok: false, reason: 'no_browser', fallback: true });
            }
            const bin = candidates[index];
            // Verificar si existe antes de lanzar
            exec(`which ${bin}`, (werr, wout) => {
                if (werr || !wout.trim()) return tryLaunch(index + 1);

                const args = isFirefox(bin)
                    ? [`--new-window`, monitorUrl,
                       `--screen`, `${secondaryDisplay.x},${secondaryDisplay.y}`]
                    : [
                        `--app=${monitorUrl}`,
                        `--start-fullscreen`,
                        `--new-window`,
                        `--window-position=${secondaryDisplay.x},${secondaryDisplay.y}`,
                        `--window-size=${secondaryDisplay.width},${secondaryDisplay.height}`,
                        `--disable-infobars`,
                        `--noerrdialogs`
                      ];

                console.log(`[MONITOR] Lanzando ${bin} ${args.join(' ')}`);
                const child = spawn(bin, args, {
                    detached: true,
                    stdio: 'ignore',
                    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' }
                });
                child.unref();
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
        res.json(rows);
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
                const args = [
                    '-hide_banner', '-y',
                    '-fflags', '+genpts',
                    '-thread_queue_size', '4096',
                    '-i', `tcp://127.0.0.1:${recPort}?listen`,

                    // --- HLS output (stream copy, cámara ya es H.264/HEVC) ---
                    '-map', '0:v?', '-map', '0:a?',
                    '-c:v', 'copy',
                    '-c:a', 'aac', '-b:a', '128k',
                    '-bsf:a', 'aac_adtstoasc',  // ← Fix: AAC ADTS→ASC para HLS/MP4
                    '-hls_time', '2',
                    '-hls_list_size', '0',
                    '-hls_segment_type', 'mpegts',
                    '-f', 'hls', hlsPath,

                    // --- MP4 output (stream copy, calidad original) ---
                    '-map', '0:v?', '-map', '0:a?',
                    '-c', 'copy',
                    '-bsf:a', 'aac_adtstoasc',  // ← Fix: evita "Malformed AAC" y error writing trailer
                    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
                    '-f', 'mp4', mp4Path
                ];

                console.log(`[REC-START] Session ${sessionId} ch${input.channel} via TCP router :${recPort}`);
                const child = spawn(ffmpegCmd, args);

                // Throttle stderr — solo errores reales, silenciar warnings de HEVC/AAC ya corregidos
                let lastRecLog = 0;
                child.stderr.on('data', d => {
                    const text = d.toString();
                    // Ignorar warnings conocidos y no críticos (PPS HEVC, NALU skip, AAC ya corregido)
                    const isKnownNoise = /PPS id out of range|Skipping invalid undecodable NALU|aac_adtstoasc|Last message repeated|Malformed AAC/i.test(text);
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
            res.json({ session_id: sessionId, message: `Started ${inputs.length} recordings.` });
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
    db.run('UPDATE recording_sessions SET end_time = ? WHERE id = ?',
        [new Date().toISOString(), sessionId]);

    io.emit('db_update', { event: 'outputs_changed' });
    res.json({ stopped: procs.length, session_id: sessionId });
});


// Export clip from MP4 using fast stream-copy (no re-encode)
app.post('/api/recordings/export', (req, res) => {
    const { session_id, channel, start_time, end_time, label } = req.body;

    if (!session_id || start_time == null || end_time == null)
        return res.status(400).json({ error: 'Missing parameters' });

    // First try to get the MP4 path from session_files
    db.get('SELECT * FROM session_files WHERE session_id = ? AND channel = ?',
        [session_id, channel], (err, fileRow) => {

        const getSourcePath = (cb) => {
            if (fileRow && fileRow.mp4_path && fs.existsSync(fileRow.mp4_path))
                return cb(fileRow.mp4_path);
            // Fallback: try HLS path
            if (fileRow && fileRow.hls_path && fs.existsSync(fileRow.hls_path))
                return cb(fileRow.hls_path);
            return res.status(404).json({ error: 'Recording file not found on disk' });
        };

        getSourcePath(sourcePath => {
            // Nombre: ClipLabel_YYYYMMDD_HHMMSS.mp4
            const now = new Date();
            const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
            const timeStr = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
            const clipLabel = (label || `clip_${Math.floor(start_time)}s`).replace(/[^a-zA-Z0-9_\- ]/g, '_').trim();
            const exportName = `${clipLabel}_${dateStr}_${timeStr}.mp4`;

            // Destino: si envían dest_path usarlo, si no, usar local mediaRoot
            const destDir = req.body.dest_path || mediaRoot;
            if (!destDir) return res.status(503).json({ error: 'No hay disco de grabación configurado' });
            const exportPath = path.join(destDir, exportName);

            const ffmpegBin = streamManager.getFFmpegPath();

            // Verificar que el binario existe antes de lanzar
            if (!fs.existsSync(ffmpegBin)) {
                return res.status(500).json({ error: `FFmpeg no encontrado en: ${ffmpegBin}` });
            }

            const args = [
                '-hide_banner', '-y',
                '-ss', start_time.toString(),
                '-i', sourcePath,
                '-t', (end_time - start_time).toString(),
                '-c', 'copy',
                exportPath
            ];

            console.log(`[EXPORT] ${exportName} from ${start_time}s to ${end_time}s`);
            let responded = false;
            const child = spawn(ffmpegBin, args);

            child.on('error', (err) => {
                console.error(`[EXPORT] FFmpeg spawn error: ${err.message}`);
                if (!responded) {
                    responded = true;
                    res.status(500).json({ error: `FFmpeg error: ${err.message}` });
                }
            });

            child.on('close', code => {
                console.log(`[EXPORT] Done: ${exportName} (code ${code})`);
                io.emit('server_log', { timestamp: new Date().toISOString(), level: 'INFO',
                    message: `Clip exportado: ${exportName} (code ${code})` });
            });

            if (!responded) {
                responded = true;
                res.json({ started: true, filename: exportName });
            }
        });

    });
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

        const addDrive = (mountPath, label, freeGB, totalGB, usedPct) => {
            if (seen.has(mountPath)) return;
            seen.add(mountPath);
            drives.push({
                id:      mountPath.replace(/[:\\/]/g, '_'),
                name:    `[${label}] ${mountPath}`,
                path:    mountPath,
                freeGB:  freeGB  || null,
                totalGB: totalGB || null,
                usedPct: usedPct || null,
                active:  mediaRoot && (mediaRoot === mountPath || mediaRoot.startsWith(mountPath + '/'))
            });
        };

        // Fuente 1: systeminformation
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
                addDrive(f.mount, f.fs || 'disk', freeGB, totalGB, usedPct);
            });
        } catch (_) {}

        // Fuente 2: /proc/mounts (Linux, más fiable en ARM/Raspberry)
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
                    try {
                        const { execSync } = require('child_process');
                        const dfOut = execSync(`df -B1 "${mount}" 2>/dev/null | tail -1`, { timeout: 3000 }).toString().trim();
                        const parts = dfOut.split(/\s+/);
                        addDrive(mount, fsType,
                            parts[3] ? (parseInt(parts[3]) / 1e9).toFixed(1) : null,
                            parts[1] ? (parseInt(parts[1]) / 1e9).toFixed(1) : null,
                            parts[4] ? parseInt(parts[4]) : null);
                    } catch (_) {
                        addDrive(mount, fsType, null, null, null);
                    }
                }
            } catch (_) {}
        }

        // Fuente 3: mediaRoot activo (incluirlo siempre si existe)
        if (mediaRoot && fs.existsSync(mediaRoot) && !seen.has(mediaRoot)) {
            addDrive(mediaRoot, 'activo', null, null, null);
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
// Mapa en memoria de procesos de preview HLS activos: { channel -> { proc, hlsPath, sock, pending } }
const livePreviewProcs = {};
// Lock por canal para evitar requests simultáneos que spawnen múltiples FFmpeg
const livePreviewPending = {};

app.post('/api/preview/live/:channel', (req, res) => {
    const channel = parseInt(req.params.channel);
    const net = require('net');

    // ── Lock: si ya hay una petición en curso para este canal, ESPERAR en lugar de rechazar ──
    if (livePreviewPending[channel]) {
        // Esperar hasta 15s a que el proceso en marcha termine y tenga URL
        const waitStart = Date.now();
        const waitForPending = () => {
            if (res.headersSent) return;
            // Si ya terminó el lock y hay URL disponible, devolverla
            if (!livePreviewPending[channel] && livePreviewProcs[channel]) {
                const name = path.basename(livePreviewProcs[channel].hlsPath);
                if (fs.existsSync(livePreviewProcs[channel].hlsPath)) {
                    return res.json({ url: `/preview/${name}`, previewId: livePreviewProcs[channel].previewId, reused: true });
                }
            }
            if (Date.now() - waitStart > 15000) {
                return res.status(504).json({ error: 'Preview timeout waiting for lock', reason: 'lock_timeout' });
            }
            setTimeout(waitForPending, 500);
        };
        return waitForPending();
    }

    // ── Si ya hay un preview activo y funcionando, reutilizarlo ──
    if (livePreviewProcs[channel] && livePreviewProcs[channel].proc && livePreviewProcs[channel].proc.exitCode === null) {
        const existingHlsName = path.basename(livePreviewProcs[channel].hlsPath);
        const existingHlsUrl  = `/preview/${existingHlsName}`;
        if (fs.existsSync(livePreviewProcs[channel].hlsPath)) {
            return res.json({ url: existingHlsUrl, previewId: livePreviewProcs[channel].previewId, reused: true });
        }
    }

    // Detener preview anterior si existe (proceso muerto o inservible)
    if (livePreviewProcs[channel]) {
        try { livePreviewProcs[channel].proc.kill('SIGKILL'); } catch(e) {}
        if (livePreviewProcs[channel].sock) { try { livePreviewProcs[channel].sock.destroy(); } catch(e) {} }
        delete livePreviewProcs[channel];
    }

    const routerState = streamManager.activeInputs[channel];
    if (!routerState || !routerState.router) {
        return res.status(503).json({ error: 'Input not ready', reason: 'router_not_active' });
    }

    const { spawn } = require('child_process');
    const ffmpegCmd = streamManager.getFFmpegPath();

    const previewId = `preview_ch${channel}_${Date.now()}`;
    const hlsPath   = path.join(previewRoot, `${previewId}.m3u8`);
    const tcpPort   = 43000 + channel;

    const args = [
        '-hide_banner', '-y',
        '-fflags', '+genpts',
        '-thread_queue_size', '4096',
        '-i', `tcp://127.0.0.1:${tcpPort}?listen`,
        '-map', '0:v?', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '28',
        '-vf', 'scale=-2:720',
        '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '96k',
        '-bsf:a', 'aac_adtstoasc',
        '-hls_time', '2',
        '-hls_list_size', '4',
        '-hls_flags', 'delete_segments+append_list',
        '-hls_segment_type', 'mpegts',
        '-f', 'hls', hlsPath
    ];

    // Activar lock antes de hacer spawn
    livePreviewPending[channel] = true;

    const proc = spawn(ffmpegCmd, args);
    livePreviewProcs[channel] = { proc, hlsPath, previewId, sock: null };

    // Silenciar stderr del preview (solo loguear errores fatales)
    proc.stderr.on('data', (d) => {
        const txt = d.toString();
        if (/error|invalid|unable/i.test(txt) && !/Last message|repeated/i.test(txt)) {
            const line = txt.split('\n')[0].trim();
            if (line) originalLog(`[PREVIEW-ERR ch${channel}] ${line}`);
        }
    });

    proc.on('exit', code => {
        if (livePreviewProcs[channel] && livePreviewProcs[channel].proc === proc) {
            delete livePreviewProcs[channel];
        }
        delete livePreviewPending[channel];
    });

    // Conectar al router de la cámara (1.5 s para que FFmpeg abra el socket TCP)
    // IMPORTANTE: releer streamManager.activeInputs en el momento de conectar,
    // no usar routerState capturado (puede estar obsoleto si el SRT se reconectó)
    setTimeout(() => {
        if (!livePreviewProcs[channel] || livePreviewProcs[channel].proc !== proc) return;
        const sock = net.createConnection(tcpPort, '127.0.0.1', () => {
            const currentRouter = streamManager.activeInputs[channel]?.router;
            if (currentRouter) currentRouter.subscribers.add(sock);
            originalLog(`[PREVIEW] Ch${channel} conectado al router TCP :${tcpPort}`);
        });
        sock.on('error', () => {});
        sock.on('close', () => {
            const currentRouter = streamManager.activeInputs[channel]?.router;
            if (currentRouter) currentRouter.subscribers.delete(sock);
        });
        livePreviewProcs[channel].sock = sock;
    }, 1500);

    // ── Esperar a que FFmpeg genere el .m3u8 ──
    const hlsName   = path.basename(hlsPath);
    const hlsUrl    = `/preview/${hlsName}`;
    const maxWaitMs = 15000;
    const pollMs    = 500;   // Aumentar intervalo a 500ms (antes 250ms) para reducir CPU
    let   elapsed   = 0;

    const waitForFile = () => {
        if (res.headersSent) { delete livePreviewPending[channel]; return; }
        if (fs.existsSync(hlsPath)) {
            // Solo log silencioso, no al broadcastLog para no llenar el panel de logs
            originalLog(`[PREVIEW] Ch${channel} HLS listo: ${hlsName} (${elapsed}ms)`);
            delete livePreviewPending[channel];
            return res.json({ url: hlsUrl, previewId });
        }
        elapsed += pollMs;
        if (elapsed >= maxWaitMs) {
            // Solo log silencioso
            originalLog(`[PREVIEW] Ch${channel} timeout esperando HLS — FFmpeg pudo fallar`);
            delete livePreviewPending[channel];
            return res.status(504).json({ error: 'HLS stream timeout', reason: 'ffmpeg_timeout' });
        }
        setTimeout(waitForFile, pollMs);
    };
    setTimeout(waitForFile, 2000);
});

app.delete('/api/preview/live/:channel', (req, res) => {
    const channel = parseInt(req.params.channel);
    if (livePreviewProcs[channel]) {
        try { livePreviewProcs[channel].proc.kill('SIGKILL'); } catch(e) {}
        if (livePreviewProcs[channel].sock) { try { livePreviewProcs[channel].sock.destroy(); } catch(e) {} }
        delete livePreviewProcs[channel];
    }
    res.json({ ok: true });
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
    // ParentDisk es ahora una ruta ABSOLUTA enviada desde el frontend
    const scanPath = req.query.disk;
    if (!scanPath) return res.json([]);
    
    try {
        if (!fs.existsSync(scanPath)) return res.json([]);
        const files = [];
        
        // Scan recursivo simple o de 1 nivel
        const items = fs.readdirSync(scanPath, { withFileTypes: true });
        for (const item of items) {
            if (item.isFile() && item.name.match(/\.(mp4|mkv|ts|flv|m3u8)$/i)) {
                const absolutePath = path.join(scanPath, item.name);
                const stat = fs.statSync(absolutePath);
                files.push({
                    name: item.name,
                    size: stat.size,
                    date: stat.mtime,
                    // Devolvemos el absolutePath bruto, y usaremos una url especial para cargar videos absolutos
                    url: `/api/media/play?path=${encodeURIComponent(absolutePath)}`, 
                    absolutePath: absolutePath
                });
            }
        }
        res.json(files.sort((a,b) => b.date - a.date)); // Fechas más recientes primero
    } catch (e) {
        res.status(500).json({ error: e.message });
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

/* =======================================
 *  NETWORK MANAGEMENT (NMCLI)
 * ======================================= */
app.get('/api/network', (req, res) => {
    const { exec } = require('child_process');
    
    exec('nmcli -t -f NAME,TYPE,STATE con show --active', (err, stdout) => {
        if (err || !stdout) return res.json({ ok: false, error: 'nmcli no disponible', fallback: true });
        
        const lines = stdout.trim().split('\n');
        let activeConn = null;
        for (let line of lines) {
            const [name, type, state] = line.split(':');
            if ((type === '802-3-ethernet' || type === 'ethernet') && state === 'activated') {
                activeConn = name;
                break;
            }
        }
        
        if (!activeConn) return res.json({ ok: false, error: 'No se encontró conexión Ethernet activa', fallback: true });
        
        exec(`nmcli -t -f ipv4.method,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS con show "${activeConn}"`, (err2, stdout2) => {
            if (err2 || !stdout2) return res.json({ ok: false, error: 'Error leyendo configuración' });
            
            const details = stdout2.trim().split('\n').reduce((acc, line) => {
                const parts = line.split(':');
                acc[parts[0]] = parts.slice(1).join(':');
                return acc;
            }, {});
            
            const addressRaw = details['IP4.ADDRESS[1]'] || details['IP4.ADDRESS'] || '';
            const [ip, cidr] = addressRaw.split('/');
            
            res.json({
                ok: true,
                connectionName: activeConn,
                mode: details['ipv4.method'] === 'manual' ? 'manual' : 'auto',
                ip: ip || '',
                cidr: cidr || '24',
                gateway: details['IP4.GATEWAY'] || '',
                dns: details['IP4.DNS[1]'] || details['IP4.DNS'] || ''
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


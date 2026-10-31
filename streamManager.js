const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const db = require('./db');

let ioInstance = null;
function setIo(io) { ioInstance = io; }

// ── OUTPUTS DESACTIVADOS ──────────────────────────────────────────────────────
// Las señales de entrada SÓLO se usan para preview HLS y grabación a disco.
// Re-emitir a destinos externos (SRT/RTMP/disk outputs) nunca se usa en producción
// y consume procesos FFmpeg innecesarios. Para reactivarlos, cambiar a true.
const OUTPUTS_ENABLED = false;
// ─────────────────────────────────────────────────────────────────────────────

// ── BACKPRESSURE DEL ROUTER ──────────────────────────────────────────────────
// Bytes máximos pendientes de escribir por suscriptor antes de actuar.
// Un cliente lento (navegador, disco USB atascado...) NUNCA debe hacer crecer la RAM
// del servidor sin límite: con 8 cámaras a 10 Mbps un solo cliente colgado acumulaba
// ~10 MB/s hasta tumbar Node.
//  - viewer/thumb/output: se desconecta al suscriptor (el cliente reconecta solo).
//  - recorder: nunca se desconecta; si el disco no da abasto se descartan paquetes
//    (FFmpeg resincroniza el MPEG-TS) para no perder la grabación entera.
const MAX_PENDING_BYTES = {
    viewer: 8 * 1024 * 1024,
    thumb: 16 * 1024 * 1024,
    output: 32 * 1024 * 1024,
    recorder: 64 * 1024 * 1024,
};

// ── RECONEXIÓN / WATCHDOG DE INGESTA ─────────────────────────────────────────
const RESTART_MIN_MS = 2000;       // primer reintento rápido tras una caída
const RESTART_MAX_MS = 10000;      // backoff máximo
const STALL_TIMEOUT_MS = 15000;    // sin datos durante 15 s con FFmpeg vivo → matar y reconectar
const FIRST_DATA_TIMEOUT_MS = 25000; // fuentes "pull" que no entregan nada tras arrancar
const STABLE_RESET_MS = 30000;     // tras 30 s estable se resetea el backoff
// ─────────────────────────────────────────────────────────────────────────────

// Locate FFmpeg binary (handles Windows local download vs Linux global).
// Se cachea: antes se hacía un readdirSync/existsSync en cada spawn.
let ffmpegPathCache = null;
function getFFmpegPath() {
    if (ffmpegPathCache) return ffmpegPathCache;
    ffmpegPathCache = 'ffmpeg'; // Linux / Docker: binario del sistema
    if (os.platform() === 'win32') {
        const binDir = path.join(__dirname, 'ffmpeg_bin');
        try {
            for (const sub of fs.readdirSync(binDir)) {
                const exePath = path.join(binDir, sub, 'bin', 'ffmpeg.exe');
                if (fs.existsSync(exePath)) { ffmpegPathCache = exePath; break; }
            }
        } catch (e) { }
    }
    return ffmpegPathCache;
}

// Bajar la prioridad de procesos secundarios (thumbnails, exports, transcodificaciones)
// para que nunca roben CPU a la ingesta y a la grabación en directo.
function lowerPriority(child) {
    if (!child || !child.pid) return;
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { }
}

// ── DETECCIÓN AUTOMÁTICA DE GPU NVIDIA NVENC ─────────────────────────────────
// Asíncrona: antes era un execSync que bloqueaba el arranque hasta 5 s.
let nvencAvailable = false;
execFile(getFFmpegPath(), ['-hide_banner', '-encoders'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
    if (!err && stdout && stdout.includes('h264_nvenc')) {
        nvencAvailable = true;
        console.log('[GPU] ✅ NVIDIA NVENC detectado — transcodificación H.265→H.264 usará GPU');
    } else if (err) {
        console.log('[GPU] ℹ️  No se pudo detectar NVENC — usando CPU (libx264)');
    } else {
        console.log('[GPU] ℹ️  NVENC no disponible — transcodificación usará CPU (libx264)');
    }
});

/**
 * Devuelve los argumentos de FFmpeg para transcodificar a H.264.
 * Si NVENC está disponible, usa GPU; si no, usa CPU con libx264.
 * @param {object} opts - Opciones opcionales { scale: '-2:720', cq: 28 }
 * @returns {string[]} Array de argumentos FFmpeg para el encoder de vídeo
 */
function getH264EncoderArgs(opts = {}) {
    const scale = opts.scale || '-2:720';
    // Solo usar NVENC si se pidió explícitamente hwaccel='cuda' Y NVENC está disponible.
    // Cuando el codec es desconocido o no se usa CUDA, siempre CPU (libx264) — seguro y fiable.
    if (nvencAvailable && (opts.hwaccel === 'cuda' || opts.useNvenc)) {
        // Encodificación en GPU (NVENC) pero manteniendo escalado y decodificación en CPU.
        // Esto es mucho más estable para streams MPEG-TS inestables o provenientes de stdin.
        return [
            '-c:v', 'h264_nvenc',
            '-preset', 'p4',
            '-rc', 'vbr',
            '-cq', String(opts.cq || 28),
            '-vf', `scale=${scale}`,
            '-pix_fmt', 'yuv420p',
        ];
    }
    // CPU fallback: libx264 ultrafast — funciona siempre
    return [
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', String(opts.cq || 28),
        '-threads', '2',
        '-vf', `scale=${scale}`,
        '-pix_fmt', 'yuv420p',
    ];
}

// In-memory store for active processes
const activeInputs = {};
const activeOutputs = {};
const telemetryCache = {};
const persistentCodecs = {};

function emitStats(payload) {
    if (ioInstance) ioInstance.emit('stats', payload);
}

function pushTelemetry(key, value) {
    if (!telemetryCache[key]) telemetryCache[key] = [];
    telemetryCache[key].push({ t: new Date().toLocaleTimeString(), y: value });
    if (telemetryCache[key].length > 60) telemetryCache[key].shift(); // Keep last 60 points
    return telemetryCache[key];
}

/* =========================================================================
 *  ROUTER TCP PERSISTENTE POR CANAL
 *  FFmpeg de ingesta → TCP 127.0.0.1:udpsrv → Node → N suscriptores
 *  (grabación, live WS/HTTP, thumbnails). El router y sus suscriptores
 *  SOBREVIVEN a los reinicios de FFmpeg: si la cámara cae y vuelve, la grabación
 *  sigue en el mismo proceso/fichero en lugar de quedarse colgada o sobrescribirse.
 *
 *  Contrato de suscriptor: { kind, write(chunk), pending(): bytes, destroy() }
 * ========================================================================= */
function safeDestroy(sub) {
    try { if (sub && typeof sub.destroy === 'function') sub.destroy(); } catch (e) { }
}

function pendingBytes(sub) {
    try {
        if (typeof sub.pending === 'function') return sub.pending() || 0;
        return sub.writableLength || 0;
    } catch (e) { return 0; }
}

function fanOut(router, channel, chunk) {
    for (const sub of router.subscribers) {
        const kind = sub.kind || 'viewer';
        const limit = MAX_PENDING_BYTES[kind] || MAX_PENDING_BYTES.viewer;
        if (pendingBytes(sub) > limit) {
            if (kind === 'recorder') {
                // Disco atascado: descartar este bloque en lugar de acumular RAM
                sub.droppedBytes = (sub.droppedBytes || 0) + chunk.length;
                const now = Date.now();
                if (!sub.lastDropLog || now - sub.lastDropLog > 5000) {
                    sub.lastDropLog = now;
                    console.error(`[ROUTER ${channel}] ⚠️ Grabación no da abasto (disco lento): ${(sub.droppedBytes / 1048576).toFixed(1)} MB descartados`);
                }
                continue;
            }
            router.subscribers.delete(sub);
            safeDestroy(sub);
            console.log(`[ROUTER ${channel}] Cliente lento (${kind}) desconectado para proteger la memoria.`);
            continue;
        }
        try {
            sub.write(chunk);
        } catch (e) {
            router.subscribers.delete(sub);
            safeDestroy(sub);
        }
    }
}

function createRouter(state, onListening) {
    const channel = state.channel;
    const port = state.inputObj.udpsrv;

    const router = net.createServer((socket) => {
        // Solo una ingesta activa: si FFmpeg se reinicia y reconecta, la conexión antigua sobra
        if (router.ingestSocket && router.ingestSocket !== socket) {
            router.ingestSocket.destroy();
        }
        router.ingestSocket = socket;
        socket.setNoDelay(true);
        socket.on('data', (data) => {
            router.lastDataAt = Date.now();
            fanOut(router, channel, data);
        });
        socket.on('error', () => { });
        socket.on('close', () => {
            if (router.ingestSocket === socket) router.ingestSocket = null;
        });
    });
    router.subscribers = new Set();
    router.port = port;
    router.ingestSocket = null;
    router.lastDataAt = 0;
    router.listening = false;

    let retries = 0;
    const bind = () => router.listen(port, '127.0.0.1');
    router.on('listening', () => {
        router.listening = true;
        console.log(`[ROUTER] Channel ${channel} bound on TCP ${port}`);
        if (onListening) { const cb = onListening; onListening = null; cb(); }
    });
    router.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && !router.closed) {
            retries++;
            if (retries > 6) {
                console.error(`[ROUTER ${channel}] Port ${port} permanently busy after ${retries} retries. Giving up.`);
                return;
            }
            console.log(`[ROUTER ${channel}] Port ${port} busy, retry ${retries}/6 in 5s...`);
            setTimeout(() => { if (!router.closed) bind(); }, 5000);
        } else {
            console.error(`[ROUTER ${channel}] TCP Socket Error:`, err.message);
        }
    });
    bind();
    return router;
}

function closeRouter(router) {
    if (!router) return;
    router.closed = true;
    for (const sub of router.subscribers) safeDestroy(sub);
    router.subscribers.clear();
    if (router.ingestSocket) { router.ingestSocket.destroy(); router.ingestSocket = null; }
    try { router.close(); } catch (e) { }
}

// Suscribir a un canal. Devuelve false si el canal no existe.
function addSubscriber(channel, sub) {
    const state = activeInputs[channel];
    if (!state || !state.router || state.router.closed) return false;
    state.router.subscribers.add(sub);
    return true;
}

function removeSubscriber(channel, sub) {
    const state = activeInputs[channel];
    if (state && state.router) state.router.subscribers.delete(sub);
}

// Tras una caída de la cámara: los visores y thumbnails se cierran (el navegador
// reconecta limpio al nuevo stream); las grabaciones se mantienen enganchadas.
function dropTransientSubscribers(router) {
    for (const sub of router.subscribers) {
        if (sub.kind === 'recorder' || sub.kind === 'output') continue;
        router.subscribers.delete(sub);
        safeDestroy(sub);
    }
}

// Canal con proceso de ingesta vivo (criterio de "online" para la UI)
function isInputOnline(channel) {
    const s = activeInputs[channel];
    return !!(s && !s.isStopping && s.process);
}

// Canal recibiendo datos ahora mismo
function hasSignal(channel, maxAgeMs = 5000) {
    const s = activeInputs[channel];
    return !!(s && s.router && s.router.lastDataAt && Date.now() - s.router.lastDataAt < maxAgeMs);
}

// Fuentes pasivas (esperan a que les envíen): no se matan por "no llegan datos al arrancar"
function isPassiveSource(url) {
    const u = (url || '').toLowerCase();
    return u.startsWith('udp://') || u.startsWith('rtp://') || u.includes('mode=listener') || u.includes('listen=1') || u.includes('?listen');
}

function buildIngestArgs(inputObj) {
    const url = inputObj.url || '';
    const isTestSource = url.toLowerCase() === 'test';

    const args = ['-hide_banner', '-nostdin', '-y', '-fflags', '+genpts'];

    if (isTestSource) {
        // Generar barras de colores y tono de audio interno (sin red).
        // -re: sin él lavfi genera a velocidad máxima de CPU (cientos de fps) e inunda el router.
        args.push(
            '-re', '-f', 'lavfi', '-i', 'smptebars=size=1280x720:rate=25',
            '-re', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000'
        );
    } else {
        // Editable Buffer para entrada
        if (inputObj.buffer && inputObj.buffer > 0) {
            // En UDP/RTSP previene smearing/artifacts ajustando la recolección
            args.push('-buffer_size', `${inputObj.buffer}M`);
        }

        // Forzar modo TCP para cámaras de vigilancia RTSP (evita artefactos y cortes rápidos).
        // El timeout de socket lo cubre el watchdog del router (independiente de la versión
        // de FFmpeg: en FFmpeg 4.x "-timeout" en RTSP activaba el modo listen).
        if (url.startsWith('rtsp://')) {
            args.push('-rtsp_transport', 'tcp');
        }

        // Flags específicos para entradas SRT (mejorar estabilidad y reconexión)
        if (url.startsWith('srt://')) {
            // Solo aplicar timeout estricto si NO es listener (caller mode)
            if (!url.includes('mode=listener')) {
                // Timeout de conexión: 5 segundos (en microsegundos)
                args.push('-timeout', '5000000');
            }
            // Forzar detección de stream más rápida para fuentes SRT (evita esperas largas)
            args.push('-probesize', '1048576');   // 1 MB
            args.push('-analyzeduration', '1000000'); // 1 segundo
        }

        args.push('-i', url);
    }

    // Main Output: copy codec or encode if test pattern, output to local MPEG-TS TCP
    // En la fuente de test el audio es la segunda entrada lavfi (antes se perdía con 0:a?)
    args.push('-map', '0:v?');
    args.push('-map', isTestSource ? '1:a?' : '0:a?');

    if (isTestSource) {
        args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '50');
    } else {
        args.push('-c:v', 'copy');
    }

    // Audio siempre a AAC en la ingesta: así grabación y visores pueden copiarlo sin recodificar
    args.push('-c:a', 'aac', '-b:a', '128k');
    if (!isTestSource && url.startsWith('rtmp')) {
        args.push('-bsf:v', 'h264_mp4toannexb'); // Force bitstream conversion only for RTMP to avoid corrupting native SRT
    }
    args.push('-f', 'mpegts');
    args.push('-sdt_period', '0.5'); // Inject PAT/PMT frequently so mid-stream connections (thumbnails) can sync instantly
    args.push('-pat_period', '0.5');
    args.push('-muxdelay', '0.5'); // Dar margen de medio segundo para que FFmpeg ordene y pacifique los paquetes TS
    args.push('-muxpreload', '0.5');
    args.push(`tcp://127.0.0.1:${inputObj.udpsrv}`);
    return args;
}

function spawnIngest(state) {
    const { channel, inputObj } = state;
    if (state.isStopping || activeInputs[channel] !== state) return;

    const ffmpegCmd = getFFmpegPath();
    const args = buildIngestArgs(inputObj);
    console.log(`[STARTING INPUT ${channel}] ${ffmpegCmd} ${args.join(' ')}`);

    const child = spawn(ffmpegCmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    state.process = child;
    state.spawnedAt = Date.now();
    state.lastUpdate = Date.now();

    child.on('error', (err) => {
        console.error(`[FATAL IN-${channel}] FFmpeg missing or crashed:`, err.message);
        // Si el spawn falló no habrá evento 'close': tratarlo como una caída para reintentar
        if (!child.pid) onExit(-1);
    });

    let lastParseTime = 0;
    let codecFound = false;
    const errorLogBuffer = [];

    child.stderr.on('data', (data) => {
        const out = data.toString();
        errorLogBuffer.push(out);
        if (errorLogBuffer.length > 30) errorLogBuffer.shift();

        // Extraer codec en cuanto aparezca (suele estar en los primeros chunks, no limitarlo por tiempo)
        if (!codecFound) {
            const codecMatch = out.match(/Video:\s*([a-zA-Z0-9_-]+)/);
            if (codecMatch) {
                let parsedCodec = codecMatch[1].toUpperCase();
                if (parsedCodec === 'HEVC') parsedCodec = 'H.265';
                else if (parsedCodec === 'H264') parsedCodec = 'H.264';
                codecFound = true;

                if (state.codec !== parsedCodec) {
                    state.codec = parsedCodec;
                    persistentCodecs[channel] = parsedCodec;
                    db.run("UPDATE inputs SET codec = ? WHERE channel = ?", [parsedCodec, channel], (err) => {
                        if (err) console.error(`[DB-CODEC] Error updating codec for Ch${channel}:`, err.message);
                        else console.log(`[DB-CODEC] Ch${channel} codec updated to ${parsedCodec} in DB`);
                    });
                }
            }
        }

        const now = Date.now();
        // THRESHOLD LIMIT: Solo analizamos estadísticas 2 veces por segundo para evitar saturar NodeJS
        if (now - lastParseTime < 500) return;
        lastParseTime = now;

        const bitrateMatch = out.match(/bitrate=\s*([\d.]+kbits\/s)/);
        if (bitrateMatch) {
            const timeMatch = out.match(/time=([\d:.]+)/);
            state.lastUpdate = now;
            const brText = bitrateMatch[1];
            const history = pushTelemetry(channel, parseFloat(brText) || 0);
            emitStats({
                channel: channel,
                bitrate: brText,
                time: timeMatch ? timeMatch[1] : '--:--:--',
                active: true,
                codec: state.codec || '',
                history // Payload con curva precargada
            });
        }
    });

    child.on('close', (code) => onExit(code));

    function onExit(code) {
        if (state.process !== child) return; // proceso ya reemplazado
        state.process = null;
        console.log(`Input ${channel} exited with code ${code}`);

        if (state.isStopping || activeInputs[channel] !== state) return;

        const router = state.router;
        if (state.pendingRestart) {
            // Reinicio pedido (cambio de URL/buffer): los visores reconectan al nuevo stream
            state.pendingRestart = false;
            if (router) dropTransientSubscribers(router);
            stopPreview(channel);
            state.restartTimer = setTimeout(() => {
                state.restartTimer = null;
                spawnIngest(state);
                scheduleThumbnail(channel);
            }, 300);
            return;
        }

        if (code !== 0) {
            console.error(`[FFMPEG CRASH CH-${channel}] Last log output:\n${errorLogBuffer.join('')}`);
        }

        // Cerrar visores/thumbnail; la grabación sigue enganchada al router persistente
        if (router) dropTransientSubscribers(router);
        stopPreview(channel);
        if (telemetryCache[channel]) delete telemetryCache[channel]; // Limpiar RAM historico

        // Remove thumbnail so UI flips to TV Bars
        fs.unlink(path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`), () => { });
        state.thumbTs = 0;

        // Turn yellow in UI (we fake an active signal with 0 bitrate)
        emitStats({ channel: channel, active: true, bitrate: '0.0kbits/s', time: '--:--:--' });

        const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * Math.pow(2, state.restartAttempts || 0));
        state.restartAttempts = (state.restartAttempts || 0) + 1;
        console.log(`[IN-${channel}] Connection lost or crashed. Auto-restarting in ${delay / 1000}s...`);
        state.restartTimer = setTimeout(() => {
            state.restartTimer = null;
            spawnIngest(state);
            scheduleThumbnail(channel);
        }, delay);
    }
}

/**
 * Start an Input Stream (Listener or Pull)
 * Receives external signal and pushes it to the local TCP router of the channel.
 */
function startInput(inputObj) {
    const channel = inputObj.channel;
    const existing = activeInputs[channel];
    if (existing && !existing.isStopping) {
        console.log(`Input ${channel} is already running.`);
        return false;
    }

    const state = {
        channel,
        inputObj,
        process: null,
        router: null,
        restartTimer: null,
        restartAttempts: 0,
        spawnedAt: 0,
        lastUpdate: Date.now(),
        isStopping: false,
        pendingRestart: false,
        prevProcess: null,
        prevSubscriber: null,
        autoPreviewTimer: null,
        thumbRetries: 0,
        thumbTs: 0,
        codec: inputObj.codec || persistentCodecs[channel] || ''
    };
    activeInputs[channel] = state;

    // Lanzar FFmpeg solo cuando el router ya escucha (evita "Connection refused" en el arranque)
    state.router = createRouter(state, () => spawnIngest(state));
    scheduleThumbnail(channel);
    return true;
}

/**
 * Reiniciar la ingesta con parámetros nuevos (URL, buffer...) SIN cerrar el router:
 * las grabaciones en curso no se cortan ni se sobrescriben.
 */
function restartInput(inputObj) {
    const channel = inputObj.channel;
    const state = activeInputs[channel];
    if (!state || state.isStopping || !state.router || state.router.port !== inputObj.udpsrv) {
        stopInput(channel);
        return startInput(inputObj);
    }
    state.inputObj = inputObj;
    state.restartAttempts = 0;
    if (state.process) {
        state.pendingRestart = true;
        try { state.process.kill('SIGKILL'); } catch (e) { }
    } else {
        // Estaba esperando reintento: adelantarlo
        if (state.restartTimer) clearTimeout(state.restartTimer);
        state.restartTimer = null;
        spawnIngest(state);
        scheduleThumbnail(channel);
    }
    return true;
}

// Retraso escalonado para evitar spawn UNKNOWN si entran muchas cámaras a la vez
let previewQueueDelay = 0;

function scheduleThumbnail(channel) {
    // Fase 1: Extraer un frame inicial de manera escalonada para no saturar la CPU
    previewQueueDelay += 2500;
    setTimeout(() => {
        previewQueueDelay = Math.max(0, previewQueueDelay - 2500);
        const state = activeInputs[channel];
        if (state && !state.isStopping && state.process && !state.prevProcess) {
            startPreview(channel, true);
        }
    }, previewQueueDelay);
}

function startPreview(channel, singleFrame = true) {
    const state = activeInputs[channel];
    if (!state || !state.router) return false;
    if (state.prevProcess) stopPreview(channel);

    const outPath = path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`);
    const ffmpegCmd = getFFmpegPath();

    // FFmpeg lee MPEG-TS desde stdin (pipe directa del router, 0% HTTP, 0% conflictos SRT).
    // Decodificación en CPU: para un único I-frame a 240 px es más rápido y fiable que
    // "-hwaccel auto", que en equipos con iGPU Intel/VAAPI provocaba fallos y reintentos.
    const args = [
        '-hide_banner', '-y',
        '-fflags', '+genpts+discardcorrupt+nobuffer',
        '-err_detect', 'ignore_err',
        '-probesize', '5000000',
        '-analyzeduration', '5000000',
        '-f', 'mpegts',
        '-i', 'pipe:0',
        '-map', '0:v:0',
        '-vf', "select='eq(pict_type,I)',scale=240:-1", // Seleccionar solo el I-Frame completo, sin crashear el demuxer
        '-q:v', '5',
        '-frames:v', '1',
        '-f', 'image2',
        '-update', '1',
        outPath
    ];

    console.log(`[PREVIEW CH-${channel}] Extrayendo thumbnail via pipe directa del router...`);
    const child = spawn(ffmpegCmd, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    lowerPriority(child);
    state.prevProcess = child;

    // Suscribir al router para recibir datos MPEG-TS directamente
    const subscriber = {
        kind: 'thumb',
        write(chunk) {
            if (child.stdin && !child.stdin.destroyed && child.stdin.writable) child.stdin.write(chunk);
        },
        pending() { return child.stdin ? child.stdin.writableLength : 0; },
        destroy() { try { child.stdin.destroy(); } catch (e) { } }
    };
    state.router.subscribers.add(subscriber);
    state.prevSubscriber = subscriber;

    child.stdin.on('error', () => { }); // Silenciar EPIPE
    child.on('error', (err) => {
        console.error(`[PREVIEW ERROR CH-${channel}] Failed to run ffmpeg:`, err.message);
    });

    let stderrOutput = '';
    child.stderr.on('data', (d) => {
        stderrOutput = (stderrOutput + d.toString()).slice(-4096);
    });

    // Timeout de seguridad de 20s
    const killTimer = setTimeout(() => {
        console.log(`[PREVIEW CH-${channel}] Timeout 20s, matando proceso...`);
        if (stderrOutput.trim()) {
            const lastLines = stderrOutput.trim().split('\n').slice(-3).join(' | ');
            console.log(`[PREVIEW CH-${channel}] Último stderr: ${lastLines.substring(0, 300)}`);
        }
        try { child.kill('SIGKILL'); } catch (e) { }
    }, 20000);

    child.on('close', (code) => {
        clearTimeout(killTimer);
        if (state.router) state.router.subscribers.delete(subscriber);
        if (state.prevProcess !== child) return; // reemplazado por otro preview
        state.prevProcess = null;
        state.prevSubscriber = null;
        if (activeInputs[channel] !== state || state.isStopping) return;

        if (code === 0) {
            fs.stat(outPath, (err, stats) => {
                if (err) {
                    console.error(`[PREVIEW CH-${channel}] ❌ FFmpeg terminó con éxito pero el archivo ${outPath} NO EXISTE.`);
                    return;
                }
                console.log(`[PREVIEW CH-${channel}] ✓ Thumbnail guardado con éxito (Tamaño: ${stats.size} bytes).`);
                state.thumbRetries = 0;
                state.thumbTs = Date.now();
                if (ioInstance) ioInstance.emit('thumbnail_ready', { channel: channel });
            });
            // NOTA: Auto-refresh desactivado a petición del usuario.
            // El thumbnail se extraerá una única vez al conectarse la cámara.
        } else if (state.process) {
            state.thumbRetries = (state.thumbRetries || 0) + 1;
            if (stderrOutput.trim()) {
                const lastLines = stderrOutput.trim().split('\n').slice(-3).join(' | ');
                console.log(`[PREVIEW CH-${channel}] FFmpeg stderr: ${lastLines.substring(0, 300)}`);
            }
            const retryDelay = state.thumbRetries <= 10 ? 5000 : 30000;
            const retryLabel = state.thumbRetries <= 10 ? `${state.thumbRetries}/10` : `#${state.thumbRetries} (lento)`;
            console.log(`[PREVIEW CH-${channel}] Falló (código ${code}). Reintento ${retryLabel} en ${retryDelay / 1000}s...`);
            state.autoPreviewTimer = setTimeout(() => {
                state.autoPreviewTimer = null;
                if (activeInputs[channel] === state && !state.isStopping && state.process) {
                    startPreview(channel, true);
                }
            }, retryDelay);
        }
    });

    return true;
}

function stopPreview(channel) {
    const inp = activeInputs[channel];
    if (inp) {
        if (inp.autoPreviewTimer) {
            clearTimeout(inp.autoPreviewTimer);
            inp.autoPreviewTimer = null;
        }
        if (inp.prevSubscriber) {
            if (inp.router) inp.router.subscribers.delete(inp.prevSubscriber);
            inp.prevSubscriber = null;
        }
        if (inp.prevProcess) {
            const proc = inp.prevProcess;
            inp.prevProcess = null;
            try { proc.kill('SIGKILL'); } catch (e) { }
        }
    }
    // NO borrar el archivo thumb_X.jpg aquí — permite que el último frame capturado
    // siga visible en la UI. Solo se borra al hacer stopInput() o si la cámara cae.
}

/**
 * Stop an Input Stream (desactivado por el usuario o borrado)
 */
function stopInput(channel) {
    const state = activeInputs[channel];
    if (!state) return false;

    console.log(`[STOPPING INPUT ${channel}] Killing process and router...`);
    state.isStopping = true;
    if (state.restartTimer) clearTimeout(state.restartTimer);
    stopPreview(channel);

    if (state.process) {
        try { state.process.kill('SIGKILL'); } catch (e) { }
        state.process = null;
    }
    closeRouter(state.router);
    state.router = null;

    delete activeInputs[channel];
    if (telemetryCache[channel]) delete telemetryCache[channel];
    fs.unlink(path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`), () => { });
    emitStats({ channel: channel, active: false });
    return true;
}

/**
 * Start an Output Stream
 * Pulls from the local router and pushes to destination URL.
 */
function startOutput(outputObj) {
    // Outputs desactivados — señales solo para preview y grabación
    if (!OUTPUTS_ENABLED) {
        console.log(`[OUTPUT] Outputs disabled — skipping output ${outputObj.id}`);
        return;
    }
    const { id, channel, url } = outputObj;
    if (activeOutputs[id]) {
        console.log(`Output ${id} is already running.`);
        return;
    }

    // Check if input stream is alive
    if (!activeInputs[channel]) {
        console.log(`Cannot start Output ${id}: Input ${channel} is offline.`);
        return; // Will stay disabled until input connects
    }

    // Generate unique local port for this specific output receiver
    const localPort = 20000 + Math.floor(Math.random() * 30000); // 20000-50000 range

    const ffmpegCmd = getFFmpegPath();
    // Migrado a TCP para evitar el límite de buffer de 64KB de Windows UDP que causaba pérdida de frames en local
    const localTcpIn = `tcp://127.0.0.1:${localPort}?listen`;

    const isRtmp = url.startsWith('rtmp');
    const isDisk = url.startsWith('disk://');
    let format = 'mpegts';
    let destUrl = url;

    if (isRtmp) format = 'flv';
    if (isDisk) {
        destUrl = url.replace('disk://', '');

        // AUTO-TIMESTAMP TO PREVENT OVERWRITES:
        // Inject current datetime into filename: NombreInput_20260418_223500.mp4
        const now = new Date();
        const df = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

        const lastSlash = Math.max(destUrl.lastIndexOf('/'), destUrl.lastIndexOf('\\'));
        const lastDot = destUrl.lastIndexOf('.');

        if (!destUrl.toLowerCase().endsWith('.m3u8')) {
            if (lastDot > lastSlash) {
                destUrl = destUrl.substring(0, lastDot) + '_' + df + destUrl.substring(lastDot);
            } else {
                destUrl += '_' + df + '.mp4';
            }
        }

        if (destUrl.toLowerCase().endsWith('.ts')) format = 'mpegts';
        else if (destUrl.toLowerCase().endsWith('.mkv')) format = 'matroska';
        else if (destUrl.toLowerCase().endsWith('.m3u8')) format = 'hls';
        else format = 'mp4';
    }

    const vcodec = outputObj.vcodec || 'copy';

    const args = [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-fflags', '+genpts', // Critical for UDP to MP4 timebase
        '-thread_queue_size', '4096', // Evita que el hilo de lectura TCP dropee paquetes si la escritura a disco o SRT se atasca
        '-probesize', '15000000',     // Dar más margen a streams H.265 tardíos para encontrar SPS/PPS
        '-analyzeduration', '15000000',
        '-i', localTcpIn
    ];

    if (vcodec === 'copy') {
        args.push('-c', 'copy');
    } else {
        args.push('-c:v', vcodec);
        args.push('-preset', 'ultrafast');
        args.push('-crf', '23');
        args.push('-g', '25');         // Force keyframe every 25 frames
        args.push('-sc_threshold', '0'); // Disable scene-change keyframes
        args.push('-c:a', 'aac');
        args.push('-b:a', '128k');
    }

    args.push('-max_muxing_queue_size', '9999'); // Prevenir hangs del ffmpeg en la cola de muxing

    // Critical bitstream filter for AAC audio inside MP4 container from raw UDP streams
    if (format === 'mp4' || format === 'hls') {
        args.push('-bsf:a', 'aac_adtstoasc');
    } else if (format === 'mpegts') {
        // Aumentar el delay y preload a 500ms para garantizar un pacing (PCR) perfecto hacia vMix sin tirones
        args.push('-muxdelay', '0.5');
        args.push('-muxpreload', '0.5');
    }

    if (isDisk && format === 'mp4') {
        args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof'); // MP4 fragmentado rocoso
    }

    if (format === 'hls') {
        args.push('-hls_time', '2');       // 2s segments = faster live edge
        args.push('-hls_list_size', '0'); // Keep all segments for replay
        args.push('-hls_segment_type', 'mpegts');
        args.push('-hls_flags', 'append_list'); // EVITA SOBREESCRIBIR el archivo si hay un microcorte y ffmpeg se reinicia
        args.push('-f', 'hls');
    } else {
        args.push('-f', format);
    }
    args.push(destUrl);

    console.log(`[STARTING OUTPUT ${id}] ${ffmpegCmd} ${args.join(' ')}`);

    const child = spawn(ffmpegCmd, args, { windowsHide: true });

    // Subscribe this output ONLY IF ffmpeg survives the first 1.5 seconds.
    setTimeout(() => {
        if (child.exitCode !== null || !activeInputs[channel] || !activeInputs[channel].router) return;
        // Test connection to verify port is alive before letting ffmpeg connect
        const sock = net.createConnection(localPort, '127.0.0.1', () => {
            console.log(`[OUT-${id}] Validated and successfully subscribed to local TCP ${localPort}`);
            const sub = {
                kind: 'output',
                write(chunk) { sock.write(chunk); },
                pending() { return sock.writableLength; },
                destroy() { sock.destroy(); }
            };
            if (addSubscriber(channel, sub) && activeOutputs[id]) activeOutputs[id].subscriber = sub;
        });
        sock.on('error', () => {
            console.log(`[OUT-${id}] Router port ${localPort} unreachable. FFmpeg will fail.`);
        });
        sock.on('close', () => {
            if (activeOutputs[id] && activeOutputs[id].subscriber) removeSubscriber(channel, activeOutputs[id].subscriber);
        });
        if (activeOutputs[id]) activeOutputs[id].tcpSocket = sock;
    }, 1500);

    child.on('error', (err) => {
        console.error(`[FATAL OUT-${id}] FFmpeg missing or crashed:`, err.message);
    });

    // Suppress heavy console logs but quietly parse bitrate metrics for UI telemetry without blocking V8
    let lastParseTime = 0;

    child.stderr.on('data', (data) => {
        const now = Date.now();
        if (now - lastParseTime < 500) return;
        lastParseTime = now;

        const out = data.toString();
        const bitrateMatch = out.match(/bitrate=\s*([\d.]+kbits\/s)/);
        const timeMatch = out.match(/time=([\d:.]+)/);

        if (bitrateMatch) {
            const outChan = 'out_' + id;
            if (activeOutputs[id]) activeOutputs[id].lastUpdate = now;
            const brText = bitrateMatch[1];
            emitStats({
                channel: outChan,
                bitrate: brText,
                time: timeMatch ? timeMatch[1] : '--:--:--',
                active: true,
                history: pushTelemetry(outChan, parseFloat(brText) || 0)
            });
        }
    });

    let intentionalStop = false;
    child.markIntentionalStop = () => { intentionalStop = true; };

    child.on('close', (code) => {
        console.log(`Output ${id} exited with code ${code}`);

        // Remove subscriber socket
        if (activeOutputs[id]) {
            if (activeOutputs[id].subscriber) removeSubscriber(channel, activeOutputs[id].subscriber);
            if (activeOutputs[id].tcpSocket) activeOutputs[id].tcpSocket.destroy();
        }

        // Auto-Restart Logic
        if (!intentionalStop) {
            console.log(`[OUT-${id}] Connection lost or crashed. Auto-restarting target in 10s...`);
            if (activeOutputs[id] && activeOutputs[id].process === child) {
                activeOutputs[id].autoRestart = setTimeout(() => {
                    delete activeOutputs[id];
                    startOutput(outputObj);
                }, 10000);
            } else if (!activeOutputs[id]) {
                setTimeout(() => { startOutput(outputObj); }, 10000);
            }
        }
    });

    activeOutputs[id] = { process: child, localPort: localPort, parentChannel: channel, outputObj: outputObj, lastUpdate: Date.now() };
    return true;
}

function stopOutput(id) {
    if (activeOutputs[id]) {
        console.log(`[STOPPING OUTPUT ${id}] Killing process...`);
        if (activeOutputs[id].autoRestart) clearTimeout(activeOutputs[id].autoRestart);

        const { process, parentChannel, subscriber, tcpSocket } = activeOutputs[id];

        if (process) {
            if (typeof process.markIntentionalStop === 'function') {
                process.markIntentionalStop();
            }
            process.kill('SIGKILL');
        }

        if (subscriber) removeSubscriber(parentChannel, subscriber);
        if (tcpSocket) tcpSocket.destroy();

        delete activeOutputs[id];
        return true;
    }
    return false;
}

// Global Heartbeat Monitor: telemetría a cero, watchdog de señal congelada y reset de backoff
setInterval(() => {
    const now = Date.now();
    for (const channel in activeInputs) {
        const inp = activeInputs[channel];
        if (!inp || inp.isStopping) continue;

        if (inp.lastUpdate && (now - inp.lastUpdate > 5000)) {
            emitStats({
                channel: channel,
                bitrate: '0.0kbits/s',
                time: '--:--:--',
                active: true,
                history: pushTelemetry(channel, 0)
            });
            inp.lastUpdate = now;
        }

        // Watchdog: FFmpeg vivo pero sin entregar datos (RTSP colgado, cámara congelada...).
        // Sin esto el proceso podía quedarse bloqueado para siempre y la cámara no volvía.
        if (inp.process && inp.router && !inp.pendingRestart) {
            const lastData = inp.router.lastDataAt;
            const gotDataThisRun = lastData > inp.spawnedAt;
            let stalledFor = 0;
            if (gotDataThisRun) {
                stalledFor = now - lastData;
                if (stalledFor < STALL_TIMEOUT_MS) {
                    if (inp.restartAttempts && now - inp.spawnedAt > STABLE_RESET_MS) inp.restartAttempts = 0;
                    continue;
                }
            } else {
                if (isPassiveSource(inp.inputObj.url)) continue;
                stalledFor = now - inp.spawnedAt;
                if (stalledFor < FIRST_DATA_TIMEOUT_MS) continue;
            }
            console.error(`[WATCHDOG CH-${channel}] Sin datos desde hace ${Math.round(stalledFor / 1000)}s. Reiniciando ingesta...`);
            try { inp.process.kill('SIGKILL'); } catch (e) { }
        }
    }

    // Heartbeat for Active Outputs
    for (const id in activeOutputs) {
        const outp = activeOutputs[id];
        const outChan = 'out_' + id;
        if (outp && outp.lastUpdate && (now - outp.lastUpdate > 5000)) {
            emitStats({
                channel: outChan,
                bitrate: '0.0kbits/s',
                time: '--:--:--',
                active: true,
                history: pushTelemetry(outChan, 0)
            });
            outp.lastUpdate = now;
        }
    }
}, 1000);

function getTotalBitrates() {
    let rx = 0;
    let tx = 0;
    for (const channel in activeInputs) {
        const hist = telemetryCache[channel];
        if (hist && hist.length > 0) rx += hist[hist.length - 1].y || 0;
    }
    for (const id in activeOutputs) {
        const hist = telemetryCache['out_' + id];
        if (hist && hist.length > 0) tx += hist[hist.length - 1].y || 0;
    }
    return { rx: (rx / 1000).toFixed(2), tx: (tx / 1000).toFixed(2) };
}

module.exports = {
    setIo,
    startInput,
    stopInput,
    restartInput,
    startOutput,
    stopOutput,
    startPreview,
    stopPreview,
    addSubscriber,
    removeSubscriber,
    isInputOnline,
    hasSignal,
    lowerPriority,
    getTotalBitrates,
    activeInputs,
    activeOutputs,
    getFFmpegPath,
    persistentCodecs,
    getH264EncoderArgs
};
// Getter: la detección de NVENC es asíncrona y termina después de exportar el módulo
Object.defineProperty(module.exports, 'nvencAvailable', { get: () => nvencAvailable, enumerable: true });

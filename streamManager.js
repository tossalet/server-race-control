const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');

let ioInstance = null;
function setIo(io) { ioInstance = io; }

// ── OUTPUTS DESACTIVADOS ──────────────────────────────────────────────────────
// Las señales de entrada SÓLO se usan para preview HLS y grabación a disco.
// Re-emitir a destinos externos (SRT/RTMP/disk outputs) nunca se usa en producción
// y consume procesos FFmpeg innecesarios. Para reactivarlos, cambiar a true.
const OUTPUTS_ENABLED = false;
// ─────────────────────────────────────────────────────────────────────────────

// ── DETECCIÓN AUTOMÁTICA DE GPU NVIDIA NVENC ─────────────────────────────────
// Al arrancar, verificamos si FFmpeg tiene soporte h264_nvenc (GPU NVIDIA).
// Si la GPU no está presente o no tiene drivers, se usa libx264 (CPU) como fallback.
let nvencAvailable = false;
(function detectNvenc() {
    try {
        const ffmpegCmd = os.platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        const output = execSync(`${ffmpegCmd} -encoders 2>&1`, { encoding: 'utf8', timeout: 5000 });
        if (output.includes('h264_nvenc')) {
            nvencAvailable = true;
            console.log('[GPU] ✅ NVIDIA NVENC detectado — transcodificación H.265→H.264 usará GPU');
        } else {
            console.log('[GPU] ℹ️  NVENC no disponible — transcodificación usará CPU (libx264)');
        }
    } catch (e) {
        console.log('[GPU] ℹ️  No se pudo detectar NVENC — usando CPU (libx264)');
    }
})();

/**
 * Devuelve los argumentos de FFmpeg para transcodificar a H.264.
 * Si NVENC está disponible, usa GPU; si no, usa CPU con libx264.
 * @param {object} opts - Opciones opcionales { scale: '-2:720', cq: 28 }
 * @returns {string[]} Array de argumentos FFmpeg para el encoder de vídeo
 */
function getH264EncoderArgs(opts = {}) {
    const scale = opts.scale || '-2:720';
    if (nvencAvailable) {
        // Si usamos hwaccel cuda completo, usamos scale_cuda en la GPU
        const scaleFilter = opts.hwaccel === 'cuda' 
            ? `scale_cuda=${scale.replace('-2', '1280')}:format=yuv420p` // scale_cuda requiere dimensiones explícitas (por ejemplo 1280:720)
            : `scale=${scale}`;

        return [
            '-c:v', 'h264_nvenc',
            '-preset', 'p4',
            '-rc', 'vbr',
            '-cq', String(opts.cq || 28),
            '-vf', scaleFilter,
        ];
    } else {
        // CPU fallback: libx264 ultrafast
        return [
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-crf', String(opts.cq || 28),
            '-threads', '2',
            '-vf', `scale=${scale}`,
        ];
    }
}
// ─────────────────────────────────────────────────────────────────────────────

// In-memory store for active processes
const activeInputs = {};
const activeOutputs = {};
const telemetryCache = {};
const persistentCodecs = {};


// Locate FFmpeg binary (handles Windows local download vs Linux global)
function getFFmpegPath() {
    if (os.platform() === 'win32') {
        const binDir = path.join(__dirname, 'ffmpeg_bin');
        if (fs.existsSync(binDir)) {
            // Find inner folder (like ffmpeg-7.0.2-essentials_build)
            const subdirs = fs.readdirSync(binDir);
            for (let sub of subdirs) {
                const exePath = path.join(binDir, sub, 'bin', 'ffmpeg.exe');
                if (fs.existsSync(exePath)) return exePath;
            }
        }
    }
    return 'ffmpeg'; // Linux Docker fallback
}

/**
 * Start an Input Stream (Listener or Pull)
 * Receives external signal and pushes to Local UDP multiplexer.
 */
function startInput(inputObj) {
    const { channel, url, udpsrv, audiowtdg, wtdgsecs } = inputObj;
    if (activeInputs[channel]) {
        console.log(`Input ${channel} is already running.`);
        return;
    }

    const ffmpegCmd = getFFmpegPath();
    const localTcpOut = `tcp://127.0.0.1:${udpsrv}`;

    // Base args: Read from URL
    const args = [
        '-hide_banner',
        '-y',
        '-fflags', '+genpts'
    ];

    // Editable Buffer para entrada
    if (inputObj.buffer && inputObj.buffer > 0) {
        // En UDP/RTSP previene smearing/artifacts ajustando la recolección
        args.push('-buffer_size', `${inputObj.buffer}M`);
    }

    // Forzar modo TCP para cámaras de vigilancia RTSP (evita artefactos y cortes rápidos)
    if (url.startsWith('rtsp://')) {
        args.push('-rtsp_transport', 'tcp');
    }

    // Flags específicos para entradas SRT (mejorar estabilidad y reconexión)
    if (url.startsWith('srt://')) {
        // Timeout de conexión: 5 segundos (en microsegundos)
        // Si la fuente SRT no responde, FFmpeg intenta reconectar en lugar de colgar
        args.push('-timeout', '5000000');
        // Forzar detección de stream más rápida para fuentes SRT (evita esperas largas)
        args.push('-probesize', '1048576');   // 1 MB
        args.push('-analyzeduration', '1000000'); // 1 segundo
    }

    args.push('-i', url);

    // Main Output: copy codec, output to local MPEG-TS TCP
    args.push('-map', '0:v?');
    args.push('-map', '0:a?');
    args.push('-c:v', 'copy');
    args.push('-c:a', 'aac');
    args.push('-b:a', '128k');
    if (url.startsWith('rtmp')) {
        args.push('-bsf:v', 'h264_mp4toannexb'); // Force bitstream conversion only for RTMP to avoid corrupting native SRT
    }
    args.push('-f', 'mpegts');
    args.push('-muxdelay', '0.5'); // Dar margen de medio segundo para que FFmpeg ordene y pacifique los paquetes TS
    args.push('-muxpreload', '0.5');
    args.push(localTcpOut);

    // Visual Preview Generation is now strictly decoupled into its own independent ffmpeg process!



    console.log(`[STARTING INPUT ${channel}] ${ffmpegCmd} ${args.join(' ')}`);
    const child = spawn(ffmpegCmd, args);

    child.on('error', (err) => {
        console.error(`[FATAL IN-${channel}] FFmpeg missing or crashed:`, err.message);
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
            if (codecMatch && activeInputs[channel]) {
                let parsedCodec = codecMatch[1].toUpperCase();
                if (parsedCodec === 'HEVC') parsedCodec = 'H.265';
                else if (parsedCodec === 'H264') parsedCodec = 'H.264';
                
                codecFound = true;
                
                if (activeInputs[channel].codec !== parsedCodec) {
                    activeInputs[channel].codec = parsedCodec;
                    persistentCodecs[channel] = parsedCodec;
                    
                    const db = require('./db');
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
        
        // Match FFmpeg stats
        const bitrateMatch = out.match(/bitrate=\s*([\d.]+kbits\/s)/);
        const timeMatch = out.match(/time=([\d:.]+)/);
        
        if (bitrateMatch && ioInstance) {
            if (activeInputs[channel]) activeInputs[channel].lastUpdate = now;
            
            if (!telemetryCache[channel]) telemetryCache[channel] = [];
            const brText = bitrateMatch[1];
            const br = parseFloat(brText); // ej. "4500.5kbits/s" -> 4500.5
            
            telemetryCache[channel].push({ t: new Date().toLocaleTimeString(), y: br || 0 });
            if (telemetryCache[channel].length > 60) telemetryCache[channel].shift(); // Keep last 60 points
            
            ioInstance.emit('stats', {
                channel: channel,
                bitrate: brText,
                time: timeMatch ? timeMatch[1] : '--:--:--',
                active: true,
                codec: activeInputs[channel] ? activeInputs[channel].codec : '',
                history: telemetryCache[channel] // Payload con curva precargada
            });
        }
    });

    // Setup TCP Multiplexer in Node.js (Eliminates UDP packet loss on loopback completely)
    const net = require('net');
    const router = net.createServer((socket) => {
        router.activeIncomingSockets = router.activeIncomingSockets || new Set();
        router.activeIncomingSockets.add(socket);
        socket.on('close', () => { if (router.activeIncomingSockets) router.activeIncomingSockets.delete(socket); });
        socket.on('data', (data) => {
            for (const sub of router.subscribers) {
                // Backpressure protection: Drop slow clients to prevent Node OOM
                if (sub.writableLength > 256 * 1024 * 1024) {
                    sub.destroy();
                    router.subscribers.delete(sub);
                    console.log(`[ROUTER ${channel}] Killed slow subscriber to prevent memory leak.`);
                } else {
                    sub.write(data);
                }
            }
        });
        socket.on('error', () => {});
    });
    router.subscribers = new Set();
    router.port = udpsrv;
    
    // Bind to the udpsrv generated port to receive FFmpeg feed
    let _routerRetries = 0;
    const _routerBind = () => router.listen(udpsrv, '127.0.0.1', () => {
        console.log(`[ROUTER] Channel ${channel} bound on TCP ${udpsrv}`);
    });
    _routerBind();
    
    router.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            _routerRetries++;
            if (_routerRetries > 6) {
                console.error(`[ROUTER ${channel}] Port ${udpsrv} permanently busy after ${_routerRetries} retries. Giving up.`);
                return;
            }
            console.log(`[ROUTER ${channel}] Port ${udpsrv} busy (TIME_WAIT), retry ${_routerRetries}/6 in 5s...`);
            setTimeout(() => {
                try { router.close(() => _routerBind()); } catch(e) { _routerBind(); }
            }, 5000);
        } else {
            console.error(`[ROUTER ${channel}] TCP Socket Error:`, err.message);
        }
    });

    let intentionalStop = false;
    child.markIntentionalStop = () => { intentionalStop = true; };

    child.on('close', (code) => {
        console.log(`Input ${channel} exited with code ${code}`);
        if (code !== 0 && !intentionalStop) {
            console.error(`[FFMPEG CRASH CH-${channel}] Last log output:\n${errorLogBuffer.join('')}`);
        }
        // Shutdown router safely
        if (router.subscribers) {
            for (const sub of router.subscribers) {
                sub.destroy();
            }
            router.subscribers.clear();
        }
        if (router.activeIncomingSockets) {
            for (const sock of router.activeIncomingSockets) {
                sock.destroy();
            }
            router.activeIncomingSockets.clear();
        }
        try { router.close(); } catch (e) {}
        try { sender.close(); } catch (e) {}
        
        if (telemetryCache[channel]) delete telemetryCache[channel]; // Limpiar RAM historico
        
        // Remove thumbnail so UI flips to TV Bars
        const extPath = path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`);
        fs.unlink(extPath, (err) => {});
        
        stopPreview(channel);

        // Collect associated outputs that need to be restarted
        const outputsToRestart = [];
        if (!intentionalStop) {
            for (const outId in activeOutputs) {
                if (activeOutputs[outId].parentChannel === channel) {
                    outputsToRestart.push(activeOutputs[outId].outputObj);
                    console.log(`[IN-${channel}] Stopping associated output ${outId} to prevent zombies...`);
                    stopOutput(outId);
                }
            }
        }

        // Auto-Restart Logic (If not deliberately stopped by user)
        if (!intentionalStop) {
            console.log(`[IN-${channel}] Connection lost or crashed. Auto-restarting in 10s...`);
            // Turn yellow in UI (we fake an active signal with 0 bitrate)
            if (ioInstance) ioInstance.emit('stats', { channel: channel, active: true, bitrate: '0.0kbits/s', time: '--:--:--' });
            
            const doRestart = () => {
                startInput(inputObj);
                // Restart outputs 2 seconds later
                setTimeout(() => {
                    for (const outObj of outputsToRestart) {
                        console.log(`[IN-${channel}] Auto-restarting associated output ${outObj.id}...`);
                        startOutput(outObj);
                    }
                }, 2000);
            };

            // Si nadie reemplazó manualmente el activeInputs, usamos un timeout para reconectar
            if (activeInputs[channel] && activeInputs[channel].process === child) {
                activeInputs[channel].autoRestart = setTimeout(() => {
                    delete activeInputs[channel];
                    doRestart();
                }, 10000);
            } else if (!activeInputs[channel]) {
                setTimeout(doRestart, 10000);
            }
        } else {
            // Intentional stop
            if (ioInstance) ioInstance.emit('stats', { channel: channel, active: false });
        }
    });

    activeInputs[channel] = { 
        process: child, 
        router: router, 
        lastUpdate: Date.now(), 
        inputObj: inputObj, 
        isStopping: false, 
        prevProcess: null, 
        prevPort: null,
        codec: inputObj.codec || persistentCodecs[channel] || ''
    };
    
    // Solo extraer un frame inicial al conectar para no consumir recursos en segundo plano
    startPreview(channel, true);

    return true;
}

function startPreview(channel, singleFrame = false) {
    if (!activeInputs[channel] || !activeInputs[channel].router) return;
    if (activeInputs[channel].prevProcess) stopPreview(channel);

    const extPath = path.join(__dirname, 'public', 'thumbs', `thumb_${channel}`);
    const ffmpegCmd = getFFmpegPath();
    const args = [ '-hide_banner', '-y' ];
    const inputObj = activeInputs[channel].inputObj || {};
    const inputCodec = activeInputs[channel].codec || '';
    
    // Si la GPU NVIDIA está disponible y no ha fallado previamente para esta cámara, la usamos
    const useGPU = nvencAvailable && !activeInputs[channel].gpuFailed;
    if (useGPU) {
        args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
        
        // Seleccionar decodificador por hardware adecuado según el códec detectado en la base de datos
        if (inputCodec.includes('265') || inputCodec.includes('HEVC')) {
            args.push('-c:v', 'hevc_cuvid');
        } else if (inputCodec.includes('264')) {
            args.push('-c:v', 'h264_cuvid');
        }
    }

    let useSubstream = false;
    if (inputObj.ptz_enabled && inputObj.ptz_ip) {
        useSubstream = true;
        let host = inputObj.ptz_ip.split(':')[0];
        let port = '554';
        try {
            if (inputObj.url && inputObj.url.startsWith('rtsp://')) {
                const urlObj = new URL(inputObj.url);
                host = urlObj.hostname;
                if (urlObj.port) port = urlObj.port;
            }
        } catch(e) {}
        const user = inputObj.ptz_user ? encodeURIComponent(inputObj.ptz_user) : '';
        const pass = inputObj.ptz_pass ? encodeURIComponent(inputObj.ptz_pass) : '';
        const auth = (user && pass) ? `${user}:${pass}@` : '';
        const rtspUrl = `rtsp://${auth}${host}:${port}/cam/realmonitor?channel=1&subtype=1&unicast=true`;
        
        args.push('-rtsp_transport', 'tcp', '-i', rtspUrl);
    } else {
        // Flags de tolerancia para evitar pixelados morados/grises al cambiar o procesar paquetes UDP
        args.push(
            '-fflags', '+genpts+discardcorrupt',
            '-err_detect', 'ignore_err',
            '-probesize', '500000',
            '-analyzeduration', '500000',
            '-f', 'mpegts', '-i', '-'
        );
    }

    if (!useSubstream) {
        args.push('-map', '0:v?');
    }

    const outPath = extPath + '.jpg';
    
    // Si usamos aceleración de hardware por GPU, debemos reescalar en la GPU con scale_cuda y descargar de memoria antes de escribir la imagen
    if (useGPU) {
        // Reescalar a 320x180 nativo en GPU para las tarjetas del panel izquierdo
        if (singleFrame) {
            args.push('-vf', 'scale_cuda=320:180,hwdownload,format=nv12', '-frames:v', '1', '-q:v', '5', '-update', '1', '-f', 'image2', outPath);
        } else {
            args.push('-vf', 'scale_cuda=320:180,hwdownload,format=nv12', '-r', '1', '-update', '1', '-q:v', '5', '-f', 'image2', outPath);
        }
    } else {
        if (singleFrame) {
            args.push('-vf', 'scale=320:-1', '-frames:v', '1', '-q:v', '5', '-update', '1', '-f', 'image2', outPath);
        } else {
            args.push('-vf', 'scale=320:-1', '-r', '1', '-update', '1', '-q:v', '5', '-f', 'image2', outPath);
        }
    }

    console.log(`[PREVIEW START CH-${channel}] ${singleFrame ? 'single' : 'continuous'} with GPU=${useGPU}`);
    const child = spawn(ffmpegCmd, args);
    activeInputs[channel].prevProcess = child;
    
    child.on('error', (err) => {
        console.error(`[PREVIEW ERROR CH-${channel}] Failed to run ffmpeg:`, err.message);
    });

    // ── Log stderr para diagnóstico ──
    let lastStderrLog = 0;
    child.stderr.on('data', (d) => {
        const text = d.toString().trim();
        if (!text) return;
        const isError = /error|fail|unable|invalid/i.test(text);
        const now = Date.now();
        if (isError || now - lastStderrLog > 10000) {
            lastStderrLog = now;
            const line = text.split('\n')[0].substring(0, 200);
            console.log(`[PREV-STDERR CH-${channel}] ${line}`);
        }
    });

    if (!useSubstream) {
        if (child.stdin) {
            child.stdin.on('error', (err) => {
                // Silenciar errores de tubería rota
            });
        }
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
        activeInputs[channel].router.subscribers.add(subObj);
        activeInputs[channel].prevSubscriber = subObj;
    }

    if (singleFrame) {
        setTimeout(() => stopPreview(channel), 15000);
    }

    const startTime = Date.now();

    child.on('close', (code) => {
        if (activeInputs[channel]) {
            if (activeInputs[channel].prevSubscriber) {
                if (activeInputs[channel].router) {
                    activeInputs[channel].router.subscribers.delete(activeInputs[channel].prevSubscriber);
                }
                activeInputs[channel].prevSubscriber = null;
            }
            
            const elapsed = Date.now() - startTime;
            const wasOurProcess = activeInputs[channel].prevProcess === child;
            activeInputs[channel].prevProcess = null;

            // Si el proceso de GPU duró menos de 2 segundos encendido y falló, marcamos para usar CPU
            if (wasOurProcess && elapsed < 2000 && nvencAvailable && !activeInputs[channel].gpuFailed) {
                console.log(`⚠️ [PREVIEW CH-${channel}] Fallo prematuro en GPU (duración: ${elapsed}ms). Activando fallback de CPU para asegurar miniaturas...`);
                activeInputs[channel].gpuFailed = true;
            }
            
            // Auto-restart: reiniciar SIEMPRE que el input siga activo
            if (!singleFrame && wasOurProcess && activeInputs[channel] && !activeInputs[channel].isStopping) {
                console.log(`[PREVIEW CH-${channel}] Process exited. Auto-restarting preview in 3 seconds...`);
                setTimeout(() => {
                    if (activeInputs[channel] && !activeInputs[channel].isStopping && !activeInputs[channel].prevProcess) {
                        startPreview(channel, false);
                    }
                }, 3000);
            }
        }
    });
}


function stopPreview(channel) {
    const inp = activeInputs[channel];
    if (inp) {
        if (inp.prevProcess) {
            try { inp.prevProcess.kill('SIGKILL'); } catch(e) {}
            inp.prevProcess = null;
        }
        if (inp.prevSubscriber) {
            if (inp.router) inp.router.subscribers.delete(inp.prevSubscriber);
            inp.prevSubscriber = null;
        }
    }
    // Borrar el archivo de imagen de previsualización para no servir capturas obsoletas
    const extPath = path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`);
    if (fs.existsSync(extPath)) {
        try { fs.unlinkSync(extPath); } catch(e){}
    }
}

/**
 * Stop an Input Stream
 */
function stopInput(channel) {
    if (activeInputs[channel]) {
        console.log(`[STOPPING INPUT ${channel}] Killing process and router...`);
        if (activeInputs[channel].autoRestart) clearTimeout(activeInputs[channel].autoRestart);
        
        if (activeInputs[channel].process) {
            if (typeof activeInputs[channel].process.markIntentionalStop === 'function') {
                activeInputs[channel].process.markIntentionalStop();
            }
            activeInputs[channel].process.kill('SIGKILL');
        }
        if (activeInputs[channel].router) {
            if (activeInputs[channel].router.subscribers) {
                for (const sub of activeInputs[channel].router.subscribers) {
                    sub.destroy();
                }
                activeInputs[channel].router.subscribers.clear();
            }
            if (activeInputs[channel].router.activeIncomingSockets) {
                for (const sock of activeInputs[channel].router.activeIncomingSockets) {
                    sock.destroy();
                }
                activeInputs[channel].router.activeIncomingSockets.clear();
            }
            try { activeInputs[channel].router.close(); } catch(e){}
        }
        
        delete activeInputs[channel];
        return true;
    }
    return false;
}

/**
 * Start an Output Stream
 * Pulls from the Local UDP multiplexer (udpsrv) and pushes to destination URL.
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

    // Generate unique local UDP port for this specific output receiver
    const localPort = 20000 + Math.floor(Math.random() * 30000); // 20000-50000 range
    
    // We assign child process FIRST so we can measure if it dies instantly
    let processStarted = false;

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
        const df = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
        
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
        '-y',
        '-fflags', '+genpts', // Critical for UDP to MP4 timebase
        '-thread_queue_size', '4096', // Evita que el hilo de lectura TCP dropee paquetes si la escritura a disco o SRT se atasca
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

    const child = spawn(ffmpegCmd, args);
    processStarted = true;
    
    // Subscribe this output ONLY IF ffmpeg survives the first 1.5 seconds.
    setTimeout(() => {
        if (child.exitCode === null && activeInputs[channel] && activeInputs[channel].router) {
            const net = require('net');
            // Test connection to verify port is alive before letting ffmpeg connect
            const sock = net.createConnection(localPort, '127.0.0.1', () => {
                console.log(`[OUT-${id}] Validated and successfully subscribed to local TCP ${localPort}`);
                if (activeInputs[channel] && activeInputs[channel].router) {
                    activeInputs[channel].router.subscribers.add(sock);
                }
                if (activeOutputs[id]) {
                    activeOutputs[id].tcpSocket = sock;
                }
            });
            sock.on('error', () => {
                console.log(`[OUT-${id}] Router port ${localPort} unreachable. FFmpeg will fail.`);
            });
            sock.on('close', () => { 
                if (activeInputs[channel] && activeInputs[channel].router) {
                    activeInputs[channel].router.subscribers.delete(sock); 
                }
            });
            
            if (activeOutputs[id]) activeOutputs[id].tcpSocket = sock;
        }
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
        
        if (bitrateMatch && ioInstance) {
            const outChan = 'out_' + id;
            if (activeOutputs[id]) activeOutputs[id].lastUpdate = now;
            
            if (!telemetryCache[outChan]) telemetryCache[outChan] = [];
            const brText = bitrateMatch[1];
            const br = parseFloat(brText); // ej. "4500.5kbits/s" -> 4500.5
            
            telemetryCache[outChan].push({ t: new Date().toLocaleTimeString(), y: br || 0 });
            if (telemetryCache[outChan].length > 60) telemetryCache[outChan].shift();
            
            ioInstance.emit('stats', {
                channel: outChan,
                bitrate: brText,
                time: timeMatch ? timeMatch[1] : '--:--:--',
                active: true,
                history: telemetryCache[outChan]
            });
        }
    });

    let intentionalStop = false;
    child.markIntentionalStop = () => { intentionalStop = true; };

    child.on('close', (code) => {
        console.log(`Output ${id} exited with code ${code}`);
        
        // Remove subscriber socket
        if (activeOutputs[id] && activeOutputs[id].tcpSocket) {
            activeOutputs[id].tcpSocket.destroy();
            if (activeInputs[channel] && activeInputs[channel].router) {
                activeInputs[channel].router.subscribers.delete(activeOutputs[id].tcpSocket);
            }
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
        
        const { process, localPort, parentChannel } = activeOutputs[id];
        
        if (process) {
            if (typeof process.markIntentionalStop === 'function') {
                process.markIntentionalStop();
            }
            process.kill('SIGKILL');
        }
        
        if (activeOutputs[id].tcpSocket) {
            activeOutputs[id].tcpSocket.destroy();
            if (activeInputs[parentChannel] && activeInputs[parentChannel].router) {
                activeInputs[parentChannel].router.subscribers.delete(activeOutputs[id].tcpSocket);
            }
        }
        
        delete activeOutputs[id];
        return true;
    }
    return false;
}

// Global Heartbeat Monitor: Detect frozen input streams and push zero telemetry
setInterval(() => {
    const now = Date.now();
    for (const channel in activeInputs) {
        const inp = activeInputs[channel];
        if (inp && inp.lastUpdate && (now - inp.lastUpdate > 5000)) {
            if (!telemetryCache[channel]) telemetryCache[channel] = [];
            telemetryCache[channel].push({ t: new Date().toLocaleTimeString(), y: 0 });
            if (telemetryCache[channel].length > 60) telemetryCache[channel].shift();
            
            if (ioInstance) {
                ioInstance.emit('stats', {
                    channel: channel,
                    bitrate: '0.0kbits/s',
                    time: '--:--:--', 
                    active: true,
                    history: telemetryCache[channel]
                });
            }
            inp.lastUpdate = now; 
        }
    }
    
    // Heartbeat for Active Outputs
    for (const id in activeOutputs) {
        const outp = activeOutputs[id];
        const outChan = 'out_' + id;
        if (outp && outp.lastUpdate && (now - outp.lastUpdate > 5000)) {
            if (!telemetryCache[outChan]) telemetryCache[outChan] = [];
            telemetryCache[outChan].push({ t: new Date().toLocaleTimeString(), y: 0 });
            if (telemetryCache[outChan].length > 60) telemetryCache[outChan].shift();
            
            if (ioInstance) {
                ioInstance.emit('stats', {
                    channel: outChan,
                    bitrate: '0.0kbits/s',
                    time: '--:--:--', 
                    active: true,
                    history: telemetryCache[outChan]
                });
            }
            outp.lastUpdate = now;
        }
    }
}, 1000);

function getTotalBitrates() {
    let rx = 0;
    let tx = 0;
    for (const channel in activeInputs) {
        if (telemetryCache[channel] && telemetryCache[channel].length > 0) {
            rx += telemetryCache[channel][telemetryCache[channel].length - 1].y || 0;
        }
    }
    for (const id in activeOutputs) {
        const outChan = 'out_' + id;
        if (telemetryCache[outChan] && telemetryCache[outChan].length > 0) {
            tx += telemetryCache[outChan][telemetryCache[outChan].length - 1].y || 0;
        }
    }
    return { rx: (rx / 1000).toFixed(2), tx: (tx / 1000).toFixed(2) };
}

module.exports = {
    setIo,
    startInput,
    stopInput,
    startOutput,
    stopOutput,
    startPreview,
    stopPreview,
    getTotalBitrates,
    activeInputs,
    activeOutputs,
    getFFmpegPath,
    persistentCodecs,
    nvencAvailable,
    getH264EncoderArgs
};

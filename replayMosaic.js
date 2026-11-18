/* =============================================================================
 *  Mosaico de edición del Monitor 2 montado en el servidor
 * =============================================================================
 *  Antes el Monitor 2 abría un vídeo por cámara y con muchas cámaras la CPU se iba al 100 %.
 *  Ahora recibe un único vídeo, como en directo: el servidor lee las grabaciones, las decodifica
 *  en la GPU y compone la cuadrícula siguiendo la línea de tiempo del panel.
 *
 *  Por cámara: Node entrega los segmentos de la grabación a un FFmpeg que los decodifica a imagen
 *  sin comprimir, a 25 imágenes por segundo exactas. Un único reloj (la posición de la línea de
 *  tiempo) decide qué imagen de cada cámara toca, así que todas van sincronizadas. Si una cámara
 *  va retrasada se ponen al día saltando imágenes; en pausa el vídeo sigue saliendo con la imagen
 *  fija, por lo que el navegador nunca tiene que reiniciar su decodificador.
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sm = require('./streamManager');
const { mosaicLayout, fillBlack, blit, startEncoder } = require('./mosaicManager').composer;

const FPS = 25;
const QUEUE_FRAMES = 8;            // imágenes decodificadas en espera por cámara
const SEEK_IGNORE_S = 0.15;        // el panel repite el mismo salto al terminar de buscar
const SEEK_REACH_S = 3;            // salto corto hacia delante: se llega sin reiniciar el decodificador
const SEEK_MIN_INTERVAL_MS = 450;  // al arrastrar por la línea de tiempo
const SEEK_WAIT_MS = 2000;         // espera máxima a que todas las cámaras lleguen al punto pedido
const DECODER_STALL_MS = 8000;
const FIRST_FRAME_MS = 6000;
const IDLE_CLOSE_MS = 10000;
const MAX_CAMERAS = 16;

const mosaics = new Map();

// Último estado que ha pedido el panel: un mosaico que arranca después parte de aquí
const transport = { position: null, positionAt: 0, paused: null, rate: null };

// ── Lista de segmentos de una grabación ──────────────────────────────────────
function parsePlaylist(text) {
    const segments = [];
    let time = 0, duration = null, discontinuity = false, ended = false;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8));
        else if (line.startsWith('#EXT-X-DISCONTINUITY')) discontinuity = true;
        else if (line.startsWith('#EXT-X-ENDLIST')) ended = true;
        else if (!line.startsWith('#') && Number.isFinite(duration)) {
            segments.push({ file: path.basename(line.split('?')[0]), start: time, duration, discontinuity });
            time += duration;
            duration = null;
            discontinuity = false;
        }
    }
    return { segments, ended, end: time };
}

function findSegment(segments, t) {
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (segments[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
}

async function loadPlaylist(tile) {
    if (tile.useLow) {
        try {
            const low = parsePlaylist(await fs.promises.readFile(tile.lowPath, 'utf8'));
            if (low.segments.length) { tile.list = low; return; }
        } catch (e) { /* sin copia ligera válida: señal completa */ }
        tile.useLow = false;
    }
    try {
        tile.list = parsePlaylist(await fs.promises.readFile(tile.mainPath, 'utf8'));
    } catch (e) {
        tile.list = { segments: [], ended: false, end: 0 };
    }
}

// ── Decodificador de una cámara ──────────────────────────────────────────────
function decoderArgs(m, tile) {
    const { tileW, tileH } = m.layout;
    const decoder = tile.hardware
        ? (tile.useLow ? sm.cuvidDecoderFor('HEVC') : sm.cuvidDecoderFor(sm.inputCodec(tile.channel)))
        : null;
    // setpts numera las imágenes una a una: un corte en la grabación no se rellena con repetidas
    const timing = 'setpts=N/(FRAME_RATE*TB),fps=' + FPS;
    const args = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err',
        '-probesize', '2000000', '-analyzeduration', '1000000'];
    if (decoder) args.push('-c:v', decoder, '-resize', `${tileW}x${tileH}`, '-surfaces', '8');
    args.push('-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v:0', '-an');
    args.push('-vf', decoder
        ? `${timing},format=yuv420p`
        : `${timing},scale=${tileW}:${tileH}:flags=fast_bilinear,format=yuv420p`);
    args.push('-threads', '2', '-f', 'rawvideo', 'pipe:1');
    return args;
}

function clearQueue(tile) {
    tile.queue = [];
    tile.queueLen = 0;
}

function stopDecoder(tile) {
    const child = tile.child;
    tile.child = null;
    tile.nextSegment = null;
    tile.finished = false;
    if (tile.reader) { tile.reader.destroy(); tile.reader = null; }
    if (child) { try { child.kill('SIGKILL'); } catch (e) { } }
    clearQueue(tile);
}

function copySegment(tile, child, file) {
    return new Promise((resolve) => {
        const reader = fs.createReadStream(file);
        tile.reader = reader;
        let failed = false;
        reader.on('error', () => { failed = true; });
        reader.on('close', () => resolve(!failed));
        reader.pipe(child.stdin, { end: false });
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Entrega los segmentos en orden; el decodificador marca el ritmo al llenarse su entrada
async function feedDecoder(m, tile, child, firstIndex) {
    let index = firstIndex;
    while (tile.child === child && !m.closed) {
        const segment = tile.list.segments[index];
        if (!segment) {
            if (tile.list.ended) { tile.reachedEnd = true; child.stdin.end(); return; }
            tile.waitingData = true;
            await sleep(1000);
            if (tile.child !== child || m.closed) return;
            await loadPlaylist(tile);
            continue;
        }
        tile.waitingData = false;
        // Hueco en la grabación: decodificador nuevo a partir de aquí
        if (segment.discontinuity && index !== firstIndex) {
            tile.nextSegment = index;
            child.stdin.end();
            return;
        }
        const ok = await copySegment(tile, child, path.join(m.mediaRoot, segment.file));
        if (tile.child !== child || m.closed) return;
        if (!ok && tile.useLow) {
            // La copia ligera ya no existe: seguir con la señal completa en el mismo punto
            tile.useLow = false;
            await loadPlaylist(tile);
            tile.retryAt = Date.now();
            stopDecoder(tile);
            return;
        }
        index++;
    }
}

function spawnDecoder(m, tile, index) {
    const segment = tile.list.segments[index];
    clearQueue(tile);
    tile.baseTime = segment.start;
    tile.nextIndex = 0;
    tile.nextSegment = null;
    tile.reachedEnd = false;
    tile.finished = false;
    tile.gotFrame = false;
    tile.waitingData = false;
    tile.startedAt = Date.now();
    tile.lastOutputAt = 0;

    const child = spawn(sm.getFFmpegPath(), decoderArgs(m, tile), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    sm.lowerPriority(child);
    tile.child = child;
    child.stdin.on('error', () => { });
    child.on('error', (err) => console.error(`[MOSAICO-EDICIÓN] CH-${tile.channel}: no se pudo lanzar FFmpeg: ${err.message}`));
    child.stdout.on('data', (chunk) => {
        if (tile.child !== child) return;
        tile.lastOutputAt = Date.now();
        tile.gotFrame = true;
        tile.queue.push(chunk);
        tile.queueLen += chunk.length;
        if (tile.queueLen >= m.frameSize * QUEUE_FRAMES) child.stdout.pause();
    });
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-300); });
    child.on('close', (code) => {
        if (tile.child !== child) return;
        tile.child = null;
        if (tile.reader) { tile.reader.destroy(); tile.reader = null; }
        if (tile.nextSegment !== null) return;          // sigue en el siguiente tramo de la grabación
        if (tile.reachedEnd) { tile.finished = true; return; }
        // Fallo: la GPU puede no admitir el formato (hay cámaras que cambian de códec)
        if (tile.hardware) tile.hardware = false;
        tile.retryAt = Date.now() + 500;
        const tail = stderrTail.trim().split('\n').slice(-1)[0] || '';
        console.log(`[MOSAICO-EDICIÓN] CH-${tile.channel}: decodificador terminó (código ${code}${tail ? ': ' + tail.substring(0, 160) : ''}), reintentando`);
    });
    feedDecoder(m, tile, child, index).catch(() => { });
}

async function startTileAt(m, tile, t) {
    stopDecoder(tile);
    tile.retryAt = 0;
    const generation = ++tile.generation;
    if (!tile.list || (t >= tile.list.end && !tile.list.ended)) await loadPlaylist(tile);
    if (generation !== tile.generation || m.closed) return;
    if (!tile.list.segments.length) {
        tile.noData = true;
        tile.retryAt = Date.now() + 3000;
        return;
    }
    tile.noData = false;
    spawnDecoder(m, tile, findSegment(tile.list.segments, t));
}

// ── Composición ──────────────────────────────────────────────────────────────
function takeFrame(m, tile) {
    if (tile.queueLen < m.frameSize) return null;
    if (tile.queue[0].length < m.frameSize) tile.queue = [Buffer.concat(tile.queue, tile.queueLen)];
    const head = tile.queue[0];
    const frame = head.subarray(0, m.frameSize);
    if (head.length > m.frameSize) tile.queue[0] = head.subarray(m.frameSize);
    else tile.queue.shift();
    tile.queueLen -= m.frameSize;
    if (tile.child && tile.child.stdout.isPaused() && tile.queueLen < m.frameSize * (QUEUE_FRAMES / 2)) tile.child.stdout.resume();
    return frame;
}

function tilePosition(tile) {
    return tile.baseTime + tile.nextIndex / FPS;
}

function tileReady(m, tile) {
    if (tile.noData || tile.finished || tile.waitingData) return true;
    if (tile.baseTime === null) return false;
    return tile.nextIndex > Math.floor((m.position - tile.baseTime) * FPS + 1e-6);
}

function composeTile(m, tile, slot) {
    const { width, height, tileW, tileH } = m.layout;
    if (tile.noData) {
        if (!tile.black) { fillBlack(m.canvas, width, height, slot.x, slot.y, tileW, tileH); tile.black = true; }
        return;
    }
    if (tile.nextSegment !== null && !tile.child && tile.queueLen < m.frameSize) spawnDecoder(m, tile, tile.nextSegment);
    if (tile.baseTime === null) return;
    const want = Math.floor((m.position - tile.baseTime) * FPS + 1e-6);
    let frame = null;
    while (tile.nextIndex <= want) {
        const next = takeFrame(m, tile);
        if (!next) break;
        frame = next;
        tile.nextIndex++;
    }
    if (frame) {
        blit(m.canvas, width, height, frame, slot.x, slot.y, tileW, tileH);
        tile.black = false;
    }
}

function tick(m) {
    if (m.closed) return;
    const now = Date.now();
    const elapsed = Math.min(1, (now - m.lastTickAt) / 1000);
    m.lastTickAt = now;

    if (m.waiting && !m.seekTimer && (now >= m.waitUntil || m.tiles.every(t => tileReady(m, t)))) m.waiting = false;
    if (!m.paused && !m.waiting) m.position += elapsed * m.rate;

    m.tiles.forEach((tile, i) => composeTile(m, tile, m.layout.tiles[i]));

    if (m.encoder && m.encoder.stdin.writable) {
        if (m.encoder.stdin.writableLength < m.frameBytes * 3) m.encoder.stdin.write(Buffer.from(m.canvas));
    } else if (!m.encoder && (!m.encoderRetryAt || now >= m.encoderRetryAt)) {
        startEncoder(m);
    }

    m.frameNo++;
    let next = m.clockStart + m.frameNo * (1000 / FPS);
    if (next < now - 200) { m.clockStart = now; m.frameNo = 0; next = now + 1000 / FPS; }
    m.timer = setTimeout(() => tick(m), Math.max(0, next - Date.now()));
}

function supervise(m) {
    if (m.closed) return;
    const now = Date.now();
    for (const tile of m.tiles) {
        if (tile.child) {
            if (!tile.gotFrame && tile.hardware && !tile.waitingData && now - tile.startedAt > FIRST_FRAME_MS) {
                tile.hardware = false;
                startTileAt(m, tile, m.position);
            } else if (tile.gotFrame && !m.paused && !tile.waitingData && tile.queueLen < m.frameSize
                && now - tile.lastOutputAt > DECODER_STALL_MS) {
                console.log(`[MOSAICO-EDICIÓN] CH-${tile.channel}: sin imagen, reconectando`);
                startTileAt(m, tile, m.position);
            }
        } else if (tile.retryAt && now >= tile.retryAt) {
            startTileAt(m, tile, m.position);
        }
    }
    if (m.router.subscribers.size === 0) {
        if (!m.idleSince) m.idleSince = now;
        else if (now - m.idleSince > IDLE_CLOSE_MS) closeMosaic(m);
    } else {
        m.idleSince = 0;
    }
}

// ── Mandos del panel ─────────────────────────────────────────────────────────
function tileReaches(tile, t) {
    if (!tile.child || tile.baseTime === null) return false;
    const delta = t - tilePosition(tile);
    return delta >= -0.04 && delta < SEEK_REACH_S;
}

function applySeek(m) {
    m.seekTimer = null;
    m.lastSeekAt = Date.now();
    m.waitUntil = m.lastSeekAt + SEEK_WAIT_MS;
    m.waiting = true;
    for (const tile of m.tiles) {
        if (!tileReaches(tile, m.position)) startTileAt(m, tile, m.position);
    }
}

function seek(m, t) {
    const target = Math.max(0, t);
    if (Math.abs(target - m.position) < SEEK_IGNORE_S) return;
    m.position = target;
    if (m.tiles.every(tile => tileReaches(tile, target))) return;
    m.waiting = true;
    m.waitUntil = Date.now() + SEEK_WAIT_MS;
    if (m.seekTimer) return;
    const delay = Math.max(0, m.lastSeekAt + SEEK_MIN_INTERVAL_MS - Date.now());
    m.seekTimer = setTimeout(() => applySeek(m), delay);
}

function applyCommand(cmd) {
    if (!cmd || !cmd.type) return;
    const hasSeek = typeof cmd.seekTo === 'number' && Number.isFinite(cmd.seekTo);
    const isReplayList = cmd.type === 'SET_MULTIVIEW' && Array.isArray(cmd.cameras) && cmd.cameras.some(c => c.isReplay);
    if (hasSeek && (cmd.type === 'MONITOR_SEEK' || cmd.type === 'PLAY_CLIP' || isReplayList)) {
        transport.position = cmd.seekTo;
        transport.positionAt = Date.now();
        for (const m of mosaics.values()) seek(m, cmd.seekTo);
    }
    if (cmd.type === 'MONITOR_PLAY' || cmd.type === 'PLAY_CLIP') {
        transport.paused = false;
        for (const m of mosaics.values()) m.paused = false;
    } else if (cmd.type === 'MONITOR_PAUSE') {
        transport.paused = true;
        for (const m of mosaics.values()) m.paused = true;
    } else if (cmd.type === 'SET_PLAYBACK_RATE' && Number(cmd.rate) > 0) {
        transport.rate = Math.min(8, Number(cmd.rate));
        for (const m of mosaics.values()) m.rate = transport.rate;
    }
}

// ── Ciclo de vida ────────────────────────────────────────────────────────────
function initialPosition(requested, paused, rate) {
    if (transport.position === null || Date.now() - transport.positionAt > 30000) return Math.max(0, requested || 0);
    return transport.position + (paused ? 0 : ((Date.now() - transport.positionAt) / 1000) * rate);
}

function createMosaic({ key, session, channels, mediaRoot, t, paused, rate }) {
    const layout = mosaicLayout(channels.length);
    const startPaused = transport.paused !== null ? transport.paused : !!paused;
    const startRate = transport.rate !== null ? transport.rate : (rate > 0 ? rate : 1);
    const m = {
        key, session, channels, layout, mediaRoot,
        frameSize: layout.tileW * layout.tileH * 1.5,
        frameBytes: layout.width * layout.height * 1.5,
        canvas: Buffer.alloc(layout.width * layout.height * 1.5),
        tiles: channels.map(channel => ({
            channel, child: null, reader: null, list: null, queue: [], queueLen: 0,
            useLow: true, hardware: !!sm.nvencAvailable, generation: 0,
            lowPath: path.join(mediaRoot, `CAM_${channel}_${session}_low.m3u8`),
            mainPath: path.join(mediaRoot, `CAM_${channel}_${session}.m3u8`),
            baseTime: null, nextIndex: 0, nextSegment: null, retryAt: 0,
            noData: false, black: false, finished: false, reachedEnd: false, waitingData: false,
            gotFrame: false, startedAt: 0, lastOutputAt: 0,
        })),
        router: { subscribers: new Set(), lastDataAt: 0 },
        encoder: null, ts: null,
        position: initialPosition(t, startPaused, startRate),
        paused: startPaused, rate: startRate,
        waiting: true, waitUntil: Date.now() + SEEK_WAIT_MS, seekTimer: null, lastSeekAt: 0,
        clockStart: Date.now(), frameNo: 0, lastTickAt: Date.now(),
        closed: false, idleSince: 0,
    };
    fillBlack(m.canvas, layout.width, layout.height, 0, 0, layout.width, layout.height);
    mosaics.set(key, m);
    console.log(`[MOSAICO-EDICIÓN] Montando ${channels.length} cámaras (${layout.cols} columnas) de la sesión ${session} en ${m.position.toFixed(1)} s`);
    for (const tile of m.tiles) startTileAt(m, tile, m.position);
    startEncoder(m);
    m.supervisor = setInterval(() => supervise(m), 1000);
    tick(m);
    return m;
}

function closeMosaic(m) {
    if (m.closed) return;
    m.closed = true;
    clearTimeout(m.timer);
    clearTimeout(m.seekTimer);
    clearInterval(m.supervisor);
    for (const tile of m.tiles) { tile.generation++; stopDecoder(tile); }
    const encoder = m.encoder;
    m.encoder = null;
    if (encoder) { try { encoder.kill('SIGKILL'); } catch (e) { } }
    for (const s of m.router.subscribers) sm.safeDestroy(s);
    m.router.subscribers.clear();
    mosaics.delete(m.key);
    console.log(`[MOSAICO-EDICIÓN] Cerrado (sin visores): sesión ${m.session}`);
}

function addViewer(options, sub) {
    const { session, channels, mediaRoot } = options;
    if (!mediaRoot || !channels.length || !/^[\w-]+$/.test(session || '')) return null;
    const list = channels.slice(0, MAX_CAMERAS);
    const key = `${session}:${list.join(',')}`;
    const m = mosaics.get(key) || createMosaic({ ...options, channels: list, key });
    const start = sm.keyframeStart(m.ts);
    if (start) { try { sub.write(start); } catch (e) { return null; } }
    m.router.subscribers.add(sub);
    m.idleSince = 0;
    return m;
}

function removeViewer(m, sub) {
    if (m) m.router.subscribers.delete(sub);
}

module.exports = { addViewer, removeViewer, applyCommand, parsePlaylist, findSegment };

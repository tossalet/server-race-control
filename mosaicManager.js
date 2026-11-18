/* =============================================================================
 *  Mosaico del Monitor 2 montado en el servidor
 * =============================================================================
 *  Antes el Monitor 2 abría un vídeo por cámara (8 a la vez) y el decodificador por GPU de
 *  Firefox (nvidia-vaapi-driver) fallaba al azar: a veces un recuadro, a veces los 8 en el
 *  mismo instante (el parpadeo). Ahora el servidor compone la cuadrícula y el Monitor 2
 *  recibe un único vídeo, como en la vista de una cámara.
 *
 *  Por cámara: un FFmpeg decodifica su copia ligera (o la señal completa si no la hay) a
 *  imagen sin comprimir del tamaño del recuadro. Node guarda la última imagen de cada una y
 *  25 veces por segundo pega todas en el lienzo, que un único FFmpeg codifica (NVENC) y se
 *  reparte por WebSocket. Una cámara que se cae o se atasca no frena a las demás: su
 *  recuadro se queda en negro hasta que vuelve.
 *
 *  La rejilla (columnas, tamaño y posición de cada recuadro) la calcula igual el Monitor 2
 *  para colocar encima los carteles y las zonas de clic: ver mosaicLayout en MonitorPage.jsx.
 * ========================================================================== */
const { spawn } = require('child_process');
const sm = require('./streamManager');

const FPS = 25;
const CANVAS_W = 1920;
const STALE_MS = 2000;        // sin imagen nueva → recuadro en negro
const DECODER_STALL_MS = 5000; // decodificador vivo pero mudo → reiniciarlo
const IDLE_CLOSE_MS = 10000;  // sin visores → cerrar el mosaico
const MAX_CAMERAS = 16;

const mosaics = new Map(); // clave "2,3,4" → mosaico

function mosaicLayout(n) {
    const cols = n <= 4 ? 2 : n <= 9 ? 3 : 4;
    const tileW = CANVAS_W / cols;
    const tileH = tileW * 9 / 16;
    const rows = Math.max(1, Math.ceil(n / cols));
    const tiles = [];
    for (let i = 0; i < n; i++) {
        const row = Math.floor(i / cols);
        const inRow = row === rows - 1 ? n - row * cols : cols;
        const offsetX = (CANVAS_W - inRow * tileW) / 2; // última fila centrada, como antes
        tiles.push({ x: offsetX + (i % cols) * tileW, y: row * tileH });
    }
    return { cols, rows, tileW, tileH, width: CANVAS_W, height: rows * tileH, tiles };
}

function fillBlack(buf, w, h, x, y, tw, th) {
    const ySize = w * h;
    for (let r = 0; r < th; r++) buf.fill(16, (y + r) * w + x, (y + r) * w + x + tw);
    const cw = w / 2;
    for (let r = 0; r < th / 2; r++) {
        const o = (y / 2 + r) * cw + x / 2;
        buf.fill(128, ySize + o, ySize + o + tw / 2);
        buf.fill(128, ySize * 1.25 + o, ySize * 1.25 + o + tw / 2);
    }
}

// Copia una imagen yuv420p del tamaño del recuadro en su sitio del lienzo
function blit(canvas, w, h, frame, x, y, tw, th) {
    const ySize = w * h;
    for (let r = 0; r < th; r++) frame.copy(canvas, (y + r) * w + x, r * tw, (r + 1) * tw);
    const cw = w / 2, ctw = tw / 2, cth = th / 2;
    const fU = tw * th, fV = fU * 1.25;
    for (let r = 0; r < cth; r++) {
        const o = (y / 2 + r) * cw + x / 2;
        frame.copy(canvas, ySize + o, fU + r * ctw, fU + (r + 1) * ctw);
        frame.copy(canvas, ySize * 1.25 + o, fV + r * ctw, fV + (r + 1) * ctw);
    }
}

function logRateLimited(tile, msg) {
    const now = Date.now();
    if (tile.lastLogAt && now - tile.lastLogAt < 30000) return;
    tile.lastLogAt = now;
    console.log(msg);
}

// ── Decodificador de una cámara ──────────────────────────────────────────────
function startTile(m, tile) {
    const { tileW, tileH } = m.layout;
    const useLow = sm.isProxyActive(tile.channel);
    if (!useLow && !sm.hasSignal(tile.channel)) return;

    const args = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err'];
    // Señal completa (cámara sin copia ligera): decodificar en la GPU para no cargar la CPU
    if (!useLow && sm.nvencAvailable) args.push('-hwaccel', 'cuda');
    args.push(
        '-probesize', '1000000', '-analyzeduration', '500000',
        '-f', 'mpegts', '-i', 'pipe:0',
        '-map', '0:v:0', '-an',
        '-vf', `scale=${tileW}:${tileH}:flags=fast_bilinear,format=yuv420p`,
        '-threads', '2',
        '-f', 'rawvideo', 'pipe:1'
    );
    const child = spawn(sm.getFFmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    sm.lowerPriority(child);
    tile.child = child;
    tile.source = useLow ? 'low' : 'full';
    tile.startedAt = Date.now();
    tile.lastOutputAt = 0;
    tile.chunks = [];
    tile.chunksLen = 0;

    const sub = {
        kind: 'viewer',
        write(chunk) { if (child.stdin.writable) child.stdin.write(chunk); },
        pending() { return child.stdin.writableLength; },
        destroy() { try { child.kill('SIGKILL'); } catch (e) { } }
    };
    tile.sub = sub;
    const ok = useLow
        ? sm.addProxySubscriber(tile.channel, sub, { fromKeyframe: true })
        : sm.addSubscriber(tile.channel, sub);
    if (!ok) { try { child.kill('SIGKILL'); } catch (e) { } }

    child.stdin.on('error', () => { });
    child.on('error', (err) => logRateLimited(tile, `[MOSAICO] CH-${tile.channel}: no se pudo lanzar FFmpeg: ${err.message}`));
    const frameSize = m.frameSize;
    child.stdout.on('data', (chunk) => {
        tile.lastOutputAt = Date.now();
        tile.chunks.push(chunk);
        tile.chunksLen += chunk.length;
        if (tile.chunksLen < frameSize) return;
        // Quedarse con la última imagen completa y guardar el resto para la siguiente
        const all = Buffer.concat(tile.chunks, tile.chunksLen);
        const whole = Math.floor(all.length / frameSize);
        const start = (whole - 1) * frameSize;
        tile.frame = Buffer.from(all.subarray(start, start + frameSize));
        tile.frameAt = Date.now();
        tile.fresh = true;
        const rest = all.subarray(whole * frameSize);
        tile.chunks = rest.length ? [Buffer.from(rest)] : [];
        tile.chunksLen = rest.length;
    });
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-400); });
    child.on('close', (code) => {
        if (tile.sub === sub) {
            if (tile.source === 'low') sm.removeProxySubscriber(tile.channel, sub);
            else sm.removeSubscriber(tile.channel, sub);
            tile.sub = null;
        }
        if (tile.child !== child) return;
        tile.child = null;
        tile.retryAt = Date.now() + 1000;
        if (!m.closed && Date.now() - tile.startedAt > 3000) {
            const tail = stderrTail.trim().split('\n').slice(-1)[0] || '';
            logRateLimited(tile, `[MOSAICO] CH-${tile.channel}: decodificador terminó (código ${code}${tail ? ': ' + tail.substring(0, 160) : ''}), reconectando`);
        }
    });
}

function stopTile(tile) {
    const child = tile.child;
    tile.child = null;
    if (tile.sub) {
        if (tile.source === 'low') sm.removeProxySubscriber(tile.channel, tile.sub);
        else sm.removeSubscriber(tile.channel, tile.sub);
        tile.sub = null;
    }
    if (child) { try { child.kill('SIGKILL'); } catch (e) { } }
}

// ── Codificador del lienzo ───────────────────────────────────────────────────
function startEncoder(m) {
    const { width, height } = m.layout;
    // La gráfica admite pocas codificaciones a la vez: si no queda sesión libre, por CPU
    const useNvenc = sm.nvencAvailable && !m.softwareEncoder;
    const enc = useNvenc
        ? ['-c:v', 'hevc_nvenc', '-preset', 'p1', '-tune', 'll', '-rc', 'cbr', '-b:v', '6M', '-maxrate', '6M', '-bufsize', '3M']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', '6M', '-maxrate', '6M', '-bufsize', '3M', '-pix_fmt', 'yuv420p'];
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-r', String(FPS),
        '-i', 'pipe:0',
        ...enc,
        '-g', String(FPS), '-bf', '0',
        '-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0',
        'pipe:1'
    ];
    const child = spawn(sm.getFFmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    m.encoder = child;
    m.ts = sm.newKeyframeCache();
    m.encoderStartedAt = Date.now();
    child.stdin.on('error', () => { });
    child.on('error', (err) => console.error(`[MOSAICO] No se pudo lanzar el codificador: ${err.message}`));
    child.stdout.on('data', (chunk) => {
        m.router.lastDataAt = Date.now();
        sm.trackKeyframes(m.ts, chunk);
        sm.fanOut(m.router, `mosaico ${m.key}`, chunk);
    });
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-400); });
    child.on('close', (code) => {
        if (m.encoder !== child) return;
        m.encoder = null;
        if (useNvenc && Date.now() - m.encoderStartedAt < 3000) {
            m.nvencFails = (m.nvencFails || 0) + 1;
            if (m.nvencFails >= 2) {
                m.softwareEncoder = true;
                console.error('[MOSAICO] NVENC no disponible para el mosaico: se codifica por CPU');
            }
        }
        // Los visores reconectan a un vídeo nuevo (las marcas de tiempo vuelven a cero)
        for (const s of m.router.subscribers) sm.safeDestroy(s);
        m.router.subscribers.clear();
        if (m.closed) return;
        console.error(`[MOSAICO] Codificador terminó (código ${code}${stderrTail.trim() ? ': ' + stderrTail.trim().split('\n').slice(-1)[0].substring(0, 200) : ''}), reiniciando`);
        m.encoderRetryAt = Date.now() + 2000;
    });
}

// ── Bucle: vigilar decodificadores y enviar el lienzo 25 veces por segundo ──
function tick(m) {
    if (m.closed) return;
    const now = Date.now();
    const { width, height, tileW, tileH } = m.layout;

    for (let i = 0; i < m.tiles.length; i++) {
        const tile = m.tiles[i];
        const pos = m.layout.tiles[i];
        if (tile.fresh) {
            blit(m.canvas, width, height, tile.frame, pos.x, pos.y, tileW, tileH);
            tile.fresh = false;
            tile.black = false;
        } else if (!tile.black && (!tile.frameAt || now - tile.frameAt > STALE_MS)) {
            fillBlack(m.canvas, width, height, pos.x, pos.y, tileW, tileH);
            tile.black = true;
        }
    }

    if (m.encoder && m.encoder.stdin.writable) {
        // Codificador atascado: saltar esta imagen en vez de acumular memoria
        if (m.encoder.stdin.writableLength < m.frameBytes * 3) m.encoder.stdin.write(Buffer.from(m.canvas));
    } else if (!m.encoder && (!m.encoderRetryAt || now >= m.encoderRetryAt)) {
        startEncoder(m);
    }

    // Programar el siguiente sin acumular deriva (si va muy retrasado, se resincroniza)
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
            const last = tile.lastOutputAt || tile.startedAt;
            // Mudo con la cámara entregando datos, o ha aparecido la copia ligera: reiniciar
            if (now - last > DECODER_STALL_MS && sm.hasSignal(tile.channel)) {
                logRateLimited(tile, `[MOSAICO] CH-${tile.channel}: sin imagen ${DECODER_STALL_MS / 1000} s, reconectando`);
                stopTile(tile);
                tile.retryAt = now + 500;
            } else if (tile.source === 'full' && sm.isProxyActive(tile.channel)) {
                stopTile(tile);
            }
            continue;
        }
        if (tile.retryAt && now < tile.retryAt) continue;
        startTile(m, tile);
    }
    if (m.router.subscribers.size === 0) {
        if (!m.idleSince) m.idleSince = now;
        else if (now - m.idleSince > IDLE_CLOSE_MS) closeMosaic(m);
    } else {
        m.idleSince = 0;
    }
}

function createMosaic(channels) {
    const key = channels.join(',');
    const layout = mosaicLayout(channels.length);
    const m = {
        key, channels, layout,
        frameSize: layout.tileW * layout.tileH * 1.5,
        frameBytes: layout.width * layout.height * 1.5,
        canvas: Buffer.alloc(layout.width * layout.height * 1.5),
        tiles: channels.map(ch => ({ channel: ch, child: null, frame: null, frameAt: 0, fresh: false, black: false })),
        router: { subscribers: new Set(), lastDataAt: 0 },
        encoder: null, ts: null,
        clockStart: Date.now(), frameNo: 0,
        closed: false, idleSince: 0,
    };
    fillBlack(m.canvas, layout.width, layout.height, 0, 0, layout.width, layout.height);
    mosaics.set(key, m);
    console.log(`[MOSAICO] Montando ${channels.length} cámaras (${layout.cols} columnas, ${layout.width}x${layout.height}): ${key}`);
    for (const tile of m.tiles) startTile(m, tile);
    startEncoder(m);
    m.supervisor = setInterval(() => supervise(m), 1000);
    tick(m);
    return m;
}

function closeMosaic(m) {
    if (m.closed) return;
    m.closed = true;
    clearTimeout(m.timer);
    clearInterval(m.supervisor);
    for (const tile of m.tiles) stopTile(tile);
    const enc = m.encoder;
    m.encoder = null;
    if (enc) { try { enc.kill('SIGKILL'); } catch (e) { } }
    for (const s of m.router.subscribers) sm.safeDestroy(s);
    m.router.subscribers.clear();
    mosaics.delete(m.key);
    console.log(`[MOSAICO] Cerrado (sin visores): ${m.key}`);
}

function parseChannels(str) {
    const seen = new Set();
    const out = [];
    for (const part of String(str || '').split(',')) {
        const ch = part.trim();
        if (/^\d+$/.test(ch) && !seen.has(ch)) { seen.add(ch); out.push(ch); }
    }
    return out.slice(0, MAX_CAMERAS);
}

// Visor nuevo: arranca en el último fotograma clave del mosaico
function addViewer(channels, sub) {
    if (!channels.length) return null;
    const key = channels.join(',');
    const m = mosaics.get(key) || createMosaic(channels);
    const start = sm.keyframeStart(m.ts);
    if (start) { try { sub.write(start); } catch (e) { return null; } }
    m.router.subscribers.add(sub);
    m.idleSince = 0;
    return m;
}

function removeViewer(m, sub) {
    if (m) m.router.subscribers.delete(sub);
}

module.exports = {
    mosaicLayout, parseChannels, addViewer, removeViewer,
    composer: { mosaicLayout, fillBlack, blit, startEncoder },
};

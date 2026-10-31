const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const si = require('systeminformation');
const db = require('./db');
const streamManager = require('./streamManager');

let ioInstance = null;
let lastCpu = os.cpus();
let smoothedCpu = 0;
let dbCache = { streamsTotal: 0, streamsActive: 0, streamsError: 0 };
let lastDbPoll = 0;

// Temperatura: systeminformation puede lanzar procesos externos (sensors, PowerShell...).
// Se consulta cada 10 s en lugar de en cada ciclo.
let cachedCpuTemp = '--';
let lastTempPoll = 0;

// GPU NVIDIA: antes se hacía execSync('nvidia-smi') cada 2,5 s, bloqueando el event loop
// (y con él el reparto de vídeo a grabación y visores) hasta 800 ms en cada llamada.
// Ahora: asíncrono, y si nvidia-smi no existe se deja de intentar.
let gpuStats = { active: false };
let nvidiaSmiAvailable = true;
let gpuQueryInFlight = false;

function getCpuLoad() {
    const cpus = os.cpus();
    let idleDiff = 0;
    let totalDiff = 0;

    for (let i = 0; i < cpus.length; i++) {
        const cpu = cpus[i];
        const last = lastCpu[i] || cpu;

        let total = 0, lastTotal = 0;
        for (const type in cpu.times) total += cpu.times[type];
        for (const type in last.times) lastTotal += last.times[type];

        idleDiff += (cpu.times.idle - last.times.idle);
        totalDiff += (total - lastTotal);
    }

    lastCpu = cpus;
    if (totalDiff === 0) return smoothedCpu;

    const rawCpu = 100 - ((idleDiff / totalDiff) * 100);

    // Exponential Moving Average (EMA) para suavizar la lectura y ocultar los micropicos de FFmpeg (20% current, 80% history)
    if (smoothedCpu === 0) smoothedCpu = rawCpu;
    else smoothedCpu = (rawCpu * 0.2) + (smoothedCpu * 0.8);

    return smoothedCpu;
}

function pollGpu() {
    if (!nvidiaSmiAvailable || gpuQueryInFlight) return;
    gpuQueryInFlight = true;
    // nvidia-smi devuelve los campos separados por comas: uso_gpu, temp, vram_usada, vram_total
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
        { timeout: 2000, windowsHide: true }, (err, stdout) => {
            gpuQueryInFlight = false;
            if (err) {
                if (err.code === 'ENOENT') nvidiaSmiAvailable = false; // no hay GPU NVIDIA: no volver a intentarlo
                gpuStats = { active: false };
                return;
            }
            const [load, temp, memUsed, memTotal] = String(stdout).trim().split('\n')[0].split(',').map(v => parseFloat(v.trim()));
            if (isNaN(load)) { gpuStats = { active: false }; return; }
            gpuStats = {
                active: true,
                load: load.toFixed(0),
                temp: temp.toFixed(0),
                memUsed: (memUsed / 1024).toFixed(2), // convertir MB a GB
                memTotal: (memTotal / 1024).toFixed(2),
                memPercent: ((memUsed / memTotal) * 100).toFixed(0)
            };
        });
}

// RAM realmente disponible. En Linux os.freemem() (según la versión de Node) devuelve MemFree,
// que NO cuenta la caché de disco: al grabar vídeo el kernel llena la RAM libre con caché de
// los archivos escritos y el panel mostraba GBs "usados" que en realidad están libres.
// MemAvailable es lo que reporta `free -h` en la columna "available".
let meminfoReadable = process.platform === 'linux';
function getAvailableMem() {
    if (meminfoReadable) {
        try {
            const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m);
            if (m) return parseInt(m[1], 10) * 1024;
        } catch { /* sin /proc: usar os.freemem() */ }
        meminfoReadable = false;
    }
    return os.freemem();
}

function pollTemperature(now) {
    if (now - lastTempPoll < 10000) return;
    lastTempPoll = now;
    si.cpuTemperature()
        .then(t => { cachedCpuTemp = t && t.main ? t.main.toFixed(1) : '--'; })
        .catch(() => { });
}

function pollDbCounts(now) {
    if (now - lastDbPoll < 10000) return;
    lastDbPoll = now;
    // Count streams logically from DB
    db.get(`SELECT
                (SELECT COUNT(*) FROM inputs) AS inTotal,
                (SELECT COUNT(*) FROM inputs WHERE enabled = 1) AS inActive,
                (SELECT COUNT(*) FROM outputs) AS outTotal,
                (SELECT COUNT(*) FROM outputs WHERE enabled = 1) AS outActive`, [], (err, row) => {
        if (err || !row) return;
        const streamsTotal = row.inTotal + row.outTotal;
        const streamsActive = row.inActive + row.outActive;
        dbCache = { streamsTotal, streamsActive, streamsError: streamsTotal - streamsActive };
    });
}

function setIo(io) {
    ioInstance = io;
    startMonitoring();
}

function startMonitoring() {
    function loop() {
        if (!ioInstance) return;

        try {
            const now = Date.now();
            pollDbCounts(now);
            pollTemperature(now);
            pollGpu();

            const totalMem = os.totalmem();
            const usedMem = totalMem - getAvailableMem();
            const netStats = streamManager.getTotalBitrates();

            const stats = {
                cpuLoad: getCpuLoad().toFixed(1),
                cpuTemp: cachedCpuTemp,
                memUsed: (usedMem / (1024 * 1024 * 1024)).toFixed(2), // GB
                memTotal: (totalMem / (1024 * 1024 * 1024)).toFixed(2), // GB
                memPercent: ((usedMem / totalMem) * 100).toFixed(1),
                netTx: netStats.tx, // Mbps
                netRx: netStats.rx, // Mbps
                streamsTotal: dbCache.streamsTotal,
                streamsActive: dbCache.streamsActive,
                streamsError: dbCache.streamsError,
                gpu: gpuStats
            };

            // Guardar en la caché global para que pueda ser leída por HTTP GET
            module.exports.lastStats = stats;

            ioInstance.emit('sys_stats', stats);
        } catch (e) {
            console.error("System Polling Error", e);
        }

        setTimeout(loop, 2500);
    }

    loop(); // init
}

module.exports = {
    setIo,
    lastStats: { gpu: { active: false } } // valor inicial por defecto
};

const os = require('os');
const db = require('./db');
const streamManager = require('./streamManager');

let ioInstance = null;
let lastCpu = os.cpus();
let smoothedCpu = 0;
let dbCache = { streamsTotal: 0, streamsActive: 0, streamsError: 0 };
let lastDbPoll = 0;

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

function setIo(io) {
    ioInstance = io;
    startMonitoring();
}

function startMonitoring() {
    async function loop() {
        if (!ioInstance) return;

        try {
            const currentCpuLoad = getCpuLoad();
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;

            const netStats = streamManager.getTotalBitrates();

            const now = Date.now();
            if (now - lastDbPoll > 10000) {
                lastDbPoll = now;
                // Count streams logically from DB
                db.all('SELECT enabled FROM inputs', [], (err, inps) => {
                    db.all('SELECT enabled FROM outputs', [], (err, outs) => {
                        let streamsTotal = 0, streamsActive = 0, streamsError = 0;
                        if(inps) {
                            streamsTotal += inps.length;
                            inps.forEach(i => i.enabled ? streamsActive++ : streamsError++);
                        }
                        if(outs) {
                            streamsTotal += outs.length;
                            outs.forEach(i => i.enabled ? streamsActive++ : streamsError++);
                        }
                        dbCache = { streamsTotal, streamsActive, streamsError };
                    });
                });
            }

            const cpuTempData = await require('systeminformation').cpuTemperature();

            // Consultar datos de la GPU NVIDIA mediante nvidia-smi de forma no bloqueante
            let gpuStats = { active: false };
            try {
                const { execSync } = require('child_process');
                // nvidia-smi devuelve los campos separados por comas: uso_gpu, temp, vram_usada, vram_total
                const nvidiaOutput = execSync('nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null', { timeout: 800 }).toString().trim();
                
                if (nvidiaOutput) {
                    const [load, temp, memUsed, memTotal] = nvidiaOutput.split(',').map(v => parseFloat(v.trim()));
                    if (!isNaN(load)) {
                        gpuStats = {
                            active: true,
                            load: load.toFixed(0),
                            temp: temp.toFixed(0),
                            memUsed: (memUsed / 1024).toFixed(2), // convertir MB a GB
                            memTotal: (memTotal / 1024).toFixed(2),
                            memPercent: ((memUsed / memTotal) * 100).toFixed(0)
                        };
                    }
                }
            } catch (gpuErr) {
                // Silenciar error si no hay nvidia-smi o falla la lectura temporal
            }

            const stats = {
                cpuLoad: currentCpuLoad.toFixed(1),
                cpuTemp: cpuTempData && cpuTempData.main ? cpuTempData.main.toFixed(1) : '--',
                memUsed: (usedMem / (1024*1024*1024)).toFixed(2), // GB
                memTotal: (totalMem / (1024*1024*1024)).toFixed(2), // GB
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

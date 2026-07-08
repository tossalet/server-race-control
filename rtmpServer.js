const NodeMediaServer = require('node-media-server');

let nms = null;

function startRtmpServer(port = 1935) {
    const config = {
        rtmp: {
            port: port,
            chunk_size: 60000,
            gop_cache: true,
            ping: 30,
            ping_timeout: 60
        }
    };
    
    if (nms) {
        try { nms.stop(); } catch(e){}
    }
    
    nms = new NodeMediaServer(config);
    nms.run();
    console.log(`[RTMP] TSST Local Engine corriendo en puerto ${port}`);
}

function restartRtmpServer(newPort) {
    startRtmpServer(newPort);
}

module.exports = {
    startRtmpServer,
    restartRtmpServer
};

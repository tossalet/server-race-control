const fs = require('fs');
const path = require('path');
const logPath = path.join(__dirname, 'logs', 'server.log');

if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    console.log('Total lines in server.log:', lines.length);
    console.log('Searching for starting inputs and errors:');
    
    // Find the last 20 matching lines
    const matches = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.includes('[STARTING INPUT') || line.includes('FATAL') || line.includes('crashed') || line.includes('exited') || line.includes('error') || line.includes('WARN')) {
            matches.push(`Line ${i}: ${line.trim()}`);
            if (matches.length > 50) break;
        }
    }
    console.log(matches.reverse().join('\n'));
} else {
    console.log('logs/server.log does not exist');
}

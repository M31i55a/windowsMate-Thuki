// Kills any process listening on port 1420 before `bun run dev` starts.
// This prevents "Port 1420 is already in use" errors when restarting the dev server.
const { execSync } = require('child_process');

if (process.platform !== 'win32') process.exit(0);

try {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    if (line.includes(':1420') && line.includes('LISTENING')) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== '0') {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
          console.log(`Killed process ${pid} on port 1420`);
        } catch (_) {}
      }
    }
  }
} catch (_) {}

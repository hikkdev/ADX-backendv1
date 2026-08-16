// Frees the dev server's port before nodemon starts, so a process orphaned by
// an earlier session (e.g. VS Code/the folder closing without cleanly
// stopping the task) can never squat the port and silently swallow requests
// meant for the new instance. Safe to run when the port is already free.
require('dotenv').config();
const { execSync } = require('child_process');

const port = process.env.PORT || 3000;

function killWindows() {
  let output;
  try {
    output = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' });
  } catch {
    return;
  }

  const pids = new Set();
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (match && Number(match[1]) === Number(port)) {
      pids.add(match[2]);
    }
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      console.log(`[kill-port] Freed port ${port} (killed leftover PID ${pid})`);
    } catch {
      // Already gone by the time we got here — fine.
    }
  }
}

function killPosix() {
  let pids;
  try {
    pids = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' }).trim();
  } catch {
    return;
  }
  if (!pids) return;

  for (const pid of pids.split('\n').filter(Boolean)) {
    try {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      console.log(`[kill-port] Freed port ${port} (killed leftover PID ${pid})`);
    } catch {
      // Already gone by the time we got here — fine.
    }
  }
}

if (process.platform === 'win32') {
  killWindows();
} else {
  killPosix();
}

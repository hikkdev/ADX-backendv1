// Refuse to start over an existing process. Killing an arbitrary process that
// happens to own the configured port can hide stale-server bugs and destroy
// unrelated work.
const path = require('path');
const net = require('net');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const portValue = process.env.PORT || '3000';
const port = Number(portValue);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[backend] Invalid PORT value: ${JSON.stringify(portValue)}`);
  process.exit(1);
}

const probe = net.createServer();
probe.unref();

probe.once('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[backend] Port ${port} is already in use. Stop the existing backend ` +
        `with Ctrl+C, or choose another PORT and update the frontend API URL.`,
    );
  } else {
    console.error(`[backend] Could not check port ${port}:`, error);
  }
  process.exit(1);
});

probe.listen(port, () => {
  probe.close(() => process.exit(0));
});

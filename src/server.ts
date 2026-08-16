import { app } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { startPublisherTimerJob, publisherTimerInterval } from './jobs/publisherTimer';

const server = app.listen(env.PORT, () => {
  logger.info('ADX backend running', { port: env.PORT, env: env.NODE_ENV });
  startPublisherTimerJob();
});

// Without this handler, a port conflict (e.g. a leftover dev server still
// holding the port) throws as an uncaught exception and kills the process
// silently — new requests then get served by the stale process instead,
// so nothing ever appears in this terminal again. Fail loudly instead.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(
      `Port ${env.PORT} is already in use — another server instance is still running. ` +
        `Stop it (check for a leftover node/tsx process) before starting a new one.`,
      { port: env.PORT },
    );
  } else {
    logger.error('Server failed to start', { err });
  }
  process.exit(1);
});

// Release the port and stop background timers on shutdown so a stopped dev
// server (Ctrl+C, VS Code task restart, nodemon restart) doesn't linger as an
// orphaned process that keeps holding the port and silently serving traffic.
function shutdown(signal: NodeJS.Signals): void {
  logger.info('Shutting down', { signal });
  if (publisherTimerInterval) clearInterval(publisherTimerInterval);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

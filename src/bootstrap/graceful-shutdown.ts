import type { Server } from 'http';
import { logger } from '../shared/logging';

/**
 * Release the port and stop background timers on shutdown so a stopped dev
 * server (Ctrl+C, VS Code task restart, nodemon restart) doesn't linger as an
 * orphaned process that keeps holding the port and silently serving traffic.
 *
 * `stopBackgroundWork` is where jobs cancel their timers.
 */
export function registerGracefulShutdown(server: Server, stopBackgroundWork: () => void): void {
  function shutdown(signal: NodeJS.Signals): void {
    logger.info('Shutting down', { signal });
    stopBackgroundWork();
    server.close(() => process.exit(0));
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

import type { Server } from 'http';
import { logger } from '../shared/logging';

/**
 * Release the port and stop background timers on shutdown so a stopped dev
 * server (Ctrl+C, VS Code task restart, nodemon restart) doesn't linger as an
 * orphaned process that keeps holding the port and silently serving traffic.
 *
 * `stopBackgroundWork` is where jobs cancel their timers.
 *
 * ## Why this does more than `server.close()`
 *
 * `server.close()` stops the listener accepting *new* connections, but its
 * callback does not fire until every existing connection has ended — and the
 * console holds keep-alive sockets open between polls. So on a restart the
 * old process would sit waiting on sockets nobody was using, the port stayed
 * bound, and the replacement nodemon had already spawned hit EADDRINUSE and
 * exited. nodemon then printed "app crashed — waiting for file changes" and
 * gave up, while the *stale* process carried on serving. Every backend edit
 * looked like a crash, and the server that answered was the old code.
 *
 * Two additions fix it. Idle keep-alives are cut immediately, which is what
 * frees the port in practice. Anything still in flight gets a grace period
 * and is then cut too, so a hung request cannot keep the process alive for
 * ever.
 */

/** How long an in-flight request has to finish before the socket is cut. */
export const SHUTDOWN_GRACE_MS = 5_000;

export function registerGracefulShutdown(server: Server, stopBackgroundWork: () => void): void {
  let shuttingDown = false;

  function shutdown(signal: NodeJS.Signals): void {
    /* A second Ctrl+C should not run the teardown twice. */
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Shutting down', { signal });
    stopBackgroundWork();

    server.close(() => process.exit(0));

    /* The keep-alive sockets nobody is using. Cutting these is what actually
       releases the port, and it cannot interrupt a request because an idle
       connection by definition has none in flight. */
    server.closeIdleConnections();

    /* Whatever was still being served gets its grace period, then goes. The
       timer is unreferenced so it never holds the process open by itself. */
    const cutoff = setTimeout(() => {
      logger.info('Shutdown grace expired — closing remaining connections', { graceMs: SHUTDOWN_GRACE_MS });
      server.closeAllConnections();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    cutoff.unref();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

import { app } from './app';
import { env } from './config/env';
import { logger } from './shared/logging';
import { prisma } from './shared/database';
import { redis } from './shared/cache';
import { registerGracefulShutdown } from './bootstrap/graceful-shutdown';
import { startPublisherTimerJob, publisherTimerInterval } from './jobs/publisher-timer.job';

/**
 * Opens the Postgres and Redis connections before the first user needs them.
 *
 * Both pools connect lazily, so without this the first request after a boot
 * paid the whole setup cost itself: measured ~890ms for the Postgres
 * connect + TLS handshake and ~235ms for Redis, which is most of the
 * difference between a ~3.1s first login and a ~0.46s steady-state one. On a
 * host that spins containers down when idle, that first request is a real
 * user's login every time.
 *
 * Deliberately fired after listen() and never awaited: the port must be bound
 * immediately so platform health checks pass, and a warm-up failure is not a
 * reason to refuse traffic — the same query will simply be retried by the
 * first request that needs it.
 */
function warmConnections(): void {
  // Concurrently, on purpose. `min` on the pool only stops idle connections
  // being reaped — it never opens them. Sequential warm-up queries would reuse
  // the same single connection and leave the floor empty, so the first request
  // that fans out (any Promise.all in a repository) would still pay a cold
  // connect. Firing POOL_FLOOR at once forces that many to be established.
  const POOL_FLOOR = 4;
  void Promise.all(
    Array.from({ length: POOL_FLOOR }, () => prisma.$queryRaw`SELECT 1`),
  )
    .then(() => logger.info('Postgres pool warmed', { connections: POOL_FLOOR }))
    .catch((err: unknown) => logger.warn('Postgres warm-up failed', { reason: String(err) }));

  void redis
    .ping()
    .then(() => logger.info('Redis connection warmed'))
    .catch((err: unknown) => logger.warn('Redis warm-up failed', { reason: String(err) }));
}

const server = app.listen(env.PORT, () => {
  logger.info('ADX backend running', { port: env.PORT, env: env.NODE_ENV });
  warmConnections();
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

registerGracefulShutdown(server, () => {
  if (publisherTimerInterval) clearInterval(publisherTimerInterval);
});

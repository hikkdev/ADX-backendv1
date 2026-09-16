import '../../config/load-env';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; pool?: Pool };

function createPrismaClient(): PrismaClient {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // node-postgres defaults this to 0, which means "wait forever" — an
    // exhausted pool then presents as a request that simply never returns
    // rather than an error anyone can act on. Fail in 10s instead.
    connectionTimeoutMillis: 10_000,
    // A query that has stopped making progress should not pin a connection
    // for the life of the process and starve every other request behind it.
    statement_timeout: 30_000,
    // Keeps the TCP connection alive through NAT/proxy idle timeouts. Without
    // it, an idle-but-pooled socket to a managed provider can be silently
    // dropped, and the next query pays a full reconnect (~800ms here) or
    // stalls until the OS notices.
    keepAlive: true,
    // Hold a floor of warm connections. Without `min`, pg-pool reaps every idle
    // connection once idleTimeoutMillis passes (`_isAboveMin` gates removal on
    // it), and opening a fresh one against a database in another region costs
    // 500-900ms. On an admin console that meant any click more than a few
    // seconds after the last one paid a cold connect — which is exactly what
    // "the sidebar is slow" was: not the query, the connection.
    min: 4,
    // Long enough that normal read/think/click pauses never drain the floor.
    idleTimeoutMillis: 5 * 60_000,
    // Neon's pooler endpoint multiplexes server-side, so a large client-side
    // pool buys nothing and just holds sockets open.
    max: 10,
  });
  globalForPrisma.pool = pool;
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

/**
 * Shuts the database down so a one-shot process can exit.
 *
 * `$disconnect()` releases Prisma's side; the pool underneath it is ours, and
 * `min: 4` means pg-pool deliberately never reaps those four sockets. A seed
 * script that only disconnected therefore finished its work and then sat there
 * with a live event loop until somebody killed it — the work was done, the
 * process just never said so, which is indistinguishable from a hang.
 *
 * The server does not call this: it wants the pool for as long as it runs.
 */
export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect();
  await globalForPrisma.pool?.end();
  globalForPrisma.pool = undefined;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

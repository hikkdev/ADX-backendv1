import { prisma } from './prisma';

/**
 * The readiness probe's view of Postgres: one round trip, bounded.
 *
 * Lives beside the client rather than in bootstrap/health so the ORM stays
 * behind shared/database — bootstrap asks "is the database there?" and never
 * holds the client.
 */
export async function pingDatabase(timeoutMs = 3_000): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`postgres ping exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

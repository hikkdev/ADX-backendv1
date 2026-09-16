import { redis } from './redis';

/** The readiness probe's view of Redis: one PING, bounded. */
export async function pingRedis(timeoutMs = 3_000): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis ping exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const reply = await Promise.race([redis.ping(), timeout]);
    if (reply !== 'PONG') throw new Error(`unexpected reply ${String(reply)}`);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { learnSourceQuality, recomputeAll } from '../modules/leads';

const TAG = 'leadScoringJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:lead-scoring-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;
const DAY_KEY = (day: string) => `lock:lead-scoring:${day}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export let leadScoringInterval: ReturnType<typeof setInterval> | null = null;

const istDay = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * LH1: once an Indian day, every open lead is re-scored (recency decays on
 * its own; a lead nobody touched for three weeks cools without anybody
 * doing anything) and every source's quality is re-learned from its own
 * 90-day conversions. Hourly interval, day key — the key is written only
 * after the run succeeds, so a failed night is tried again on the next tick.
 */
export async function leadScoringTick(now = new Date()): Promise<void> {
  recordHeartbeat('lead-scoring', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;
  try {
    const dayKey = DAY_KEY(istDay(now));
    if (await redis.get(dayKey)) return;
    const sources = await learnSourceQuality(now);
    const scored = await recomputeAll(now);
    await redis.set(dayKey, '1', 'EX', 60 * 60 * 36);
    logger.info('Leads re-scored', { tag: TAG, ...scored, sources: sources.sources, sourcesChanged: sources.changed });
  } catch (err) {
    logger.error('leadScoringJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startLeadScoringJob(): void {
  leadScoringInterval = setInterval(() => void leadScoringTick(), INTERVAL_MS);
}

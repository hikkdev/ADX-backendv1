import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { purgeExitedDocuments, runDocumentExpirySweep } from '../modules/agents';

/**
 * AG-4 (the owner, 20 Sep 2026): a driving licence, a vehicle insurance, a
 * police certificate — an agent's papers with a date. This tick reminds the
 * agent thirty and seven days out and, on the day, marks the paper expired:
 * an applicant sees it as theirs to renew, and a working agent is put on
 * hold until the renewed paper is approved at the desk. Every instance runs
 * the interval; only the one that wins the lock does the work.
 */

const TAG = 'agentDocumentExpiryJob';
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOCK_KEY = 'lock:agent-document-expiry-tick';
const LOCK_TTL_MS = 5 * 60 * 1000;

export let agentDocumentExpiryInterval: ReturnType<typeof setInterval> | null = null;

export function startAgentDocumentExpiryJob(): void {
  agentDocumentExpiryInterval = setInterval(async () => {
    recordHeartbeat('agent-document-expiry');
    const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
    if (!acquired) return;
    try {
      const result = await runDocumentExpirySweep();
      if (result.considered > 0) logger.info('Agent document expiry tick', { tag: TAG, ...result });
      // AG-5: ninety days after an exit, the papers go.
      const purged = await purgeExitedDocuments();
      if (purged.agents > 0) logger.info('Exited agents\' papers purged', { tag: TAG, ...purged });
    } catch (error) {
      reportError(error, { tag: TAG });
    } finally {
      await redis.del(LOCK_KEY).catch(() => undefined);
    }
  }, INTERVAL_MS);
}

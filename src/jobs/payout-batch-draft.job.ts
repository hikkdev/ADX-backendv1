import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { getPlatformSettings } from '../modules/app-config';
import { permissionsFor } from '../modules/access-control';
import { createNotification } from '../modules/notifications';
import { draftScheduledBatch, lastSlot } from '../modules/payouts';
import { listAdminUserIds, systemUserId } from '../modules/users';

const TAG = 'payoutBatchDraftJob';
const INTERVAL_MS = 5 * 60 * 1000;
const LOCK_KEY = 'lock:payout-batch-draft-tick';
// Shorter than the interval, so an instance that dies mid-draft clears its
// own lock rather than holding the week's draft until a restart.
const LOCK_TTL_MS = 4 * 60 * 1000;
/** One draft per slot on the cadence: the slot key is what makes it once. */
const SLOT_KEY = (slot: Date) => `lock:payout-batch-draft:${slot.toISOString()}`;
const SLOT_TTL_SECONDS = 8 * 24 * 60 * 60;
/** The permission that marks a finance admin: the people who can sign a batch off and release it. */
const FINANCE_PERMISSION = 'finance.approve';

export let payoutBatchDraftInterval: ReturnType<typeof setInterval> | null = null;

/** Every admin holding the finance permission — a super admin with no role config holds them all. */
export async function financeAdminIds(): Promise<string[]> {
  const admins = await listAdminUserIds();
  const out: string[] = [];
  for (const userId of admins) {
    if ((await permissionsFor(userId, ['ADMIN'])).includes(FINANCE_PERMISSION)) out.push(userId);
  }
  return out;
}

/**
 * The weekly payout draft — Lot G (Q124).
 *
 * Every five minutes: if the cadence on the platform settings row is on and
 * its slot for this week (`weekday` at `hourIst`, Indian time) has passed and
 * has not yet been drafted, one DRAFT batch is built from every APPROVED
 * withdrawal in no open batch, as the system user, audited
 * `PAYOUT_BATCH_DRAFTED_BY_SCHEDULE`, and every finance admin is told. Runs
 * on an interval rather than a cron so a process that started at noon on
 * Monday still drafts Monday's batch; the slot key is what makes it once.
 * Nothing here approves or releases — that stays with two people.
 */
export async function payoutBatchDraftTick(now = new Date()): Promise<void> {
  recordHeartbeat('payout-batch-draft', now);

  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const { finance } = await getPlatformSettings();
    const cadence = finance.payoutBatchCadence;
    if (!cadence.enabled) return;

    const slot = lastSlot(cadence, now);
    const first = await redis.set(SLOT_KEY(slot), '1', 'EX', SLOT_TTL_SECONDS, 'NX');
    if (!first) return;

    const actor = await systemUserId();
    if (!actor) {
      logger.warn('Payout batch draft skipped: no system user', { tag: TAG, slot: slot.toISOString() });
      return;
    }

    const draft = await draftScheduledBatch(actor, now);
    if (!draft) {
      logger.info('Payout batch draft: nothing to draft', { tag: TAG, slot: slot.toISOString() });
      return;
    }
    logger.info('Payout batch drafted by schedule', {
      tag: TAG,
      batchId: draft.batch.id,
      reference: draft.batch.reference,
      lineCount: draft.lineCount,
      totalNet: draft.totalNet,
      moreWaiting: draft.moreWaiting,
    });

    const admins = await financeAdminIds();
    await Promise.all(
      admins.map((userId) =>
        createNotification({
          userId,
          type: 'PAYOUT',
          title: 'Weekly payout batch drafted',
          subtitle: `${draft.batch.reference} · ${draft.lineCount} line${draft.lineCount === 1 ? '' : 's'} · ₹${draft.totalNet}`,
          message:
            `The schedule drafted ${draft.batch.reference} with ${draft.lineCount} approved withdrawal${draft.lineCount === 1 ? '' : 's'} totalling ₹${draft.totalNet} net.` +
            (draft.moreWaiting ? ' More approved lines did not fit under the cap and wait for the next draft.' : '') +
            ' Review the lines, submit it, and have a second admin approve and release.',
          suggestedAction: 'Open the batch',
          relatedId: draft.batch.id,
        }),
      ),
    );
  } catch (err) {
    logger.error('payoutBatchDraftJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  } finally {
    await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

export function startPayoutBatchDraftJob(): void {
  payoutBatchDraftInterval = setInterval(() => void payoutBatchDraftTick(), INTERVAL_MS);
}

import { prismaPayoutsRepository as repository } from './prisma-payouts.repository';
import type { BatchRow } from './payouts.repository';
import type { PayoutBatchStatus, WithdrawalStatus } from '../../shared/database';

/**
 * A released batch's status is derived from its lines, never set by hand —
 * Lot B (Q140).
 *
 * Shared between the withdrawal ladder (a line marked paid or failed through
 * `/finance/withdrawals/:id/...` still belongs to its batch) and the batch
 * service, so it lives in its own file rather than in either of them.
 */

/** The one answer for a set of released lines. */
export function deriveBatchStatus(tally: readonly { status: WithdrawalStatus; count: number }[]): PayoutBatchStatus {
  let total = 0;
  let failed = 0;
  let paid = 0;
  for (const row of tally) {
    total += row.count;
    if (row.status === 'FAILED') failed += row.count;
    if (row.status === 'PAID') paid += row.count;
  }
  // Anything still with the rail keeps the batch open.
  if (paid + failed < total) return 'RELEASED';
  if (total > 0 && failed === total) return 'FAILED';
  if (failed > 0) return 'PARTIALLY_FAILED';
  return 'COMPLETED';
}

const DERIVED: readonly PayoutBatchStatus[] = ['RELEASED', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED'];

/**
 * Re-derives a released batch's status from its lines. A batch still being
 * released, or not yet released, is left alone — its status is the process's,
 * not the lines'.
 */
export async function syncBatchStatus(batchId: string, now: Date): Promise<BatchRow | null> {
  const batch = await repository.findBatch(batchId);
  if (!batch) return null;
  if (!DERIVED.includes(batch.status)) return batch;
  const status = deriveBatchStatus(await repository.tallyBatchLines(batchId));
  if (status === batch.status) return batch;
  return repository.updateBatch(batchId, {
    status,
    completedAt: status === 'RELEASED' ? null : now,
  });
}

import { money } from '../../shared/money';
import { partyOfWithdrawal, type BankAccountRow, type BatchRow, type MethodRow, type WithdrawalRow } from './payouts.repository';
import { userLabels, type UserLabel } from './user-labels.port';

/**
 * Wire shapes shared by the finance controllers. Masked on the way out: a
 * statement or a batch line needs to show which account, and nothing on
 * either needs the whole number.
 */

export const shapeMethod = (method: MethodRow) => ({
  id: method.id,
  type: method.type,
  accountHolder: method.accountHolder,
  bankName: method.bankName,
  accountNumberMasked: method.accountNumber
    ? `•••• ${method.accountNumber.slice(-4)}`
    : null,
  ifscCode: method.ifscCode,
  bankBranch: method.bankBranch,
  ifscVerifiedAt: method.ifscVerifiedAt,
  upiVpa: method.upiVpa,
  isDefault: method.isDefault,
  status: method.status,
  verifiedVia: method.verifiedVia,
  verifiedAt: method.verifiedAt,
  nameMatchPct: method.nameMatchPct ? money(method.nameMatchPct) : null,
  rejectionReason: method.rejectionReason,
  createdAt: method.createdAt,
});

export const shapeWithdrawal = (row: WithdrawalRow) => {
  const party = partyOfWithdrawal(row);
  return {
    id: row.id,
    reference: row.reference,
    walletId: row.walletId,
    /** Lot B (Q140): from the wallet's owner, for the queue's filter and the batch line. */
    partyKind: party.kind,
    partyName: party.name,
    /** E6: the queue says when the wallet behind the line is frozen (Lot A FREEZE_WALLET). */
    walletFrozen: Boolean(row.wallet.frozenAt),
    amount: money(row.amount),
    taxWithheld: money(row.taxWithheld),
    netAmount: money(row.netAmount),
    status: row.status,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    reservedAt: row.reservedAt,
    batchId: row.batchId,
    rail: row.rail,
    railReference: row.railReference,
    paidAt: row.paidAt,
    failureReason: row.failureReason,
    method: shapeMethod(row.payoutMethod),
  };
};

export const shapeBatch = (batch: BatchRow) => ({
  id: batch.id,
  reference: batch.reference,
  status: batch.status,
  rail: batch.rail,
  bankAccountId: batch.bankAccountId,
  cutoffAt: batch.cutoffAt,
  scheduledFor: batch.scheduledFor,
  createdByUserId: batch.createdByUserId,
  submittedAt: batch.submittedAt,
  approvedByUserId: batch.approvedByUserId,
  approvedAt: batch.approvedAt,
  releasedAt: batch.releasedAt,
  completedAt: batch.completedAt,
  lineCount: batch.lineCount,
  totalNet: money(batch.totalNet),
  exportFileId: batch.exportFileId,
  note: batch.note,
  createdAt: batch.createdAt,
  updatedAt: batch.updatedAt,
});

/**
 * E6: `createdBy { id, name }` and `approvedBy { id, name } | null` on a
 * batch, through the user-label port bootstrap fills. One lookup for the
 * whole page.
 */
export async function withBatchActors<T extends { createdByUserId: string; approvedByUserId: string | null }>(
  batches: T[],
): Promise<(T & { createdBy: UserLabel; approvedBy: UserLabel | null })[]> {
  const ids = batches.flatMap((batch) => [batch.createdByUserId, ...(batch.approvedByUserId ? [batch.approvedByUserId] : [])]);
  const labels = await userLabels(ids);
  const label = (id: string): UserLabel => labels.get(id) ?? { id, name: null };
  return batches.map((batch) => ({
    ...batch,
    createdBy: label(batch.createdByUserId),
    approvedBy: batch.approvedByUserId ? label(batch.approvedByUserId) : null,
  }));
}

/** Already masked in the row: the whole number was never stored. */
export const shapeBankAccount = (account: BankAccountRow) => ({
  id: account.id,
  label: account.label,
  bankName: account.bankName,
  accountHolder: account.accountHolder,
  accountNumberMasked: account.accountNumberMasked,
  ifsc: account.ifsc,
  isActive: account.isActive,
  isDefault: account.isDefault,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
});

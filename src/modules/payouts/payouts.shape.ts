import { money } from '../../shared/money';
import { VERIFICATION_PROVIDER_LABELS, isTechnical, type AttemptRecord, type UpiVpaAnswer, type VerificationProviderName } from '../../shared/verification';
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

/**
 * The last automatic check of a payout method, as the desk and the person
 * read it (2 Oct 2026). `outcome`:
 *
 *   VERIFIED       the provider confirmed it (and the name, when one was sent)
 *   NOT_FOUND      the UPI ID is not active, or does not exist
 *   NAME_MISMATCH  live, under a name that does not match the holder
 *   INVALID        the bank says the account is not live
 *   REFUSED        the provider said no for another reason
 *   UNAVAILABLE    nobody could answer — the method waits for the desk
 *
 * A method whose last check is NOT_FOUND, NAME_MISMATCH or REFUSED is
 * FLAGGED: saved, unverified, and the reason is here for the desk.
 */
export type MethodCheckOutcome = 'VERIFIED' | 'NOT_FOUND' | 'NAME_MISMATCH' | 'INVALID' | 'REFUSED' | 'UNAVAILABLE';
export type MethodCheckView = {
  check: 'UPI_VPA' | 'BANK_ACCOUNT';
  outcome: MethodCheckOutcome;
  provider: VerificationProviderName | null;
  providerLabel: string | null;
  /** The name on the account / UPI ID, as the provider gave it. */
  nameAtBank: string | null;
  /** 0–100, when a name was sent and scored. */
  nameMatchScore: number | null;
  failureCode: string | null;
  message: string;
  checkedAt: string;
};

const labelOf = (provider: VerificationProviderName | null) => (provider ? VERIFICATION_PROVIDER_LABELS[provider] : null);

export function upiCheckView(answer: UpiVpaAnswer, at: Date): MethodCheckView {
  return {
    check: 'UPI_VPA',
    outcome: answer.outcome,
    provider: answer.provider,
    providerLabel: labelOf(answer.provider),
    nameAtBank: answer.nameAtBank,
    nameMatchScore: answer.nameMatchScore,
    failureCode: answer.failureCode,
    message: answer.message,
    checkedAt: at.toISOString(),
  };
}

export function bankCheckView(facts: { nameAtBank: string | null; nameMatchScore: number | null }, at: Date): MethodCheckView {
  return {
    check: 'BANK_ACCOUNT',
    outcome: 'VERIFIED',
    provider: 'CASHFREE_SECURE_ID',
    providerLabel: labelOf('CASHFREE_SECURE_ID'),
    nameAtBank: facts.nameAtBank,
    nameMatchScore: facts.nameMatchScore,
    failureCode: null,
    message: 'The bank confirmed the account.',
    checkedAt: at.toISOString(),
  };
}

const NOT_FOUND_CODES = new Set(['VPA_NOT_FOUND', 'UPI_INVALID', 'UPI_NOT_FOUND', 'UPI_INACTIVE']);

/** A UPI check read back off its attempt — what the desk's queue shows beside a method. */
export function attemptCheckView(attempt: AttemptRecord): MethodCheckView {
  const raw = attempt.result ?? {};
  const named = raw['customerName'] ?? raw['nameAtBank'];
  const nameAtBank = typeof named === 'string' && named ? named : null;
  let outcome: MethodCheckOutcome;
  let message: string;
  if (attempt.status === 'VERIFIED') {
    outcome = 'VERIFIED';
    message = 'The UPI ID is live and its name matches.';
  } else if (attempt.status === 'FAILED' && !isTechnical(attempt.errorClass)) {
    if (attempt.failureCode === 'NAME_MISMATCH') {
      outcome = 'NAME_MISMATCH';
      message = 'The name on this UPI ID does not match the account holder.';
    } else if (attempt.failureCode && NOT_FOUND_CODES.has(attempt.failureCode)) {
      outcome = 'NOT_FOUND';
      message = 'This UPI ID is not active, or does not exist.';
    } else {
      outcome = 'REFUSED';
      message = 'The UPI ID was not confirmed.';
    }
  } else {
    outcome = 'UNAVAILABLE';
    message = 'This UPI ID could not be checked. Try again, or verify it by hand.';
  }
  return {
    check: 'UPI_VPA',
    outcome,
    provider: attempt.provider,
    providerLabel: labelOf(attempt.provider),
    nameAtBank,
    nameMatchScore: attempt.nameMatchScore,
    failureCode: attempt.failureCode,
    message,
    checkedAt: attempt.updatedAt.toISOString(),
  };
}

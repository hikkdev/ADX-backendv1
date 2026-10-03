import { withdrawalPaidPort } from './withdrawal-paid.port';
import { ApiError } from '../../shared/errors';
import { lookupIfsc, normaliseIfsc, type IfscAnswer } from '../../shared/integrations';
import { routedBankAccount, routedUpiVpa, verificationRuntime, type UpiVpaAnswer } from '../../shared/verification';
import { Decimal, money, type Money } from '../../shared/money';
import { monthWindowIST } from '../../shared/time';
import { platformAccount, post as postLedger } from '../ledger';
import { notify } from '../notifications';
import { logger } from '../../shared/logging';
import { ensureWallet, move, snapshot } from '../wallets';
import { syncBatchStatus } from './batch-status';
import { prismaPayoutsRepository as repository } from './prisma-payouts.repository';
import { railFor, availableRails } from './rail';
import { DEFAULT_MINIMUM_WITHDRAWAL, dailyCapFor, withholdingFor } from './rules.service';
import { attemptCheckView, bankCheckView, upiCheckView, type MethodCheckView } from './payouts.shape';
import type { MethodRow, PaidWithdrawalFilter, WithdrawalListFilter, WithdrawalRow } from './payouts.repository';
import type { PayoutMethod as PayoutMethodRow } from '../../shared/database';
import type { PayoutMethodType, PayoutRailName } from '../../shared/database';

/**
 * Getting money out.
 *
 * Two rules shape everything here, and both were decisions rather than
 * defaults. **Nothing is auto-approved** — a person vets every withdrawal
 * whatever the amount, so there is no threshold anywhere in this file. And
 * **tax is withheld when income is credited, not when it is withdrawn**: a
 * publisher's wallet already holds net-of-tax money by the time they ask for
 * it, so withdrawing does not deduct again. The columns to withhold at payout
 * exist for a policy that changes its mind, and are zero today.
 *
 * ── The ledger convention used throughout ──
 *
 * A wallet account is signed from the party's point of view: positive means the
 * party has money. `platform:payables` is its mirror, so its running total is
 * the negative of every wallet balance, and a movement between them balances to
 * zero. `platform:cash` enters at the moment finance confirms the transfer
 * left the bank (Lot B): release moves the obligation from the wallet to
 * payables, and mark-paid discharges payables against cash — the two legs a
 * bank statement can be reconciled against.
 *
 * ── Approval reserves, release debits (Lot B, Q140) ──
 *
 * Approval vets and RESERVES: the line goes APPROVED with `reservedAt`, the
 * reservation is subtracted from everything spendable and withdrawable, and
 * no money moves. The wallet debit and its PAYOUT legs post when a batch
 * releases the line (or, for a line paid by hand outside a batch, at
 * mark-paid). Rejecting an approved line simply un-reserves it. So a batch
 * that fails half-way has nothing to reverse, and every reversal that does
 * happen is of one line's own movement.
 */

/* ------------------------------------------------------------------ */
/* Payout methods                                                      */
/* ------------------------------------------------------------------ */

export type NewMethodInput = {
  type: PayoutMethodType;
  accountHolder?: string;
  bankName?: string;
  accountNumber?: string;
  ifscCode?: string;
  upiVpa?: string;
};

export const listMethods = (userId: string) => repository.findMethodsForUser(userId);

/** One method by id, for `advertisers` to check a refund's destination against. */
export const findPayoutMethod = (methodId: string) => repository.findMethod(methodId);

/** A method the caller does not own reads as missing, never as forbidden. */
export async function assertMethodOwned(methodId: string, userId: string): Promise<MethodRow> {
  const method = await repository.findMethod(methodId);
  if (!method || method.userId !== userId) {
    throw new ApiError(404, 'NOT_FOUND', 'Payout method not found');
  }
  return method;
}

/**
 * Lot B (Q11/Q109): the IFSC directory's answer for a code, shaped for the
 * app's "look up branch" field. Null when the directory did not answer.
 */
export const ifscLookup = (code: string): Promise<IfscAnswer | null> => lookupIfsc(code);

/**
 * A bank account's IFSC is checked against the public directory before the
 * row is written (Lot B, Q11):
 *
 *   known      the directory's bank and branch are stored, with the moment;
 *   unknown    400 IFSC_UNKNOWN — a typo is caught before ops spends a penny
 *              drop on it;
 *   no answer  the typed bank stands, unverified — a free third-party service
 *              being down must not stop a party adding their account.
 */
export async function addMethod(userId: string, input: NewMethodInput): Promise<MethodRow> {
  if (input.type === 'BANK') {
    if (!input.accountHolder || !input.bankName || !input.accountNumber || !input.ifscCode) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'A bank account needs a holder, bank, number and IFSC.');
    }
  } else if (!input.upiVpa) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A UPI method needs a VPA.');
  }

  let bankName = input.type === 'BANK' ? input.bankName! : null;
  let bankBranch: string | null = null;
  let ifscVerifiedAt: Date | null = null;
  if (input.type === 'BANK') {
    const answer = await lookupIfsc(input.ifscCode!);
    if (answer && !answer.found) {
      throw new ApiError(400, 'IFSC_UNKNOWN', 'That IFSC is not in the bank directory. Check it against the cheque or passbook.', {
        ifsc: answer.ifsc,
      });
    }
    if (answer?.found) {
      bankName = answer.bank;
      bankBranch = answer.branch || null;
      ifscVerifiedAt = new Date();
    }
  }

  const existing = await repository.countMethodsForUser(userId);
  return repository.createMethod({
    userId,
    type: input.type,
    accountHolder: input.type === 'BANK' ? input.accountHolder! : null,
    bankName,
    accountNumber: input.type === 'BANK' ? input.accountNumber! : null,
    ifscCode: input.type === 'BANK' ? normaliseIfsc(input.ifscCode!) : null,
    bankBranch,
    ifscVerifiedAt,
    upiVpa: input.type === 'UPI' ? input.upiVpa!.trim() : null,
    // A UPI method keeps the holder's name when the form sent one: it is the
    // name the UPI check compares against.
    ...(input.type === 'UPI' && input.accountHolder?.trim() ? { accountHolder: input.accountHolder.trim() } : {}),
    // The first method a party adds is their default; nobody should have to
    // choose one when they only have one.
    isDefault: existing === 0,
  });
}

/**
 * A person adds their OWN payout method (the app, the website, a print
 * partner's own screen) — 2 Oct 2026. Saved exactly as `addMethod` saves
 * it; then, for a UPI ID while the UPI check is Digio's VPA lookup, the
 * check runs at once:
 *
 *   VERIFIED                          the method is marked verified, recorded
 *                                     as the desk's check would record it;
 *   NOT_FOUND / NAME_MISMATCH / REFUSED  FLAGGED — saved, unverified, the
 *                                     answer on record for the desk;
 *   UNAVAILABLE                       unverified, for the desk to check.
 *
 * The method saves either way: a check that could not run never stops a
 * person adding where their money goes. No consent is captured here, so
 * Cashfree's penny drop (the backup) is never asked from this door.
 */
/**
 * The name a UPI check matches against: the holder the method names, else the
 * owner's own name — the app and website forms ask for no holder on a UPI ID,
 * and without a name Digio gives no match score (2 Oct 2026). A failed read
 * sends no name rather than failing the check.
 */
async function upiNameFor(method: MethodRow): Promise<string | undefined> {
  if (method.accountHolder?.trim()) return method.accountHolder.trim();
  try {
    return (await repository.findHolderName(method.userId)) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function addOwnMethod(userId: string, input: NewMethodInput, now = new Date()): Promise<{ method: MethodRow; check: MethodCheckView | null }> {
  const method = await addMethod(userId, input);
  if (method.type !== 'UPI' || !method.upiVpa) return { method, check: null };
  const { upiCheck } = await verificationRuntime().settings();
  if (upiCheck !== 'VPA_LOOKUP') return { method, check: null };

  let answer: UpiVpaAnswer;
  try {
    answer = await routedUpiVpa({ vpa: method.upiVpa, name: await upiNameFor(method) }, { caseType: 'PAYOUT_METHOD', caseId: method.id });
  } catch (err) {
    // The router does not throw for a provider; a store that did must not undo the save.
    logger.error('The UPI check on a new payout method could not run; left for the desk', { methodId: method.id, reason: err instanceof Error ? err.name : 'unknown' });
    return { method, check: null };
  }
  const check = upiCheckView(answer, now);
  if (answer.outcome !== 'VERIFIED') return { method, check };
  const verified = await recordVerified(method.id, { via: answer.via ?? 'NAME_LOOKUP', reference: answer.reference, nameMatchPct: scoreOf(answer.nameMatchScore), byUserId: null }, now);
  return { method: verified, check };
}

/** The last UPI check of each UPI method, read off the attempts — what the desk's queue shows beside it. */
export async function lastUpiChecks(methods: readonly MethodRow[]): Promise<Map<string, MethodCheckView>> {
  const out = new Map<string, MethodCheckView>();
  const attempts = verificationRuntime().attempts;
  await Promise.all(
    methods
      .filter((method) => method.type === 'UPI')
      .map(async (method) => {
        const rows = await attempts.listForCase('PAYOUT_METHOD', method.id, 10);
        const last = rows
          .filter((row) => row.checkType === 'UPI_VPA' && row.status !== 'PENDING')
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        if (last) out.set(method.id, attemptCheckView(last));
      }),
  );
  return out;
}

const scoreOf = (score: number | null): Money | null => (score === null ? null : String(score));

export async function removeMethod(methodId: string, userId: string): Promise<void> {
  const method = await assertMethodOwned(methodId, userId);
  if (method.isDefault) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'That is your default. Make another one the default before removing it.'
    );
  }
  await repository.removeMethod(methodId);
}

export async function setDefaultMethod(methodId: string, userId: string): Promise<MethodRow> {
  await assertMethodOwned(methodId, userId);
  return repository.setDefaultMethod(userId, methodId);
}

/**
 * Ops confirms a method is really the party's.
 *
 * A penny drop where the rail offers one, ops eyes where it does not. Both end
 * in the same state; what differs is what the record says about how it was
 * proved, which is the thing that matters when a payout is later disputed.
 */
export async function verifyMethod(
  methodId: string,
  input: {
    via: 'PENNY_DROP' | 'NAME_LOOKUP' | 'MANUAL';
    reference?: string | null;
    nameMatchPct?: Money | null;
    byUserId: string;
  },
  now = new Date()
): Promise<MethodRow> {
  return (await verifyMethodChecked(methodId, input, now)).method;
}

/**
 * `verifyMethod`, with the provider's answer beside the method — what the
 * desk's "Check UPI ID" / penny drop shows (the name at the bank, the score).
 * `check` is null when nothing was asked (MANUAL, NAME_LOOKUP by hand, or a
 * method already verified).
 */
export async function verifyMethodChecked(
  methodId: string,
  input: {
    via: 'PENNY_DROP' | 'NAME_LOOKUP' | 'MANUAL';
    reference?: string | null;
    nameMatchPct?: Money | null;
    byUserId: string;
  },
  now = new Date()
): Promise<{ method: MethodRow; check: MethodCheckView | null }> {
  const method = await repository.findMethod(methodId);
  if (!method) throw new ApiError(404, 'NOT_FOUND', 'Payout method not found');
  if (method.status === 'VERIFIED') return { method, check: null };

  // AG-4: a PENNY_DROP on a bank method runs Cashfree's bank-account check
  // (a rupee sent, the name at the bank read back). Cashfree saying the
  // account is not live, refusing, or being unconfigured is a 409 the desk
  // reads and may answer by hand; nothing is marked verified then.
  //
  // Cashfree Phase 1 (1 Oct 2026): the check goes through the verification
  // router (an attempt on record against the method), and a PENNY_DROP that
  // can run no check is refused rather than marking the method verified:
  //
  //   - a UPI method (2 Oct 2026): with the UPI check on Digio's VPA lookup
  //     (`verificationRouting.upiCheck: 'VPA_LOOKUP'`, the default) the
  //     desk's PENNY_DROP runs the routed UPI_VPA check — no consent needed
  //     through Digio; Cashfree's penny drop, the backup, is skipped without
  //     the holder's consent. Live with a matching name → VERIFIED, recorded
  //     as a NAME_LOOKUP (Digio) or a PENNY_DROP (Cashfree); not found, a
  //     name under `nameMatchMin` or a refusal → 409 VERIFICATION_UNAVAILABLE
  //     with the answer; nobody could answer → 503 VERIFICATION_UNAVAILABLE.
  //     With NONE, or a check that needs the holder themself (their consent
  //     for a penny drop, their ₹1 for a reverse one), it stays the 409
  //     UPI_CHECK_NOT_CONFIGURED, and the desk verifies by hand.
  //   - a bank method with no account number or IFSC on it had nothing to
  //     check. It is a 409 now, not a verification.
  let reference = input.reference ?? null;
  let nameMatchPct = input.nameMatchPct ?? null;
  let via: 'PENNY_DROP' | 'NAME_LOOKUP' | 'MANUAL' = input.via;
  let check: MethodCheckView | null = null;
  if (input.via === 'PENNY_DROP' && method.type !== 'BANK') {
    const { upiCheck } = await verificationRuntime().settings();
    if (upiCheck !== 'VPA_LOOKUP') {
      throw new ApiError(
        409,
        'UPI_CHECK_NOT_CONFIGURED',
        upiCheck === 'NONE'
          ? 'No UPI check has been chosen yet, so a UPI id cannot be penny-dropped. Verify it by hand, or choose a check under Settings › Integrations › Verification routing.'
          : 'A UPI check needs the account holder themself — their consent for a penny drop, or their ₹1 for a reverse penny drop — so it cannot be run from the desk. Verify this UPI id by hand.',
        { upiCheck, reason: upiCheck === 'NONE' ? 'NOT_CHOSEN' : 'NEEDS_ACCOUNT_HOLDER' },
      );
    }
    if (!method.upiVpa) {
      throw new ApiError(409, 'VERIFICATION_UNAVAILABLE', 'This method has no UPI ID to check', { code: 'NOTHING_TO_CHECK' });
    }
    const answer = await routedUpiVpa({ vpa: method.upiVpa, name: await upiNameFor(method) }, { caseType: 'PAYOUT_METHOD', caseId: method.id });
    check = upiCheckView(answer, now);
    if (answer.outcome === 'UNAVAILABLE') throw new ApiError(503, 'VERIFICATION_UNAVAILABLE', answer.message, { code: 'UNAVAILABLE', check });
    if (answer.outcome !== 'VERIFIED') throw new ApiError(409, 'VERIFICATION_UNAVAILABLE', answer.message, { code: answer.outcome, check });
    via = answer.via ?? 'NAME_LOOKUP';
    reference = answer.reference ?? reference;
    nameMatchPct = scoreOf(answer.nameMatchScore) ?? nameMatchPct;
  } else if (input.via === 'PENNY_DROP') {
    if (!method.accountNumber || !method.ifscCode) {
      throw new ApiError(409, 'VERIFICATION_UNAVAILABLE', 'This method has no account number and IFSC to check', { code: 'NOTHING_TO_CHECK' });
    }
    const answer = await routedBankAccount({ accountNumber: method.accountNumber, ifsc: method.ifscCode, name: method.accountHolder }, { caseType: 'PAYOUT_METHOD', caseId: method.id });
    if (!answer.ok) throw new ApiError(409, 'VERIFICATION_UNAVAILABLE', answer.message, { code: answer.code });
    if (!answer.facts.valid) {
      throw new ApiError(409, 'VERIFICATION_UNAVAILABLE', `Cashfree says the account is ${answer.facts.accountStatus ?? 'not live'}${answer.facts.nameAtBank ? ` (name at bank: ${answer.facts.nameAtBank})` : ''}`, { code: 'INVALID', facts: answer.facts });
    }
    reference = answer.facts.referenceId ?? answer.facts.utr ?? reference;
    nameMatchPct = answer.facts.nameMatchScore !== null ? String(answer.facts.nameMatchScore) : nameMatchPct;
    check = bankCheckView(answer.facts, now);
  }

  return { method: await recordVerified(methodId, { via, reference, nameMatchPct, byUserId: input.byUserId }, now), check };
}

/** How a verified method is written — by the desk's check, by hand, or by the check run when a person added their own UPI ID (no desk user). */
async function recordVerified(
  methodId: string,
  input: { via: 'PENNY_DROP' | 'NAME_LOOKUP' | 'MANUAL'; reference: string | null; nameMatchPct: Money | null; byUserId: string | null },
  now: Date
): Promise<MethodRow> {
  return repository.updateMethod(methodId, {
    status: 'VERIFIED',
    verifiedVia: input.via,
    verificationReference: input.reference,
    nameMatchPct: input.nameMatchPct ? new Decimal(input.nameMatchPct) : null,
    verifiedAt: now,
    verifiedByUserId: input.byUserId,
    rejectionReason: null,
  } as never);
}

export async function rejectMethod(
  methodId: string,
  reason: string,
  byUserId: string
): Promise<MethodRow> {
  if (!reason.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Say why the method was rejected.');
  }
  const method = await repository.findMethod(methodId);
  if (!method) throw new ApiError(404, 'NOT_FOUND', 'Payout method not found');
  return repository.updateMethod(methodId, {
    status: 'REJECTED',
    rejectionReason: reason.trim(),
    verifiedByUserId: byUserId,
  } as never);
}

export const listMethodsAwaitingReview = (limit = 100) =>
  repository.listMethodsByStatus('PENDING_VERIFICATION', limit);

/* ------------------------------------------------------------------ */
/* Withdrawal                                                          */
/* ------------------------------------------------------------------ */

async function nextReference(now: Date): Promise<string> {
  const year = now.getUTCFullYear();
  let n = (await repository.countForYear(year)) + 1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const reference = `WDR-${year}-${String(n).padStart(6, '0')}`;
    if (!(await repository.referenceExists(reference))) return reference;
    n += 1;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not allocate a withdrawal reference');
}

const startOfDay = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * What this party could withdraw right now, and why it is not more.
 *
 * Returned as a whole rather than as a single number because every screen that
 * asks needs the reasons too: the frame draws pending money separately from
 * cleared, and a cap that has been reached should say so rather than silently
 * shrinking the maximum.
 */
export async function withdrawalAllowance(walletId: string, now = new Date()) {
  const party = await repository.findPartyContext(walletId);
  if (!party) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');

  const [balances, cap] = await Promise.all([
    snapshot(walletId, now),
    dailyCapFor(party.sizeBand, party.onboardedAt, now),
  ]);

  const dayStart = startOfDay(now);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const usedToday = await repository.sumForDay(walletId, dayStart, dayEnd);

  const remainingToday = Decimal.max(
    new Decimal(cap.cap).minus(new Decimal(usedToday)),
    new Decimal(0)
  );
  const available = Decimal.min(new Decimal(balances.withdrawable), remainingToday);

  return {
    walletId,
    party: { kind: party.kind, name: party.name, sizeBand: party.sizeBand },
    balance: balances.balance,
    pendingClearance: balances.pendingClearance,
    openWithdrawals: balances.openWithdrawals,
    withdrawable: balances.withdrawable,
    dailyCap: cap.cap,
    usedToday: money(usedToday),
    remainingToday: money(remainingToday),
    /** The most this party may ask for right now. */
    maximum: money(Decimal.max(available, new Decimal(0))),
    minimum: DEFAULT_MINIMUM_WITHDRAWAL,
    monthsOnPlatform: cap.months,
    nextRung: cap.nextRung,
    /** Lot A FREEZE_WALLET: while set, the maximum is academic — nothing leaves. */
    frozenAt: balances.frozenAt ?? null,
  };
}

/** Lot A FREEZE_WALLET: a withdrawal is neither raised nor approved from a frozen wallet. */
function assertNotFrozen(frozenAt: Date | null | undefined): void {
  if (frozenAt) {
    throw new ApiError(409, 'WALLET_FROZEN', 'This wallet is frozen; withdrawals are refused until it is lifted', {
      frozenAt,
    });
  }
}

/**
 * Lot A (Q21): the marker `requestClosingWithdrawal` writes on the final
 * payout of a closing account. The closure freezes the wallet and then raises
 * this withdrawal, so the freeze must not stop it at approval or release —
 * and must stop everything else. The marker is the whole test: a withdrawal
 * carries it only when this module wrote it there.
 */
export const CLOSURE_WITHDRAWAL_MARKER = '[closure] Final payout of a closed account';

export const isClosureWithdrawal = (row: Pick<WithdrawalRow, 'decisionNote'>): boolean =>
  Boolean(row.decisionNote?.startsWith(CLOSURE_WITHDRAWAL_MARKER));

export async function requestWithdrawal(
  walletId: string,
  input: { amount: Money; payoutMethodId: string; userId: string; decisionNote?: string | null },
  now = new Date()
): Promise<WithdrawalRow> {
  const method = await assertMethodOwned(input.payoutMethodId, input.userId);
  if (method.status !== 'VERIFIED') {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'That payout method has not been verified yet. ADX checks it before sending money to it.'
    );
  }

  const allowance = await withdrawalAllowance(walletId, now);
  assertNotFrozen(allowance.frozenAt);
  const amount = new Decimal(input.amount);

  if (amount.lessThanOrEqualTo(0)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Enter an amount to withdraw.');
  }
  if (amount.lessThan(new Decimal(allowance.minimum))) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `The smallest withdrawal is ₹${allowance.minimum}.`
    );
  }
  if (amount.greaterThan(new Decimal(allowance.remainingToday))) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `That is over today's limit. You can withdraw ₹${allowance.remainingToday} more today; your daily cap is ₹${allowance.dailyCap}.`
    );
  }
  if (amount.greaterThan(new Decimal(allowance.withdrawable))) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Only ₹${allowance.withdrawable} has cleared. ₹${allowance.pendingClearance} is still inside its clearing window.`
    );
  }

  /*
   * Nothing is withheld here. Tax was already deducted when the earning or the
   * incentive was credited, so this wallet holds net-of-tax money and taking it
   * again would tax the same rupee twice.
   */
  return repository.createWithdrawal({
    reference: await nextReference(now),
    walletId,
    payoutMethodId: method.id,
    amount,
    taxWithheld: new Decimal(0),
    taxRatePct: new Decimal(0),
    taxSection: null,
    netAmount: amount,
    // E6: the note ops typed at the desk rides on the row, not only the audit.
    ...(input.decisionNote ? { decisionNote: input.decisionNote } : {}),
  });
}

/**
 * A withdrawal ops raises for a party who cannot raise their own — Lot B
 * (B4b, owner decisions 50/122). A print partner's account is
 * sign-in-disabled, so the settlement of an approved job cost starts at the
 * desk: ops names the wallet and the amount, and everything after that is
 * `requestWithdrawal` unchanged — the VERIFIED method (the party's default
 * unless one is named), the minimum, the daily cap, the cleared balance and
 * the freeze. It then walks the same ladder — approve, batch release or a
 * hand mark-paid with the UTR — so an offline NEFT is a PAID withdrawal on
 * the books rather than a note in a spreadsheet.
 *
 * The rules are the same for every party on purpose: this is not a print
 * partner path, it is the ordinary path started by somebody else.
 */
export async function requestWithdrawalOnBehalf(
  input: { walletId: string; amount: Money; payoutMethodId?: string | null; note?: string | null },
  now = new Date()
): Promise<WithdrawalRow> {
  const party = await repository.findPartyContext(input.walletId);
  if (!party) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
  if (!party.userId) {
    throw new ApiError(409, 'CONFLICT', 'This wallet has no account to pay; a payout method needs one.');
  }

  let methodId = input.payoutMethodId ?? null;
  if (!methodId) {
    const methods = await repository.findMethodsForUser(party.userId);
    const verified = methods.filter((method) => method.status === 'VERIFIED');
    const method = verified.find((row) => row.isDefault) ?? verified[0];
    if (!method) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'This party has no verified payout method. Record one with POST /finance/payout-methods and verify it first.'
      );
    }
    methodId = method.id;
  }

  return requestWithdrawal(
    input.walletId,
    { amount: input.amount, payoutMethodId: methodId, userId: party.userId, decisionNote: input.note ?? null },
    now
  );
}

/**
 * The last withdrawal of a closing account — Lot A (Q21).
 *
 * Three of the ordinary rules are deliberately not applied, and each for the
 * same reason: they exist to pace a *running* account. A daily cap would leave
 * a closed wallet trickling out over weeks with nobody left to press the
 * button; the minimum would strand a balance under it for ever; and the freeze
 * is the closure's own doing, so honouring it here would mean the closure
 * could never pay anybody back. What is NOT relaxed is the one rule that
 * protects the money: the method must be a VERIFIED default, and a person
 * still vets the request — this creates a REQUESTED row and nothing more.
 *
 * Holds and the clearing window are respected, because that money is not the
 * party's to take yet. When they swallow the whole balance the caller is told
 * so and records it on the closure case rather than silently paying nothing.
 */
export async function requestClosingWithdrawal(
  walletId: string,
  input: { userId: string; note?: string },
  now = new Date()
): Promise<{
  withdrawal: WithdrawalRow | null;
  amount: Money;
  reason: 'REQUESTED' | 'NO_VERIFIED_METHOD' | 'NOTHING_WITHDRAWABLE';
}> {
  const balances = await snapshot(walletId, now);
  const amount = new Decimal(balances.withdrawable);

  if (amount.lessThanOrEqualTo(0)) {
    return { withdrawal: null, amount: money(amount), reason: 'NOTHING_WITHDRAWABLE' };
  }

  const methods = await repository.findMethodsForUser(input.userId);
  const verified = methods.filter((method) => method.status === 'VERIFIED');
  const method = verified.find((row) => row.isDefault) ?? verified[0];
  if (!method) {
    return { withdrawal: null, amount: money(amount), reason: 'NO_VERIFIED_METHOD' };
  }

  const withdrawal = await repository.createWithdrawal({
    reference: await nextReference(now),
    walletId,
    payoutMethodId: method.id,
    amount,
    // Tax was withheld when the money was credited; see the header.
    taxWithheld: new Decimal(0),
    taxRatePct: new Decimal(0),
    taxSection: null,
    netAmount: amount,
    // The marker approval and release read to let this one debit past the
    // freeze the closure applied. See CLOSURE_WITHDRAWAL_MARKER.
    decisionNote: input.note ? `${CLOSURE_WITHDRAWAL_MARKER}: ${input.note}` : CLOSURE_WITHDRAWAL_MARKER,
  });
  return { withdrawal, amount: money(amount), reason: 'REQUESTED' };
}

export async function cancelWithdrawal(
  withdrawalId: string,
  userId: string
): Promise<WithdrawalRow> {
  const request = await repository.findWithdrawal(withdrawalId);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Withdrawal not found');

  const party = await repository.findPartyContext(request.walletId);
  if (!party || party.userId !== userId) {
    throw new ApiError(404, 'NOT_FOUND', 'Withdrawal not found');
  }
  if (request.status !== 'REQUESTED') {
    throw new ApiError(
      409,
      'CONFLICT',
      'ADX has already started on this one. Contact support to stop it.'
    );
  }
  return repository.updateWithdrawal(withdrawalId, { status: 'CANCELLED' });
}

/**
 * Ops approves, and only ops.
 *
 * There is no amount below which this is skipped: the instruction was that
 * every payout is vetted by a person, so the absence of a threshold in this
 * file is the feature. Approving RESERVES the money (Lot B, Q140): the line
 * goes APPROVED with `reservedAt`, the reservation comes off the party's
 * spendable and withdrawable balance, and nothing moves until a batch
 * releases it. The party cannot spend what is on its way to their bank; the
 * books do not say it has left until it has.
 */
export async function approveWithdrawal(
  withdrawalId: string,
  input: { byUserId: string; note?: string | null; rail?: PayoutRailName | null },
  now = new Date()
): Promise<WithdrawalRow> {
  const request = await repository.findWithdrawal(withdrawalId);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Withdrawal not found');
  if (request.status !== 'REQUESTED') {
    throw new ApiError(409, 'CONFLICT', `This withdrawal is ${request.status.toLowerCase()}.`);
  }

  const party = await repository.findPartyContext(request.walletId);
  if (!party) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');

  const closing = isClosureWithdrawal(request);
  const balances = await snapshot(request.walletId, now);
  // Lot A (Q21): the closure's own final payout is the one withdrawal a
  // frozen wallet admits — the freeze is the closure's doing.
  if (!closing) assertNotFrozen(balances.frozenAt);
  assertWalletCovers(request, balances);

  const rail = await railFor(input.rail ?? null);
  return repository.updateWithdrawal(withdrawalId, {
    status: 'APPROVED',
    decidedAt: now,
    decidedByUserId: input.byUserId,
    // The closure marker survives the decision: release reads it too.
    decisionNote: closing
      ? [request.decisionNote, input.note].filter(Boolean).join(' — ')
      : (input.note ?? null),
    rail: rail.name,
    reservedAt: now,
  });
}

/**
 * Re-checked at approval and again at release rather than trusted from the
 * request: the balance may have moved since it was raised, and paying out
 * what the wallet can no longer cover is how an overdraft happens.
 *
 * Computed from the unclamped parts rather than from `withdrawable`, which is
 * floored at zero for display — a wallet that is short would read as having
 * nothing available rather than as having a shortfall, and the check would
 * pass. This request's own reservation is added back, because it is the one
 * about to be paid; every other open request stays reserved.
 */
export function walletShortfall(
  request: Pick<WithdrawalRow, 'amount'>,
  balances: { balance: Money; pendingClearance: Money; held: Money; openWithdrawals: Money }
): Decimal | null {
  const amount = new Decimal(request.amount);
  const otherOpen = Decimal.max(new Decimal(balances.openWithdrawals).minus(amount), new Decimal(0));
  const fundable = new Decimal(balances.balance)
    .minus(new Decimal(balances.pendingClearance))
    .minus(new Decimal(balances.held))
    .minus(otherOpen);
  return amount.greaterThan(fundable) ? Decimal.max(fundable, new Decimal(0)) : null;
}

function assertWalletCovers(
  request: Pick<WithdrawalRow, 'amount'>,
  balances: { balance: Money; pendingClearance: Money; held: Money; openWithdrawals: Money }
): void {
  const fundable = walletShortfall(request, balances);
  if (fundable !== null) {
    throw new ApiError(
      409,
      'CONFLICT',
      `The wallet no longer covers this: ₹${money(fundable)} can be paid against a request for ₹${money(request.amount)}.`
    );
  }
}

/**
 * The debit and its PAYOUT legs — Lot B (Q140), posted when a line is
 * released rather than when it is approved. Keyed on the withdrawal, so a
 * retried release, a batch re-run and a hand mark-paid all post it once.
 * The closure's own payout passes the freeze it caused; nothing else does.
 */
export async function debitForRelease(
  request: WithdrawalRow,
  input: { byUserId: string },
  now = new Date()
): Promise<{ ledgerTransactionId: string; created: boolean }> {
  const party = await repository.findPartyContext(request.walletId);
  if (!party) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
  const amount = new Decimal(request.amount);
  const result = await move({
    walletId: request.walletId,
    walletLabel: `${party.name} · ${party.kind.toLowerCase()}`,
    amount: money(amount.negated()),
    entryType: 'PAYOUT',
    ledgerKind: 'PAYOUT',
    idempotencyKey: `withdrawal:${request.id}`,
    counterLegs: [
      {
        accountCode: 'platform:payables',
        amount: money(amount),
        note: 'Obligation discharged at release',
      },
    ],
    reference: request.reference,
    note: `Withdrawal ${request.reference}`,
    createdByUserId: input.byUserId,
    occurredAt: now,
    allowFrozen: isClosureWithdrawal(request),
  });
  return { ledgerTransactionId: result.ledgerTransactionId, created: result.created };
}

/**
 * Refused, before or after approval. An APPROVED line is only reserved
 * (Lot B, Q140), so refusing it un-reserves and nothing is reversed. A line
 * sitting in a batch a second admin has already signed off stays where it
 * is — cancel the batch, or fail the line after release.
 */
export async function rejectWithdrawal(
  withdrawalId: string,
  input: { byUserId: string; reason: string },
  now = new Date()
): Promise<WithdrawalRow> {
  if (!input.reason.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Say why the withdrawal was refused.');
  }
  const request = await repository.findWithdrawal(withdrawalId);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Withdrawal not found');
  if (request.status !== 'REQUESTED' && request.status !== 'APPROVED') {
    throw new ApiError(409, 'CONFLICT', `This withdrawal is ${request.status.toLowerCase()}.`);
  }
  if (request.batchId) {
    const batch = await repository.findBatch(request.batchId);
    if (batch && batch.status !== 'DRAFT' && batch.status !== 'IN_REVIEW') {
      throw new ApiError(
        409,
        'CONFLICT',
        `This line is in batch ${batch.reference}, which is ${batch.status.toLowerCase()}. Cancel the batch to free it.`
      );
    }
  }
  // Nothing to reverse: no money has moved before release.
  const rejected = await repository.updateWithdrawal(withdrawalId, {
    status: 'REJECTED',
    decidedAt: now,
    decidedByUserId: input.byUserId,
    decisionNote: input.reason.trim(),
    reservedAt: null,
    batchId: null,
  });
  if (request.batchId) await repository.recountBatch(request.batchId);
  return rejected;
}

/**
 * Finance confirms the transfer landed, with the UTR the bank line will show.
 *
 * This is where cash enters the books (Lot B): release already moved the
 * obligation from the wallet to payables; now payables is discharged against
 * `platform:cash` — payables −net, cash +net (cash leaving is a credit to
 * the cash account, the same way a top-up settling is a debit). No wallet leg,
 * so it posts to the ledger directly, keyed on the withdrawal.
 *
 * A line paid by hand straight from APPROVED never went through a batch, so
 * the debit it would have had at release is posted here first (Lot B, Q140)
 * — the wallet must not keep money that has left the bank.
 */
export async function markWithdrawalPaid(
  withdrawalId: string,
  input: { railReference: string; byUserId: string },
  now = new Date()
): Promise<WithdrawalRow> {
  if (!input.railReference.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A payment needs its UTR or transfer reference.');
  }
  const request = await repository.findWithdrawal(withdrawalId);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Withdrawal not found');
  if (request.status === 'PAID') return request;
  if (request.status !== 'APPROVED' && request.status !== 'PROCESSING') {
    throw new ApiError(
      409,
      'CONFLICT',
      'Only an approved withdrawal can be marked paid.'
    );
  }

  let ledgerTransactionId = request.ledgerTransactionId ?? null;
  if (request.status === 'APPROVED') {
    ledgerTransactionId = (await debitForRelease(request, { byUserId: input.byUserId }, now)).ledgerTransactionId;
  }

  const railReference = input.railReference.trim();
  const net = money(request.netAmount);
  const [payables, cash] = await Promise.all([
    platformAccount('platform:payables'),
    platformAccount('platform:cash'),
  ]);
  await postLedger(
    {
      kind: 'PAYOUT',
      idempotencyKey: `withdrawal-paid:${request.id}`,
      legs: [
        { accountId: payables.id, amount: money(new Decimal(net).negated()), reference: request.reference, note: 'Payout paid' },
        { accountId: cash.id, amount: net, reference: request.reference, note: `Payout paid, UTR ${railReference}` },
      ],
      occurredAt: now,
      createdByUserId: input.byUserId,
      note: `Withdrawal ${request.reference} paid`,
    },
    now
  );

  const paid = await repository.updateWithdrawal(withdrawalId, {
    status: 'PAID',
    paidAt: now,
    railReference,
    rail: request.rail ?? 'MANUAL_NEFT',
    ledgerTransactionId,
  });
  if (paid.batchId) await syncBatchStatus(paid.batchId, now);
  await tellPartyPaid(paid, railReference);
  // Account lifecycle (2 Oct 2026): an exited agent's sign-in ends with their final payout.
  await withdrawalPaidPort()
    ?.onPaid(paid, input.byUserId)
    .catch((err: unknown) => logger.warn('Withdrawal-paid hook failed', { withdrawalId: paid.id, reason: err instanceof Error ? err.message : String(err) }));
  return paid;
}

/** How the payout-paid message names where the money went — never the whole account number. */
export function payoutMethodLabel(method: Pick<PayoutMethodRow, 'type' | 'upiVpa' | 'bankName' | 'accountNumber'>): string {
  if (method.type === 'UPI') return method.upiVpa ?? 'your UPI ID';
  const last4 = method.accountNumber ? method.accountNumber.slice(-4) : null;
  return [method.bankName, last4 ? `••••${last4}` : null].filter(Boolean).join(' ') || 'your bank account';
}

/**
 * Lot E1/F: the person is told the transfer landed — one `notify` call: the
 * in-app PAYOUT row, plus the email and SMS the seeded `payout-paid`
 * template names (amount, method, reference), each subject to their PAYOUT
 * preference. Best effort: a notification that cannot be raised must not
 * unwind a payment that has been recorded.
 */
async function tellPartyPaid(paid: WithdrawalRow, railReference: string): Promise<void> {
  try {
    const party = await repository.findPartyContext(paid.walletId);
    if (!party?.userId) return;
    const amount = money(paid.netAmount);
    const method = payoutMethodLabel(paid.payoutMethod);
    await notify(
      'PAYOUT_PAID',
      party.userId,
      { amount, method, reference: paid.reference, utr: railReference },
      {
        inApp: {
          type: 'PAYOUT',
          title: 'Payout sent',
          subtitle: `₹${amount}`,
          message: `Your payout of ₹${amount} was sent to ${method}. Reference ${paid.reference}, UTR ${railReference}.`,
          suggestedAction: 'View wallet',
          relatedId: paid.id,
          relatedType: 'WITHDRAWAL',
        },
      },
    );
  } catch (err) {
    logger.warn('Payout-paid notice was not sent', { withdrawalId: paid.id, reason: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The transfer bounced. The money goes back where it came from.
 *
 * A reversal rather than an edit: the ledger cannot be changed, so the failed
 * payout stays on the record and a fresh movement returns the balance.
 */
export async function failWithdrawal(
  withdrawalId: string,
  input: { reason: string; byUserId: string },
  now = new Date()
): Promise<WithdrawalRow> {
  const request = await repository.findWithdrawal(withdrawalId);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Withdrawal not found');
  if (request.status === 'FAILED') return request;
  if (request.status === 'APPROVED') {
    // Lot B (Q140): nothing has left the wallet yet, so there is nothing to
    // return. Refuse the line instead, which un-reserves it.
    throw new ApiError(409, 'CONFLICT', 'This line has not been released; reject it instead.');
  }
  if (request.status !== 'PROCESSING') {
    throw new ApiError(409, 'CONFLICT', 'Only a payout in flight can fail.');
  }

  const party = await repository.findPartyContext(request.walletId);
  if (!party) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');

  await move({
    walletId: request.walletId,
    walletLabel: `${party.name} · ${party.kind.toLowerCase()}`,
    amount: money(request.amount),
    entryType: 'ADJUSTMENT',
    ledgerKind: 'ADJUSTMENT',
    idempotencyKey: `withdrawal-failed:${request.id}`,
    counterLegs: [
      {
        accountCode: 'platform:payables',
        amount: money(new Decimal(request.amount).negated()),
        note: 'Payout returned',
      },
    ],
    reference: request.reference,
    note: `Withdrawal ${request.reference} failed: ${input.reason}`,
    createdByUserId: input.byUserId,
    occurredAt: now,
  });

  const failed = await repository.updateWithdrawal(withdrawalId, {
    status: 'FAILED',
    failureReason: input.reason,
  });
  if (failed.batchId) await syncBatchStatus(failed.batchId, now);
  return failed;
}

export const getWithdrawal = (id: string) => repository.findWithdrawal(id);

export const listWithdrawals = (filter: Omit<WithdrawalListFilter, 'limit'> & { limit?: number }) =>
  repository.listWithdrawals({ ...filter, limit: Math.min(filter.limit ?? 50, 200) });

/**
 * Lot B (Q140): the queue's header — rows per status, and lines the rail has
 * held over a day. E6: plus the reserved, processing and paid-this-month
 * totals (the IST calendar month `now` falls in), as decimal strings.
 */
export async function withdrawalSummary(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const month = monthWindowIST(ist.getUTCFullYear(), ist.getUTCMonth() + 1);
  const summary = await repository.withdrawalSummary(new Date(now.getTime() - 24 * 60 * 60 * 1000), month);
  return {
    counts: summary.counts,
    processingOver24h: summary.processingOver24h,
    reservedTotal: money(summary.reservedTotal),
    processingTotal: money(summary.processingTotal),
    paidThisMonth: money(summary.paidThisMonth),
  };
}

/**
 * P-B: what one party has actually been paid out — the `netAmount` of its
 * PAID lines, lifetime or inside a `paidAt` window `[paidFrom, paidTo)` —
 * for the publisher's detail card. An aggregate rather than a page, so a
 * long payout history never truncates the figure.
 */
export async function paidWithdrawalTotal(filter: PaidWithdrawalFilter): Promise<{ total: Money; count: number }> {
  const result = await repository.sumPaidWithdrawals(filter);
  return { total: money(result.total), count: result.count };
}

/** Lot B (Q85): a withdrawal by the UTR the bank line shows, or by the reference the narration carries — for `reconciliation`. */
export const findWithdrawalByUtr = (utr: string) => repository.findWithdrawalByRailReference(utr.trim());
export const findWithdrawalByReference = (reference: string) => repository.findWithdrawalByReference(reference.trim().toUpperCase());

export const walletForUser = (userId: string) => repository.findWalletForUser(userId);

/**
 * Lot J2 (f): the caller's wallet, opened on first read for a publisher who
 * has never earned — a zero snapshot rather than a 404, so the pay sheet can
 * offer the wallet rail honestly (the advertiser path does the same). An
 * agent or a print partner still gets nothing until they first earn: their
 * wallets are opened by the credit that pays them.
 */
export async function walletForUserOrOpen(userId: string): Promise<{ id: string; kind: 'PUBLISHER' | 'AGENT' | 'PRINT_PARTNER' } | null> {
  const found = await repository.findWalletForUser(userId);
  if (found) return found;
  const publisherId = await repository.findPublisherIdForUser(userId);
  if (!publisherId) return null;
  const opened = await ensureWallet({ kind: 'PUBLISHER', id: publisherId }, 'Publisher wallet');
  return { id: opened.id, kind: 'PUBLISHER' };
}
export const partyContext = (walletId: string) => repository.findPartyContext(walletId);
export { availableRails };

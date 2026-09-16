import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import { prismaLedgerRepository as repository } from './prisma-ledger.repository';
import type { AccountRow, TransactionRow } from './ledger.repository';
import type { LedgerTransactionKind } from '../../shared/database';

/**
 * Double-entry, above the wallets.
 *
 * `WalletEntry` stays exactly as it is: it is the party's own statement, one
 * row per movement, and it is what a publisher reads. This sits above it and
 * answers a different question — where the money came from and where it went,
 * with ADX's own accounts on the other side of every movement.
 *
 * Three rules, and the database enforces all three rather than trusting this
 * file: every transaction balances to zero, nothing is ever updated or deleted,
 * and one idempotency key means one movement however many times it is posted.
 *
 * Sign convention: a leg is signed from the account's own point of view.
 * Positive is money arriving, negative is money leaving. A publisher earning
 * ₹1,000 is +1000 on the publisher's wallet account and −1000 on ADX's
 * payables account; the pair sums to zero, which is the whole idea.
 */

/* ------------------------------------------------------------------ */
/* The chart of accounts                                               */
/* ------------------------------------------------------------------ */

/**
 * ADX's own positions. Fixed, seeded on first use, and deliberately short — an
 * account nobody planned is a number nobody reconciles, so opening one is a
 * code change and a review rather than a runtime call.
 */
export const PLATFORM_ACCOUNTS = [
  {
    code: 'platform:cash',
    name: 'Cash and bank',
    /** Money genuinely held by ADX: gateway settlements in, payouts out. */
  },
  {
    code: 'platform:revenue',
    name: 'Revenue',
    /** ADX's take: commission on a booking, a package sale, a service fee. */
  },
  {
    code: 'platform:payables',
    name: 'Payable to parties',
    /** What ADX owes publishers, agents and partners but has not yet paid. */
  },
  {
    code: 'platform:tax-withheld',
    name: 'Tax withheld (TDS)',
    /** Deducted from an earning and owed to the tax authority, not to the party. */
  },
  {
    code: 'platform:goodwill',
    name: 'Goodwill issued',
    /** Credit given away — an apology with a balance. An expense, not a payable. */
  },
  {
    code: 'platform:penalties',
    name: 'Penalties recovered',
    /** Taken from a party under the lapse ladder, offsetting goodwill. */
  },
  {
    code: 'platform:cost-of-sales',
    name: 'Cost of sales',
    /**
     * Lot B: what ADX pays to deliver a booking — a print partner's approved
     * job cost, an installation crew. An expense, so it carries a debit
     * (negative) balance; the payable to the partner is the other side.
     */
  },
  {
    code: 'platform:suspense',
    name: 'Suspense',
    /**
     * Where a movement lands when its counterparty is not yet known — a bank
     * credit before reconciliation matches it. Everything here is a question
     * somebody has to answer, so the reconciliation screen reports on it.
     */
  },
] as const;

export type PlatformAccountCode = (typeof PLATFORM_ACCOUNTS)[number]['code'];

let cataloguePromise: Promise<void> | null = null;

/** Seeds the platform accounts once per process. Safe to call on every path. */
export async function ensureAccounts(): Promise<void> {
  cataloguePromise ??= (async () => {
    for (const account of PLATFORM_ACCOUNTS) {
      const existing = await repository.findAccountByCode(account.code);
      if (!existing) {
        await repository.createAccount({
          code: account.code,
          name: account.name,
          kind: 'PLATFORM',
        });
      }
    }
  })();
  await cataloguePromise;
}

/** Only for tests, which reset the module between cases. */
export function resetAccountCache(): void {
  cataloguePromise = null;
}

export async function platformAccount(code: PlatformAccountCode): Promise<AccountRow> {
  await ensureAccounts();
  const account = await repository.findAccountByCode(code);
  if (!account) throw new ApiError(500, 'INTERNAL_ERROR', `Ledger account ${code} is missing`);
  return account;
}

/**
 * The account mirroring a wallet, created on first use.
 *
 * Lazily rather than alongside the wallet, so wallets that predate the ledger
 * join it the first time money moves rather than needing a backfill that would
 * have to invent opening balances.
 */
export async function walletAccount(walletId: string, label: string): Promise<AccountRow> {
  const existing = await repository.findAccountByWallet(walletId);
  if (existing) return existing;
  return repository.createAccount({
    code: `wallet:${walletId}`,
    name: label,
    kind: 'WALLET',
    walletId,
  });
}

/* ------------------------------------------------------------------ */
/* Posting                                                             */
/* ------------------------------------------------------------------ */

export type PostLeg = {
  accountId: string;
  /** Signed, from this account's point of view. Positive in, negative out. */
  amount: Money;
  campaignId?: string | null;
  orderId?: string | null;
  reference?: string | null;
  note?: string | null;
};

export type PostInput = {
  kind: LedgerTransactionKind;
  /**
   * The caller's promise that two attempts are one event. Make it out of what
   * caused the movement — `package-debit:<saleId>`, `earning:<orderId>:<day>` —
   * never out of a clock, or a retry mints a second movement.
   */
  idempotencyKey: string;
  legs: PostLeg[];
  occurredAt?: Date;
  createdByUserId?: string | null;
  note?: string | null;
};

const YEAR = () => new Date().getUTCFullYear();

async function nextReference(now: Date): Promise<string> {
  const year = now.getUTCFullYear();
  let n = (await repository.countForYear(year)) + 1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const reference = `LGR-${year}-${String(n).padStart(6, '0')}`;
    if (!(await repository.referenceExists(reference))) return reference;
    n += 1;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not allocate a ledger reference');
}

/** Legs must balance before the database is asked, so the error names the caller. */
export function assertBalanced(legs: { amount: Money }[]): void {
  if (legs.length < 2) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'A ledger transaction needs at least two legs');
  }
  const total = legs.reduce((sum, leg) => sum.plus(new Decimal(leg.amount)), new Decimal(0));
  if (!total.isZero()) {
    throw new ApiError(
      500,
      'INTERNAL_ERROR',
      `Ledger legs do not balance: they sum to ${money(total)}, expected 0.00`
    );
  }
  if (legs.some((leg) => new Decimal(leg.amount).isZero())) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'A ledger leg cannot move nothing');
  }
}

/**
 * Appends one movement. Idempotent on `idempotencyKey`.
 *
 * Returns `created: false` when the key had already been posted, so a caller
 * can tell a fresh movement from a replay without a second read.
 */
export async function post(
  input: PostInput,
  now = new Date()
): Promise<{ transaction: TransactionRow; created: boolean }> {
  assertBalanced(input.legs);

  const existing = await repository.findTransactionByKey(input.idempotencyKey);
  if (existing) return { transaction: existing, created: false };

  const occurredAt = input.occurredAt ?? now;
  return repository.append({
    reference: await nextReference(occurredAt),
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    occurredAt,
    createdByUserId: input.createdByUserId ?? null,
    note: input.note ?? null,
    legs: input.legs.map((leg) => ({
      accountId: leg.accountId,
      amount: new Decimal(money(leg.amount)),
      campaignId: leg.campaignId ?? null,
      orderId: leg.orderId ?? null,
      reference: leg.reference ?? null,
      note: leg.note ?? null,
    })),
  });
}

/**
 * Undoes a movement by posting its mirror.
 *
 * The original stays exactly where it is. A reversal is itself a transaction —
 * referenced, dated, attributable and reversible in turn — and the unique index
 * on `reversesId` means one movement can be reversed once, so a double-tapped
 * correction cannot quietly double the correction.
 */
export async function reverse(
  transactionId: string,
  input: { reason: string; createdByUserId?: string | null },
  now = new Date()
): Promise<TransactionRow> {
  const original = await repository.findTransaction(transactionId);
  if (!original) throw new ApiError(404, 'NOT_FOUND', 'Ledger transaction not found');
  if (original.kind === 'REVERSAL') {
    throw new ApiError(
      409,
      'CONFLICT',
      'That transaction is itself a reversal. Post a fresh correcting entry instead.'
    );
  }
  if (!input.reason.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A reversal needs a reason.');
  }

  const key = `reversal:${transactionId}`;
  const already = await repository.findTransactionByKey(key);
  if (already) return already;

  const { transaction } = await repository.append({
    reference: await nextReference(now),
    kind: 'REVERSAL',
    idempotencyKey: key,
    reversesId: original.id,
    occurredAt: now,
    createdByUserId: input.createdByUserId ?? null,
    note: `Reverses ${original.reference}: ${input.reason.trim()}`,
    legs: original.legs.map((leg) => ({
      accountId: leg.accountId,
      amount: leg.amount.negated(),
      campaignId: leg.campaignId,
      orderId: leg.orderId,
      reference: leg.reference,
      note: `Reversal of ${original.reference}`,
    })),
  });
  return transaction;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export async function balanceOf(accountId: string): Promise<Money> {
  return money(await repository.balanceOf(accountId));
}

export async function walletBalance(walletId: string): Promise<Money> {
  const account = await repository.findAccountByWallet(walletId);
  // A wallet that has never moved money has no account, and no balance is the
  // honest answer rather than an error.
  return account ? money(await repository.balanceOf(account.id)) : money(0);
}

export function listTransactions(filter: {
  accountId?: string;
  walletId?: string;
  kind?: LedgerTransactionKind[];
  from?: Date;
  to?: Date;
  /** E6: a leg of exactly this absolute amount. */
  amount?: string;
  limit?: number;
  cursor?: string;
}) {
  return repository.listTransactions({
    ...filter,
    limit: Math.min(filter.limit ?? 50, 200),
  });
}

export const getTransaction = (id: string) => repository.findTransaction(id);
export const listAccounts = () => repository.listAccounts();

/**
 * Proves the books rather than asserting them.
 *
 * `unbalanced` should always be empty — the constraint trigger makes an
 * unbalanced commit impossible — and `drift` catches the subtler failure: a
 * caller that moved a wallet without posting the matching legs, or the reverse.
 * Run from the reconciliation screen, and in the test suite so it is not the
 * kind of check that only exists on a slide.
 */
export async function verifyLedger(): Promise<{
  unbalanced: { transactionId: string; total: Money }[];
  drift: { walletId: string; walletTotal: Money; ledgerTotal: Money }[];
  healthy: boolean;
}> {
  const [unbalanced, drift] = await Promise.all([
    repository.findUnbalanced(),
    repository.findWalletDrift(),
  ]);
  return {
    unbalanced: unbalanced.map((row) => ({ transactionId: row.transactionId, total: money(row.total) })),
    drift: drift.map((row) => ({
      walletId: row.walletId,
      walletTotal: money(row.walletTotal),
      ledgerTotal: money(row.ledgerTotal),
    })),
    healthy: unbalanced.length === 0 && drift.length === 0,
  };
}

export { YEAR as ledgerYear };

import { Prisma } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import type { LedgerTransactionKind } from '../../shared/database';

/**
 * Posting to the ledger from inside somebody else's database transaction.
 *
 * The wallet and the books have to move together or not at all. `post()` opens
 * its own transaction, which is right for a caller that has nothing else to do;
 * this variant joins one already open, so a wallet update, its statement line
 * and the matching legs commit as a single act. Without it the two are separate
 * writes and a crash between them leaves the books disagreeing with the wallet
 * — which `verifyLedger` would report, but only after the fact.
 *
 * Kept apart from ledger.service.ts, and named as a repository, because it
 * takes a Prisma transaction client. That is what it is: repository-layer code
 * that happens to be handed its transaction rather than opening one.
 */

export type TxClient = Prisma.TransactionClient;

export type PostWithinInput = {
  kind: LedgerTransactionKind;
  idempotencyKey: string;
  legs: {
    accountId: string;
    amount: Money;
    campaignId?: string | null;
    orderId?: string | null;
    reference?: string | null;
    note?: string | null;
  }[];
  occurredAt?: Date;
  createdByUserId?: string | null;
  note?: string | null;
};

async function referenceWithin(tx: TxClient, now: Date): Promise<string> {
  const year = now.getUTCFullYear();
  const count = await tx.ledgerTransaction.count({
    where: {
      createdAt: {
        gte: new Date(Date.UTC(year, 0, 1)),
        lt: new Date(Date.UTC(year + 1, 0, 1)),
      },
    },
  });
  for (let n = count + 1; n < count + 60; n += 1) {
    const reference = `LGR-${year}-${String(n).padStart(6, '0')}`;
    const clash = await tx.ledgerTransaction.count({ where: { reference } });
    if (clash === 0) return reference;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not allocate a ledger reference');
}

/** The wallet account for a wallet, opened on first use. */
export async function walletAccountWithin(
  tx: TxClient,
  walletId: string,
  label: string
): Promise<{ id: string }> {
  const existing = await tx.ledgerAccount.findUnique({ where: { walletId } });
  if (existing) return existing;
  return tx.ledgerAccount.create({
    data: { code: `wallet:${walletId}`, name: label, kind: 'WALLET', walletId },
  });
}

/** A platform account by code. Seeded by `ensureAccounts` before this is reached. */
export async function platformAccountWithin(tx: TxClient, code: string): Promise<{ id: string }> {
  const account = await tx.ledgerAccount.findUnique({ where: { code } });
  if (!account) throw new ApiError(500, 'INTERNAL_ERROR', `Ledger account ${code} is missing`);
  return account;
}

export async function postWithin(
  tx: TxClient,
  input: PostWithinInput,
  now = new Date()
): Promise<{ id: string; reference: string; created: boolean }> {
  const total = input.legs.reduce((sum, leg) => sum.plus(new Decimal(leg.amount)), new Decimal(0));
  if (!total.isZero()) {
    throw new ApiError(
      500,
      'INTERNAL_ERROR',
      `Ledger legs do not balance: they sum to ${money(total)}, expected 0.00`
    );
  }

  const seen = await tx.ledgerTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (seen) return { id: seen.id, reference: seen.reference, created: false };

  const occurredAt = input.occurredAt ?? now;
  const created = await tx.ledgerTransaction.create({
    data: {
      reference: await referenceWithin(tx, occurredAt),
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      occurredAt,
      createdByUserId: input.createdByUserId ?? null,
      note: input.note ?? null,
    },
  });

  for (const leg of input.legs) {
    await tx.ledgerLeg.create({
      data: {
        transactionId: created.id,
        accountId: leg.accountId,
        amount: new Prisma.Decimal(money(leg.amount)),
        campaignId: leg.campaignId ?? null,
        orderId: leg.orderId ?? null,
        reference: leg.reference ?? null,
        note: leg.note ?? null,
      },
    });
  }

  return { id: created.id, reference: created.reference, created: true };
}

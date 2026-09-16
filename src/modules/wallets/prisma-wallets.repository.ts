import { Prisma, prisma } from '../../shared/database';
import type { WalletEntry, WalletHold } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { platformAccountWithin, postWithin, walletAccountWithin } from '../ledger';
import type { WalletsRepository, MovementInput, WalletOwner, WalletSnapshotRow } from './wallets.repository';

const ZERO = new Prisma.Decimal(0);

const ownerWhere = (owner: WalletOwner) =>
  owner.kind === 'PUBLISHER'
    ? { publisherId: owner.id }
    : owner.kind === 'AGENT'
      ? { agentId: owner.id }
      : owner.kind === 'PRINT_PARTNER'
        ? { printPartnerId: owner.id }
        : { advertiserId: owner.id };

export const prismaWalletsRepository: WalletsRepository = {
  async ensure(owner, label) {
    const where = ownerWhere(owner);
    const existing = await prisma.wallet.findFirst({ where });
    if (existing) return existing;
    const wallet = await prisma.wallet.create({ data: where });
    // Open the ledger account alongside, so the two exist together from the
    // first rupee rather than the account appearing on first movement.
    await prisma.ledgerAccount.upsert({
      where: { walletId: wallet.id },
      create: { code: `wallet:${wallet.id}`, name: label, kind: 'WALLET', walletId: wallet.id },
      update: {},
    });
    return wallet;
  },

  findById(walletId) {
    return prisma.wallet.findUnique({ where: { id: walletId } });
  },

  findByOwner(owner) {
    return prisma.wallet.findFirst({ where: ownerWhere(owner) });
  },

  async snapshot(walletId, now): Promise<WalletSnapshotRow | null> {
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) return null;

    const [holds, openWithdrawals, uncleared] = await Promise.all([
      prisma.walletHold.aggregate({
        where: { walletId, status: 'HELD' },
        _sum: { amount: true },
      }),
      // Lot B (Q140): a withdrawal is reserved from request through approval
      // and debited at batch release, so only the first two states are still
      // in the balance. A PROCESSING line has already left it.
      prisma.withdrawalRequest.aggregate({
        where: { walletId, status: { in: ['REQUESTED', 'APPROVED'] } },
        _sum: { amount: true },
      }),
      // Earnings credited but still inside their clearing window. The money is
      // in the balance and is not yet withdrawable, which is exactly the
      // Pending / Cleared split the frame draws.
      prisma.earningAccrual.aggregate({
        where: { clearsAt: { gt: now }, publisherId: wallet.publisherId ?? '__none__' },
        _sum: { net: true },
      }),
    ]);

    return {
      wallet,
      held: holds._sum.amount ?? ZERO,
      openWithdrawals: openWithdrawals._sum.amount ?? ZERO,
      pendingClearance: uncleared._sum.net ?? ZERO,
    };
  },

  listEntries(walletId, filter) {
    return prisma.walletEntry.findMany({
      where: {
        walletId,
        ...(filter.types?.length ? { type: { in: filter.types } } : {}),
        ...(filter.from || filter.to
          ? {
              createdAt: {
                ...(filter.from ? { gte: filter.from } : {}),
                ...(filter.to ? { lte: filter.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: filter.limit,
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    });
  },

  /**
   * The one place a party's money moves.
   *
   * Wallet, statement line and ledger legs commit together or not at all. The
   * idempotency key is what makes a retried job safe: the ledger refuses the
   * second post, and this returns the movement that already happened rather
   * than crediting twice.
   *
   * Everything a movement has to check is read inside this transaction —
   * the freeze, the funds, the hold — rather than by the service beforehand,
   * because a check outside the transaction is a check something else can
   * invalidate between the read and the write.
   *
   * Lot J2 (g): one movement at a time per wallet. The transaction takes a
   * Postgres advisory lock keyed on the wallet id (`pg_advisory_xact_lock`,
   * released with the commit) **before** it reads the row, so two debits
   * arriving together are serialised: the second reads the balance the
   * first left, and `requireFunds` refuses it. Without the lock both read
   * the same balance under READ COMMITTED and both pass.
   */
  async move(input: MovementInput) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.walletId}))`;
      const wallet = await tx.wallet.findUnique({ where: { id: input.walletId } });
      if (!wallet) return null;

      const already = await tx.ledgerTransaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (already) {
        const entries = await tx.walletEntry.findMany({
          where: {
            walletId: wallet.id,
            ...(input.reference ? { reference: input.reference } : {}),
            ...(input.captureHoldId ? { holdId: input.captureHoldId } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: 2,
        });
        const entry = entries.find((row) => !row.isGoodwill) ?? entries[0] ?? null;
        return { wallet, entry, entries, ledgerTransactionId: already.id, created: false };
      }

      const amount = new Prisma.Decimal(input.amount);
      const debit = amount.isNegative();

      // Lot A FREEZE_WALLET, on the row about to be written: money lands, and
      // nothing leaves — except the closure's own final payout.
      if (debit && wallet.frozenAt && !input.allowFrozen) {
        throw new ApiError(409, 'WALLET_FROZEN', 'This wallet is frozen; money cannot leave it', {
          walletId: wallet.id,
          frozenAt: wallet.frozenAt,
          reason: wallet.frozenReason,
        });
      }

      let hold: WalletHold | null = null;
      if (input.captureHoldId) {
        hold = await tx.walletHold.findUnique({ where: { id: input.captureHoldId } });
        if (!hold || hold.walletId !== wallet.id) {
          throw new ApiError(404, 'NOT_FOUND', 'Hold not found');
        }
        if (hold.status !== 'HELD') {
          throw new ApiError(409, 'CONFLICT', `This hold is already ${hold.status.toLowerCase()}`);
        }
      }

      if (debit && input.requireFunds) {
        const open = await tx.walletHold.aggregate({
          where: { walletId: wallet.id, status: 'HELD' },
          _sum: { amount: true },
        });
        // Lot B (Q140): money reserved by a withdrawal awaiting release is
        // not spendable either — it is on its way to the bank.
        const reserved = await tx.withdrawalRequest.aggregate({
          where: { walletId: wallet.id, status: { in: ['REQUESTED', 'APPROVED'] } },
          _sum: { amount: true },
        });
        const spendable = new Prisma.Decimal(wallet.balance)
          .add(wallet.goodwill)
          .sub(open._sum.amount ?? ZERO)
          .sub(reserved._sum.amount ?? ZERO);
        if (spendable.lessThan(amount.negated())) {
          throw new ApiError(402, 'INSUFFICIENT_FUNDS', 'Wallet balance does not cover this');
        }
      }

      const now = new Date();
      const entries: WalletEntry[] = [];
      let updated = wallet;
      const campaignId = input.campaignId ?? hold?.campaignId ?? null;

      if (debit && input.spendGoodwillFirst) {
        // Goodwill first, settled balance for the rest. Two statement lines,
        // one ledger transaction — the books see one movement of the total.
        const owed = amount.negated();
        const fromGoodwill = Prisma.Decimal.min(new Prisma.Decimal(wallet.goodwill), owed);
        const fromBalance = owed.sub(fromGoodwill);

        updated = await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            goodwill: { decrement: fromGoodwill },
            balance: { decrement: fromBalance },
            lastActivityAt: now,
          },
        });

        if (fromGoodwill.greaterThan(ZERO)) {
          entries.push(
            await tx.walletEntry.create({
              data: {
                walletId: wallet.id,
                type: input.entryType,
                amount: fromGoodwill.negated(),
                balanceAfter: updated.goodwill,
                isGoodwill: true,
                campaignId,
                orderId: input.orderId ?? null,
                reference: input.reference ?? null,
                note: input.note ? `${input.note} (credit applied)` : 'Goodwill applied',
              },
            })
          );
        }
        if (fromBalance.greaterThan(ZERO)) {
          entries.push(
            await tx.walletEntry.create({
              data: {
                walletId: wallet.id,
                type: input.entryType,
                amount: fromBalance.negated(),
                balanceAfter: updated.balance,
                campaignId,
                orderId: input.orderId ?? null,
                reference: input.reference ?? null,
                note: input.note ?? null,
                // holdId is unique: only the settled-balance line settles the hold.
                ...(hold ? { holdId: hold.id } : {}),
              },
            })
          );
        }
      } else {
        const toGoodwill = input.isGoodwill === true;
        updated = await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            ...(toGoodwill ? { goodwill: { increment: amount } } : { balance: { increment: amount } }),
            lastActivityAt: now,
          },
        });
        entries.push(
          await tx.walletEntry.create({
            data: {
              walletId: wallet.id,
              type: input.entryType,
              amount,
              balanceAfter: toGoodwill ? updated.goodwill : updated.balance,
              isGoodwill: toGoodwill,
              campaignId,
              orderId: input.orderId ?? null,
              reference: input.reference ?? null,
              note: input.note ?? null,
              ...(hold ? { holdId: hold.id } : {}),
            },
          })
        );
      }

      if (hold) {
        await tx.walletHold.update({
          where: { id: hold.id },
          data: { status: 'CAPTURED', capturedAt: now },
        });
      }

      const walletAccount = await walletAccountWithin(tx, wallet.id, input.walletLabel);
      const legs = [
        {
          accountId: walletAccount.id,
          amount: input.amount,
          orderId: input.orderId ?? null,
          campaignId,
          reference: input.reference ?? null,
          note: input.note ?? null,
        },
      ];
      for (const counter of input.counterLegs) {
        const account = await platformAccountWithin(tx, counter.accountCode);
        legs.push({
          accountId: account.id,
          amount: counter.amount,
          orderId: input.orderId ?? null,
          campaignId,
          reference: input.reference ?? null,
          note: counter.note ?? null,
        });
      }

      const posted = await postWithin(tx, {
        kind: input.ledgerKind,
        idempotencyKey: input.idempotencyKey,
        legs,
        occurredAt: input.occurredAt ?? now,
        createdByUserId: input.createdByUserId ?? null,
        note: input.note ?? null,
      });

      const entry = entries.find((row) => !row.isGoodwill) ?? entries[0] ?? null;
      return { wallet: updated, entry, entries, ledgerTransactionId: posted.id, created: true };
    });
  },

  async sumEntries(walletId, types, from, to) {
    const result = await prisma.walletEntry.aggregate({
      where: {
        walletId,
        ...(types?.length ? { type: { in: types } } : {}),
        ...(from || to
          ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      _sum: { amount: true },
      _count: true,
    });
    return { total: result._sum.amount ?? ZERO, count: result._count };
  },

  listWallets(filter) {
    return prisma.wallet.findMany({
      where: {
        ...(filter.kind === 'PUBLISHER' ? { publisherId: { not: null } } : {}),
        ...(filter.kind === 'AGENT' ? { agentId: { not: null } } : {}),
        ...(filter.kind === 'ADVERTISER' ? { advertiserId: { not: null } } : {}),
        ...(filter.kind === 'PRINT_PARTNER' ? { printPartnerId: { not: null } } : {}),
      },
      include: {
        publisher: { select: { id: true, name: true, displayId: true, sizeBand: true } },
        agent: { select: { id: true, userId: true } },
        advertiser: { select: { id: true, name: true, companyName: true } },
        printPartner: { select: { id: true, name: true, displayId: true, city: true } },
      },
      orderBy: { lastActivityAt: 'desc' },
      take: filter.limit,
    }) as never;
  },

  async freeze(walletId, input) {
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId }, select: { id: true } });
    if (!wallet) return null;
    return prisma.wallet.update({
      where: { id: walletId },
      data: { frozenAt: input.at, frozenReason: input.reason, frozenById: input.byUserId },
    });
  },

  async unfreeze(walletId) {
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId }, select: { id: true } });
    if (!wallet) return null;
    return prisma.wallet.update({
      where: { id: walletId },
      data: { frozenAt: null, frozenReason: null, frozenById: null },
    });
  },
};

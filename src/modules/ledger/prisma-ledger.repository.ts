import { Prisma, prisma } from '../../shared/database';
import type {
  AccountRow,
  LedgerRepository,
  NewTransaction,
  TransactionFilter,
  TransactionRow,
} from './ledger.repository';

const withLegs = { legs: { include: { account: true }, orderBy: { createdAt: 'asc' } } } as const;

export const prismaLedgerRepository: LedgerRepository = {
  findAccountByCode(code) {
    return prisma.ledgerAccount.findUnique({ where: { code } });
  },

  findAccountByWallet(walletId) {
    return prisma.ledgerAccount.findUnique({ where: { walletId } });
  },

  createAccount(data) {
    return prisma.ledgerAccount.create({
      data: {
        code: data.code,
        name: data.name,
        kind: data.kind,
        walletId: data.walletId ?? null,
      },
    });
  },

  listAccounts(kind) {
    return prisma.ledgerAccount.findMany({
      ...(kind ? { where: { kind } } : {}),
      orderBy: { code: 'asc' },
    });
  },

  /**
   * The whole point of the module, in one function.
   *
   * Both writes go in one database transaction so a transaction can never exist
   * without its legs — and the deferred balance trigger fires at that commit, so
   * an unbalanced set never lands. The unique index on the idempotency key is
   * what makes a retry safe: two concurrent attempts race, one wins, the loser
   * reads back the winner's row rather than writing a second movement.
   */
  async append(data: NewTransaction): Promise<{ transaction: TransactionRow; created: boolean }> {
    try {
      const transaction = await prisma.$transaction(async (tx) => {
        const created = await tx.ledgerTransaction.create({
          data: {
            reference: data.reference,
            kind: data.kind,
            idempotencyKey: data.idempotencyKey,
            reversesId: data.reversesId ?? null,
            occurredAt: data.occurredAt,
            createdByUserId: data.createdByUserId ?? null,
            note: data.note ?? null,
          },
        });

        for (const leg of data.legs) {
          await tx.ledgerLeg.create({
            data: {
              transactionId: created.id,
              accountId: leg.accountId,
              amount: leg.amount,
              campaignId: leg.campaignId ?? null,
              orderId: leg.orderId ?? null,
              reference: leg.reference ?? null,
              note: leg.note ?? null,
            },
          });
        }

        return tx.ledgerTransaction.findUniqueOrThrow({
          where: { id: created.id },
          include: withLegs,
        });
      });

      return { transaction: transaction as TransactionRow, created: true };
    } catch (error) {
      // P2002 on the idempotency key means somebody else posted this first.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.ledgerTransaction.findUnique({
          where: { idempotencyKey: data.idempotencyKey },
          include: withLegs,
        });
        if (existing) return { transaction: existing as TransactionRow, created: false };
      }
      throw error;
    }
  },

  findTransaction(id) {
    return prisma.ledgerTransaction.findUnique({
      where: { id },
      include: withLegs,
    }) as Promise<TransactionRow | null>;
  },

  findTransactionByKey(idempotencyKey) {
    return prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey },
      include: withLegs,
    }) as Promise<TransactionRow | null>;
  },

  async listTransactions(filter: TransactionFilter): Promise<TransactionRow[]> {
    const legFilter =
      filter.accountId || filter.walletId
        ? {
            legs: {
              some: filter.accountId
                ? { accountId: filter.accountId }
                : { account: { walletId: filter.walletId } },
            },
          }
        : {};

    const occurred =
      filter.from || filter.to
        ? {
            occurredAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {};

    // E6: the amount facet - a leg of exactly that value, either sign.
    const amountFilter = filter.amount
      ? { AND: [{ legs: { some: { OR: [{ amount: filter.amount }, { amount: '-' + filter.amount }] } } }] }
      : {};

    return prisma.ledgerTransaction.findMany({
      where: {
        ...legFilter,
        ...occurred,
        ...amountFilter,
        ...(filter.kind?.length ? { kind: { in: filter.kind } } : {}),
      },
      include: withLegs,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    }) as Promise<TransactionRow[]>;
  },

  async referenceExists(reference) {
    return (await prisma.ledgerTransaction.count({ where: { reference } })) > 0;
  },

  countForYear(year) {
    return prisma.ledgerTransaction.count({
      where: {
        createdAt: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lt: new Date(Date.UTC(year + 1, 0, 1)),
        },
      },
    });
  },

  async balanceOf(accountId) {
    const result = await prisma.ledgerLeg.aggregate({
      where: { accountId },
      _sum: { amount: true },
    });
    return result._sum.amount ?? new Prisma.Decimal(0);
  },

  async findUnbalanced() {
    const rows = await prisma.$queryRaw<{ transactionId: string; total: Prisma.Decimal }[]>`
      SELECT "transactionId", SUM("amount") AS total
        FROM "LedgerLeg"
       GROUP BY "transactionId"
      HAVING SUM("amount") <> 0
    `;
    return rows;
  },

  /**
   * Where the party's own statement and ADX's books disagree.
   *
   * `balance + goodwill` is what the wallet says it holds; the sum of its ledger
   * legs is what the books say. Any row this returns is a bug in a caller that
   * moved one without the other.
   */
  async findWalletDrift() {
    return prisma.$queryRaw<
      { walletId: string; walletTotal: Prisma.Decimal; ledgerTotal: Prisma.Decimal }[]
    >`
      SELECT w."id" AS "walletId",
             (w."balance" + w."goodwill") AS "walletTotal",
             COALESCE(SUM(l."amount"), 0) AS "ledgerTotal"
        FROM "Wallet" w
        JOIN "LedgerAccount" a ON a."walletId" = w."id"
        LEFT JOIN "LedgerLeg" l ON l."accountId" = a."id"
       GROUP BY w."id", w."balance", w."goodwill"
      HAVING (w."balance" + w."goodwill") <> COALESCE(SUM(l."amount"), 0)
    `;
  },
};

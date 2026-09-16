import { Prisma, prisma } from '../../shared/database';
import { money } from '../../shared/money';
import {
  LINE_STATUSES,
  type LineFilter,
  type LineRow,
  type ReconciliationRepository,
  type StatusSummary,
} from './reconciliation.repository';

const ZERO = new Prisma.Decimal(0);

function lineWhere(filter: LineFilter): Prisma.BankStatementLineWhereInput {
  const q = filter.q?.trim();
  return {
    ...(filter.bankAccountId ? { bankAccountId: filter.bankAccountId } : {}),
    ...(filter.importId ? { importId: filter.importId } : {}),
    ...(filter.status?.length ? { matchStatus: { in: filter.status } } : {}),
    ...(filter.from || filter.to
      ? { valueDate: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
    ...(q
      ? {
          OR: [
            { description: { contains: q, mode: 'insensitive' } },
            { utr: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

export const prismaReconciliationRepository: ReconciliationRepository = {
  /* ── Profiles ──────────────────────────────────────────────────── */

  listProfiles() {
    return prisma.bankStatementProfile.findMany({ orderBy: { name: 'asc' } });
  },

  findProfile(id) {
    return prisma.bankStatementProfile.findUnique({ where: { id } });
  },

  createProfile(data) {
    return prisma.bankStatementProfile.create({
      data: {
        name: data.name,
        bankName: data.bankName,
        columns: data.columns as Prisma.InputJsonValue,
        dateFormat: data.dateFormat,
      },
    });
  },

  /* ── Imports ───────────────────────────────────────────────────── */

  createImport(data) {
    return prisma.bankStatementImport.create({ data });
  },

  findImport(id) {
    return prisma.bankStatementImport.findUnique({ where: { id } });
  },

  listImports(filter) {
    return prisma.bankStatementImport.findMany({
      where: filter.bankAccountId ? { bankAccountId: filter.bankAccountId } : {},
      orderBy: { createdAt: 'desc' },
      take: filter.limit,
    });
  },

  async addLines(importId, bankAccountId, lines) {
    if (lines.length === 0) {
      await prisma.bankStatementImport.update({ where: { id: importId }, data: { lineCount: 0, duplicateCount: 0 } });
      return { created: 0, duplicates: 0 };
    }
    // The file may repeat a line, and so may last month's file: both are
    // caught by the unique (account, hash) with skipDuplicates.
    const result = await prisma.bankStatementLine.createMany({
      data: lines.map((line) => ({
        importId,
        bankAccountId,
        valueDate: line.valueDate,
        description: line.description,
        utr: line.utr,
        direction: line.direction,
        amount: new Prisma.Decimal(line.amount),
        runningBalance: line.runningBalance === null ? null : new Prisma.Decimal(line.runningBalance),
        rawHash: line.rawHash,
      })),
      skipDuplicates: true,
    });
    const duplicates = lines.length - result.count;
    await prisma.bankStatementImport.update({
      where: { id: importId },
      data: { lineCount: result.count, duplicateCount: duplicates },
    });
    return { created: result.count, duplicates };
  },

  /* ── Lines ─────────────────────────────────────────────────────── */

  findLine(id) {
    return prisma.bankStatementLine.findUnique({ where: { id }, include: { match: true } });
  },

  async listLines(filter, page) {
    const where = lineWhere(filter);
    const [items, total, groups] = await Promise.all([
      prisma.bankStatementLine.findMany({
        where,
        include: { match: true },
        orderBy: [{ valueDate: 'desc' }, { id: 'desc' }],
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.bankStatementLine.count({ where }),
      // The status facet removed, so the chips stay a way back out.
      prisma.bankStatementLine.groupBy({
        by: ['matchStatus'],
        where: lineWhere({ ...filter, status: undefined }),
        _count: { _all: true },
      }),
    ]);
    const counts: Record<string, number> = {};
    for (const status of LINE_STATUSES) counts[status] = 0;
    for (const group of groups) counts[group.matchStatus] = group._count._all;
    return { items, total, counts };
  },

  /* Lot G (Q125): keyset, not offset — strictly past the cursor under
     (valueDate desc, id desc): an earlier value date, or the same date and a
     smaller id. The cursor rides in its own AND arm so it never collides with
     the filter's own valueDate window. */
  findLineRows(filter, slice) {
    const where = lineWhere(filter);
    return prisma.bankStatementLine.findMany({
      where: slice.after
        ? {
            AND: [
              where,
              {
                OR: [
                  { valueDate: { lt: slice.after.valueDate } },
                  { valueDate: slice.after.valueDate, id: { lt: slice.after.id } },
                ],
              },
            ],
          }
        : where,
      include: { match: true },
      orderBy: [{ valueDate: 'desc' }, { id: 'desc' }],
      take: slice.take,
    });
  },

  listUnmatched(filter) {
    return prisma.bankStatementLine.findMany({
      where: lineWhere({ ...filter, status: ['UNMATCHED'] }),
      include: { match: true },
      orderBy: [{ valueDate: 'asc' }, { id: 'asc' }],
      take: filter.limit,
    });
  },

  setLineStatus(id, status) {
    return prisma.bankStatementLine.update({ where: { id }, data: { matchStatus: status }, include: { match: true } });
  },

  /* ── Matches ───────────────────────────────────────────────────── */

  createMatch(data) {
    return prisma.reconciliationMatch.create({
      data: { ...data, difference: new Prisma.Decimal(data.difference) },
    });
  },

  updateMatch(id, patch) {
    return prisma.reconciliationMatch.update({ where: { id }, data: patch });
  },

  async deleteMatch(lineId) {
    await prisma.reconciliationMatch.deleteMany({ where: { lineId } });
  },

  async claimedLedgerTransactionIds(ids) {
    if (ids.length === 0) return new Set();
    const rows = await prisma.reconciliationMatch.findMany({
      where: { ledgerTransactionId: { in: ids } },
      select: { ledgerTransactionId: true },
    });
    return new Set(rows.map((row) => row.ledgerTransactionId!).filter(Boolean));
  },

  async claimedWithdrawalIds(ids) {
    if (ids.length === 0) return new Set();
    const rows = await prisma.reconciliationMatch.findMany({
      where: { withdrawalId: { in: ids } },
      select: { withdrawalId: true },
    });
    return new Set(rows.map((row) => row.withdrawalId!).filter(Boolean));
  },

  async claimedTopUpIds(ids) {
    if (ids.length === 0) return new Set();
    const rows = await prisma.reconciliationMatch.findMany({
      where: { topUpId: { in: ids } },
      select: { topUpId: true },
    });
    return new Set(rows.map((row) => row.topUpId!).filter(Boolean));
  },

  /* ── Summary ───────────────────────────────────────────────────── */

  async summary(filter) {
    const groups = await prisma.bankStatementLine.groupBy({
      by: ['matchStatus'],
      where: lineWhere(filter),
      _count: { _all: true },
      _sum: { amount: true },
    });
    const out = {} as StatusSummary;
    for (const status of LINE_STATUSES) out[status] = { count: 0, sum: money(0) };
    for (const group of groups) {
      out[group.matchStatus] = { count: group._count._all, sum: money(group._sum.amount ?? ZERO) };
    }
    return out;
  },
};

export type { LineRow };

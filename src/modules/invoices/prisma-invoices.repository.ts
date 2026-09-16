import { prisma, type InvoiceStatus, type Prisma, type PublisherInvoiceStatus } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import { INVOICE_STATUSES, PUBLISHER_INVOICE_STATUSES } from './invoices.schema';
import { formatInvoiceNumber, sequenceKey } from './numbering';
import type {
  InvoiceListFilter,
  InvoicesRepository,
  NewInvoice,
  Numbering,
  PublisherInvoiceListFilter,
} from './invoices.repository';

const LEGAL_ENTITY_ID = 'default';

type Tx = Prisma.TransactionClient;

/**
 * Consecutive numbering, GST-style: the sequence row is bumped and the
 * invoice written in the same transaction, so a rollback gives the number
 * back and two concurrent issues serialise on the row.
 */
async function allocateNumber(tx: Tx, numbering: Numbering): Promise<string> {
  const series = sequenceKey(numbering.series, numbering.financialYear);
  const sequence = await tx.invoiceSequence.upsert({
    where: { series },
    create: { series, next: 2 },
    update: { next: { increment: 1 } },
  });
  // After the upsert `next` is the value to hand out NEXT time; the one we
  // took is the value before the bump.
  return formatInvoiceNumber(numbering.series, numbering.financialYear, sequence.next - 1);
}

function invoiceCreateData(data: NewInvoice, number: string): Prisma.InvoiceCreateInput {
  const { lines, ...rest } = data;
  return {
    ...rest,
    number,
    lines: {
      create: lines.map((line) => ({ ...line })),
    },
  };
}

const withLines = { lines: { orderBy: { sortOrder: 'asc' as const } } };

/** Not a credit note, not void — the document that stands for the sale. */
const live = { kind: { not: 'CREDIT_NOTE' as const }, status: { not: 'VOID' as const } };

function invoiceWhere(filter: InvoiceListFilter, withStatus: boolean): Prisma.InvoiceWhereInput {
  const statuses = withStatus ? (filter.status as InvoiceStatus[] | undefined) : undefined;
  return {
    ...(statuses?.length ? { status: { in: statuses } } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.advertiserId ? { advertiserId: filter.advertiserId } : {}),
    ...(filter.from || filter.to
      ? { issuedAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
    ...(filter.q
      ? {
          OR: [
            { number: { contains: filter.q, mode: 'insensitive' } },
            { recipientName: { contains: filter.q, mode: 'insensitive' } },
            { recipientGstin: { contains: filter.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

function publisherInvoiceWhere(filter: PublisherInvoiceListFilter, withStatus: boolean): Prisma.PublisherInvoiceWhereInput {
  const statuses = withStatus ? (filter.status as PublisherInvoiceStatus[] | undefined) : undefined;
  return {
    ...(statuses?.length ? { status: { in: statuses } } : {}),
    ...(filter.publisherId ? { publisherId: filter.publisherId } : {}),
    ...(filter.period ? { period: filter.period } : {}),
    ...(filter.q ? { OR: [{ gstin: { contains: filter.q, mode: 'insensitive' } }, { period: { contains: filter.q } }] } : {}),
  };
}

export const prismaInvoicesRepository: InvoicesRepository = {
  /* ── Legal entity ─────────────────────────────────────────────── */

  getLegalEntity() {
    return prisma.legalEntitySettings.upsert({
      where: { id: LEGAL_ENTITY_ID },
      create: { id: LEGAL_ENTITY_ID },
      update: {},
    });
  },

  updateLegalEntity(patch, byUserId) {
    return prisma.legalEntitySettings.upsert({
      where: { id: LEGAL_ENTITY_ID },
      create: { id: LEGAL_ENTITY_ID, ...patch, updatedById: byUserId },
      update: { ...patch, updatedById: byUserId },
    });
  },

  /* ── Invoices ─────────────────────────────────────────────────── */

  findInvoice(id) {
    return prisma.invoice.findUnique({ where: { id }, include: withLines });
  },

  findLiveInvoiceForCampaign(campaignId) {
    return prisma.invoice.findFirst({ where: { campaignId, ...live }, include: withLines });
  },

  findLiveInvoiceForPackageSale(packageSaleId) {
    return prisma.invoice.findFirst({ where: { packageSaleId, ...live }, include: withLines });
  },

  findCreditNoteFor(invoiceId) {
    return prisma.invoice.findFirst({
      where: { voidsInvoiceId: invoiceId, kind: 'CREDIT_NOTE' },
      include: withLines,
    });
  },

  createNumbered(data, numbering) {
    return prisma.$transaction(async (tx) => {
      const number = await allocateNumber(tx, numbering);
      return tx.invoice.create({ data: invoiceCreateData(data, number), include: withLines });
    });
  },

  createCreditNote(originalId, data, numbering) {
    return prisma.$transaction(async (tx) => {
      const number = await allocateNumber(tx, numbering);
      const creditNote = await tx.invoice.create({
        data: invoiceCreateData({ ...data, voidsInvoiceId: originalId }, number),
        include: withLines,
      });
      const original = await tx.invoice.update({
        where: { id: originalId },
        data: { status: 'VOID' },
        include: withLines,
      });
      return { creditNote, original };
    });
  },

  updateInvoice(id, patch) {
    return prisma.invoice.update({ where: { id }, data: patch, include: withLines });
  },

  async listInvoices(filter) {
    const where = invoiceWhere(filter, true);
    const [items, total, groups] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: filter.sort === 'oldest' ? [{ issuedAt: 'asc' }, { createdAt: 'asc' }] : [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
        ...listArgs(filter),
      }),
      prisma.invoice.count({ where }),
      // The chips count against everything but the status facet itself.
      prisma.invoice.groupBy({ by: ['status'], where: invoiceWhere(filter, false), _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, INVOICE_STATUSES) };
  },

  listInvoicesForAdvertiser(advertiserId, limit) {
    return prisma.invoice.findMany({
      where: { advertiserId, status: { not: 'DRAFT' } },
      orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
  },

  /* ── Publisher invoices ───────────────────────────────────────── */

  findPublisherInvoice(id) {
    return prisma.publisherInvoice.findUnique({ where: { id } });
  },

  findPublisherInvoiceForPeriod(publisherId, period) {
    return prisma.publisherInvoice.findUnique({ where: { publisherId_period: { publisherId, period } } });
  },

  createPublisherInvoice(data) {
    return prisma.publisherInvoice.create({ data });
  },

  updatePublisherInvoice(id, patch) {
    return prisma.publisherInvoice.update({ where: { id }, data: patch });
  },

  async listPublisherInvoices(filter) {
    const where = publisherInvoiceWhere(filter, true);
    const [items, total, groups] = await Promise.all([
      prisma.publisherInvoice.findMany({ where, orderBy: { createdAt: 'desc' }, ...listArgs(filter) }),
      prisma.publisherInvoice.count({ where }),
      prisma.publisherInvoice.groupBy({
        by: ['status'],
        where: publisherInvoiceWhere(filter, false),
        _count: { _all: true },
      }),
    ]);
    return { items, total, counts: countsFrom(groups, PUBLISHER_INVOICE_STATUSES) };
  },

  /* ── Statements ───────────────────────────────────────────────── */

  findStatement(id) {
    return prisma.statement.findUnique({ where: { id } });
  },

  findStatementForPeriod(walletId, periodStart) {
    return prisma.statement.findUnique({ where: { walletId_periodStart: { walletId, periodStart } } });
  },

  upsertStatement(data) {
    const { walletId, periodStart, ...rest } = data;
    return prisma.statement.upsert({
      where: { walletId_periodStart: { walletId, periodStart } },
      create: { walletId, periodStart, ...rest },
      update: { ...rest, generatedAt: new Date() },
    });
  },

  updateStatement(id, patch) {
    return prisma.statement.update({ where: { id }, data: patch });
  },

  listStatementsForWallet(walletId, limit) {
    return prisma.statement.findMany({ where: { walletId }, orderBy: { periodStart: 'desc' }, take: limit });
  },
};

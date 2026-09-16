import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The publisher's monthly payment advice — Lot B (Q13), and the PDF both
 * documents render to.
 */

const { repository, payouts, publishers, uploads, wallets, notifications } = vi.hoisted(() => ({
  notifications: { notify: vi.fn(async () => ({ notificationId: 'ntf_1', templateKey: 'statement-ready', deliveries: [{ channel: 'EMAIL', deliveryId: 'dlv_1' }] })) },
  repository: {
    getLegalEntity: vi.fn(),
    findStatement: vi.fn(),
    findStatementForPeriod: vi.fn(),
    upsertStatement: vi.fn(),
    updateStatement: vi.fn(),
    listStatementsForWallet: vi.fn(),
  },
  payouts: { listAccrualsForPeriod: vi.fn(), publisherIdsWithAccruals: vi.fn(), partyContext: vi.fn() },
  publishers: { findPublisherBilling: vi.fn(), findPublisherForUser: vi.fn() },
  uploads: { storeGeneratedFile: vi.fn() },
  wallets: { findWalletFor: vi.fn(), sumEntries: vi.fn() },
}));

vi.mock('../prisma-invoices.repository', () => ({ prismaInvoicesRepository: repository }));
vi.mock('../../payouts', () => payouts);
vi.mock('../../publishers', () => publishers);
vi.mock('../../uploads', () => uploads);
vi.mock('../../wallets', () => wallets);
vi.mock('../../notifications', () => notifications);

import {
  buildPaymentAdvice,
  generatePublisherStatement,
  isFirstOfMonthIST,
  monthWindow,
  previousMonth,
  runMonthlyStatements,
  statementPdf,
} from '../statements.service';
import { formatINR, renderInvoicePdf, renderPaymentAdvicePdf } from '../pdf';

const NOW = new Date('2026-09-01T02:00:00Z');
const AUGUST = monthWindow(2026, 8);

const accrual = (day: number, over: Record<string, unknown> = {}) => ({
  id: `acc_${day}`,
  forDate: new Date(Date.UTC(2026, 7, day)),
  gross: new Decimal('2000.00'),
  commission: new Decimal('300.00'),
  taxWithheld: new Decimal('34.00'),
  net: new Decimal('1666.00'),
  clearsAt: new Date(Date.UTC(2026, 7, day + 7)),
  listing: { id: 'lst_1', title: 'Indiranagar hoarding', city: 'Bengaluru' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.getLegalEntity.mockResolvedValue({ tradeName: 'ADX', legalName: null, gstin: '29ABCDE1234F1Z5', registeredAddress: '1 MG Road', city: 'Bengaluru', stateName: 'Karnataka' });
  payouts.listAccrualsForPeriod.mockResolvedValue([accrual(1), accrual(2), accrual(3)]);
  payouts.publisherIdsWithAccruals.mockResolvedValue(['pub_1', 'pub_2']);
  publishers.findPublisherBilling.mockResolvedValue({ id: 'pub_1', userId: 'usr_pub', name: 'Ravi Media', gstin: '29PUBLI1234K1Z9', address: '4 Brigade Road', city: 'Bengaluru', state: 'Karnataka' });
  wallets.findWalletFor.mockResolvedValue({ id: 'wal_1' });
  wallets.sumEntries.mockImplementation(async (_walletId: string, types?: string[], from?: Date, to?: Date) => {
    if (!from && to?.getTime() === AUGUST.start.getTime()) return { total: new Decimal('500.00'), count: 2 };
    if (!from && to?.getTime() === AUGUST.end.getTime()) return { total: new Decimal('4498.00'), count: 6 };
    if (types?.includes('EARNING')) return { total: new Decimal('4998.00'), count: 3 };
    if (types?.includes('PAYOUT')) return { total: new Decimal('-1000.00'), count: 1 };
    return { total: new Decimal('3998.00'), count: 4 };
  });
  uploads.storeGeneratedFile.mockResolvedValue({ id: 'file_1', url: 'https://cdn/statements/x.pdf' });
  repository.upsertStatement.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'stm_1', generatedAt: NOW, ...data }));
});

describe('the calendar', () => {
  it('names the month just ended, in Indian time', () => {
    expect(previousMonth(new Date('2026-09-01T02:00:00Z')).period).toBe('2026-08');
    // 22:00 UTC on 31 Aug is already 1 Sep in India: August has ended.
    expect(previousMonth(new Date('2026-08-31T22:00:00Z')).period).toBe('2026-08');
    expect(previousMonth(new Date('2026-01-15T00:00:00Z')).period).toBe('2025-12');
    expect(isFirstOfMonthIST(new Date('2026-08-31T22:00:00Z'))).toBe(true);
    expect(isFirstOfMonthIST(new Date('2026-08-31T10:00:00Z'))).toBe(false);
    expect(AUGUST.start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(AUGUST.end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(AUGUST.label).toBe('August 2026');
  });
});

describe('the advice', () => {
  it('itemises every day, totals it, prints the GSTIN and reads the wallet around the month', async () => {
    const built = await buildPaymentAdvice('pub_1', AUGUST, NOW);
    expect(built).not.toBeNull();
    const { advice, statement } = built!;
    expect(payouts.listAccrualsForPeriod).toHaveBeenCalledWith('pub_1', AUGUST.start, AUGUST.end);
    expect(advice.rows).toHaveLength(3);
    expect(advice.rows[0]).toMatchObject({ listing: 'Indiranagar hoarding, Bengaluru', gross: '2000.00', commission: '300.00', taxWithheld: '34.00', net: '1666.00' });
    expect(advice.totals).toEqual({ gross: '6000.00', commission: '900.00', taxWithheld: '102.00', net: '4998.00', days: 3 });
    expect(advice.publisher.gstin).toBe('29PUBLI1234K1Z9');
    expect(advice.supplier.gstin).toBe('29ABCDE1234F1Z5');
    expect(advice.wallet).toEqual({ openingBalance: '500.00', closingBalance: '4498.00', credits: '4998.00', debits: '1000.00' });

    expect(statement.reference).toBe('PA/2026-08/wal_1');
    expect(statement.walletId).toBe('wal_1');
    expect(statement.taxWithheld.toFixed(2)).toBe('102.00');
    expect(statement.debits.toFixed(2)).toBe('1000.00');
    expect(statement.entryCount).toBe(4);
  });

  it('writes nothing for an empty month', async () => {
    payouts.listAccrualsForPeriod.mockResolvedValue([]);
    await expect(generatePublisherStatement('pub_1', AUGUST, NOW)).resolves.toBeNull();
    expect(repository.upsertStatement).not.toHaveBeenCalled();
  });

  it('renders, stores under the publisher, and upserts the row once per wallet and month', async () => {
    const statement = await generatePublisherStatement('pub_1', AUGUST, NOW);
    expect(uploads.storeGeneratedFile).toHaveBeenCalledWith('usr_pub', expect.objectContaining({
      filename: 'payment-advice-2026-08.pdf',
      mimeType: 'application/pdf',
      purpose: 'STATEMENT',
    }));
    const content = uploads.storeGeneratedFile.mock.calls[0]![1].content as Buffer;
    expect(content.subarray(0, 4).toString()).toBe('%PDF');
    expect(repository.upsertStatement).toHaveBeenCalledWith(expect.objectContaining({
      walletId: 'wal_1',
      periodStart: AUGUST.start,
      pdfPath: 'https://cdn/statements/x.pdf',
    }));
    expect(statement?.id).toBe('stm_1');
  });

  it('keeps the file unstored when nobody owns the publisher yet', async () => {
    publishers.findPublisherBilling.mockResolvedValue({ id: 'pub_1', userId: null, name: 'Held by agent', gstin: null, address: null, city: null, state: null });
    await generatePublisherStatement('pub_1', AUGUST, NOW);
    expect(uploads.storeGeneratedFile).not.toHaveBeenCalled();
    expect(repository.upsertStatement).toHaveBeenCalledWith(expect.objectContaining({ pdfPath: null }));
  });

  it('runs every publisher who earned, and one failure does not stop the rest', async () => {
    publishers.findPublisherBilling
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'pub_2', userId: 'usr_2', name: 'Two', gstin: null, address: null, city: null, state: null });
    const result = await runMonthlyStatements(AUGUST, NOW);
    expect(result).toEqual({ period: '2026-08', generated: 1, skipped: 0, failed: 1 });
  });

  /* Lot F (E7-1): each advice upserted tells its publisher once — the in-app
     PAYOUT row and the statement-ready email, the month, the net figure and
     the deep link in the variables. */
  it('tells each publisher once per statement upserted, with the month, the net figure and a deep link', async () => {
    const result = await runMonthlyStatements(AUGUST, NOW);
    expect(result.generated).toBe(2);
    expect(notifications.notify).toHaveBeenCalledTimes(2);
    expect(notifications.notify).toHaveBeenCalledWith(
      'STATEMENT_READY',
      'usr_pub',
      {
        month: 'August 2026',
        net: '4998.00',
        url: expect.stringMatching(/\/api\/v1\/payouts\/wallet\/statements\/stm_1\/pdf$/),
        partyName: 'Ravi Media',
        reference: 'PA/2026-08/wal_1',
      },
      { inApp: expect.objectContaining({ type: 'PAYOUT', title: 'Payment advice for August 2026', relatedId: 'stm_1' }) },
    );
  });

  it('has nobody to tell when no app account owns the publisher, and a failed notice does not fail the run', async () => {
    publishers.findPublisherBilling.mockResolvedValue({ id: 'pub_1', userId: null, name: 'Held by agent', gstin: null, address: null, city: null, state: null });
    await runMonthlyStatements(AUGUST, NOW);
    expect(notifications.notify).not.toHaveBeenCalled();

    publishers.findPublisherBilling.mockResolvedValue({ id: 'pub_1', userId: 'usr_pub', name: 'Ravi Media', gstin: null, address: null, city: null, state: null });
    notifications.notify.mockRejectedValue(new Error('comms down'));
    await expect(runMonthlyStatements(AUGUST, NOW)).resolves.toMatchObject({ generated: 2, failed: 0 });
  });

  it('the on-demand generate does not tell anyone; only the run does', async () => {
    await generatePublisherStatement('pub_1', AUGUST, NOW);
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});

describe('reading it back', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'stm_1',
    reference: 'PA/2026-08/wal_1',
    walletId: 'wal_1',
    periodStart: AUGUST.start,
    periodEnd: AUGUST.end,
    generatedAt: NOW,
    pdfPath: 'https://cdn/statements/x.pdf',
    ...over,
  });

  it('redirects to the stored file for the wallet\'s owner, and hides it from anyone else', async () => {
    repository.findStatement.mockResolvedValue(row());
    payouts.partyContext.mockResolvedValue({ kind: 'PUBLISHER', entityId: 'pub_1', userId: 'usr_pub' });
    await expect(statementPdf('stm_1', { userId: 'usr_pub', isAdmin: false })).resolves.toEqual({ url: 'https://cdn/statements/x.pdf' });
    await expect(statementPdf('stm_1', { userId: 'usr_admin', isAdmin: true })).resolves.toEqual({ url: 'https://cdn/statements/x.pdf' });
    await expect(statementPdf('stm_1', { userId: 'usr_other', isAdmin: false })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('renders on demand when no file was kept, and keeps it now that it can', async () => {
    repository.findStatement.mockResolvedValue(row({ pdfPath: null }));
    payouts.partyContext.mockResolvedValue({ kind: 'PUBLISHER', entityId: 'pub_1', userId: 'usr_pub' });
    repository.updateStatement.mockResolvedValue(row());
    const result = await statementPdf('stm_1', { userId: 'usr_pub', isAdmin: false });
    expect('buffer' in result).toBe(true);
    if ('buffer' in result) {
      expect(result.buffer.subarray(0, 4).toString()).toBe('%PDF');
      expect(result.filename).toBe('payment-advice-2026-08.pdf');
    }
    expect(repository.updateStatement).toHaveBeenCalledWith('stm_1', { pdfPath: 'https://cdn/statements/x.pdf' });
  });
});

describe('the paper', () => {
  it('groups rupees the Indian way', () => {
    expect(formatINR('1234506.50')).toBe('12,34,506.50');
    expect(formatINR('999.00')).toBe('999.00');
    expect(formatINR('-1000')).toBe('-1,000.00');
    expect(formatINR('100000000')).toBe('10,00,00,000.00');
  });

  it('renders an invoice and a credit note to A4 PDFs', async () => {
    const invoice = {
      id: 'inv_1',
      number: 'INV/2026-27/000001',
      kind: 'TAX_INVOICE' as const,
      status: 'PAID' as const,
      advertiserId: 'adv_1',
      campaignId: 'cmp_1',
      packageSaleId: null,
      paymentId: null,
      topUpId: null,
      voidsInvoiceId: null,
      issuedAt: NOW,
      dueAt: null,
      supplierName: 'ADX',
      supplierGstin: '29ABCDE1234F1Z5',
      supplierStateCode: '29',
      recipientName: 'Priya Foods',
      recipientGstin: '29PQRST5678G1Z2',
      recipientStateCode: '29',
      recipientAddress: '12 Church Street, Bengaluru',
      placeOfSupply: '29 - Karnataka',
      taxableValue: new Decimal('21100.00'),
      cgst: new Decimal('1899.00'),
      sgst: new Decimal('1899.00'),
      igst: new Decimal('0.00'),
      roundOff: new Decimal('0.00'),
      total: new Decimal('24898.00'),
      currency: 'INR',
      pdfFileId: null,
      ledgerTransactionId: null,
      createdById: 'usr_adv',
      createdAt: NOW,
      updatedAt: NOW,
      lines: [
        { id: 'l1', invoiceId: 'inv_1', kind: 'MEDIA' as const, description: 'Indiranagar hoarding, Bengaluru — 10 days × 1', sacCode: '998366', quantity: new Decimal(10), unitRate: new Decimal('2000.00'), taxableValue: new Decimal('20000.00'), gstPct: new Decimal('0.18'), gstAmount: new Decimal('3600.00'), campaignSpotId: 'spot_1', sortOrder: 1 },
        { id: 'l2', invoiceId: 'inv_1', kind: 'PLATFORM' as const, description: 'Platform fee', sacCode: '998599', quantity: new Decimal(1), unitRate: new Decimal('100.00'), taxableValue: new Decimal('100.00'), gstPct: new Decimal('0.18'), gstAmount: new Decimal('18.00'), campaignSpotId: null, sortOrder: 2 },
        { id: 'l3', invoiceId: 'inv_1', kind: 'INSTALLATION' as const, description: 'Installation', sacCode: '995419', quantity: new Decimal(1), unitRate: new Decimal('1000.00'), taxableValue: new Decimal('1000.00'), gstPct: new Decimal('0.18'), gstAmount: new Decimal('180.00'), campaignSpotId: null, sortOrder: 3 },
      ],
    };
    const pdf = await renderInvoicePdf(invoice, { supplierPan: 'ABCDE1234F', supplierAddress: '1 MG Road, Bengaluru' });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(1000);

    const credit = await renderInvoicePdf(
      {
        ...invoice,
        kind: 'CREDIT_NOTE',
        status: 'ISSUED',
        number: 'INV-CN/2026-27/000001',
        voidsInvoiceId: 'inv_1',
        total: new Decimal('-24898.00'),
        lines: invoice.lines.map((line) => ({ ...line, taxableValue: line.taxableValue.negated(), gstAmount: line.gstAmount.negated() })),
      },
      { againstNumber: 'INV/2026-27/000001' },
    );
    expect(credit.subarray(0, 4).toString()).toBe('%PDF');

    const advice = await renderPaymentAdvicePdf({
      reference: 'PA/2026-08/wal_1',
      period: '2026-08',
      periodLabel: 'August 2026',
      supplier: { name: 'ADX', gstin: '29ABCDE1234F1Z5', address: null },
      publisher: { name: 'Ravi Media', gstin: null, address: null },
      rows: Array.from({ length: 45 }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, 1 + (i % 31))), listing: `Site ${i}`, gross: '2000.00', commission: '300.00', taxWithheld: '0.00', net: '1700.00' })),
      totals: { gross: '90000.00', commission: '13500.00', taxWithheld: '0.00', net: '76500.00', days: 45 },
      wallet: { openingBalance: '0.00', closingBalance: '76500.00', credits: '76500.00', debits: '0.00' },
      generatedAt: NOW,
    });
    // Forty-five rows overflow one page; the table continues on a second.
    expect(advice.subarray(0, 4).toString()).toBe('%PDF');
    expect(advice.toString('latin1')).toContain('/Type /Pages');
  });
});

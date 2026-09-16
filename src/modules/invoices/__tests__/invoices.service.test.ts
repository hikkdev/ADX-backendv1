import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The invoice — Lot B (Q13).
 *
 * The lines are read off the booking as it was authorised and the same
 * `revenue.quote` that priced it; the number is consecutive in its series;
 * the tax is split by state; a void is a credit note. Nothing here moves
 * money, so nothing here mocks a wallet.
 */

const { repository, advertisers, campaigns, packages, publishers, revenue, uploads } = vi.hoisted(() => ({
  repository: {
    getLegalEntity: vi.fn(),
    updateLegalEntity: vi.fn(),
    findInvoice: vi.fn(),
    findLiveInvoiceForCampaign: vi.fn(),
    findLiveInvoiceForPackageSale: vi.fn(),
    findCreditNoteFor: vi.fn(),
    createNumbered: vi.fn(),
    createCreditNote: vi.fn(),
    updateInvoice: vi.fn(),
    listInvoices: vi.fn(),
    listInvoicesForAdvertiser: vi.fn(),
    findPublisherInvoice: vi.fn(),
    findPublisherInvoiceForPeriod: vi.fn(),
    createPublisherInvoice: vi.fn(),
    updatePublisherInvoice: vi.fn(),
    listPublisherInvoices: vi.fn(),
  },
  advertisers: { getAdvertiser: vi.fn(), assertMayActFor: vi.fn() },
  campaigns: { findCampaignForInvoice: vi.fn() },
  packages: { findSaleForInvoice: vi.fn() },
  publishers: { findPublisherForUser: vi.fn(), findPublisherBilling: vi.fn() },
  revenue: { quote: vi.fn(), invoiceTaxCodes: vi.fn() },
  uploads: { findUploadedFile: vi.fn(), storeGeneratedFile: vi.fn() },
}));

vi.mock('../prisma-invoices.repository', () => ({ prismaInvoicesRepository: repository }));
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../campaigns', () => campaigns);
vi.mock('../../packages', () => packages);
vi.mock('../../publishers', () => publishers);
vi.mock('../../revenue', () => revenue);
vi.mock('../../uploads', () => uploads);

import {
  issueInvoiceForCampaign,
  issueInvoiceForPackage,
  markCampaignInvoicePaid,
  markInvoicePaid,
  totalsFor,
  updateLegalEntity,
  uploadPublisherInvoice,
  voidInvoice,
} from '../invoices.service';

const NOW = new Date('2026-09-12T10:00:00Z');

const entity = (over: Record<string, unknown> = {}) => ({
  id: 'default',
  legalName: 'Keysquare Technologies Pvt Ltd',
  tradeName: 'ADX',
  gstin: '29ABCDE1234F1Z5',
  pan: 'ABCDE1234F',
  tan: null,
  cin: null,
  registeredAddress: '1 MG Road',
  city: 'Bengaluru',
  stateCode: '29',
  stateName: 'Karnataka',
  invoicePrefix: 'INV',
  financialYearStartMonth: 4,
  updatedById: null,
  updatedAt: NOW,
  ...over,
});

const advertiser = (over: Record<string, unknown> = {}) => ({
  id: 'adv_1',
  userId: 'usr_adv',
  name: 'Priya',
  companyName: 'Priya Foods',
  gstin: '29PQRST5678G1Z2',
  billingAddress: '12 Church Street',
  city: 'Bengaluru',
  state: 'Karnataka',
  ...over,
});

const campaign = (over: Record<string, unknown> = {}) => ({
  id: 'cmp_1',
  reference: 'ADX-CMP-2026-000001',
  name: 'Diwali',
  advertiserId: 'adv_1',
  createdByUserId: 'usr_adv',
  status: 'SCHEDULED',
  startDate: new Date('2026-10-01T00:00:00Z'),
  endDate: new Date('2026-10-10T00:00:00Z'),
  spotsSubtotal: '20000.00',
  feesTotal: '1100.00',
  gstAmount: '3780.00',
  discount: '0.00',
  // 20000 media + 100 platform (0.5%) + 1000 install, GST 18% on all = 3798? no:
  // media 20000 × .18 = 3600, platform 100 × .18 = 18, install 1000 × .18 = 180 → 3798.
  total: '24898.00',
  walletHoldId: 'hold_1',
  paidAt: NOW,
  launchedAt: null,
  spots: [
    { id: 'spot_1', listingId: 'lst_1', title: 'Indiranagar hoarding', city: 'Bengaluru', status: 'RESERVED', ratePerDay: '2000.00', days: 10, quantity: 1, lineTotal: '20000.00' },
  ],
  ...over,
});

/** The bill `revenue.quote` answers for the one spot above. */
const bill = () => ({
  lines: [
    { kind: 'MEDIA', label: 'Indiranagar hoarding', taxableValue: '20000.00', gstPct: '0.18', gstAmount: '3600.00', total: '23600.00', amountShownInCart: true },
    { kind: 'PLATFORM', label: 'Platform fee', taxableValue: '100.00', gstPct: '0.18', gstAmount: '18.00', total: '118.00', amountShownInCart: false },
    { kind: 'INSTALLATION', label: 'Installation', taxableValue: '1000.00', gstPct: '0.18', gstAmount: '180.00', total: '1180.00', amountShownInCart: false },
  ],
  gstAmount: '3798.00',
  grossTotal: '24898.00',
});

const codes = () => ({
  mediaGstPct: '0.18',
  mediaSacCode: '998366',
  fees: [
    { kind: 'PLATFORM', name: 'Platform fee', sacCode: '998599', gstPct: '0.18', perSpot: false, percentPct: '0.005' },
    { kind: 'INSTALLATION', name: 'Installation', sacCode: '995419', gstPct: '0.18', perSpot: true, percentPct: null },
  ],
});

const stored = (data: Record<string, unknown>, number = 'INV/2026-27/000001') => ({
  id: 'inv_1',
  number,
  pdfFileId: null,
  createdAt: NOW,
  updatedAt: NOW,
  currency: 'INR',
  ...data,
  lines: ((data['lines'] as Record<string, unknown>[]) ?? []).map((line, index) => ({ id: `line_${index}`, invoiceId: 'inv_1', ...line })),
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.getLegalEntity.mockResolvedValue(entity());
  repository.updateLegalEntity.mockImplementation(async (patch: Record<string, unknown>) => entity(patch));
  repository.findLiveInvoiceForCampaign.mockResolvedValue(null);
  repository.findLiveInvoiceForPackageSale.mockResolvedValue(null);
  repository.findCreditNoteFor.mockResolvedValue(null);
  repository.createNumbered.mockImplementation(async (data: Record<string, unknown>, numbering: { series: string; financialYear: string }) =>
    stored(data, `${numbering.series}/${numbering.financialYear}/000001`),
  );
  repository.updateInvoice.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...stored({ id }), ...patch }));
  advertisers.getAdvertiser.mockResolvedValue(advertiser());
  campaigns.findCampaignForInvoice.mockResolvedValue(campaign());
  revenue.quote.mockResolvedValue(bill());
  revenue.invoiceTaxCodes.mockResolvedValue(codes());
});

describe('totals', () => {
  it('splits CGST and SGST in-state, IGST across states, and carries the rounding', () => {
    const lines = [
      { kind: 'MEDIA' as const, description: 'x', sacCode: null, quantity: new Decimal(1), unitRate: new Decimal('100.33'), taxableValue: new Decimal('100.33'), gstPct: new Decimal('0.18'), gstAmount: new Decimal('18.06'), campaignSpotId: null },
    ];
    const intra = totalsFor(lines, '29', '29');
    expect(intra.intraState).toBe(true);
    expect(intra.cgst.toFixed(2)).toBe('9.03');
    expect(intra.sgst.toFixed(2)).toBe('9.03');
    expect(intra.igst.toFixed(2)).toBe('0.00');
    expect(intra.total.toFixed(2)).toBe('118.00');
    expect(intra.roundOff.toFixed(2)).toBe('-0.39');

    const inter = totalsFor(lines, '29', '27');
    expect(inter.intraState).toBe(false);
    expect(inter.igst.toFixed(2)).toBe('18.06');
    expect(inter.cgst.toFixed(2)).toBe('0.00');

    // An unknown recipient state is the supplier's own.
    expect(totalsFor(lines, '29', null).intraState).toBe(true);
  });

  it('gives the odd paisa to SGST so the two halves add up', () => {
    const lines = [
      { kind: 'MEDIA' as const, description: 'x', sacCode: null, quantity: new Decimal(1), unitRate: new Decimal('1'), taxableValue: new Decimal('1.00'), gstPct: new Decimal('0.18'), gstAmount: new Decimal('0.19'), campaignSpotId: null },
    ];
    const t = totalsFor(lines, '29', '29');
    expect(t.cgst.plus(t.sgst).toFixed(2)).toBe('0.19');
  });
});

describe('a campaign invoice', () => {
  it('itemises the snapshot with the codes, numbers it in the tax series, and reconciles to what was held', async () => {
    const invoice = await issueInvoiceForCampaign('cmp_1', { byUserId: 'usr_adv', now: NOW });

    expect(revenue.quote).toHaveBeenCalledWith({
      listingId: 'lst_1',
      days: 10,
      spots: 1,
      ratePerDay: '2000.00',
      at: new Date('2026-10-01T00:00:00Z'),
    });
    const [data, numbering] = repository.createNumbered.mock.calls[0] as [Record<string, any>, { series: string; financialYear: string }];
    expect(numbering).toEqual({ series: 'INV', financialYear: '2026-27' });
    expect(invoice.number).toBe('INV/2026-27/000001');
    expect(data.kind).toBe('TAX_INVOICE');
    expect(data.status).toBe('ISSUED'); // SCHEDULED: the hold waits for the start
    expect(data.dueAt).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(data.supplierGstin).toBe('29ABCDE1234F1Z5');
    expect(data.recipientName).toBe('Priya Foods');
    expect(data.recipientGstin).toBe('29PQRST5678G1Z2');
    expect(data.recipientStateCode).toBe('29');
    expect(data.placeOfSupply).toBe('29 - Karnataka');

    const kinds = data.lines.map((line: { kind: string }) => line.kind);
    expect(kinds).toEqual(['MEDIA', 'PLATFORM', 'INSTALLATION']);
    const media = data.lines[0];
    expect(media.sacCode).toBe('998366');
    expect(media.campaignSpotId).toBe('spot_1');
    expect(media.quantity.toString()).toBe('10');
    expect(media.unitRate.toFixed(2)).toBe('2000.00');
    expect(media.taxableValue.toFixed(2)).toBe('20000.00');
    expect(media.gstAmount.toFixed(2)).toBe('3600.00');
    expect(data.lines[1].sacCode).toBe('998599');
    expect(data.lines[2].sacCode).toBe('995419');
    expect(data.lines[2].quantity.toString()).toBe('1');
    expect(data.lines.map((line: { sortOrder: number }) => line.sortOrder)).toEqual([1, 2, 3]);

    expect(data.taxableValue.toFixed(2)).toBe('21100.00');
    expect(data.cgst.toFixed(2)).toBe('1899.00');
    expect(data.sgst.toFixed(2)).toBe('1899.00');
    expect(data.igst.toFixed(2)).toBe('0.00');
    expect(data.roundOff.toFixed(2)).toBe('0.00');
    expect(data.total.toFixed(2)).toBe('24898.00');
    expect(data.createdById).toBe('usr_adv');
  });

  it('is PAID when the hold was captured, and carries the discount at 0% so the total is what was held', async () => {
    campaigns.findCampaignForInvoice.mockResolvedValue(campaign({ status: 'LIVE', discount: '500.00', total: '24398.00' }));
    await issueInvoiceForCampaign('cmp_1', { now: NOW });
    const data = repository.createNumbered.mock.calls[0]![0] as Record<string, any>;
    expect(data.status).toBe('PAID');
    expect(data.dueAt).toBeNull();
    const discount = data.lines.find((line: { kind: string }) => line.kind === 'DISCOUNT');
    expect(discount.taxableValue.toFixed(2)).toBe('-500.00');
    expect(discount.gstAmount.toFixed(2)).toBe('0.00');
    expect(data.total.toFixed(2)).toBe('24398.00');
  });

  it('is a PROFORMA in its own series until the entity has a GSTIN', async () => {
    repository.getLegalEntity.mockResolvedValue(entity({ gstin: null, stateCode: null }));
    await issueInvoiceForCampaign('cmp_1', { now: NOW });
    const [data, numbering] = repository.createNumbered.mock.calls[0] as [Record<string, any>, { series: string }];
    expect(data.kind).toBe('PROFORMA');
    expect(numbering.series).toBe('INV-PRO');
    expect(data.supplierGstin).toBeNull();
  });

  it('charges IGST when the recipient is in another state, and resolves the state from free text', async () => {
    advertisers.getAdvertiser.mockResolvedValue(advertiser({ gstin: null, state: 'Maharashtra', city: 'Mumbai' }));
    await issueInvoiceForCampaign('cmp_1', { now: NOW });
    const data = repository.createNumbered.mock.calls[0]![0] as Record<string, any>;
    expect(data.recipientStateCode).toBe('27');
    expect(data.igst.toFixed(2)).toBe('3798.00');
    expect(data.cgst.toFixed(2)).toBe('0.00');
    expect(data.placeOfSupply).toBe('27 - Maharashtra');
  });

  it('is idempotent, and yields to the winner of a race', async () => {
    const existing = stored({ campaignId: 'cmp_1', status: 'ISSUED' });
    repository.findLiveInvoiceForCampaign.mockResolvedValue(existing);
    await expect(issueInvoiceForCampaign('cmp_1')).resolves.toBe(existing);
    expect(repository.createNumbered).not.toHaveBeenCalled();

    repository.findLiveInvoiceForCampaign.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    repository.createNumbered.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(issueInvoiceForCampaign('cmp_1', { now: NOW })).resolves.toBe(existing);
  });

  it('refuses a campaign that was never authorised, or whose lines no longer add up to the hold', async () => {
    campaigns.findCampaignForInvoice.mockResolvedValue(campaign({ walletHoldId: null, total: null }));
    await expect(issueInvoiceForCampaign('cmp_1')).rejects.toMatchObject({ statusCode: 409 });

    // The fee schedule moved since the booking: the invoice would lie.
    campaigns.findCampaignForInvoice.mockResolvedValue(campaign({ total: '24000.00' }));
    await expect(issueInvoiceForCampaign('cmp_1')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.createNumbered).not.toHaveBeenCalled();
  });
});

describe('a package invoice', () => {
  const sale = (over: Record<string, unknown> = {}) => ({
    id: 'sale_1',
    reference: 'PKG-2026-000001',
    advertiserId: 'adv_1',
    createdByUserId: 'usr_agent',
    status: 'ACTIVE',
    packageName: 'Growth',
    tier: 'GROWTH',
    cycle: 'ANNUAL',
    months: 12,
    subtotal: '60000.00',
    discountPct: '20.00',
    discountAmount: '12000.00',
    gstPct: '18.00',
    gstAmount: '8640.00',
    total: '56640.00',
    paidAt: NOW,
    paidMethod: 'WALLET',
    paidReference: 'sale_1',
    startsAt: NOW,
    endsAt: null,
    lines: [
      { kind: 'PLAN', code: 'GROWTH', label: 'Growth plan', pricePerMonth: '4000.00', months: 12, amount: '48000.00' },
      { kind: 'ADDON', code: 'ANALYTICS', label: 'Analytics', pricePerMonth: '1000.00', months: 12, amount: '12000.00' },
    ],
    ...over,
  });

  it('converts the percent to a fraction, discounts before tax, and reconciles to the sale', async () => {
    packages.findSaleForInvoice.mockResolvedValue(sale());
    await issueInvoiceForPackage('sale_1', { now: NOW });
    const data = repository.createNumbered.mock.calls[0]![0] as Record<string, any>;
    expect(data.status).toBe('PAID');
    expect(data.packageSaleId).toBe('sale_1');
    expect(data.lines.map((line: { kind: string }) => line.kind)).toEqual(['PACKAGE', 'PACKAGE', 'DISCOUNT']);
    expect(data.lines[0].gstPct.toString()).toBe('0.18');
    expect(data.lines[0].quantity.toString()).toBe('12');
    expect(data.lines[2].taxableValue.toFixed(2)).toBe('-12000.00');
    expect(data.lines[2].gstAmount.toFixed(2)).toBe('-2160.00');
    expect(data.taxableValue.toFixed(2)).toBe('48000.00');
    expect(data.cgst.plus(data.sgst).toFixed(2)).toBe('8640.00');
    expect(data.total.toFixed(2)).toBe('56640.00');
  });

  it('refuses an unpaid sale', async () => {
    packages.findSaleForInvoice.mockResolvedValue(sale({ status: 'PENDING_PAYMENT', paidAt: null }));
    await expect(issueInvoiceForPackage('sale_1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('paid', () => {
  it('marks the live invoice paid when the campaign is captured, with the payment behind it', async () => {
    repository.findLiveInvoiceForCampaign.mockResolvedValue(stored({ campaignId: 'cmp_1', kind: 'TAX_INVOICE', status: 'ISSUED' }));
    repository.findInvoice.mockResolvedValue(stored({ campaignId: 'cmp_1', kind: 'TAX_INVOICE', status: 'ISSUED' }));
    await markCampaignInvoicePaid('cmp_1');
    expect(repository.updateInvoice).toHaveBeenCalledWith('inv_1', { status: 'PAID' });

    repository.updateInvoice.mockClear();
    await markInvoicePaid('inv_1', { paymentId: 'pay_1' });
    expect(repository.updateInvoice).toHaveBeenCalledWith('inv_1', { status: 'PAID', paymentId: 'pay_1' });
  });

  it('does nothing for a campaign that was never invoiced, and refuses a void or a credit note', async () => {
    await expect(markCampaignInvoicePaid('cmp_9')).resolves.toBeNull();
    repository.findInvoice.mockResolvedValue(stored({ kind: 'TAX_INVOICE', status: 'VOID' }));
    await expect(markInvoicePaid('inv_1')).rejects.toMatchObject({ statusCode: 409 });
    repository.findInvoice.mockResolvedValue(stored({ kind: 'CREDIT_NOTE', status: 'ISSUED' }));
    await expect(markInvoicePaid('inv_1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('voiding', () => {
  const original = () =>
    stored({
      kind: 'TAX_INVOICE',
      status: 'PAID',
      advertiserId: 'adv_1',
      campaignId: 'cmp_1',
      packageSaleId: null,
      voidsInvoiceId: null,
      supplierName: 'ADX',
      supplierGstin: '29ABCDE1234F1Z5',
      supplierStateCode: '29',
      recipientName: 'Priya Foods',
      recipientGstin: null,
      recipientStateCode: '29',
      recipientAddress: null,
      placeOfSupply: '29 - Karnataka',
      taxableValue: new Decimal('21100.00'),
      cgst: new Decimal('1899.00'),
      sgst: new Decimal('1899.00'),
      igst: new Decimal('0.00'),
      roundOff: new Decimal('0.00'),
      total: new Decimal('24898.00'),
      lines: [
        { kind: 'MEDIA', description: 'Indiranagar hoarding', sacCode: '998366', quantity: new Decimal(10), unitRate: new Decimal('2000.00'), taxableValue: new Decimal('20000.00'), gstPct: new Decimal('0.18'), gstAmount: new Decimal('3600.00'), campaignSpotId: 'spot_1', sortOrder: 1 },
      ],
    });

  it('issues a mirror-image credit note in the CN series and voids the original in one transaction', async () => {
    repository.findInvoice.mockResolvedValue(original());
    repository.createCreditNote.mockImplementation(async (id: string, data: Record<string, unknown>, numbering: { series: string; financialYear: string }) => ({
      creditNote: stored(data, `${numbering.series}/${numbering.financialYear}/000001`),
      original: { ...original(), status: 'VOID' },
    }));

    const { creditNote, original: voided } = await voidInvoice('inv_1', { reason: 'Site vandalised', byUserId: 'usr_fin', now: NOW });

    const [againstId, data, numbering] = repository.createCreditNote.mock.calls[0] as [string, Record<string, any>, { series: string }];
    expect(againstId).toBe('inv_1');
    expect(numbering.series).toBe('INV-CN');
    expect(creditNote.number).toBe('INV-CN/2026-27/000001');
    expect(data.kind).toBe('CREDIT_NOTE');
    expect(data.voidsInvoiceId).toBe('inv_1');
    expect(data.total.toFixed(2)).toBe('-24898.00');
    expect(data.cgst.toFixed(2)).toBe('-1899.00');
    // The reason rides as a zero-value line, then the mirrored lines.
    expect(data.lines[0].kind).toBe('OTHER');
    expect(data.lines[0].description).toContain('Site vandalised');
    expect(data.lines[0].taxableValue.toFixed(2)).toBe('0.00');
    expect(data.lines[1].taxableValue.toFixed(2)).toBe('-20000.00');
    expect(data.lines[1].gstAmount.toFixed(2)).toBe('-3600.00');
    expect(data.createdById).toBe('usr_fin');
    expect(voided.status).toBe('VOID');
  });

  it('answers with the standing note the second time, and refuses to void a credit note', async () => {
    repository.findInvoice.mockResolvedValue({ ...original(), status: 'VOID' });
    const standing = stored({ kind: 'CREDIT_NOTE' }, 'INV-CN/2026-27/000001');
    repository.findCreditNoteFor.mockResolvedValue(standing);
    const again = await voidInvoice('inv_1', { reason: 'again', byUserId: null });
    expect(again.creditNote).toBe(standing);
    expect(repository.createCreditNote).not.toHaveBeenCalled();

    repository.findInvoice.mockResolvedValue(stored({ kind: 'CREDIT_NOTE', status: 'ISSUED' }));
    await expect(voidInvoice('inv_1', { reason: 'x', byUserId: null })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the legal entity', () => {
  it('fills the state and the PAN in from the GSTIN and reports before and after', async () => {
    repository.getLegalEntity.mockResolvedValue(entity({ gstin: null, pan: null, stateCode: null, stateName: null }));
    const { before, after } = await updateLegalEntity({ gstin: '27ABCDE1234F1Z5' }, 'usr_admin');
    expect(before.gstin).toBeNull();
    expect(repository.updateLegalEntity).toHaveBeenCalledWith(
      { gstin: '27ABCDE1234F1Z5', stateCode: '27', pan: 'ABCDE1234F', stateName: 'Maharashtra' },
      'usr_admin',
    );
    expect(after.stateCode).toBe('27');
  });
});

describe('a publisher invoice', () => {
  beforeEach(() => {
    publishers.findPublisherForUser.mockResolvedValue({ id: 'pub_1', gstin: '29PUBLI1234K1Z9' });
    uploads.findUploadedFile.mockResolvedValue({ id: 'file_1', userId: 'usr_pub', url: 'https://cdn/x.pdf' });
    repository.findPublisherInvoiceForPeriod.mockResolvedValue(null);
    repository.createPublisherInvoice.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'pinv_1', status: 'UPLOADED', ...data }));
  });

  it('records the upload against the publisher, with their GSTIN when none was typed', async () => {
    const row = await uploadPublisherInvoice('usr_pub', { period: '2026-08', fileId: 'file_1', amount: '1200.50' });
    expect(repository.createPublisherInvoice).toHaveBeenCalledWith({
      publisherId: 'pub_1',
      period: '2026-08',
      fileId: 'file_1',
      fileUrl: 'https://cdn/x.pdf',
      gstin: '29PUBLI1234K1Z9',
      amount: new Decimal('1200.50'),
    });
    expect(row.status).toBe('UPLOADED');
  });

  it('refuses a file that is not the publisher\'s own, a second upload for the period, and no GSTIN at all', async () => {
    uploads.findUploadedFile.mockResolvedValue({ id: 'file_1', userId: 'usr_other', url: 'x' });
    await expect(uploadPublisherInvoice('usr_pub', { period: '2026-08', fileId: 'file_1', amount: '1' })).rejects.toMatchObject({ statusCode: 400 });

    uploads.findUploadedFile.mockResolvedValue({ id: 'file_1', userId: 'usr_pub', url: 'x' });
    repository.findPublisherInvoiceForPeriod.mockResolvedValue({ id: 'pinv_0', status: 'MATCHED' });
    await expect(uploadPublisherInvoice('usr_pub', { period: '2026-08', fileId: 'file_1', amount: '1' })).rejects.toMatchObject({ statusCode: 409 });

    repository.findPublisherInvoiceForPeriod.mockResolvedValue(null);
    publishers.findPublisherForUser.mockResolvedValue({ id: 'pub_1', gstin: null });
    await expect(uploadPublisherInvoice('usr_pub', { period: '2026-08', fileId: 'file_1', amount: '1' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('replaces a rejected one in place', async () => {
    repository.findPublisherInvoiceForPeriod.mockResolvedValue({ id: 'pinv_0', status: 'REJECTED' });
    repository.updatePublisherInvoice.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
    const row = await uploadPublisherInvoice('usr_pub', { period: '2026-08', fileId: 'file_1', amount: '900' });
    expect(repository.updatePublisherInvoice).toHaveBeenCalledWith('pinv_0', expect.objectContaining({ status: 'UPLOADED', note: null, reviewedById: null }));
    expect(row.id).toBe('pinv_0');
  });
});

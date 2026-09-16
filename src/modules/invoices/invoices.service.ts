import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import { toListPage, type ListPage } from '../../shared/pagination';
import type { InvoiceKind, InvoiceLineKind, InvoiceStatus, LegalEntitySettings } from '../../shared/database';
import { getAdvertiser } from '../advertisers';
import { findCampaignForInvoice, type CampaignInvoiceSnapshot } from '../campaigns';
import { findSaleForInvoice, type PackageSaleInvoiceSnapshot } from '../packages';
import { findPublisherForUser } from '../publishers';
import { invoiceTaxCodes, quote as revenueQuote, type InvoiceTaxCodes } from '../revenue';
import { findUploadedFile } from '../uploads';
import { gstStateCode, gstStateName, placeOfSupplyLabel } from './gst-states';
import { financialYearLabel, seriesFor } from './numbering';
import { prismaInvoicesRepository as repository } from './prisma-invoices.repository';
import type {
  InvoiceListFilter,
  InvoiceRow,
  InvoiceWithLines,
  LegalEntityPatchRow,
  NewInvoice,
  NewInvoiceLine,
  PublisherInvoiceListFilter,
} from './invoices.repository';
import type { LegalEntityPatch, ReviewPublisherInvoiceInput, UploadPublisherInvoiceInput } from './invoices.schema';

/**
 * Invoices — Lot B (Q13/Q34).
 *
 * One document per sale from one consecutive series, whatever collected the
 * money. The lines are read off the booking as it was authorised — the spot
 * snapshot and the same `revenue.quote` that priced the checkout — so the
 * invoice cannot disagree with the amount that was held. Nothing here moves
 * money: the hold, the capture and the refund are `advertisers`' and the
 * desk's; this is the paper that describes them.
 *
 * Three facts shape the arithmetic:
 *
 * - **Proforma until the entity has a GSTIN.** A tax invoice names a
 *   supplier's GSTIN; without one the document is a proforma and consumes no
 *   number in the tax series.
 * - **CGST + SGST or IGST, never both.** Decided by the supplier's state code
 *   against the recipient's. A recipient whose state cannot be resolved is
 *   treated as in-state: for a service with no recipient address, the place
 *   of supply is the supplier's location.
 * - **Rupee rounding is carried as `roundOff`**, so the lines and the total
 *   reconcile to the paisa.
 */

const D = Decimal;
const TWO = (value: Decimal | string | number) => new D(value).toDecimalPlaces(2, D.ROUND_HALF_UP);

export type InvoiceView = Omit<
  InvoiceWithLines,
  'taxableValue' | 'cgst' | 'sgst' | 'igst' | 'roundOff' | 'total' | 'lines'
> & {
  taxableValue: Money;
  cgst: Money;
  sgst: Money;
  igst: Money;
  roundOff: Money;
  total: Money;
  /** The GST in one figure, whichever way it was split. */
  gstTotal: Money;
  lines: {
    id: string;
    kind: InvoiceLineKind;
    description: string;
    sacCode: string | null;
    quantity: string;
    unitRate: Money;
    taxableValue: Money;
    gstPct: string;
    gstAmount: Money;
    campaignSpotId: string | null;
    sortOrder: number;
  }[];
};

export type InvoiceListView = Omit<InvoiceRow, 'taxableValue' | 'cgst' | 'sgst' | 'igst' | 'roundOff' | 'total'> & {
  taxableValue: Money;
  cgst: Money;
  sgst: Money;
  igst: Money;
  roundOff: Money;
  total: Money;
  gstTotal: Money;
};

export const shapeInvoiceRow = (row: InvoiceRow): InvoiceListView => ({
  ...row,
  taxableValue: money(row.taxableValue),
  cgst: money(row.cgst),
  sgst: money(row.sgst),
  igst: money(row.igst),
  roundOff: money(row.roundOff),
  total: money(row.total),
  gstTotal: money(new D(row.cgst).plus(row.sgst).plus(row.igst)),
});

export const shapeInvoice = (invoice: InvoiceWithLines): InvoiceView => ({
  ...shapeInvoiceRow(invoice),
  lines: invoice.lines.map((line) => ({
    id: line.id,
    kind: line.kind,
    description: line.description,
    sacCode: line.sacCode,
    quantity: new D(line.quantity).toString(),
    unitRate: money(line.unitRate),
    taxableValue: money(line.taxableValue),
    gstPct: new D(line.gstPct).toString(),
    gstAmount: money(line.gstAmount),
    campaignSpotId: line.campaignSpotId,
    sortOrder: line.sortOrder,
  })),
});

/* ------------------------------------------------------------------ */
/* The legal entity                                                    */
/* ------------------------------------------------------------------ */

export const getLegalEntity = () => repository.getLegalEntity();

/**
 * The GSTIN carries the state code, so setting one fills the other in when
 * it was not given; the name follows the code. Returns before and after for
 * the audit diff.
 */
export async function updateLegalEntity(
  patch: LegalEntityPatch,
  byUserId: string,
): Promise<{ before: LegalEntitySettings; after: LegalEntitySettings }> {
  const before = await repository.getLegalEntity();
  const row: LegalEntityPatchRow = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (row as Record<string, unknown>)[key] = value;
  }
  const gstin = row.gstin === undefined ? before.gstin : row.gstin;
  if (gstin && row.stateCode === undefined && !before.stateCode) row.stateCode = gstin.slice(0, 2);
  if (gstin && row.pan === undefined && !before.pan) row.pan = gstin.slice(2, 12);
  const stateCode = row.stateCode === undefined ? before.stateCode : row.stateCode;
  if (stateCode && row.stateName === undefined) row.stateName = gstStateName(stateCode) ?? before.stateName;
  if (row.stateCode === null) row.stateName = null;
  const after = await repository.updateLegalEntity(row, byUserId);
  return { before, after };
}

/* ------------------------------------------------------------------ */
/* The arithmetic                                                      */
/* ------------------------------------------------------------------ */

type Party = { name: string; gstin: string | null; stateCode: string | null; address: string | null };

type LineDraft = Omit<NewInvoiceLine, 'sortOrder'>;

/**
 * Totals from lines. The GST is split by state; the total is rounded to the
 * rupee and the difference kept as `roundOff` so the sum of the lines plus
 * the tax plus the round-off is the total, to the paisa.
 */
export function totalsFor(
  lines: LineDraft[],
  supplierStateCode: string | null,
  recipientStateCode: string | null,
): Pick<NewInvoice, 'taxableValue' | 'cgst' | 'sgst' | 'igst' | 'roundOff' | 'total'> & { intraState: boolean } {
  const taxableValue = lines.reduce((sum, line) => sum.plus(line.taxableValue), new D(0));
  const gst = TWO(lines.reduce((sum, line) => sum.plus(line.gstAmount), new D(0)));
  // Unknown recipient state: the place of supply is the supplier's own.
  const intraState = !supplierStateCode || !recipientStateCode || supplierStateCode === recipientStateCode;
  const cgst = intraState ? TWO(gst.dividedBy(2)) : new D(0);
  const sgst = intraState ? gst.minus(cgst) : new D(0);
  const igst = intraState ? new D(0) : gst;
  const raw = taxableValue.plus(gst);
  const total = raw.toDecimalPlaces(0, D.ROUND_HALF_UP);
  return {
    taxableValue: TWO(taxableValue),
    cgst,
    sgst,
    igst,
    roundOff: TWO(total.minus(raw)),
    total: TWO(total),
    intraState,
  };
}

const numberLines = (lines: LineDraft[]): NewInvoiceLine[] =>
  lines.map((line, index) => ({ ...line, sortOrder: index + 1 }));

function supplierFrom(entity: LegalEntitySettings): Party {
  const stateCode = entity.stateCode ?? (entity.gstin ? entity.gstin.slice(0, 2) : null);
  const address = [entity.registeredAddress, entity.city, entity.stateName ?? gstStateName(stateCode)]
    .filter(Boolean)
    .join(', ');
  return {
    name: entity.tradeName ?? entity.legalName ?? 'ADX',
    gstin: entity.gstin,
    stateCode,
    address: address || null,
  };
}

async function recipientFor(advertiserId: string): Promise<Party & { userId: string | null }> {
  const advertiser = await getAdvertiser(advertiserId);
  const stateCode =
    (advertiser.gstin ? gstStateCode(advertiser.gstin.slice(0, 2)) : null) ??
    gstStateCode(advertiser.state) ??
    gstStateCode(advertiser.city);
  const address = [advertiser.billingAddress, advertiser.city, advertiser.state].filter(Boolean).join(', ');
  return {
    name: advertiser.companyName ?? advertiser.name,
    gstin: advertiser.gstin,
    stateCode,
    address: address || null,
    userId: advertiser.userId,
  };
}

function header(
  kind: InvoiceKind,
  status: InvoiceStatus,
  supplier: Party,
  recipient: Party,
  issuedAt: Date,
): Pick<
  NewInvoice,
  | 'kind'
  | 'status'
  | 'issuedAt'
  | 'supplierName'
  | 'supplierGstin'
  | 'supplierStateCode'
  | 'recipientName'
  | 'recipientGstin'
  | 'recipientStateCode'
  | 'recipientAddress'
  | 'placeOfSupply'
> {
  return {
    kind,
    status,
    issuedAt,
    supplierName: supplier.name,
    supplierGstin: supplier.gstin,
    supplierStateCode: supplier.stateCode,
    recipientName: recipient.name,
    recipientGstin: recipient.gstin,
    recipientStateCode: recipient.stateCode,
    recipientAddress: recipient.address,
    placeOfSupply: placeOfSupplyLabel(recipient.stateCode ?? supplier.stateCode),
  };
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';

/* ------------------------------------------------------------------ */
/* A campaign's invoice                                                */
/* ------------------------------------------------------------------ */

/**
 * The lines for a booking: one MEDIA line per spot, the fee lines from the
 * schedule aggregated across the spots, and the discount.
 *
 * The amounts come from `revenue.quote` — the call the checkout made at
 * authorisation, at the same instant — and the codes from the schedule. The
 * campaign's own `discount` is applied after GST in the checkout (it is a
 * credit against the bill, not a rate discount), so it is carried here at
 * 0% GST: the invoice total then equals the amount that was held, which is
 * the one thing an invoice must not get wrong.
 */
export async function campaignLines(
  campaign: CampaignInvoiceSnapshot,
  codes: InvoiceTaxCodes,
): Promise<{ lines: LineDraft[]; gross: Decimal }> {
  const lines: LineDraft[] = [];
  const fees = new Map<
    InvoiceLineKind,
    { name: string; taxable: Decimal; gst: Decimal; gstPct: string; sacCode: string | null; units: number }
  >();

  for (const spot of campaign.spots) {
    if (spot.status === 'CANCELLED') continue;
    const bill = await revenueQuote({
      listingId: spot.listingId,
      days: spot.days,
      spots: spot.quantity,
      ratePerDay: spot.ratePerDay,
      ...(campaign.startDate ? { at: campaign.startDate } : {}),
    });
    const media = bill.lines.find((line) => line.kind === 'MEDIA');
    const mediaTaxable = new D(media?.taxableValue ?? spot.lineTotal);
    const mediaPct = new D(media?.gstPct ?? codes.mediaGstPct);
    lines.push({
      kind: 'MEDIA',
      description: `${spot.title}${spot.city ? `, ${spot.city}` : ''} — ${spot.days} day${spot.days === 1 ? '' : 's'} × ${spot.quantity}`,
      sacCode: codes.mediaSacCode,
      quantity: new D(spot.days).times(spot.quantity),
      unitRate: TWO(spot.ratePerDay),
      taxableValue: TWO(mediaTaxable),
      gstPct: mediaPct,
      gstAmount: TWO(media?.gstAmount ?? mediaTaxable.times(mediaPct)),
      campaignSpotId: spot.id,
    });

    for (const line of bill.lines) {
      if (line.kind === 'MEDIA') continue;
      const schedule = codes.fees.find((fee) => fee.kind === line.kind);
      const key = line.kind as InvoiceLineKind;
      const seen = fees.get(key) ?? {
        name: line.label,
        taxable: new D(0),
        gst: new D(0),
        gstPct: line.gstPct,
        sacCode: schedule?.sacCode ?? null,
        units: 0,
      };
      seen.taxable = seen.taxable.plus(line.taxableValue);
      seen.gst = seen.gst.plus(line.gstAmount);
      seen.units += schedule?.percentPct !== null && schedule?.percentPct !== undefined ? 0 : schedule?.perSpot ? spot.quantity : 1;
      fees.set(key, seen);
    }
  }

  for (const [kind, fee] of fees) {
    const quantity = fee.units > 0 ? fee.units : 1;
    lines.push({
      kind,
      description: fee.name,
      sacCode: fee.sacCode,
      quantity: new D(quantity),
      unitRate: TWO(fee.taxable.dividedBy(quantity)),
      taxableValue: TWO(fee.taxable),
      gstPct: new D(fee.gstPct),
      gstAmount: TWO(fee.gst),
      campaignSpotId: null,
    });
  }

  const discount = new D(campaign.discount);
  if (discount.greaterThan(0)) {
    lines.push({
      kind: 'DISCOUNT',
      description: 'Campaign discount',
      sacCode: null,
      quantity: new D(1),
      unitRate: TWO(discount.negated()),
      taxableValue: TWO(discount.negated()),
      gstPct: new D(0),
      gstAmount: new D(0),
      campaignSpotId: null,
    });
  }

  const gross = lines.reduce((sum, line) => sum.plus(line.taxableValue).plus(line.gstAmount), new D(0));
  return { lines, gross };
}

/**
 * Idempotent: the live invoice for the campaign, or a new one.
 *
 * Called by the checkout through the port the moment the hold is placed, and
 * by the desk's `POST /finance/invoices/issue` when that call was missed. A
 * campaign that was never authorised has nothing to invoice; one whose
 * re-priced lines no longer add up to the amount that was held is refused
 * rather than documented wrongly.
 */
export async function issueInvoiceForCampaign(
  campaignId: string,
  options: { byUserId?: string | null; now?: Date } = {},
): Promise<InvoiceWithLines> {
  const existing = await repository.findLiveInvoiceForCampaign(campaignId);
  if (existing) return existing;

  const campaign = await findCampaignForInvoice(campaignId);
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  if (!campaign.walletHoldId || campaign.total === null) {
    throw new ApiError(409, 'CONFLICT', 'This campaign has not been authorised, so there is nothing to invoice yet.');
  }
  if (campaign.status === 'CANCELLED') {
    throw new ApiError(409, 'CONFLICT', 'A cancelled campaign is not invoiced after the fact.');
  }

  const [entity, codes, recipient] = await Promise.all([
    repository.getLegalEntity(),
    invoiceTaxCodes(),
    recipientFor(campaign.advertiserId),
  ]);
  const { lines, gross } = await campaignLines(campaign, codes);

  if (!TWO(gross).equals(TWO(campaign.total))) {
    throw new ApiError(
      409,
      'CONFLICT',
      `The lines add up to ${money(gross)} but ${money(campaign.total)} was held. The fee schedule has changed since the booking; the invoice was not issued.`,
    );
  }

  const now = options.now ?? new Date();
  const supplier = supplierFrom(entity);
  const kind: InvoiceKind = entity.gstin ? 'TAX_INVOICE' : 'PROFORMA';
  // LIVE or later means the hold was captured; SCHEDULED keeps it until the start.
  const captured = campaign.status === 'LIVE' || campaign.status === 'COMPLETED';
  const totals = totalsFor(lines, supplier.stateCode, recipient.stateCode);

  const data: NewInvoice = {
    ...header(kind, captured ? 'PAID' : 'ISSUED', supplier, recipient, now),
    advertiserId: campaign.advertiserId,
    campaignId: campaign.id,
    packageSaleId: null,
    paymentId: null,
    topUpId: null,
    voidsInvoiceId: null,
    dueAt: captured ? null : campaign.startDate,
    taxableValue: totals.taxableValue,
    cgst: totals.cgst,
    sgst: totals.sgst,
    igst: totals.igst,
    roundOff: totals.roundOff,
    total: totals.total,
    ledgerTransactionId: null,
    createdById: options.byUserId ?? campaign.createdByUserId,
    lines: numberLines(lines),
  };

  try {
    return await repository.createNumbered(data, {
      series: seriesFor(kind, entity.invoicePrefix),
      financialYear: financialYearLabel(now, entity.financialYearStartMonth),
    });
  } catch (err) {
    // Two issues raced on the one-live-invoice-per-campaign index; the loser
    // rolled its number back and answers with the winner's document.
    if (isUniqueViolation(err)) {
      const won = await repository.findLiveInvoiceForCampaign(campaignId);
      if (won) return won;
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* A package sale's invoice                                            */
/* ------------------------------------------------------------------ */

/**
 * One PACKAGE line per sale line — the plan, then each add-on — and a
 * DISCOUNT line for the annual cycle's fifth off, which is a rate discount
 * and so reduces the taxable value. The sale stores its GST as a percent
 * (18); the line carries the fraction (0.18) every other line does. The sale
 * is not changed.
 */
export function packageLines(sale: PackageSaleInvoiceSnapshot, sacCode: string | null): LineDraft[] {
  const gstPct = new D(sale.gstPct).dividedBy(100);
  const lines: LineDraft[] = sale.lines.map((line) => {
    const amount = new D(line.amount);
    return {
      kind: 'PACKAGE' as const,
      description: `${line.label} — ${line.months} month${line.months === 1 ? '' : 's'}${sale.cycle === 'ANNUAL' ? ' (annual)' : ''}`,
      sacCode,
      quantity: new D(line.months),
      unitRate: TWO(line.pricePerMonth),
      taxableValue: TWO(amount),
      gstPct,
      gstAmount: TWO(amount.times(gstPct)),
      campaignSpotId: null,
    };
  });
  const discount = new D(sale.discountAmount);
  if (discount.greaterThan(0)) {
    lines.push({
      kind: 'DISCOUNT',
      description: `Annual cycle discount (${new D(sale.discountPct).toFixed(0)}%)`,
      sacCode: null,
      quantity: new D(1),
      unitRate: TWO(discount.negated()),
      taxableValue: TWO(discount.negated()),
      gstPct,
      gstAmount: TWO(discount.negated().times(gstPct)),
      campaignSpotId: null,
    });
  }
  return lines;
}

export async function issueInvoiceForPackage(
  saleId: string,
  options: { byUserId?: string | null; now?: Date } = {},
): Promise<InvoiceWithLines> {
  const existing = await repository.findLiveInvoiceForPackageSale(saleId);
  if (existing) return existing;

  const sale = await findSaleForInvoice(saleId);
  if (!sale) throw new ApiError(404, 'NOT_FOUND', 'Package sale not found');
  if (!sale.paidAt) {
    throw new ApiError(409, 'CONFLICT', 'This sale has not been paid, so there is nothing to invoice yet.');
  }

  const [entity, codes, recipient] = await Promise.all([
    repository.getLegalEntity(),
    invoiceTaxCodes(),
    recipientFor(sale.advertiserId),
  ]);
  const lines = packageLines(sale, codes.mediaSacCode);
  const now = options.now ?? new Date();
  const supplier = supplierFrom(entity);
  const kind: InvoiceKind = entity.gstin ? 'TAX_INVOICE' : 'PROFORMA';
  const totals = totalsFor(lines, supplier.stateCode, recipient.stateCode);

  const data: NewInvoice = {
    ...header(kind, 'PAID', supplier, recipient, now),
    advertiserId: sale.advertiserId,
    campaignId: null,
    packageSaleId: sale.id,
    paymentId: null,
    topUpId: null,
    voidsInvoiceId: null,
    dueAt: null,
    taxableValue: totals.taxableValue,
    cgst: totals.cgst,
    sgst: totals.sgst,
    igst: totals.igst,
    roundOff: totals.roundOff,
    total: totals.total,
    ledgerTransactionId: null,
    createdById: options.byUserId ?? sale.createdByUserId,
    lines: numberLines(lines),
  };

  try {
    return await repository.createNumbered(data, {
      series: seriesFor(kind, entity.invoicePrefix),
      financialYear: financialYearLabel(now, entity.financialYearStartMonth),
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const won = await repository.findLiveInvoiceForPackageSale(saleId);
      if (won) return won;
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Paid, void, credit notes                                            */
/* ------------------------------------------------------------------ */

async function getInvoiceOrThrow(id: string): Promise<InvoiceWithLines> {
  const invoice = await repository.findInvoice(id);
  if (!invoice) throw new ApiError(404, 'NOT_FOUND', 'Invoice not found');
  return invoice;
}

export const getInvoice = getInvoiceOrThrow;

/**
 * Lot C's door: the gateway payment or the recorded top-up that settled the
 * invoice. Idempotent; a void or a credit note cannot be paid.
 */
export async function markInvoicePaid(
  invoiceId: string,
  by: { paymentId?: string | null; topUpId?: string | null } = {},
): Promise<InvoiceWithLines> {
  const invoice = await getInvoiceOrThrow(invoiceId);
  if (invoice.kind === 'CREDIT_NOTE') throw new ApiError(409, 'CONFLICT', 'A credit note is not paid');
  if (invoice.status === 'VOID') throw new ApiError(409, 'CONFLICT', 'This invoice was voided');
  const patch = {
    ...(by.paymentId ? { paymentId: by.paymentId } : {}),
    ...(by.topUpId ? { topUpId: by.topUpId } : {}),
  };
  if (invoice.status === 'PAID' && Object.keys(patch).length === 0) return invoice;
  return repository.updateInvoice(invoiceId, { status: 'PAID', ...patch });
}

/**
 * Lot C (Q110): the invoice standing for a booking or a sale, for `payments`
 * to stamp the gateway payment on. Null when nothing was issued (yet).
 */
export async function liveInvoiceFor(target: { campaignId?: string | null; packageSaleId?: string | null }): Promise<InvoiceWithLines | null> {
  if (target.campaignId) return repository.findLiveInvoiceForCampaign(target.campaignId);
  if (target.packageSaleId) return repository.findLiveInvoiceForPackageSale(target.packageSaleId);
  return null;
}

/** The campaign's hold was captured. Nothing to do when it was never invoiced. */
export async function markCampaignInvoicePaid(campaignId: string): Promise<InvoiceWithLines | null> {
  const invoice = await repository.findLiveInvoiceForCampaign(campaignId);
  if (!invoice) return null;
  if (invoice.status === 'PAID') return invoice;
  return markInvoicePaid(invoice.id);
}

/**
 * Voids an invoice by issuing a credit note against it.
 *
 * An issued document is never deleted or edited: the credit note is the
 * reversal, numbered in its own series, and the original goes VOID in the
 * same transaction. **Its lines and totals are the mirror image of the
 * original — negative** — so that summing an advertiser's documents nets to
 * what was actually billed; the PDF prints the magnitudes under a CREDIT
 * NOTE heading. The reason travels as a zero-value OTHER line at the top,
 * which is what the recipient reads on the paper. Idempotent: a second void
 * returns the note that already stands.
 */
export async function voidInvoice(
  invoiceId: string,
  input: { reason: string; byUserId: string | null; now?: Date },
): Promise<{ creditNote: InvoiceWithLines; original: InvoiceWithLines }> {
  const original = await getInvoiceOrThrow(invoiceId);
  if (original.kind === 'CREDIT_NOTE') {
    throw new ApiError(409, 'CONFLICT', 'A credit note is not voided; it is the void.');
  }
  if (original.status === 'VOID') {
    const standing = await repository.findCreditNoteFor(original.id);
    if (standing) return { creditNote: standing, original };
    throw new ApiError(409, 'CONFLICT', 'This invoice is already void.');
  }
  if (original.status === 'DRAFT') {
    throw new ApiError(409, 'CONFLICT', 'A draft has not been issued and needs no credit note.');
  }

  const entity = await repository.getLegalEntity();
  const now = input.now ?? new Date();
  const reason = input.reason.trim();

  const mirrored: LineDraft[] = [
    {
      kind: 'OTHER',
      description: `Credit note against ${original.number}: ${reason}`,
      sacCode: null,
      quantity: new D(0),
      unitRate: new D(0),
      taxableValue: new D(0),
      gstPct: new D(0),
      gstAmount: new D(0),
      campaignSpotId: null,
    },
    ...original.lines.map((line) => ({
      kind: line.kind,
      description: line.description,
      sacCode: line.sacCode,
      quantity: new D(line.quantity),
      unitRate: TWO(new D(line.unitRate).negated()),
      taxableValue: TWO(new D(line.taxableValue).negated()),
      gstPct: new D(line.gstPct),
      gstAmount: TWO(new D(line.gstAmount).negated()),
      campaignSpotId: line.campaignSpotId,
    })),
  ];

  const data: NewInvoice = {
    kind: 'CREDIT_NOTE',
    status: 'ISSUED',
    issuedAt: now,
    supplierName: original.supplierName,
    supplierGstin: original.supplierGstin,
    supplierStateCode: original.supplierStateCode,
    recipientName: original.recipientName,
    recipientGstin: original.recipientGstin,
    recipientStateCode: original.recipientStateCode,
    recipientAddress: original.recipientAddress,
    placeOfSupply: original.placeOfSupply,
    advertiserId: original.advertiserId,
    campaignId: original.campaignId,
    packageSaleId: original.packageSaleId,
    paymentId: null,
    topUpId: null,
    voidsInvoiceId: original.id,
    dueAt: null,
    taxableValue: TWO(new D(original.taxableValue).negated()),
    cgst: TWO(new D(original.cgst).negated()),
    sgst: TWO(new D(original.sgst).negated()),
    igst: TWO(new D(original.igst).negated()),
    roundOff: TWO(new D(original.roundOff).negated()),
    total: TWO(new D(original.total).negated()),
    ledgerTransactionId: null,
    createdById: input.byUserId,
    lines: numberLines(mirrored),
  };

  return repository.createCreditNote(original.id, data, {
    series: seriesFor('CREDIT_NOTE', entity.invoicePrefix),
    financialYear: financialYearLabel(now, entity.financialYearStartMonth),
  });
}

/** A cancelled booking: the live invoice, if any, is credited and voided. */
export async function creditNoteForCampaign(
  campaignId: string,
  reason: string,
  byUserId: string | null,
): Promise<InvoiceWithLines | null> {
  const invoice = await repository.findLiveInvoiceForCampaign(campaignId);
  if (!invoice) return null;
  const { creditNote } = await voidInvoice(invoice.id, { reason, byUserId });
  return creditNote;
}

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

export async function listInvoices(query: InvoiceListFilter): Promise<ListPage<InvoiceListView>> {
  const { items, total, counts } = await repository.listInvoices(query);
  return toListPage(items.map(shapeInvoiceRow), total, counts, query);
}

export async function listInvoicesForAdvertiser(advertiserId: string, limit = 100): Promise<InvoiceListView[]> {
  const rows = await repository.listInvoicesForAdvertiser(advertiserId, Math.min(limit, 400));
  return rows.map(shapeInvoiceRow);
}

/** An invoice as one advertiser may read it: theirs, and issued. */
export async function getInvoiceForAdvertiser(advertiserId: string, invoiceId: string): Promise<InvoiceWithLines> {
  const invoice = await getInvoiceOrThrow(invoiceId);
  if (invoice.advertiserId !== advertiserId || invoice.status === 'DRAFT') {
    throw new ApiError(404, 'NOT_FOUND', 'Invoice not found');
  }
  return invoice;
}

/* ------------------------------------------------------------------ */
/* Publisher invoices                                                  */
/* ------------------------------------------------------------------ */

/**
 * A GST-registered publisher's own invoice to ADX for a month, so ADX can
 * claim the input credit. One per period: a rejected one is replaced in
 * place, anything else refuses a second upload. The file is resolved by id
 * and must be the publisher's own upload.
 */
export async function uploadPublisherInvoice(userId: string, input: UploadPublisherInvoiceInput) {
  const publisher = await findPublisherForUser(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'You do not have a publisher profile');

  const file = await findUploadedFile(input.fileId);
  if (!file || file.userId !== userId) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Upload the invoice first and send its file id');
  }
  const gstin = input.gstin ?? publisher.gstin ?? null;
  if (!gstin) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A GSTIN is needed on an invoice ADX can claim credit against');
  }
  const amount = new D(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw new ApiError(400, 'VALIDATION_ERROR', 'The amount has to be positive');

  const existing = await repository.findPublisherInvoiceForPeriod(publisher.id, input.period);
  if (existing && existing.status !== 'REJECTED') {
    throw new ApiError(409, 'CONFLICT', `An invoice for ${input.period} is already ${existing.status.toLowerCase()}`);
  }
  if (existing) {
    return repository.updatePublisherInvoice(existing.id, {
      fileId: file.id,
      fileUrl: file.url,
      gstin,
      amount: TWO(amount),
      status: 'UPLOADED',
      note: null,
      reviewedById: null,
      reviewedAt: null,
    });
  }
  return repository.createPublisherInvoice({
    publisherId: publisher.id,
    period: input.period,
    fileId: file.id,
    fileUrl: file.url,
    gstin,
    amount: TWO(amount),
  });
}

export async function reviewPublisherInvoice(id: string, input: ReviewPublisherInvoiceInput, byUserId: string, now = new Date()) {
  const before = await repository.findPublisherInvoice(id);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Publisher invoice not found');
  if (input.status === 'REJECTED' && !input.note?.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Say why the invoice was rejected');
  }
  const after = await repository.updatePublisherInvoice(id, {
    status: input.status,
    note: input.note?.trim() || null,
    reviewedById: byUserId,
    reviewedAt: now,
  });
  return { before, after };
}

export async function listPublisherInvoices(query: PublisherInvoiceListFilter) {
  const { items, total, counts } = await repository.listPublisherInvoices(query);
  return toListPage(
    items.map((row) => ({ ...row, amount: money(row.amount) })),
    total,
    counts,
    query,
  );
}

export const listMyPublisherInvoices = async (userId: string) => {
  const publisher = await findPublisherForUser(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'You do not have a publisher profile');
  const page = await repository.listPublisherInvoices({ publisherId: publisher.id, page: 1, pageSize: 100 });
  return page.items.map((row) => ({ ...row, amount: money(row.amount) }));
};

import type {
  Invoice,
  InvoiceKind,
  InvoiceLine,
  InvoiceLineKind,
  InvoiceStatus,
  LegalEntitySettings,
  Prisma,
  PublisherInvoice,
  PublisherInvoiceStatus,
  Statement,
} from '../../shared/database';
import type { ListQuery } from '../../shared/pagination';

/**
 * What the invoices module stores: the legal entity, the invoices and their
 * lines, the numbering sequences, the publishers' own invoices to ADX, and
 * the monthly statements (payment advices) it renders for publishers.
 *
 * Money is `Prisma.Decimal` at this boundary and a string everywhere above it.
 */

export type InvoiceRow = Invoice;
export type InvoiceWithLines = Invoice & { lines: InvoiceLine[] };

export type NewInvoiceLine = {
  kind: InvoiceLineKind;
  description: string;
  sacCode: string | null;
  quantity: Prisma.Decimal;
  unitRate: Prisma.Decimal;
  taxableValue: Prisma.Decimal;
  gstPct: Prisma.Decimal;
  gstAmount: Prisma.Decimal;
  campaignSpotId: string | null;
  sortOrder: number;
};

export type NewInvoice = {
  kind: InvoiceKind;
  status: InvoiceStatus;
  advertiserId: string;
  campaignId: string | null;
  packageSaleId: string | null;
  paymentId: string | null;
  topUpId: string | null;
  voidsInvoiceId: string | null;
  issuedAt: Date;
  dueAt: Date | null;
  supplierName: string | null;
  supplierGstin: string | null;
  supplierStateCode: string | null;
  recipientName: string;
  recipientGstin: string | null;
  recipientStateCode: string | null;
  recipientAddress: string | null;
  placeOfSupply: string | null;
  taxableValue: Prisma.Decimal;
  cgst: Prisma.Decimal;
  sgst: Prisma.Decimal;
  igst: Prisma.Decimal;
  roundOff: Prisma.Decimal;
  total: Prisma.Decimal;
  ledgerTransactionId: string | null;
  createdById: string | null;
  lines: NewInvoiceLine[];
};

/** Which counter the number comes from. */
export type Numbering = { series: string; financialYear: string };

export type InvoicePatch = Partial<
  Pick<Invoice, 'status' | 'paymentId' | 'topUpId' | 'pdfFileId' | 'ledgerTransactionId'>
>;

export type InvoiceListFilter = ListQuery & {
  kind?: InvoiceKind | undefined;
  advertiserId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
};

export type LegalEntityPatchRow = Partial<
  Pick<
    LegalEntitySettings,
    | 'legalName'
    | 'tradeName'
    | 'gstin'
    | 'pan'
    | 'tan'
    | 'cin'
    | 'registeredAddress'
    | 'city'
    | 'stateCode'
    | 'stateName'
    | 'invoicePrefix'
    | 'financialYearStartMonth'
  >
>;

export type NewPublisherInvoice = {
  publisherId: string;
  period: string;
  fileId: string | null;
  fileUrl: string | null;
  gstin: string | null;
  amount: Prisma.Decimal;
};

export type PublisherInvoicePatch = Partial<
  Pick<PublisherInvoice, 'status' | 'note' | 'reviewedById' | 'reviewedAt' | 'fileId' | 'fileUrl' | 'gstin' | 'amount'>
>;

export type PublisherInvoiceListFilter = ListQuery & {
  publisherId?: string | undefined;
  period?: string | undefined;
};

export type NewStatement = {
  reference: string;
  walletId: string;
  periodStart: Date;
  periodEnd: Date;
  openingBalance: Prisma.Decimal;
  credits: Prisma.Decimal;
  debits: Prisma.Decimal;
  taxWithheld: Prisma.Decimal;
  closingBalance: Prisma.Decimal;
  entryCount: number;
  pdfPath: string | null;
  csvPath: string | null;
};

export interface InvoicesRepository {
  /* ── Legal entity ─────────────────────────────────────────────── */
  /** The one row, created empty on first read. */
  getLegalEntity(): Promise<LegalEntitySettings>;
  updateLegalEntity(patch: LegalEntityPatchRow, byUserId: string): Promise<LegalEntitySettings>;

  /* ── Invoices ─────────────────────────────────────────────────── */
  findInvoice(id: string): Promise<InvoiceWithLines | null>;
  /** The invoice that stands for a campaign: not a credit note, not void. */
  findLiveInvoiceForCampaign(campaignId: string): Promise<InvoiceWithLines | null>;
  findLiveInvoiceForPackageSale(packageSaleId: string): Promise<InvoiceWithLines | null>;
  findCreditNoteFor(invoiceId: string): Promise<InvoiceWithLines | null>;
  /**
   * Allocates the next number in the series and writes the invoice with its
   * lines, in one transaction — a failed write rolls the counter back.
   */
  createNumbered(data: NewInvoice, numbering: Numbering): Promise<InvoiceWithLines>;
  /**
   * The credit note and the void, together: the note takes its number, is
   * written, and the original goes VOID in the same transaction.
   */
  createCreditNote(
    originalId: string,
    data: NewInvoice,
    numbering: Numbering,
  ): Promise<{ creditNote: InvoiceWithLines; original: InvoiceWithLines }>;
  updateInvoice(id: string, patch: InvoicePatch): Promise<InvoiceWithLines>;
  listInvoices(filter: InvoiceListFilter): Promise<{ items: InvoiceRow[]; total: number; counts: Record<string, number> }>;
  listInvoicesForAdvertiser(advertiserId: string, limit: number): Promise<InvoiceRow[]>;

  /* ── Publisher invoices ───────────────────────────────────────── */
  findPublisherInvoice(id: string): Promise<PublisherInvoice | null>;
  findPublisherInvoiceForPeriod(publisherId: string, period: string): Promise<PublisherInvoice | null>;
  createPublisherInvoice(data: NewPublisherInvoice): Promise<PublisherInvoice>;
  updatePublisherInvoice(id: string, patch: PublisherInvoicePatch): Promise<PublisherInvoice>;
  listPublisherInvoices(
    filter: PublisherInvoiceListFilter,
  ): Promise<{ items: PublisherInvoice[]; total: number; counts: Record<string, number> }>;

  /* ── Statements ───────────────────────────────────────────────── */
  findStatement(id: string): Promise<Statement | null>;
  findStatementForPeriod(walletId: string, periodStart: Date): Promise<Statement | null>;
  /** Written once per wallet per period; a rerun refreshes the figures and keeps the id. */
  upsertStatement(data: NewStatement): Promise<Statement>;
  updateStatement(id: string, patch: Partial<Pick<Statement, 'pdfPath' | 'csvPath'>>): Promise<Statement>;
  listStatementsForWallet(walletId: string, limit: number): Promise<Statement[]>;
}

export type { PublisherInvoiceStatus };

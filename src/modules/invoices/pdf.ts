import PDFDocument from 'pdfkit';
import { Decimal, type Money } from '../../shared/money';
import { amountInWords } from './amount-in-words';
import { gstStateName } from './gst-states';
import type { InvoiceWithLines } from './invoices.repository';

/**
 * The paper — A4, pdfkit, the standard Helvetica faces so nothing has to be
 * shipped with the build. Helvetica has no rupee glyph, so amounts print as
 * "Rs." rather than a box.
 *
 * Two documents. The tax invoice / proforma / credit note, and the
 * publisher's monthly payment advice. Both render to a Buffer; where it goes
 * afterwards is the service's business.
 */

const PAGE = { width: 595.28, height: 841.89, margin: 40 };
const CONTENT = PAGE.width - PAGE.margin * 2;

/** 12,34,506.50 — Indian grouping. */
export function formatINR(value: Decimal | Money | number): string {
  const fixed = new Decimal(value).toFixed(2);
  const negative = fixed.startsWith('-');
  const [whole, paise] = (negative ? fixed.slice(1) : fixed).split('.') as [string, string];
  let grouped = whole;
  if (whole.length > 3) {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${last3}`;
  }
  return `${negative ? '-' : ''}${grouped}.${paise}`;
}

const rs = (value: Decimal | Money | number): string => `Rs. ${formatINR(value)}`;

const pct = (fraction: Decimal | string): string => `${new Decimal(fraction).times(100).toDecimalPlaces(2).toString()}%`;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Sep 2026", in Indian time. */
export function formatDate(date: Date | null | undefined): string {
  if (!date) return '—';
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

type Doc = InstanceType<typeof PDFDocument>;

function collect(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function newDoc(title: string): Doc {
  return new PDFDocument({
    size: 'A4',
    margin: PAGE.margin,
    info: { Title: title, Author: 'ADX', Creator: 'ADX platform' },
  });
}

/* ── Table plumbing ─────────────────────────────────────────────────── */

type Column = { label: string; width: number; align?: 'left' | 'right' };

function tableHeader(doc: Doc, columns: Column[], y: number): number {
  let x = PAGE.margin;
  doc.rect(PAGE.margin, y, CONTENT, 18).fill('#eeeeee');
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8);
  for (const column of columns) {
    doc.text(column.label, x + 3, y + 5, { width: column.width - 6, align: column.align ?? 'left' });
    x += column.width;
  }
  return y + 18;
}

function tableRow(doc: Doc, columns: Column[], cells: string[], y: number, bold = false): number {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#000000');
  // The tallest cell decides the row height.
  let height = 0;
  columns.forEach((column, index) => {
    const h = doc.heightOfString(cells[index] ?? '', { width: column.width - 6 });
    height = Math.max(height, h);
  });
  height += 8;
  if (y + height > PAGE.height - PAGE.margin - 40) {
    doc.addPage();
    y = tableHeader(doc, columns, PAGE.margin);
  }
  let x = PAGE.margin;
  columns.forEach((column, index) => {
    doc.text(cells[index] ?? '', x + 3, y + 4, { width: column.width - 6, align: column.align ?? 'left' });
    x += column.width;
  });
  doc.moveTo(PAGE.margin, y + height).lineTo(PAGE.margin + CONTENT, y + height).lineWidth(0.3).strokeColor('#bbbbbb').stroke();
  return y + height;
}

function block(doc: Doc, x: number, y: number, width: number, heading: string, lines: (string | null | undefined)[]): number {
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#555555').text(heading.toUpperCase(), x, y, { width });
  let cursor = y + 12;
  doc.font('Helvetica').fontSize(9).fillColor('#000000');
  for (const line of lines) {
    if (!line) continue;
    doc.text(line, x, cursor, { width });
    cursor += doc.heightOfString(line, { width }) + 2;
  }
  return cursor;
}

/* ── The tax invoice ────────────────────────────────────────────────── */

const TITLES = { TAX_INVOICE: 'TAX INVOICE', PROFORMA: 'PROFORMA INVOICE', CREDIT_NOTE: 'CREDIT NOTE' } as const;

export type InvoiceContext = {
  /** The number of the invoice a credit note reverses, when it is one. */
  againstNumber?: string | null;
  supplierPan?: string | null;
  supplierCin?: string | null;
  supplierAddress?: string | null;
  supplierLegalName?: string | null;
};

export async function renderInvoicePdf(invoice: InvoiceWithLines, context: InvoiceContext = {}): Promise<Buffer> {
  const doc = newDoc(`${TITLES[invoice.kind]} ${invoice.number}`);
  const done = collect(doc);
  const credit = invoice.kind === 'CREDIT_NOTE';
  const abs = (value: Decimal | string) => new Decimal(value).abs();

  doc.font('Helvetica-Bold').fontSize(16).text(TITLES[invoice.kind], PAGE.margin, PAGE.margin, { width: CONTENT, align: 'right' });
  if (invoice.kind === 'PROFORMA') {
    doc.font('Helvetica').fontSize(8).fillColor('#555555')
      .text('Not a tax invoice. Issued before the supplier registered for GST.', PAGE.margin, PAGE.margin + 20, { width: CONTENT, align: 'right' });
  }

  // Supplier, left; the document's facts, right.
  const supplierBottom = block(doc, PAGE.margin, PAGE.margin, CONTENT / 2 - 10, 'Supplier', [
    invoice.supplierName ?? 'ADX',
    context.supplierLegalName && context.supplierLegalName !== invoice.supplierName ? context.supplierLegalName : null,
    context.supplierAddress,
    invoice.supplierGstin ? `GSTIN: ${invoice.supplierGstin}` : null,
    context.supplierPan ? `PAN: ${context.supplierPan}` : null,
    context.supplierCin ? `CIN: ${context.supplierCin}` : null,
    invoice.supplierStateCode ? `State: ${gstStateName(invoice.supplierStateCode) ?? ''} (${invoice.supplierStateCode})` : null,
  ]);

  const factsX = PAGE.margin + CONTENT / 2 + 10;
  const factsBottom = block(doc, factsX, PAGE.margin + 36, CONTENT / 2 - 10, 'Document', [
    `Number: ${invoice.number}`,
    `Date: ${formatDate(invoice.issuedAt)}`,
    invoice.dueAt && !credit ? `Due: ${formatDate(invoice.dueAt)}` : null,
    invoice.placeOfSupply ? `Place of supply: ${invoice.placeOfSupply}` : null,
    credit && context.againstNumber ? `Against invoice: ${context.againstNumber}` : null,
    invoice.status === 'PAID' ? 'Status: PAID' : invoice.status === 'VOID' ? 'Status: VOID (see credit note)' : null,
  ]);

  let y = Math.max(supplierBottom, factsBottom) + 14;
  y = block(doc, PAGE.margin, y, CONTENT, 'Bill to', [
    invoice.recipientName,
    invoice.recipientAddress,
    invoice.recipientGstin ? `GSTIN: ${invoice.recipientGstin}` : 'Unregistered recipient',
    invoice.recipientStateCode ? `State: ${gstStateName(invoice.recipientStateCode) ?? ''} (${invoice.recipientStateCode})` : null,
  ]);
  y += 14;

  const columns: Column[] = [
    { label: '#', width: 22 },
    { label: 'Description', width: 193 },
    { label: 'SAC', width: 45 },
    { label: 'Qty', width: 45, align: 'right' },
    { label: 'Rate', width: 65, align: 'right' },
    { label: 'Taxable', width: 65, align: 'right' },
    { label: 'GST %', width: 35, align: 'right' },
    { label: 'GST', width: 45, align: 'right' },
  ];
  y = tableHeader(doc, columns, y);
  invoice.lines.forEach((line, index) => {
    const zero = new Decimal(line.taxableValue).isZero() && new Decimal(line.quantity).isZero();
    y = tableRow(doc, columns, [
      String(index + 1),
      line.description,
      line.sacCode ?? '',
      zero ? '' : new Decimal(line.quantity).toDecimalPlaces(2).toString(),
      zero ? '' : formatINR(credit ? abs(line.unitRate) : line.unitRate),
      zero ? '' : formatINR(credit ? abs(line.taxableValue) : line.taxableValue),
      zero ? '' : pct(line.gstPct),
      zero ? '' : formatINR(credit ? abs(line.gstAmount) : line.gstAmount),
    ], y);
  });

  // Totals, right-aligned under the table.
  y += 10;
  const totals: [string, Decimal][] = [['Taxable value', abs(invoice.taxableValue)]];
  const intra = !new Decimal(invoice.igst).abs().greaterThan(0);
  if (intra) {
    totals.push(['CGST', abs(invoice.cgst)], ['SGST', abs(invoice.sgst)]);
  } else {
    totals.push(['IGST', abs(invoice.igst)]);
  }
  if (!new Decimal(invoice.roundOff).isZero()) totals.push(['Round off', new Decimal(invoice.roundOff).times(credit ? -1 : 1)]);
  totals.push([credit ? 'Total credited' : 'Total', abs(invoice.total)]);

  const labelX = PAGE.margin + CONTENT - 220;
  for (const [label, value] of totals) {
    const last = label.startsWith('Total');
    doc.font(last ? 'Helvetica-Bold' : 'Helvetica').fontSize(last ? 10 : 9).fillColor('#000000');
    doc.text(label, labelX, y, { width: 120, align: 'right' });
    doc.text(rs(value), labelX + 120, y, { width: 100, align: 'right' });
    y += last ? 16 : 13;
  }

  y += 6;
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#555555').text('AMOUNT IN WORDS', PAGE.margin, y);
  doc.font('Helvetica').fontSize(9).fillColor('#000000').text(amountInWords(invoice.total), PAGE.margin, y + 11, { width: CONTENT });
  y += 32;

  if (credit) {
    doc.font('Helvetica').fontSize(8).fillColor('#555555')
      .text('This credit note reverses the invoice named above in full. The amount, where it had been paid, is returned through the refund desk.', PAGE.margin, y, { width: CONTENT });
    y += 24;
  }

  doc.font('Helvetica').fontSize(7.5).fillColor('#777777')
    .text('Computer-generated document; no signature is required. Media as described is supplied on the ADX platform; the publisher of each site is named on the campaign record.', PAGE.margin, PAGE.height - PAGE.margin - 24, { width: CONTENT, align: 'center' });

  doc.end();
  return done;
}

/* ── The publisher's payment advice ─────────────────────────────────── */

export type PaymentAdviceRow = {
  date: Date;
  listing: string;
  gross: Money;
  commission: Money;
  taxWithheld: Money;
  net: Money;
};

export type PaymentAdvice = {
  reference: string;
  period: string;
  periodLabel: string;
  supplier: { name: string; gstin: string | null; address: string | null };
  publisher: { name: string; gstin: string | null; address: string | null };
  rows: PaymentAdviceRow[];
  totals: { gross: Money; commission: Money; taxWithheld: Money; net: Money; days: number };
  wallet: { openingBalance: Money; closingBalance: Money; credits: Money; debits: Money };
  generatedAt: Date;
};

export async function renderPaymentAdvicePdf(advice: PaymentAdvice): Promise<Buffer> {
  const doc = newDoc(`Payment advice ${advice.reference}`);
  const done = collect(doc);

  doc.font('Helvetica-Bold').fontSize(16).text('PAYMENT ADVICE', PAGE.margin, PAGE.margin, { width: CONTENT, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#555555').text(advice.periodLabel, PAGE.margin, PAGE.margin + 20, { width: CONTENT, align: 'right' });

  const left = block(doc, PAGE.margin, PAGE.margin, CONTENT / 2 - 10, 'From', [
    advice.supplier.name,
    advice.supplier.address,
    advice.supplier.gstin ? `GSTIN: ${advice.supplier.gstin}` : null,
  ]);
  const right = block(doc, PAGE.margin + CONTENT / 2 + 10, PAGE.margin + 36, CONTENT / 2 - 10, 'Advice', [
    `Reference: ${advice.reference}`,
    `Period: ${advice.period}`,
    `Generated: ${formatDate(advice.generatedAt)}`,
  ]);
  let y = Math.max(left, right) + 14;
  y = block(doc, PAGE.margin, y, CONTENT, 'Publisher', [
    advice.publisher.name,
    advice.publisher.address,
    advice.publisher.gstin ? `GSTIN: ${advice.publisher.gstin}` : 'GSTIN not on record',
  ]);
  y += 14;

  const columns: Column[] = [
    { label: 'Date', width: 65 },
    { label: 'Site', width: 190 },
    { label: 'Gross', width: 65, align: 'right' },
    { label: 'Commission', width: 65, align: 'right' },
    { label: 'TDS', width: 65, align: 'right' },
    { label: 'Net credited', width: 65, align: 'right' },
  ];
  y = tableHeader(doc, columns, y);
  for (const row of advice.rows) {
    y = tableRow(doc, columns, [
      formatDate(row.date),
      row.listing,
      formatINR(row.gross),
      formatINR(row.commission),
      formatINR(row.taxWithheld),
      formatINR(row.net),
    ], y);
  }
  y = tableRow(doc, columns, [
    '',
    `Total — ${advice.totals.days} day${advice.totals.days === 1 ? '' : 's'}`,
    formatINR(advice.totals.gross),
    formatINR(advice.totals.commission),
    formatINR(advice.totals.taxWithheld),
    formatINR(advice.totals.net),
  ], y, true);

  y += 14;
  const labelX = PAGE.margin + CONTENT - 240;
  const walletLines: [string, Money][] = [
    ['Wallet opening balance', advice.wallet.openingBalance],
    ['Credits in the period', advice.wallet.credits],
    ['Debits in the period', advice.wallet.debits],
    ['Wallet closing balance', advice.wallet.closingBalance],
  ];
  for (const [label, value] of walletLines) {
    const last = label.startsWith('Wallet closing');
    doc.font(last ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#000000');
    doc.text(label, labelX, y, { width: 140, align: 'right' });
    doc.text(rs(value), labelX + 140, y, { width: 100, align: 'right' });
    y += 13;
  }

  y += 10;
  doc.font('Helvetica').fontSize(8).fillColor('#555555').text(
    'This advice lists the amounts credited to your ADX wallet for the days your sites ran, after ADX commission and any tax withheld at source. It is not a tax invoice. If you are registered for GST, upload your invoice to ADX for this period from the Statements screen so ADX can claim the input credit.',
    PAGE.margin, y, { width: CONTENT },
  );

  doc.font('Helvetica').fontSize(7.5).fillColor('#777777')
    .text('Computer-generated document; no signature is required.', PAGE.margin, PAGE.height - PAGE.margin - 16, { width: CONTENT, align: 'center' });

  doc.end();
  return done;
}

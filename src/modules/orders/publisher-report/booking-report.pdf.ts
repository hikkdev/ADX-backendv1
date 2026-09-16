import PDFDocument from 'pdfkit';
import { Decimal, type Money } from '../../../shared/money';
import type { PhotoBytes } from './photo-bytes';

/**
 * The paper — G6 (Q110): A4, pdfkit, Helvetica, the way the invoices are
 * drawn. Helvetica has no rupee glyph, so money prints as "Rs.". Everything
 * here is drawing; what goes on the page is decided in the service.
 */

export type BookingReportData = {
  generatedAt: Date;
  orderId: string;
  publisher: { name: string; displayId: string | null };
  spot: { title: string; displayId: string | null; address: string; city: string | null };
  campaign: { name: string; reference: string; status: string } | null;
  flight: { start: Date | null; end: Date | null; days: number | null; quantity: number };
  order: { status: string; installBy: string | null; agentName: string | null };
  milestones: { title: string; status: string; at: Date | null; note: string | null }[];
  photos: { label: string; capturedAt: Date | null; bytes: PhotoBytes }[];
  earnings: {
    daysAccrued: number;
    daysTotal: number | null;
    gross: Money;
    commission: Money;
    taxWithheld: Money;
    net: Money;
    cleared: Money;
    held: Money;
    /** NOT_ACCRUED — nothing has run; ACCRUING — some days posted, more to come; ACCRUED — every day of the flight is on the books. */
    status: 'NOT_ACCRUED' | 'ACCRUING' | 'ACCRUED';
    /** NOT_POSTED / PARTLY_POSTED / POSTED — whether the accrued days have reached the wallet ledger. */
    ledger: 'NOT_POSTED' | 'PARTLY_POSTED' | 'POSTED';
  };
};

const PAGE = { width: 595.28, height: 841.89, margin: 40 };
const CONTENT = PAGE.width - PAGE.margin * 2;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 12,34,506.50 — Indian grouping. */
export function formatINR(value: Money | number | Decimal): string {
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

const rs = (value: Money | number | Decimal): string => `Rs. ${formatINR(value)}`;

/** "12 Sep 2026", Indian time. */
export function formatDate(date: Date | null | undefined): string {
  if (!date) return '—';
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

/** "12 Sep 2026, 14:05", Indian time. */
export function formatDateTime(date: Date | null | undefined): string {
  if (!date) return '—';
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${formatDate(date)}, ${hh}:${mm}`;
}

const label = (value: string): string => value.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

type Doc = InstanceType<typeof PDFDocument>;

function collect(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function ensureRoom(doc: Doc, y: number, needed: number): number {
  if (y + needed <= PAGE.height - PAGE.margin) return y;
  doc.addPage();
  return PAGE.margin;
}

function heading(doc: Doc, y: number, text: string): number {
  y = ensureRoom(doc, y, 30);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text(text, PAGE.margin, y);
  doc.moveTo(PAGE.margin, y + 15).lineTo(PAGE.margin + CONTENT, y + 15).lineWidth(0.5).strokeColor('#999999').stroke();
  return y + 22;
}

function pair(doc: Doc, y: number, key: string, value: string): number {
  y = ensureRoom(doc, y, 14);
  doc.font('Helvetica').fontSize(9).fillColor('#555555').text(key, PAGE.margin, y, { width: 130 });
  doc.fillColor('#000000').text(value, PAGE.margin + 135, y, { width: CONTENT - 135 });
  return y + Math.max(13, doc.heightOfString(value, { width: CONTENT - 135 }) + 3);
}

export async function renderBookingReportPdf(data: BookingReportData): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE.margin,
    info: { Title: `ADX booking report ${data.orderId}`, Author: 'ADX', Creator: 'ADX platform' },
  });
  const done = collect(doc);
  let y = PAGE.margin;

  doc.font('Helvetica-Bold').fontSize(18).text('ADX', PAGE.margin, y);
  doc.font('Helvetica').fontSize(9).fillColor('#555555').text(`Booking report · generated ${formatDateTime(data.generatedAt)}`, PAGE.margin, y + 22);
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(14).text('Booking report', PAGE.margin, y, { width: CONTENT, align: 'right' });
  doc.font('Helvetica').fontSize(9).text(`Order ${data.orderId}`, PAGE.margin, y + 20, { width: CONTENT, align: 'right' });
  y += 48;

  y = heading(doc, y, 'The spot');
  y = pair(doc, y, 'Publisher', data.publisher.displayId ? `${data.publisher.name} (${data.publisher.displayId})` : data.publisher.name);
  y = pair(doc, y, 'Spot', data.spot.displayId ? `${data.spot.title} (${data.spot.displayId})` : data.spot.title);
  y = pair(doc, y, 'Address', [data.spot.address, data.spot.city].filter(Boolean).join(', '));
  y += 6;

  y = heading(doc, y, 'The campaign');
  y = pair(doc, y, 'Campaign', data.campaign ? `${data.campaign.name} (${data.campaign.reference})` : '—');
  if (data.campaign) y = pair(doc, y, 'Campaign status', label(data.campaign.status));
  y = pair(doc, y, 'Flight', `${formatDate(data.flight.start)} to ${formatDate(data.flight.end)}${data.flight.days ? ` · ${data.flight.days} day${data.flight.days === 1 ? '' : 's'}` : ''}${data.flight.quantity > 1 ? ` · ${data.flight.quantity} faces` : ''}`);
  y = pair(doc, y, 'Booking status', label(data.order.status));
  y = pair(doc, y, 'Installed by', data.order.installBy ? (data.order.installBy === 'PUBLISHER' ? 'The publisher' : `ADX agent${data.order.agentName ? ` · ${data.order.agentName}` : ''}`) : '—');
  y += 6;

  y = heading(doc, y, 'Milestones');
  if (data.milestones.length === 0) {
    y = pair(doc, y, '—', 'No milestones were recorded on this booking.');
  }
  for (const milestone of data.milestones) {
    y = ensureRoom(doc, y, 14);
    doc.font('Helvetica').fontSize(9).fillColor('#000000').text(milestone.title, PAGE.margin, y, { width: 220 });
    doc.fillColor('#555555').text(label(milestone.status), PAGE.margin + 225, y, { width: 90 });
    doc.fillColor('#000000').text(milestone.at ? formatDateTime(milestone.at) : '—', PAGE.margin + 320, y, { width: 140 });
    y += 13;
    if (milestone.note) {
      doc.fontSize(8).fillColor('#555555').text(milestone.note, PAGE.margin + 10, y, { width: CONTENT - 10 });
      y += 11;
    }
  }
  y += 6;

  y = heading(doc, y, 'Proof photos');
  if (data.photos.length === 0) {
    y = pair(doc, y, '—', 'No photos were attached to this booking.');
  } else {
    const thumb = 120;
    const gap = 12;
    const perRow = Math.floor((CONTENT + gap) / (thumb + gap));
    let column = 0;
    for (const photo of data.photos) {
      if (column === 0) y = ensureRoom(doc, y, thumb + 30);
      const x = PAGE.margin + column * (thumb + gap);
      if (photo.bytes) {
        try {
          doc.image(photo.bytes.data, x, y, { fit: [thumb, thumb], align: 'center', valign: 'center' });
        } catch {
          doc.rect(x, y, thumb, thumb).lineWidth(0.5).strokeColor('#bbbbbb').stroke();
          doc.font('Helvetica').fontSize(8).fillColor('#777777').text('Photo could not be drawn', x + 6, y + thumb / 2 - 5, { width: thumb - 12, align: 'center' });
        }
      } else {
        doc.rect(x, y, thumb, thumb).lineWidth(0.5).strokeColor('#bbbbbb').stroke();
        doc.font('Helvetica').fontSize(8).fillColor('#777777').text('Photo not available', x + 6, y + thumb / 2 - 5, { width: thumb - 12, align: 'center' });
      }
      doc.font('Helvetica').fontSize(8).fillColor('#000000').text(photo.label, x, y + thumb + 3, { width: thumb });
      doc.fillColor('#555555').text(photo.capturedAt ? formatDateTime(photo.capturedAt) : '', x, y + thumb + 13, { width: thumb });
      column += 1;
      if (column >= perRow) {
        column = 0;
        y += thumb + 30;
      }
    }
    if (column !== 0) y += thumb + 30;
  }
  y += 6;

  y = heading(doc, y, 'Earnings');
  const e = data.earnings;
  y = pair(doc, y, 'Days accrued', e.daysTotal ? `${e.daysAccrued} of ${e.daysTotal}` : String(e.daysAccrued));
  y = pair(doc, y, 'Gross', rs(e.gross));
  y = pair(doc, y, 'ADX commission', `- ${rs(e.commission)}`);
  if (new Decimal(e.taxWithheld).greaterThan(0)) y = pair(doc, y, 'Tax withheld', `- ${rs(e.taxWithheld)}`);
  doc.font('Helvetica-Bold');
  y = pair(doc, y, 'Net to you', rs(e.net));
  doc.font('Helvetica');
  y = pair(doc, y, 'Cleared / held', `${rs(e.cleared)} withdrawable · ${rs(e.held)} clearing`);
  y = pair(doc, y, 'Accrual', label(e.status));
  y = pair(doc, y, 'Ledger', label(e.ledger));

  y = ensureRoom(doc, y + 18, 30);
  doc.font('Helvetica').fontSize(7.5).fillColor('#777777').text(
    'Figures are as recorded on the ADX ledger at the time this report was generated. Money is in Indian rupees. Times are Indian Standard Time. This is a record for the publisher, not a tax document; the monthly payment advice is the statement of account.',
    PAGE.margin,
    y,
    { width: CONTENT },
  );

  doc.end();
  return done;
}

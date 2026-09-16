import PDFDocument from 'pdfkit';
import { formatCsv } from '../../shared/csv';
import type { ReportColumn, ReportRow } from './catalogue';

/**
 * The two renderings of a report — Lot G (Q129).
 *
 * CSV is the header row of labels and one line per row, RFC 4180 through
 * `shared/csv`, for a spreadsheet. PDF is pdfkit on landscape A4: a title,
 * the window, then the table — the header repeated on every page, a page
 * number in the footer, and cells clipped to their column so a long name
 * never pushes the table off the paper. Both render to a Buffer; where it
 * goes afterwards is the service's business.
 */

export type RenderedReport = { buffer: Buffer; mimeType: string; extension: 'csv' | 'pdf' };

export function renderCsv(columns: readonly ReportColumn[], rows: readonly ReportRow[]): RenderedReport {
  const lines: (string | number | null)[][] = [columns.map((column) => column.label), ...rows.map((row) => columns.map((column) => row[column.key] ?? null))];
  return { buffer: Buffer.from(formatCsv(lines), 'utf8'), mimeType: 'text/csv; charset=utf-8', extension: 'csv' };
}

const PAGE = { width: 841.89, height: 595.28, margin: 36 };
const CONTENT = PAGE.width - PAGE.margin * 2;
const ROW_HEIGHT = 14;
const HEADER_HEIGHT = 18;
const FOOTER_SPACE = 30;

type Doc = InstanceType<typeof PDFDocument>;

function collect(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/** Wider columns for wider labels, never narrower than a date fits in. */
function widths(columns: readonly ReportColumn[]): number[] {
  const weights = columns.map((column) => Math.max(8, Math.min(28, column.label.length + 4)));
  const total = weights.reduce((sum, w) => sum + w, 0);
  return weights.map((w) => (CONTENT * w) / total);
}

function tableHeader(doc: Doc, columns: readonly ReportColumn[], cols: number[], y: number): number {
  let x = PAGE.margin;
  doc.rect(PAGE.margin, y, CONTENT, HEADER_HEIGHT).fill('#eeeeee');
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8);
  columns.forEach((column, index) => {
    const width = cols[index]!;
    doc.text(column.label, x + 3, y + 5, { width: width - 6, align: column.align ?? 'left', lineBreak: false, ellipsis: true });
    x += width;
  });
  return y + HEADER_HEIGHT;
}

function tableRow(doc: Doc, columns: readonly ReportColumn[], cols: number[], row: ReportRow, y: number, shaded: boolean): number {
  if (shaded) doc.rect(PAGE.margin, y, CONTENT, ROW_HEIGHT).fill('#f7f7f7');
  doc.fillColor('#000000').font('Helvetica').fontSize(8);
  let x = PAGE.margin;
  columns.forEach((column, index) => {
    const width = cols[index]!;
    const value = row[column.key];
    doc.text(value === null || value === undefined ? '' : String(value), x + 3, y + 3, {
      width: width - 6,
      align: column.align ?? 'left',
      lineBreak: false,
      ellipsis: true,
    });
    x += width;
  });
  return y + ROW_HEIGHT;
}

function footer(doc: Doc, page: number): void {
  doc.font('Helvetica').fontSize(7).fillColor('#666666');
  doc.text(`Page ${page}`, PAGE.margin, PAGE.height - PAGE.margin + 6, { width: CONTENT, align: 'right', lineBreak: false });
}

export async function renderPdf(input: {
  title: string;
  windowLabel: string;
  generatedAt: Date;
  columns: readonly ReportColumn[];
  rows: readonly ReportRow[];
}): Promise<RenderedReport> {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: PAGE.margin,
    info: { Title: input.title, Author: 'ADX', Creator: 'ADX platform' },
  });
  const done = collect(doc);
  const cols = widths(input.columns);
  let page = 1;

  const heading = (): number => {
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#000000').text(input.title, PAGE.margin, PAGE.margin, { width: CONTENT, lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor('#333333');
    doc.text(`Window: ${input.windowLabel}   ·   Generated ${input.generatedAt.toISOString()}   ·   ${input.rows.length} rows`, PAGE.margin, PAGE.margin + 20, {
      width: CONTENT,
      lineBreak: false,
    });
    return PAGE.margin + 40;
  };

  let y = tableHeader(doc, input.columns, cols, heading());
  const limit = PAGE.height - PAGE.margin - FOOTER_SPACE;
  if (input.rows.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666666').text('No rows in this window.', PAGE.margin + 3, y + 6, { width: CONTENT, lineBreak: false });
  }
  input.rows.forEach((row, index) => {
    if (y + ROW_HEIGHT > limit) {
      footer(doc, page);
      doc.addPage();
      page += 1;
      y = tableHeader(doc, input.columns, cols, heading());
    }
    y = tableRow(doc, input.columns, cols, row, y, index % 2 === 1);
  });
  footer(doc, page);
  doc.end();
  return { buffer: await done, mimeType: 'application/pdf', extension: 'pdf' };
}

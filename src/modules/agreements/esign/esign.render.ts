import PDFDocument from 'pdfkit';

/**
 * DS-1: the document as paper. ADX renders the PDF Digio signs from its own
 * template (Settings › Agreements stays the source of truth): the Markdown
 * body with the party's details merged in, under a plain header, with a
 * signature page at the end where the provider draws the signatures.
 *
 * A4, pdfkit, Helvetica — the same paper as the invoices. The Markdown
 * dialect is the one the templates use: `#`/`##`/`###` headings, blank-line
 * paragraphs, `-` bullets, `1.` numbered lines, `---` rules, `**bold**` as
 * emphasis. Anything else prints as text.
 */

const PAGE = { width: 595.28, height: 841.89, margin: 56 };
const CONTENT = PAGE.width - PAGE.margin * 2;

type Doc = InstanceType<typeof PDFDocument>;

function collect(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Merge fields                                                        */
/* ------------------------------------------------------------------ */

/**
 * `{{party.name}}`, `{{party.displayId}}`, `{{date}}`, `{{agent.grade}}` …
 * A field the template names and the request does not carry prints as an
 * em dash rather than the tag — a party should never see `{{`.
 */
export function mergeFields(body: string, fields: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key: string) => {
    const value = fields[key];
    return value === undefined ? '—' : value;
  });
}

/** `{{listings}}` for the publisher's licence: the schedule, one line per listing. */
export function renderListingSchedule(listings: { reference: string | null; title: string; city: string | null }[]): string {
  if (listings.length === 0) return 'Schedule A: no listings are on the platform yet; every listing the publisher lists is covered by this licence from the day it is approved.';
  return ['Schedule A — the spaces licensed', '', ...listings.map((l, i) => `${i + 1}. ${l.reference ? `${l.reference} — ` : ''}${l.title}${l.city ? `, ${l.city}` : ''}`)].join('\n');
}

/* ------------------------------------------------------------------ */
/* Markdown → paper                                                    */
/* ------------------------------------------------------------------ */

type Line = { kind: 'h1' | 'h2' | 'h3' | 'p' | 'bullet' | 'number' | 'rule' | 'blank'; text: string; marker?: string };

function parse(markdown: string): Line[] {
  const out: Line[] = [];
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (trimmed === '') {
      out.push({ kind: 'blank', text: '' });
      continue;
    }
    if (/^---+$|^\*\*\*+$/.test(trimmed)) {
      out.push({ kind: 'rule', text: '' });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      out.push({ kind: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3', text: heading[2]! });
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      out.push({ kind: 'bullet', text: bullet[1]! });
      continue;
    }
    const numbered = /^(\d+[.)])\s+(.*)$/.exec(trimmed);
    if (numbered) {
      out.push({ kind: 'number', text: numbered[2]!, marker: numbered[1]! });
      continue;
    }
    out.push({ kind: 'p', text: trimmed });
  }
  return out;
}

/** Runs of `**bold**` become bold runs; everything else prints as it is. */
function runs(text: string): { text: string; bold: boolean }[] {
  const parts: { text: string; bold: boolean }[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), bold: false });
    parts.push({ text: match[1]!, bold: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bold: false });
  return parts.length > 0 ? parts : [{ text, bold: false }];
}

function paragraph(doc: Doc, text: string, options: { indent?: number; size?: number } = {}): void {
  const indent = options.indent ?? 0;
  const size = options.size ?? 10.5;
  const parts = runs(text.replace(/\*([^*]+)\*/g, '$1').replace(/`([^`]+)`/g, '$1'));
  doc.fontSize(size);
  parts.forEach((part, index) => {
    doc.font(part.bold ? 'Helvetica-Bold' : 'Helvetica').text(part.text, PAGE.margin + indent, undefined, {
      width: CONTENT - indent,
      continued: index < parts.length - 1,
      lineGap: 3,
    });
  });
  doc.moveDown(0.6);
}

export type DocumentHeader = {
  title: string;
  kindLabel: string;
  version: number;
  reference: string;
  partyName: string;
  partyDisplayId: string | null;
  date: string;
  /** Under the title: "Insertion order for campaign CMP-…", say. Optional. */
  subtitle?: string | null;
};

/**
 * The paper: a header block, the merged body, a signature page. Pure in the
 * sense that the same inputs give the same document.
 */
export async function renderAgreementPdf(header: DocumentHeader, markdown: string, signers: { role: 'PARTY' | 'ADX'; name: string }[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin, info: { Title: header.title, Author: 'ADX' } });
  const done = collect(doc);

  // Header
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#E40209').text('ADX', PAGE.margin, PAGE.margin - 16);
  doc.fillColor('#000000');
  doc.font('Helvetica-Bold').fontSize(18).text(header.title, PAGE.margin, PAGE.margin + 4, { width: CONTENT });
  if (header.subtitle) doc.font('Helvetica').fontSize(11).fillColor('#444444').text(header.subtitle, { width: CONTENT });
  doc.fillColor('#000000');
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(9).fillColor('#555555');
  doc.text(`${header.kindLabel} · version ${header.version} · reference ${header.reference}`, { width: CONTENT });
  doc.text(`Between ADX (Keysquare Technologies) and ${header.partyName}${header.partyDisplayId ? ` (${header.partyDisplayId})` : ''} · ${header.date}`, { width: CONTENT });
  doc.fillColor('#000000');
  doc.moveDown(0.3);
  doc.moveTo(PAGE.margin, doc.y).lineTo(PAGE.width - PAGE.margin, doc.y).lineWidth(0.6).strokeColor('#BBBBBB').stroke();
  doc.strokeColor('#000000');
  doc.moveDown(0.8);

  // Body
  let lastBlank = true;
  for (const line of parse(markdown)) {
    if (doc.y > PAGE.height - PAGE.margin - 40) doc.addPage();
    switch (line.kind) {
      case 'blank':
        if (!lastBlank) doc.moveDown(0.2);
        break;
      case 'rule':
        doc.moveTo(PAGE.margin, doc.y).lineTo(PAGE.width - PAGE.margin, doc.y).lineWidth(0.5).strokeColor('#BBBBBB').stroke();
        doc.strokeColor('#000000');
        doc.moveDown(0.8);
        break;
      case 'h1':
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(15).text(line.text, PAGE.margin, undefined, { width: CONTENT });
        doc.moveDown(0.5);
        break;
      case 'h2':
        doc.moveDown(0.2);
        doc.font('Helvetica-Bold').fontSize(12.5).text(line.text, PAGE.margin, undefined, { width: CONTENT });
        doc.moveDown(0.4);
        break;
      case 'h3':
        doc.font('Helvetica-Bold').fontSize(11).text(line.text, PAGE.margin, undefined, { width: CONTENT });
        doc.moveDown(0.3);
        break;
      case 'bullet': {
        const y = doc.y;
        doc.font('Helvetica').fontSize(10.5).text('•', PAGE.margin + 6, y, { width: 12, lineBreak: false });
        doc.y = y;
        paragraph(doc, line.text, { indent: 20 });
        break;
      }
      case 'number': {
        const y = doc.y;
        doc.font('Helvetica').fontSize(10.5).text(line.marker ?? '', PAGE.margin + 2, y, { width: 22, lineBreak: false });
        doc.y = y;
        paragraph(doc, line.text, { indent: 26 });
        break;
      }
      default:
        paragraph(doc, line.text);
    }
    lastBlank = line.kind === 'blank';
  }

  // Signature page
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(13).text('Signatures', PAGE.margin, PAGE.margin, { width: CONTENT });
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(10).fillColor('#444444').text('This document is signed electronically. Each signature below is affixed through Digio with the signer\'s identity verified as the method states; the audit certificate records who signed, when and from where.', { width: CONTENT });
  doc.fillColor('#000000');
  doc.moveDown(1.5);
  for (const signer of signers) {
    doc.font('Helvetica-Bold').fontSize(10.5).text(signer.role === 'ADX' ? 'For ADX (Keysquare Technologies)' : `For ${header.partyName}`, { width: CONTENT });
    doc.font('Helvetica').fontSize(10).text(signer.name, { width: CONTENT });
    doc.moveDown(2.2);
    doc.moveTo(PAGE.margin, doc.y).lineTo(PAGE.margin + 240, doc.y).lineWidth(0.6).strokeColor('#888888').stroke();
    doc.strokeColor('#000000');
    doc.fontSize(8.5).fillColor('#777777').text('Signature', PAGE.margin, doc.y + 3);
    doc.fillColor('#000000');
    doc.moveDown(2.5);
  }

  doc.end();
  return done;
}

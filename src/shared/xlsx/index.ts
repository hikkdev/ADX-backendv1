import * as cheerio from 'cheerio';
import { readZip } from '../zip';

/**
 * XLSX, read by hand — 26 Sep 2026 (the bulk listing upload).
 *
 * The apps and the website promise "CSV or XLSX" for a publisher's bulk
 * listing file, and the build has no spreadsheet library. An .xlsx is a zip
 * of XML parts, and the tree already holds both halves: `shared/zip`'s
 * `readZip` (DEFLATE and STORED entries, the central directory walked) and
 * `cheerio` in XML mode. What this reads is the FIRST worksheet in the
 * workbook's own order, as rows of cells — the same `string[][]` that
 * `parseCsv` answers, so an importer takes either file through one door.
 *
 * What a cell becomes: a shared or inline string its text; a number its
 * decimal at Excel's own fifteen significant digits (so the stored
 * 1234.5600000000001 reads 1234.56, as the cell shows it); a number formatted as a date (the built-in date formats, or a
 * custom code with a day or a year in it) an ISO date `YYYY-MM-DD`; a
 * boolean `TRUE`/`FALSE`; a formula its cached value; an error cell empty.
 * A cell the sheet skips is an empty string, so columns keep their places.
 * No macros, no ZIP64, no .xls (the binary format) — those are refused.
 */

export class XlsxError extends Error {}

/** Excel's built-in number formats that are dates (ECMA-376 §18.8.30). */
const BUILT_IN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** The Excel serial day 0, in the 1900 system (with Lotus's phantom 29 Feb 1900 folded in). */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/** An XLSX is a zip: it starts with the local-header signature `PK\x03\x04`. */
export function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

/** `B12` → 1 (zero-based column index). */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0]?.toUpperCase() ?? '';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function isDateFormatCode(code: string): boolean {
  // Strip quoted literals, escapes and colour/condition brackets before looking for date tokens.
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  return /[dy]/i.test(bare);
}

function serialToIsoDate(serial: number): string {
  return new Date(EXCEL_EPOCH_MS + Math.round(serial * 86_400_000)).toISOString().slice(0, 10);
}

function normalisePath(target: string): string {
  const cleaned = target.replace(/^\/+/, '');
  return cleaned.startsWith('xl/') ? cleaned : `xl/${cleaned}`;
}

/** The first worksheet as rows of cells. Throws `XlsxError` for a file that is not a readable workbook. */
export function readXlsxRows(buffer: Buffer): string[][] {
  let parts: Map<string, Buffer>;
  try {
    parts = new Map(readZip(buffer).map((entry) => [entry.name, entry.data]));
  } catch {
    throw new XlsxError('The file is not a readable .xlsx workbook');
  }
  const xml = (name: string) => {
    const data = parts.get(name);
    return data ? cheerio.load(data.toString('utf8'), { xml: true }) : null;
  };

  const workbook = xml('xl/workbook.xml');
  if (!workbook) throw new XlsxError('The file is not a readable .xlsx workbook');

  // The first sheet in the workbook's order, through its relationship.
  const firstSheet = workbook('sheets > sheet').first();
  const relId = firstSheet.attr('r:id') ?? firstSheet.attr('id');
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const rels = xml('xl/_rels/workbook.xml.rels');
  if (rels && relId) {
    const target = rels(`Relationship[Id="${relId}"]`).attr('Target');
    if (target) sheetPath = normalisePath(target);
  }
  const sheet = xml(sheetPath);
  if (!sheet) throw new XlsxError('The workbook has no worksheet');

  // Shared strings: every <t> of an <si>, runs included, phonetic hints left out.
  const shared: string[] = [];
  const strings = xml('xl/sharedStrings.xml');
  strings?.('sst > si').each((_, si) => {
    const item = strings(si);
    item.find('rPh').remove();
    shared.push(item.find('t').map((__, t) => strings(t).text()).get().join(''));
  });

  // Which cell styles are dates.
  const dateStyles = new Set<number>();
  const styles = xml('xl/styles.xml');
  if (styles) {
    const customDates = new Set<number>();
    styles('numFmts > numFmt').each((_, fmt) => {
      const id = Number(styles(fmt).attr('numFmtId'));
      if (isDateFormatCode(styles(fmt).attr('formatCode') ?? '')) customDates.add(id);
    });
    styles('cellXfs > xf').each((index, xf) => {
      const id = Number(styles(xf).attr('numFmtId') ?? 0);
      if (BUILT_IN_DATE_FORMATS.has(id) || customDates.has(id)) dateStyles.add(index);
    });
  }

  const rows: string[][] = [];
  sheet('sheetData > row').each((rowIndex, rowNode) => {
    const rowNumber = Number(sheet(rowNode).attr('r') ?? rowIndex + 1);
    const cells: string[] = [];
    sheet(rowNode)
      .children('c')
      .each((cellIndex, cellNode) => {
        const cell = sheet(cellNode);
        const ref = cell.attr('r');
        const column = ref ? columnIndex(ref) : cellIndex;
        const type = cell.attr('t') ?? 'n';
        const raw = cell.children('v').first().text();
        let value = '';
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = cell.find('is t').map((__, t) => sheet(t).text()).get().join('');
        else if (type === 'str') value = raw;
        else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : '';
        else if (type === 'e') value = '';
        else if (raw !== '') {
          const number = Number(raw);
          value = Number.isFinite(number) ? (dateStyles.has(Number(cell.attr('s') ?? -1)) ? serialToIsoDate(number) : String(Number(number.toPrecision(15)))) : raw;
        }
        while (cells.length < column) cells.push('');
        cells[column] = value;
      });
    // Rows the sheet skipped stay as empty rows, so a row number means the same line.
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = cells;
  });

  // A trailing run of blank rows (Excel often keeps formatted empties) is not data.
  while (rows.length > 0 && rows[rows.length - 1]!.every((cell) => cell.trim() === '')) rows.pop();
  return rows;
}

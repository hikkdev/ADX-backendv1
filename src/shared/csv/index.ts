/**
 * CSV, hand-rolled — Lot B (Q85).
 *
 * Two functions and no dependency: a bank's statement export and a bank's
 * bulk-transfer upload are both plain RFC 4180 with the usual wrinkles (a BOM,
 * CRLF, quoted fields with doubled quotes, a ragged last line), and pulling in
 * a parser for that is more surface than the problem has.
 */

/** Rows of cells. Handles quotes, doubled quotes, CRLF and a leading BOM. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // A blank trailing line is not a record.
  return rows.filter((cells) => cells.some((value) => value.trim() !== ''));
}

const needsQuoting = (value: string) => /[",\r\n]/.test(value) || value !== value.trim();

/** One cell, quoted only when it has to be. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return needsQuoting(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows to text, CRLF-terminated, which is what a bank's upload expects. */
export function formatCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

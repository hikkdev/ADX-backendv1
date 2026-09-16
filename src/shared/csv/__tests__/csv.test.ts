import { describe, expect, it } from 'vitest';
import { formatCsv, parseCsv } from '..';

describe('parseCsv', () => {
  it('reads quoted cells, doubled quotes, CRLF and a BOM', () => {
    const text = '\ufeffDate,Description,Amount\r\n01/09/2026,"NEFT, ""Sharma"" Hoardings",5000.00\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['Date', 'Description', 'Amount'],
      ['01/09/2026', 'NEFT, "Sharma" Hoardings', '5000.00'],
    ]);
  });

  it('keeps a last line with no newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('formatCsv', () => {
  it('quotes only what needs it and terminates with CRLF', () => {
    expect(formatCsv([['Name', 'Amount'], ['Sharma, Hoardings', '5000.00'], [null, 'say "hi"']])).toBe(
      'Name,Amount\r\n"Sharma, Hoardings",5000.00\r\n,"say ""hi"""\r\n'
    );
  });

  it('round-trips', () => {
    const rows = [['a', 'b,c', 'd"e'], ['1', '', ' x ']];
    expect(parseCsv(formatCsv(rows))).toEqual(rows);
  });
});

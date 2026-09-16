import { describe, expect, it } from 'vitest';
import { lineHash, parseAmount, parseDate, parseStatement, utrFromDescription } from '../csv';

/**
 * A bank's statement export into lines — Lot B (Q85). Generic CSV in: the
 * defaults read what most Indian banks export; a profile renames the columns
 * and the date format for the bank that does it differently.
 */

const HDFC = [
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '01/09/2026,NEFT DR-HDFC0001234-SHARMA HOARDINGS-WDR-2026-000118,HDFCN52026090112345678,01/09/2026,"5,000.00",,"1,20,000.00"',
  '02/09/2026,IMPS 425512345678 NILGIRI COFFEE TOP UP,425512345678,02/09/2026,,"25,000.00","1,45,000.00"',
  '03/09/2026,BANK CHARGES,,03/09/2026,118.00,,"1,44,882.00"',
].join('\n');

describe('dates and amounts', () => {
  it('reads the format tokens and returns a UTC calendar day', () => {
    expect(parseDate('01/09/2026')?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(parseDate('2026-09-01', 'yyyy-MM-dd')?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(parseDate('01-Sep-26', 'dd-MMM-yy')?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('yesterday')).toBeNull();
  });

  it('strips lakh commas, currency, parentheses and Dr/Cr', () => {
    expect(parseAmount('1,23,456.78')).toEqual({ amount: expect.objectContaining({}), side: null });
    expect(parseAmount('1,23,456.78')!.amount.toFixed(2)).toBe('123456.78');
    expect(parseAmount('₹ 500')!.amount.toFixed(2)).toBe('500.00');
    expect(parseAmount('(250.00)')).toMatchObject({ side: 'DR' });
    expect(parseAmount('1200 Cr')).toMatchObject({ side: 'CR' });
    expect(parseAmount('-75.5')).toMatchObject({ side: 'DR' });
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
  });

  it('finds a UTR inside a narration', () => {
    expect(utrFromDescription('NEFT DR-HDFC0001234-SHARMA-HDFCN52026090112345678')).toBe('HDFCN52026090112345678');
    expect(utrFromDescription('IMPS 425512345678 NILGIRI')).toBe('425512345678');
    expect(utrFromDescription('BANK CHARGES')).toBeNull();
  });
});

describe('parseStatement', () => {
  it('reads an HDFC-shaped export through a profile', () => {
    const parsed = parseStatement(HDFC, {
      columns: { date: 'Date', description: 'Narration', utr: 'Chq./Ref.No.', debit: 'Withdrawal Amt.', credit: 'Deposit Amt.', balance: 'Closing Balance' },
    });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.lines[0]).toMatchObject({
      direction: 'DEBIT',
      amount: '5000.00',
      utr: 'HDFCN52026090112345678',
      runningBalance: '120000.00',
      description: 'NEFT DR-HDFC0001234-SHARMA HOARDINGS-WDR-2026-000118',
    });
    expect(parsed.lines[1]).toMatchObject({ direction: 'CREDIT', amount: '25000.00', utr: '425512345678' });
    expect(parsed.lines[2]).toMatchObject({ direction: 'DEBIT', amount: '118.00', utr: null });
    expect(parsed.periodStart?.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(parsed.periodEnd?.toISOString().slice(0, 10)).toBe('2026-09-03');
  });

  it('uses the defaults, skips the address block above the header, and reports bad rows', () => {
    const text = [
      'Sharma Hoardings Pvt Ltd',
      'Account statement for September',
      '',
      'Date,Description,Ref No./UTR,Debit,Credit,Balance',
      '05/09/2026,NEFT OUT,UTR1,"1,000.00",,',
      'not a date,junk,,,,',
      '06/09/2026,NO MONEY,,,,',
      '07/09/2026,CASH IN,,,"2,500.00",',
    ].join('\r\n');
    const parsed = parseStatement(text);
    expect(parsed.lines.map((line) => [line.direction, line.amount])).toEqual([
      ['DEBIT', '1000.00'],
      ['CREDIT', '2500.00'],
    ]);
    // Row numbers count non-blank records, which is what the eye counts too.
    expect(parsed.problems).toEqual([
      { row: 5, problem: 'Unreadable date "not a date"' },
      { row: 6, problem: 'No amount' },
    ]);
  });

  it('reads a single signed amount column', () => {
    const text = 'Txn Date,Particulars,Amount\n01-Sep-2026,PAYOUT,-500.00\n02-Sep-2026,DEPOSIT,750 Cr\n';
    const parsed = parseStatement(text, { columns: { date: 'Txn Date', description: 'Particulars', amount: 'Amount' }, dateFormat: 'dd-MMM-yyyy' });
    expect(parsed.lines.map((line) => [line.direction, line.amount])).toEqual([
      ['DEBIT', '500.00'],
      ['CREDIT', '750.00'],
    ]);
  });

  it('names the missing header rather than reading nothing silently', () => {
    expect(parseStatement('a,b\n1,2').problems[0]!.problem).toMatch(/No header row/);
  });

  it('hashes the same line to the same value, and a different amount to a different one', () => {
    const base = { valueDate: new Date('2026-09-01T00:00:00Z'), description: 'NEFT OUT ', amount: '5000.00', direction: 'DEBIT' as const };
    expect(lineHash(base)).toBe(lineHash({ ...base, description: 'NEFT OUT' }));
    expect(lineHash(base)).not.toBe(lineHash({ ...base, amount: '5000.01' }));
  });
});

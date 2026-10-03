import { describe, expect, it } from 'vitest';
import { canonicalForm, partyLabel, planMobileFixes, type MobileRow } from '../lib/mobile-backfill';

/**
 * The mobile backfill's decisions (`npm run backfill:mobiles`).
 *
 * Pinned: a ten-digit number and a `91`-prefixed twelve-digit one are fixed
 * to `+91` and ten digits; spaces, dashes and brackets are read through; a
 * number already in the form is unchanged; on a unique column a number
 * whose `+91` form is held elsewhere, or that two rows of the run would
 * both take, is a clash and left alone — on a column that is not unique it
 * is simply fixed; a number that cannot be read is unparseable; a second
 * pass over the fixed rows has nothing to do. And the report never prints a
 * number, even when a party is named by one.
 */

const row = (id: string, mobile: string): MobileRow => ({ id, mobile });
const kinds = (plan: ReturnType<typeof planMobileFixes>) => Object.fromEntries(plan.decisions.map((decision) => [decision.row.id, decision.kind]));

describe('planMobileFixes', () => {
  it('fixes a ten-digit number and a 91-prefixed twelve-digit one to +91 and ten digits', () => {
    const plan = planMobileFixes([row('suraj', '9507842149'), row('asha', '919812345678')], { unique: true });
    expect(plan.decisions).toEqual([
      { kind: 'fix', row: row('suraj', '9507842149'), to: '+919507842149' },
      { kind: 'fix', row: row('asha', '919812345678'), to: '+919812345678' },
    ]);
    expect(plan.counts).toEqual({ unchanged: 0, fix: 2, clash: 0, unparseable: 0 });
  });

  it('leaves a number already in the form unchanged', () => {
    const plan = planMobileFixes([row('done', '+919507842149')], { unique: true });
    expect(plan.decisions).toEqual([{ kind: 'unchanged', row: row('done', '+919507842149') }]);
    expect(plan.counts).toEqual({ unchanged: 1, fix: 0, clash: 0, unparseable: 0 });
  });

  it('reads through spaces, dashes and brackets — including a spaced +91', () => {
    const plan = planMobileFixes(
      [row('a', '95078 42149'), row('b', '950-784-2148'), row('c', '(950) 784 2147'), row('d', '+91 95078 42146'), row('e', '+91-95078-42145')],
      { unique: true },
    );
    expect(plan.decisions.map((decision) => (decision.kind === 'fix' ? decision.to : decision.kind))).toEqual([
      '+919507842149',
      '+919507842148',
      '+919507842147',
      '+919507842146',
      '+919507842145',
    ]);
  });

  it('on a unique column, a +91 form another row already holds is a clash, left alone', () => {
    const plan = planMobileFixes([row('legacy', '9507842149')], { unique: true, existing: [row('signed-in', '+919507842149')] });
    expect(plan.decisions).toEqual([{ kind: 'clash', row: row('legacy', '9507842149'), to: '+919507842149', heldBy: ['signed-in'] }]);
    expect(plan.counts).toEqual({ unchanged: 0, fix: 0, clash: 1, unparseable: 0 });
  });

  it('on a column that is not unique, the same number is simply fixed', () => {
    const plan = planMobileFixes([row('shop-2', '9507842149')], { unique: false, existing: [row('shop-1', '+919507842149')] });
    expect(plan.decisions).toEqual([{ kind: 'fix', row: row('shop-2', '9507842149'), to: '+919507842149' }]);
  });

  it('two rows of one run that would take the same +91 form both clash on a unique column', () => {
    const rows = [row('typed', '9507842149'), row('prefixed', '91 9507842149')];
    const unique = planMobileFixes(rows, { unique: true });
    expect(unique.decisions).toEqual([
      { kind: 'clash', row: rows[0], to: '+919507842149', heldBy: ['prefixed'] },
      { kind: 'clash', row: rows[1], to: '+919507842149', heldBy: ['typed'] },
    ]);
    expect(kinds(planMobileFixes(rows, { unique: false }))).toEqual({ typed: 'fix', prefixed: 'fix' });
  });

  it('a row in the whole table passed as existing does not clash with itself', () => {
    const table = [row('legacy', '9507842149'), row('other', '+919812345678')];
    const plan = planMobileFixes(table, { unique: true, existing: table });
    expect(kinds(plan)).toEqual({ legacy: 'fix', other: 'unchanged' });
  });

  it('a number normalizeMobile cannot make canonical is unparseable, left alone', () => {
    const plan = planMobileFixes([row('short', '12345'), row('foreign', '+1 415 555 0100'), row('uk', '447700900123'), row('empty', '')], { unique: true });
    expect(kinds(plan)).toEqual({ short: 'unparseable', foreign: 'unparseable', uk: 'unparseable', empty: 'unparseable' });
    expect(plan.counts).toEqual({ unchanged: 0, fix: 0, clash: 0, unparseable: 4 });
  });

  it('is idempotent: once the fixes are written, a second pass has nothing to do', () => {
    const table = [row('a', '9507842149'), row('b', '919812345678'), row('c', '+91 98765 43210'), row('d', '+919000000001'), row('e', '12345'), row('f', '9000000001')];
    const first = planMobileFixes(table, { unique: true, existing: table });
    expect(first.counts).toEqual({ unchanged: 1, fix: 3, clash: 1, unparseable: 1 });

    const written = table.map((stored) => {
      const decision = first.decisions.find((candidate) => candidate.row.id === stored.id)!;
      return decision.kind === 'fix' ? { ...stored, mobile: decision.to } : stored;
    });
    const second = planMobileFixes(written, { unique: true, existing: written });
    expect(second.counts).toEqual({ unchanged: 4, fix: 0, clash: 1, unparseable: 1 });
    // What was left for a person is still left for a person, unchanged.
    expect(second.decisions.find((decision) => decision.row.id === 'f')).toMatchObject({ kind: 'clash', heldBy: ['d'] });
  });
});

describe('canonicalForm', () => {
  it('is the +91 form, or null when there is none', () => {
    expect(canonicalForm('9507842149')).toBe('+919507842149');
    expect(canonicalForm('+919507842149')).toBe('+919507842149');
    expect(canonicalForm('12345')).toBeNull();
  });
});

describe('partyLabel', () => {
  it('names a party by its name and display id', () => {
    expect(partyLabel('Suraj Kumar Prints', 'PUB-1909-2601')).toBe('Suraj Kumar Prints (PUB-1909-2601)');
    expect(partyLabel('Shop No. 12', null)).toBe('Shop No. 12 (no display id)');
    expect(partyLabel(null, 'ADX-1909-2601')).toBe('(no name) (ADX-1909-2601)');
  });

  it('never prints a number, even for a party still named by one', () => {
    expect(partyLabel('9507842149', 'PUB-1909-2601')).toBe('(named by its number) (PUB-1909-2601)');
    expect(partyLabel('+91 95078 42149', null)).toBe('(named by its number) (no display id)');
    expect(partyLabel('Ravi 95078-42149', 'ADV-1909-2601')).toBe('Ravi [number] (ADV-1909-2601)');
  });
});

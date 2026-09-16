import { describe, expect, it } from 'vitest';
import { Decimal } from '../../money';
import { auditDiff } from '../audit-diff';

describe('auditDiff', () => {
  it('reports only the named fields that changed, before and after', () => {
    const before = { status: 'PENDING', amount: '10.00', note: 'same', ignored: 1 };
    const after = { status: 'APPROVED', amount: '10.00', note: 'same', ignored: 2 };
    expect(auditDiff(before, after, ['status', 'amount', 'note'])).toEqual({
      status: { before: 'PENDING', after: 'APPROVED' },
    });
  });

  /* Money is a decimal string end to end; a Decimal in the row must not land in JSON as an object. */
  it('stringifies Decimals and compares them by value', () => {
    const before = { balance: new Decimal('100.50'), cap: new Decimal('5') };
    const after = { balance: new Decimal('120'), cap: new Decimal('5.00') };
    expect(auditDiff(before, after, ['balance', 'cap'])).toEqual({
      balance: { before: '100.5', after: '120' },
    });
  });

  it('writes dates as ISO strings and missing values as null', () => {
    const before = { verifiedAt: null, name: undefined };
    const after = { verifiedAt: new Date('2026-09-11T10:00:00Z'), name: 'Asha' };
    expect(auditDiff(before, after, ['verifiedAt', 'name'])).toEqual({
      verifiedAt: { before: null, after: '2026-09-11T10:00:00.000Z' },
      name: { before: null, after: 'Asha' },
    });
  });

  /*
   * The audit log is readable by every admin. A password rotation must be
   * visible as an event without the log becoming the place the hashes live.
   */
  it('masks fields whose key names a secret, but still records that they changed', () => {
    const before = { passwordHash: 'old', apiToken: 'abc', otpCode: '1111', webhookSecret: 's1', name: 'x' };
    const after = { passwordHash: 'new', apiToken: 'abc', otpCode: '2222', webhookSecret: 's2', name: 'x' };
    expect(auditDiff(before, after, ['passwordHash', 'apiToken', 'otpCode', 'webhookSecret', 'name'])).toEqual({
      passwordHash: { before: '[REDACTED]', after: '[REDACTED]' },
      otpCode: { before: '[REDACTED]', after: '[REDACTED]' },
      webhookSecret: { before: '[REDACTED]', after: '[REDACTED]' },
    });
  });

  it('compares nested values structurally', () => {
    const before = { meta: { a: 1, b: [1, 2] } };
    const after = { meta: { a: 1, b: [1, 2] } };
    expect(auditDiff(before, after, ['meta'])).toEqual({});
    expect(auditDiff(before, { meta: { a: 1, b: [1, 3] } }, ['meta'])).toEqual({
      meta: { before: { a: 1, b: [1, 2] }, after: { a: 1, b: [1, 3] } },
    });
  });

  it('diffs every key of both objects when no field list is given', () => {
    expect(auditDiff({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })).toEqual({
      b: { before: 2, after: 3 },
      c: { before: null, after: 4 },
    });
  });
});

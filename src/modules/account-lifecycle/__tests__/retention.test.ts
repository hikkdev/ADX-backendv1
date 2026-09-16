import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION_YEARS,
  dueAtFor,
  erasedMobile,
  financialYearEnd,
  hashMobile,
  retainUntilFor,
} from '../erasure/retention';

/**
 * The retention date is the one number in this feature somebody will be asked
 * to justify years from now, so it is pinned here rather than trusted.
 *
 * The Indian financial year runs 1 April to 31 March. "Eight years" means
 * eight whole financial years from the end of the one the erasure completed
 * in — not eight years from a Tuesday in September.
 */

describe('financialYearEnd', () => {
  it('puts an April date in the year that ends next March', () => {
    // 2 April 2026 IST is FY 2026-27, which ends 31 March 2027. 23:59:59.999
    // IST on that day is 18:29:59.999 UTC.
    expect(financialYearEnd(new Date('2026-04-02T00:00:00+05:30')).toISOString()).toBe(
      '2027-03-31T18:29:59.999Z',
    );
  });

  it('puts a February date in the year that ends this March', () => {
    expect(financialYearEnd(new Date('2026-02-10T00:00:00+05:30')).toISOString()).toBe(
      '2026-03-31T18:29:59.999Z',
    );
  });

  it('reads the boundary in IST, not in UTC', () => {
    // 31 March 2026 at 23:00 IST is still FY 2025-26; the same instant in UTC
    // is 17:30 on the 31st, which a UTC reading would also get right — so the
    // case that matters is the other side of midnight.
    const justAfter = new Date('2026-04-01T00:30:00+05:30');
    expect(financialYearEnd(justAfter).toISOString()).toBe('2027-03-31T18:29:59.999Z');

    const justBefore = new Date('2026-03-31T23:30:00+05:30');
    expect(financialYearEnd(justBefore).toISOString()).toBe('2026-03-31T18:29:59.999Z');
  });
});

describe('retainUntilFor', () => {
  it('adds whole financial years to the end of the one it completed in', () => {
    const completedAt = new Date('2026-09-12T10:00:00+05:30');
    // FY 2026-27 ends 31 March 2027; eight more years is 31 March 2035.
    expect(retainUntilFor(completedAt, 8).toISOString()).toBe('2035-03-31T18:29:59.999Z');
  });

  it('defaults to the Companies Act window when nothing says otherwise', () => {
    expect(DEFAULT_RETENTION_YEARS).toBe(8);
    const completedAt = new Date('2026-09-12T10:00:00+05:30');
    expect(retainUntilFor(completedAt).toISOString()).toBe(
      retainUntilFor(completedAt, 8).toISOString(),
    );
  });

  it('is always later than the erasure itself', () => {
    for (const iso of ['2026-01-01', '2026-03-31', '2026-04-01', '2026-12-31']) {
      const at = new Date(`${iso}T12:00:00+05:30`);
      expect(retainUntilFor(at, 1).getTime()).toBeGreaterThan(at.getTime());
    }
  });
});

describe('dueAtFor', () => {
  it('is thirty days after the ask', () => {
    const requestedAt = new Date('2026-09-12T00:00:00Z');
    expect(dueAtFor(requestedAt).toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });
});

describe('the tombstone', () => {
  it('hashes the number rather than keeping it', () => {
    const hash = hashMobile('+919876543210');
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain('9876543210');
    expect(hashMobile('+919876543210')).toBe(hash);
    expect(hashMobile('+919876543211')).not.toBe(hash);
  });

  it('derives the replacement number from the hash, so uniqueness survives', () => {
    expect(erasedMobile('+919876543210')).toMatch(/^erased:[0-9a-f]{16}$/);
    expect(erasedMobile('+919876543210')).not.toBe(erasedMobile('+919876543211'));
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * PC-1 — promo codes.
 *
 * What is pinned: the two pure rules — `discountFor` (percent or flat, the
 * cap, never more than the base, to the paisa) and `promoProblem` (off,
 * not yet, expired, used up, the advertiser's own limit, the minimum
 * spend) — and the desk: a code is upper-cased and de-spaced, a duplicate
 * is 409, a percent above 100 or a window that ends before it starts is
 * 400, the money goes out as strings, and every write is audited.
 */
const { repository, audit } = vi.hoisted(() => ({
  repository: {
    list: vi.fn(),
    findById: vi.fn(),
    findByCode: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    countRedemptions: vi.fn(),
    upsertRedemption: vi.fn(),
    releaseRedemption: vi.fn(),
    listRedemptions: vi.fn(),
  },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn((before: unknown, after: unknown) => ({ before, after })) },
}));

vi.mock('../prisma-promo-codes.repository', () => ({ prismaPromoCodesRepository: repository }));
vi.mock('../../../shared/audit', () => audit);

import { createPromoCode, discountFor, findPromoByCode, normaliseCode, promoProblem, updatePromoCode } from '../promo-codes.service';

const NOW = new Date('2026-10-12T10:00:00Z');
const promo = (over: Record<string, unknown> = {}) => ({
  id: 'promo_1',
  code: 'FESTIVE20',
  description: 'Festive launch',
  kind: 'PERCENT' as const,
  value: new Decimal('20'),
  maxDiscount: new Decimal('5000'),
  minSpend: new Decimal('10000'),
  startsAt: new Date('2026-10-01T00:00:00Z'),
  endsAt: new Date('2026-11-01T00:00:00Z'),
  usageLimit: 100,
  perAdvertiserLimit: 1,
  isActive: true,
  createdById: 'usr_admin',
  createdAt: NOW,
  updatedAt: NOW,
  _count: { redemptions: 3 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findByCode.mockResolvedValue(null);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => promo({ ...data, _count: { redemptions: 0 } }));
  repository.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => promo(patch));
  audit.logActivity.mockResolvedValue(undefined);
});

describe('normaliseCode', () => {
  it('upper-cases and drops spaces, so "festive 20" is FESTIVE20', () => {
    expect(normaliseCode('  festive 20 ')).toBe('FESTIVE20');
    expect(normaliseCode('Diwali-25')).toBe('DIWALI-25');
  });

  it('looks a code up normalised, and an empty one up not at all', async () => {
    repository.findByCode.mockResolvedValue(promo());
    await expect(findPromoByCode(' festive20 ')).resolves.toMatchObject({ code: 'FESTIVE20' });
    expect(repository.findByCode).toHaveBeenCalledWith('FESTIVE20');
    await expect(findPromoByCode('   ')).resolves.toBeNull();
  });
});

describe('discountFor', () => {
  it('a percent of the base, capped, to the paisa', () => {
    expect(discountFor(promo(), new Decimal('21600')).toFixed(2)).toBe('4320.00');
    expect(discountFor(promo(), new Decimal('50000')).toFixed(2)).toBe('5000.00');
    expect(discountFor(promo({ maxDiscount: null, value: new Decimal('12.5') }), new Decimal('999.99')).toFixed(2)).toBe('125.00');
  });

  it('a flat amount, never more than the base, and nothing off nothing', () => {
    expect(discountFor(promo({ kind: 'FLAT', value: new Decimal('1500'), maxDiscount: null }), new Decimal('21600')).toFixed(2)).toBe('1500.00');
    expect(discountFor(promo({ kind: 'FLAT', value: new Decimal('1500'), maxDiscount: null }), new Decimal('900')).toFixed(2)).toBe('900.00');
    expect(discountFor(promo({ kind: 'FLAT', value: new Decimal('1500'), maxDiscount: null }), new Decimal('0')).toFixed(2)).toBe('0.00');
  });
});

describe('promoProblem', () => {
  const ctx = { now: NOW, base: new Decimal('21600'), redemptions: 3, advertiserRedemptions: 0 };

  it('is null for a live code within its limits', () => {
    expect(promoProblem(promo(), ctx)).toBeNull();
  });

  it('names each refusal in the advertiser\'s words', () => {
    expect(promoProblem(promo({ isActive: false }), ctx)).toMatch(/not active/);
    expect(promoProblem(promo({ startsAt: new Date('2026-11-01T00:00:00Z'), endsAt: null }), ctx)).toMatch(/starts on 2026-11-01/);
    expect(promoProblem(promo({ endsAt: new Date('2026-10-01T00:00:00Z') }), ctx)).toMatch(/expired/);
    expect(promoProblem(promo({ usageLimit: 3 }), ctx)).toMatch(/used up/);
    expect(promoProblem(promo(), { ...ctx, advertiserRedemptions: 1 })).toMatch(/already used/);
    expect(promoProblem(promo(), { ...ctx, base: new Decimal('9999.99') })).toMatch(/at least ₹10000\.00/);
    // No limits at all: nothing to hit.
    expect(promoProblem(promo({ usageLimit: null, perAdvertiserLimit: null, minSpend: null, startsAt: null, endsAt: null }), { ...ctx, redemptions: 10_000, advertiserRedemptions: 50, base: new Decimal('1') })).toBeNull();
  });
});

describe('the desk', () => {
  it('creates a code normalised, with money as strings, active by default, and audits it', async () => {
    const view = await createPromoCode({ code: 'festive 20', kind: 'PERCENT', value: '20', maxDiscount: '5000', minSpend: null, usageLimit: 100 }, 'usr_admin');
    expect(repository.findByCode).toHaveBeenCalledWith('FESTIVE20');
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ code: 'FESTIVE20', kind: 'PERCENT', isActive: true, usageLimit: 100, perAdvertiserLimit: null, createdById: 'usr_admin' }));
    expect(view).toMatchObject({ code: 'FESTIVE20', value: '20.00', maxDiscount: '5000.00', minSpend: null, redemptions: 0 });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PROMO_CODE_CREATED', expect.objectContaining({ targetType: 'PromoCode' }));
  });

  it('refuses a duplicate, a percent above 100, and a window that ends before it starts', async () => {
    repository.findByCode.mockResolvedValue(promo());
    await expect(createPromoCode({ code: 'FESTIVE20', kind: 'PERCENT', value: '20' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
    repository.findByCode.mockResolvedValue(null);
    await expect(createPromoCode({ code: 'BIG', kind: 'PERCENT', value: '150' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
    await expect(createPromoCode({ code: 'LATE', kind: 'FLAT', value: '100', startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-10-01T00:00:00.000Z' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('updates only the fields given, re-running the rules on the merged row, and audits the change', async () => {
    repository.findById.mockResolvedValue(promo());
    const view = await updatePromoCode('promo_1', { isActive: false, maxDiscount: null }, 'usr_admin');
    expect(repository.update).toHaveBeenCalledWith('promo_1', { isActive: false, maxDiscount: null });
    expect(view.isActive).toBe(false);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PROMO_CODE_UPDATED', expect.objectContaining({ targetId: 'promo_1', metadata: { fields: expect.arrayContaining(['isActive', 'maxDiscount']) } }));

    // The merged row is what the rules see: a percent code moved above 100 is refused.
    await expect(updatePromoCode('promo_1', { value: '101' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
    // Renaming onto another code's name is a 409; onto its own is fine.
    repository.findByCode.mockResolvedValue(promo({ id: 'promo_2', code: 'OTHER' }));
    await expect(updatePromoCode('promo_1', { code: 'other' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
    repository.findByCode.mockResolvedValue(promo());
    await expect(updatePromoCode('promo_1', { code: 'festive20' }, 'usr_admin')).resolves.toBeTruthy();
  });

  it('a code nobody has is 404', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(updatePromoCode('promo_x', { isActive: true }, 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
  });
});

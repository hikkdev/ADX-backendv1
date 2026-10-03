import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CP-4 — lead rewards are an advertiser-side idea, and a rate key can be
 * switched off.
 *
 * The owner's decision: lead rewards go to advertiser agents, because they
 * are the ones bringing revenue. A publisher agent is paid to onboard, and
 * CP-1's salary-and-quota model is what pays them for it.
 *
 * Switching a side off needs a ROW. The resolution order is
 * `TIER:SIDE → TIER → *:SIDE → *`, so only a narrower row can stop a broader
 * one — and a row priced at zero would be indistinguishable from a price
 * nobody has set yet. `paysNothing` is the difference between "free" and
 * "off", and `rateFor` answers null for both an off key and an unpriced one,
 * so no caller had to learn about the flag.
 */

const { repository, wallets, settings } = vi.hoisted(() => ({
  repository: {
    findIncentiveRate: vi.fn(),
    listIncentiveRates: vi.fn(),
    upsertIncentiveRate: vi.fn(),
    createIncentive: vi.fn(),
    findIncentive: vi.fn(),
    findIncentiveFor: vi.fn(),
    updateIncentive: vi.fn(),
    listIncentives: vi.fn(),
    sumIncentives: vi.fn(),
    countIncentivesByEvent: vi.fn(),
    listTaxRates: vi.fn(),
    findTaxRate: vi.fn(),
  },
  wallets: { ensureWallet: vi.fn(), move: vi.fn() },
  settings: { getPlatformSettings: vi.fn() },
}));

vi.mock('../prisma-payouts.repository', () => ({ prismaPayoutsRepository: repository }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../app-config', () => settings);
vi.mock('../../notifications', () => ({
  notify: vi.fn(async () => ({ notificationId: null, templateKey: null, deliveries: [] })),
  createNotification: vi.fn(async () => ({ id: 'ntf' })),
}));

import { DEFAULT_INCENTIVE_RATES, ensureIncentiveRates, rateFor, resetIncentiveCache, setIncentiveRate } from '../incentives.service';

const NOW = new Date('2026-09-23T10:00:00Z');

type WrittenRate = { event: string; tier: string; amount: unknown; paysNothing?: boolean };
/** Every rate row the seeder wrote, in order, and the last of them. */
const writtenRows = (): WrittenRate[] => repository.upsertIncentiveRate.mock.calls.map((call) => call[0] as WrittenRate);
const writtenKeys = (): string[] => writtenRows().map((row) => `${row.event}:${row.tier}`);
const lastWritten = (): WrittenRate => {
  const rows = writtenRows();
  return rows[rows.length - 1]!;
};

beforeEach(() => {
  vi.clearAllMocks();
  resetIncentiveCache();
  repository.listIncentiveRates.mockResolvedValue([]);
  repository.upsertIncentiveRate.mockImplementation(async (data: { event: string; tier: string }) => ({ id: `ir_${data.event}_${data.tier}` }));
});

describe('CP-4: what the platform seeds for the lead hunt', () => {
  it('prices every lead event on the advertiser side and switches the publisher side off', () => {
    const leads = DEFAULT_INCENTIVE_RATES.filter((rate) => rate.event.startsWith('LEAD_'));
    expect(leads.map((rate) => [rate.event, rate.tier, rate.amount, rate.paysNothing ?? false])).toEqual([
      ['LEAD_CONVERTED', '*:ADVERTISER', '100.00', false],
      ['LEAD_CONVERTED', '*:PUBLISHER', '0.00', true],
      ['LEAD_ACTIVATED', '*:ADVERTISER', '750.00', false],
      ['LEAD_ACTIVATED', '*:PUBLISHER', '0.00', true],
      ['LEAD_RETAINED', '*:ADVERTISER', '100.00', false],
      ['LEAD_RETAINED', '*:PUBLISHER', '0.00', true],
    ]);
    // No unqualified lead row survives: one would pay both sides through the `*` fallback.
    expect(leads.some((rate) => rate.tier === '*')).toBe(false);
  });

  it('seeds by event AND tier, so a platform that already priced LEAD_CONVERTED still gains the off switch', async () => {
    /* The guard used to be the event alone. On a database carrying the old
       `LEAD_CONVERTED *` row that would have skipped BOTH new keys and left
       the hunt quietly paying publisher-side leads — the exact bug this
       pins. */
    repository.listIncentiveRates.mockResolvedValue([{ id: 'ir_old', event: 'LEAD_CONVERTED', tier: '*', amount: '100.00' }]);
    await ensureIncentiveRates();
    const written = writtenKeys();
    expect(written).toContain('LEAD_CONVERTED:*:PUBLISHER');
    expect(written).toContain('LEAD_CONVERTED:*:ADVERTISER');
    // The key it already had is left exactly as the desk set it.
    expect(written).not.toContain('LEAD_CONVERTED:*');
  });

  it('carries the off flag through to the row it writes', async () => {
    await ensureIncentiveRates();
    const off = writtenRows().filter((data) => data.paysNothing === true);
    expect(off.map((data) => `${data.event}:${data.tier}`)).toEqual([
      'LEAD_CONVERTED:*:PUBLISHER',
      'LEAD_ACTIVATED:*:PUBLISHER',
      'LEAD_RETAINED:*:PUBLISHER',
    ]);
  });
});

describe('CP-4: what a switched-off key answers', () => {
  it('answers null, exactly as an unpriced key does', async () => {
    repository.findIncentiveRate.mockResolvedValue({ id: 'ir_off', event: 'LEAD_CONVERTED', tier: '*:PUBLISHER', amount: '0.00', paysNothing: true });
    expect(await rateFor('LEAD_CONVERTED', '*', NOW, 'PUBLISHER')).toBeNull();
    repository.findIncentiveRate.mockResolvedValue(null);
    expect(await rateFor('LEAD_CONVERTED', '*', NOW, 'PUBLISHER')).toBeNull();
  });

  it('still pays the advertiser side its own figure', async () => {
    repository.findIncentiveRate.mockResolvedValue({ id: 'ir_adv', event: 'LEAD_CONVERTED', tier: '*:ADVERTISER', amount: '100.00', paysNothing: false });
    expect(await rateFor('LEAD_CONVERTED', '*', NOW, 'ADVERTISER')).toBe('100.00');
  });

  it('asks the repository for the four keys in the documented order', async () => {
    repository.findIncentiveRate.mockResolvedValue(null);
    await rateFor('LEAD_ACTIVATED', 'GOLD', NOW, 'ADVERTISER');
    expect(repository.findIncentiveRate).toHaveBeenCalledWith('LEAD_ACTIVATED', 'GOLD', NOW, 'ADVERTISER');
  });
});

describe('CP-4: switching a key off from the desk', () => {
  it('records the row as paying nothing and stores a zero rather than the amount typed', async () => {
    await setIncentiveRate({ event: 'LEAD_RETAINED', tier: '*:PUBLISHER', amount: '250.00', paysNothing: true, effectiveFrom: NOW });
    const data = lastWritten();
    expect(data.tier).toBe('*:PUBLISHER');
    expect(data.paysNothing).toBe(true);
    expect(String(data.amount)).toBe('0');
  });

  it('leaves an ordinary re-pricing alone — no flag, and the amount as typed', async () => {
    await setIncentiveRate({ event: 'LEAD_RETAINED', tier: '*:ADVERTISER', amount: '250.00', effectiveFrom: NOW });
    const data = lastWritten();
    expect(data.paysNothing).toBeUndefined();
    expect(String(data.amount)).toBe('250');
  });
});

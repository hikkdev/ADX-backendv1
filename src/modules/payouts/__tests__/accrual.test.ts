import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot B (B1): what a day of a spot is worth, and where the commission on it
 * comes from.
 *
 * Three things were decided and are pinned here. The gross is rate × quantity
 * — the live under-accrual was a run that ignored quantity. The commission is
 * the rate stamped on the spot at authorisation, never re-derived; a spot
 * authorised before the stamp existed is resolved once, at the campaign's
 * start, and the accrual says so. And the advertiser's CAMPAIGN_SPEND is
 * posted at capture (B3a), so the accrual posts no spend leg of its own.
 */

const { repository, wallets, rules, audit, notifications } = vi.hoisted(() => ({
  repository: {
    findAccruableSpots: vi.fn(),
    findAccruedDates: vi.fn(),
    createAccrual: vi.fn(),
    findUnderAccruedSpots: vi.fn(),
  },
  wallets: { ensureWallet: vi.fn(), move: vi.fn(), snapshot: vi.fn() },
  rules: { withholdingFor: vi.fn(), dailyCapFor: vi.fn() },
  audit: { logActivity: vi.fn(), findActivityRows: vi.fn(), auditDiff: vi.fn(() => ({})) },
  notifications: { createNotification: vi.fn() },
}));

vi.mock('../prisma-payouts.repository', () => ({ prismaPayoutsRepository: repository }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../notifications', () => notifications);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../rules.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rules.service')>();
  return { ...actual, ...rules };
});

import { grossForDay, runDailyAccrual, splitDay } from '../accrual.service';
import { quantityBackfill } from '../accrual-backfill.service';
import { registerCommissionResolverPort, resetCommissionResolverPort } from '../commission.port';

const NOW = new Date('2026-09-12T10:00:00Z');
const START = new Date('2026-09-10T00:00:00Z');

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'spt_1',
  ratePerDay: new Decimal('1000.00'),
  quantity: 3,
  commissionPct: new Decimal('0.1200'),
  commissionSource: 'MEDIA_TYPE',
  orderId: 'ord_1',
  campaign: { id: 'cmp_1', startDate: START, endDate: new Date('2026-09-30T00:00:00Z') },
  listing: { id: 'lst_1', publisherId: 'pub_1', title: 'Lift lobby panel', suspensionScopes: [] },
  ...over,
});

const resolver = { resolve: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  resetCommissionResolverPort();
  repository.findAccruedDates.mockResolvedValue([]);
  repository.createAccrual.mockResolvedValue({ id: 'acr_1' });
  rules.withholdingFor.mockResolvedValue({ ratePct: '2.00', section: '194C' });
  wallets.ensureWallet.mockResolvedValue({ id: 'wal_1' });
  wallets.move.mockResolvedValue({ entry: { id: 'ent_1' }, ledgerTransactionId: 'ltx_1', created: true });
  audit.findActivityRows.mockResolvedValue([]);
  notifications.createNotification.mockResolvedValue({ id: 'ntf_1' });
});

describe('a day of a spot', () => {
  it('is worth rate × quantity — the bug was ignoring quantity', () => {
    expect(grossForDay('1000.00', 3)).toBe('3000.00');
    expect(grossForDay('1000.00', 1)).toBe('1000.00');
  });

  it('splits the day gross, not the unit rate', () => {
    const split = splitDay(grossForDay('1000.00', 3), '12.00', '2.00');
    expect(split.gross).toBe('3000.00');
    expect(split.commission).toBe('360.00');
    expect(split.taxWithheld).toBe('52.80');
    expect(split.net).toBe('2587.20');
  });
});

describe('the daily run', () => {
  it('credits rate × quantity per day, at the commission stamped on the spot', async () => {
    repository.findAccruableSpots.mockResolvedValue([spot()]);

    const run = await runDailyAccrual(NOW);

    // 10th and 11th have finished; the 12th is running.
    expect(run.daysCredited).toBe(2);
    const movement = wallets.move.mock.calls[0]![0] as {
      amount: string;
      counterLegs: { accountCode: string; amount: string }[];
      ledgerKind: string;
    };
    expect(movement.amount).toBe('2587.20');
    expect(movement.ledgerKind).toBe('PUBLISHER_EARNING');
    expect(movement.counterLegs).toEqual([
      { accountCode: 'platform:payables', amount: '-3000.00' },
      expect.objectContaining({ accountCode: 'platform:revenue', amount: '360.00' }),
      expect.objectContaining({ accountCode: 'platform:tax-withheld', amount: '52.80' }),
    ]);

    const accrual = repository.createAccrual.mock.calls[0]![0] as Record<string, Decimal | string>;
    expect(accrual['gross']!.toString()).toBe('3000');
    // The Decimal(5,2) column holds a percentage; the stamp is a fraction.
    expect((accrual['commissionRatePct'] as Decimal).toFixed(2)).toBe('12.00');
    expect(accrual['commissionSource']).toBe('MEDIA_TYPE');
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  /**
   * B3a posts CAMPAIGN_SPEND when the hold is captured — wallet − /
   * platform:payables + for the whole booking. The accrual releases each
   * day's gross out of payables; posting spend here as well would count the
   * booking twice on the advertiser's side.
   */
  it('posts no advertiser-side spend leg of its own', async () => {
    repository.findAccruableSpots.mockResolvedValue([spot()]);
    await runDailyAccrual(NOW);
    for (const call of wallets.move.mock.calls) {
      const movement = call[0] as { ledgerKind: string; counterLegs: { accountCode: string }[] };
      expect(movement.ledgerKind).not.toBe('CAMPAIGN_SPEND');
      expect(movement.counterLegs.map((leg) => leg.accountCode)).not.toContain('platform:cash');
    }
  });

  it('resolves a spot authorised before the stamp existed, once, at the flight start, and says so', async () => {
    registerCommissionResolverPort(resolver);
    resolver.resolve.mockResolvedValue({ ratePct: '0.15', source: 'PLATFORM_DEFAULT' });
    repository.findAccruableSpots.mockResolvedValue([spot({ commissionPct: null, commissionSource: null })]);

    const run = await runDailyAccrual(NOW);

    expect(run.daysCredited).toBe(2);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(resolver.resolve).toHaveBeenCalledWith({ listingId: 'lst_1', ratePerDay: '1000.00', at: START });
    const accrual = repository.createAccrual.mock.calls[0]![0] as Record<string, Decimal | string>;
    expect((accrual['commissionRatePct'] as Decimal).toFixed(2)).toBe('15.00');
    expect(accrual['commissionSource']).toBe('RESOLVED_AT_ACCRUAL');
    expect((accrual['commission'] as Decimal).toFixed(2)).toBe('450.00');
  });

  it('skips an unstamped spot rather than guess when no resolver is wired', async () => {
    repository.findAccruableSpots.mockResolvedValue([
      spot({ id: 'spt_legacy', commissionPct: null, commissionSource: null }),
      spot({ id: 'spt_ok' }),
    ]);

    const run = await runDailyAccrual(NOW);

    expect(run.skipped).toBe(1);
    expect(run.daysCredited).toBe(2);
    for (const call of wallets.move.mock.calls) {
      expect((call[0] as { reference: string }).reference).toBe('spt_ok');
    }
  });

  it('keys each day on the spot so a second run pays nothing twice', async () => {
    repository.findAccruableSpots.mockResolvedValue([spot()]);
    repository.findAccruedDates.mockResolvedValue([new Date('2026-09-10T00:00:00Z')]);
    const run = await runDailyAccrual(NOW);
    expect(run.daysCredited).toBe(1);
    expect((wallets.move.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey).toBe(
      'accrual:spt_1:2026-09-11'
    );
  });
});

describe('the quantity backfill (Q135)', () => {
  const underAccrued = (over: Record<string, unknown> = {}) => ({
    id: 'spt_1',
    ratePerDay: new Decimal('1000.00'),
    quantity: 3,
    campaignId: 'cmp_1',
    orderId: 'ord_1',
    listing: { id: 'lst_1', title: 'Lift lobby panel', publisherId: 'pub_1', publisherUserId: 'usr_pub' },
    accruals: [
      {
        id: 'acr_1',
        forDate: new Date('2026-09-10T00:00:00Z'),
        gross: new Decimal('1000.00'),
        commissionRatePct: new Decimal('12.00'),
        taxRatePct: new Decimal('2.00'),
      },
      {
        id: 'acr_2',
        forDate: new Date('2026-09-11T00:00:00Z'),
        gross: new Decimal('1000.00'),
        commissionRatePct: new Decimal('12.00'),
        taxRatePct: new Decimal('2.00'),
      },
      // Already right — accrued after the fix. Not a candidate.
      {
        id: 'acr_3',
        forDate: new Date('2026-09-12T00:00:00Z'),
        gross: new Decimal('3000.00'),
        commissionRatePct: new Decimal('12.00'),
        taxRatePct: new Decimal('2.00'),
      },
    ],
    ...over,
  });

  it('dry run lists the spot-days that were paid at the unit rate, and moves nothing', async () => {
    repository.findUnderAccruedSpots.mockResolvedValue([underAccrued()]);

    const result = await quantityBackfill({ dryRun: true, byUserId: 'usr_admin' }, NOW);

    expect(result.dryRun).toBe(true);
    expect(result.spots).toHaveLength(1);
    expect(result.spots[0]).toMatchObject({
      spotId: 'spt_1',
      quantity: 3,
      days: 2,
      grossPosted: '2000.00',
      grossDue: '6000.00',
      missingGross: '4000.00',
      missingCommission: '480.00',
      missingTax: '70.40',
      missingNet: '3449.60',
    });
    expect(result.totals.missingNet).toBe('3449.60');
    expect(wallets.move).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('execute posts one ADJUSTMENT per spot, records it against the spot, and tells the publisher', async () => {
    repository.findUnderAccruedSpots.mockResolvedValue([underAccrued()]);

    const result = await quantityBackfill({ dryRun: false, byUserId: 'usr_admin', requestId: 'req_1' }, NOW);

    expect(result.corrected).toBe(1);
    expect(wallets.move).toHaveBeenCalledTimes(1);
    const movement = wallets.move.mock.calls[0]![0] as Record<string, unknown>;
    expect(movement).toMatchObject({
      walletId: 'wal_1',
      amount: '3449.60',
      entryType: 'ADJUSTMENT',
      ledgerKind: 'ADJUSTMENT',
      idempotencyKey: 'accrual-quantity-fix:spt_1',
      campaignId: 'cmp_1',
      orderId: 'ord_1',
      reference: 'spt_1',
      createdByUserId: 'usr_admin',
    });
    expect(movement['counterLegs']).toEqual([
      expect.objectContaining({ accountCode: 'platform:payables', amount: '-4000.00' }),
      expect.objectContaining({ accountCode: 'platform:revenue', amount: '480.00' }),
      expect.objectContaining({ accountCode: 'platform:tax-withheld', amount: '70.40' }),
    ]);
    expect(String(movement['note'])).toContain('quantity');

    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'ACCRUAL_QUANTITY_CORRECTED',
      expect.objectContaining({
        targetType: 'CampaignSpot',
        targetId: 'spt_1',
        module: 'payouts',
        requestId: 'req_1',
        metadata: expect.objectContaining({ missingNet: '3449.60', ledgerTransactionId: 'ltx_1' }),
      })
    );
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_pub', type: 'PAYOUT', relatedId: 'spt_1' })
    );
    expect(String((notifications.createNotification.mock.calls[0]![0] as { subtitle: string }).subtitle)).toContain(
      'PUBLISHER_ACCRUAL_CORRECTED'
    );
  });

  it('skips a spot that was already corrected — the audit row is the record', async () => {
    repository.findUnderAccruedSpots.mockResolvedValue([underAccrued(), underAccrued({ id: 'spt_2' })]);
    audit.findActivityRows.mockResolvedValue([{ targetId: 'spt_1' }]);

    const dry = await quantityBackfill({ dryRun: true, byUserId: 'usr_admin' }, NOW);
    expect(dry.spots.map((row) => row.spotId)).toEqual(['spt_2']);
    expect(dry.alreadyCorrected).toBe(1);

    const run = await quantityBackfill({ dryRun: false, byUserId: 'usr_admin' }, NOW);
    expect(run.corrected).toBe(1);
    expect((wallets.move.mock.calls[0]![0] as { reference: string }).reference).toBe('spt_2');
  });

  it('ignores a quantity-one spot and a spot whose every day was already right', async () => {
    repository.findUnderAccruedSpots.mockResolvedValue([
      underAccrued({ id: 'spt_q1', quantity: 1 }),
      underAccrued({
        id: 'spt_right',
        accruals: [
          {
            id: 'acr_9',
            forDate: new Date('2026-09-10T00:00:00Z'),
            gross: new Decimal('3000.00'),
            commissionRatePct: new Decimal('12.00'),
            taxRatePct: new Decimal('2.00'),
          },
        ],
      }),
    ]);
    const dry = await quantityBackfill({ dryRun: true, byUserId: 'usr_admin' }, NOW);
    expect(dry.spots).toEqual([]);
  });

  it('does not record a correction the wallet refused', async () => {
    repository.findUnderAccruedSpots.mockResolvedValue([underAccrued()]);
    wallets.move.mockRejectedValue(new Error('WALLET_GONE'));

    const run = await quantityBackfill({ dryRun: false, byUserId: 'usr_admin' }, NOW);

    expect(run.corrected).toBe(0);
    expect(run.failed).toEqual([{ spotId: 'spt_1', reason: 'Error: WALLET_GONE' }]);
    expect(audit.logActivity).not.toHaveBeenCalled();
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});

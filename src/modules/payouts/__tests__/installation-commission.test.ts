import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot B, package B3b — what an agent earns for an installation and an
 * onboarding.
 *
 * Owner decisions 101 and 102: INSTALLATION and ADVERTISER_ONBOARDED are
 * events in the rate table, seeded like the rest; the installation figure is
 * either the flat rate or, when ops has switched the platform to PER_ORDER,
 * the figure typed on the order — falling back to the flat rate when nobody
 * typed one. Both events land PENDING_VERIFICATION like every other incentive,
 * and recording one twice for the same order or party returns the first.
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
// Lot E1/F: the dispatcher behind the payout-paid and incentive notices — never the wire in a unit test.
vi.mock('../../notifications', () => ({ notify: vi.fn(async () => ({ notificationId: null, templateKey: null, deliveries: [] })), createNotification: vi.fn(async () => ({ id: 'ntf' })) }));

import {
  DEFAULT_INCENTIVE_RATES,
  installationFeeFor,
  recordIncentiveOnce,
  resetIncentiveCache,
} from '../incentives.service';
import { incentiveQuerySchema, recordIncentiveSchema, setIncentiveRateSchema } from '../payouts.schema';
import { resetRulesCache } from '../rules.service';

const NOW = new Date('2026-09-12T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  resetIncentiveCache();
  resetRulesCache();
  repository.listIncentiveRates.mockResolvedValue([{ id: 'ir_1' }]);
  repository.listTaxRates.mockResolvedValue([{ id: 't1' }]);
  repository.findTaxRate.mockResolvedValue(null);
  repository.findIncentiveFor.mockResolvedValue(null);
  repository.findIncentiveRate.mockImplementation(async (event: string) => ({
    id: `ir_${event}`,
    amount: new Decimal(event === 'INSTALLATION' ? '1450.00' : '2000.00'),
  }));
  repository.createIncentive.mockImplementation(async (d: Record<string, unknown>) => ({
    id: 'inc_new',
    status: 'PENDING_VERIFICATION',
    ...d,
  }));
  settings.getPlatformSettings.mockResolvedValue({ installation: { commissionMode: 'FLAT' } });
});

describe('the two new events are in the table', () => {
  it('seeds INSTALLATION at 1450 and ADVERTISER_ONBOARDED at 2000, like PUBLISHER_ONBOARDED (Q101, Q102)', () => {
    expect(DEFAULT_INCENTIVE_RATES).toContainEqual({ event: 'INSTALLATION', tier: '*', amount: '1450.00' });
    expect(DEFAULT_INCENTIVE_RATES).toContainEqual({ event: 'ADVERTISER_ONBOARDED', tier: '*', amount: '2000.00' });
    expect(DEFAULT_INCENTIVE_RATES).toContainEqual({ event: 'PUBLISHER_ONBOARDED', tier: '*', amount: '2000.00' });
  });

  it('lets ops record either by hand, and set a rate for either', () => {
    expect(recordIncentiveSchema.safeParse({ agentId: 'agt_1', event: 'INSTALLATION', orderId: 'ord_1' }).success).toBe(true);
    expect(recordIncentiveSchema.safeParse({ agentId: 'agt_1', event: 'ADVERTISER_ONBOARDED' }).success).toBe(true);
    expect(setIncentiveRateSchema.safeParse({ event: 'INSTALLATION', amount: '1500.00' }).success).toBe(true);
  });

  it('gives the finance queue an orderId facet', () => {
    expect(incentiveQuerySchema.parse({ orderId: 'ord_1' }).orderId).toBe('ord_1');
  });
});

describe('installationFeeFor (Q102)', () => {
  it('is the flat rate when the platform is on FLAT, whatever the order says', async () => {
    expect(await installationFeeFor({ agentFeeAmount: new Decimal('1800.00') }, 'SILVER', NOW)).toBe('1450.00');
    // LH2: the lookup carries the lead's side as a fourth argument, undefined for an order.
    expect(repository.findIncentiveRate).toHaveBeenCalledWith('INSTALLATION', 'SILVER', NOW, undefined);
  });

  it('is the figure ops typed on the order when the platform is on PER_ORDER', async () => {
    settings.getPlatformSettings.mockResolvedValue({ installation: { commissionMode: 'PER_ORDER' } });
    expect(await installationFeeFor({ agentFeeAmount: new Decimal('1800.00') }, 'SILVER', NOW)).toBe('1800.00');
    expect(repository.findIncentiveRate).not.toHaveBeenCalled();
  });

  it('falls back to the flat rate on PER_ORDER when nobody typed one', async () => {
    settings.getPlatformSettings.mockResolvedValue({ installation: { commissionMode: 'PER_ORDER' } });
    expect(await installationFeeFor({ agentFeeAmount: null }, 'BRONZE', NOW)).toBe('1450.00');
  });

  it('is null, never zero, when no rate is configured', async () => {
    repository.findIncentiveRate.mockResolvedValue(null);
    expect(await installationFeeFor({ agentFeeAmount: null }, '*', NOW)).toBeNull();
  });

  it('reads the flat rate when the settings row cannot be read', async () => {
    settings.getPlatformSettings.mockRejectedValue(new Error('redis down'));
    expect(await installationFeeFor({ agentFeeAmount: new Decimal('1800.00') }, '*', NOW)).toBe('1450.00');
  });
});

describe('recordIncentiveOnce', () => {
  it('records the event PENDING_VERIFICATION with the order on it', async () => {
    const row = await recordIncentiveOnce(
      { agentId: 'agt_1', event: 'INSTALLATION', tier: 'BRONZE', orderId: 'ord_1', amount: '1800.00' },
      NOW,
    );
    expect(row.status).toBe('PENDING_VERIFICATION');
    expect(repository.findIncentiveFor).toHaveBeenCalledWith('INSTALLATION', { orderId: 'ord_1' });
    expect(repository.createIncentive).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'INSTALLATION', orderId: 'ord_1', amount: new Decimal('1800.00') }),
    );
    expect(wallets.move).not.toHaveBeenCalled();
  });

  it('returns the first row when the same order is signed off twice', async () => {
    repository.findIncentiveFor.mockResolvedValue({ id: 'inc_first', status: 'PENDING_VERIFICATION' });
    const row = await recordIncentiveOnce(
      { agentId: 'agt_1', event: 'INSTALLATION', tier: 'BRONZE', orderId: 'ord_1' },
      NOW,
    );
    expect(row.id).toBe('inc_first');
    expect(repository.createIncentive).not.toHaveBeenCalled();
  });

  it('keys an onboarding on the party rather than an order', async () => {
    await recordIncentiveOnce(
      { agentId: 'agt_1', event: 'ADVERTISER_ONBOARDED', tier: 'GOLD', advertiserId: 'adv_1' },
      NOW,
    );
    expect(repository.findIncentiveFor).toHaveBeenCalledWith('ADVERTISER_ONBOARDED', { advertiserId: 'adv_1' });
    expect(repository.createIncentive).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ADVERTISER_ONBOARDED', advertiserId: 'adv_1', amount: new Decimal('2000.00') }),
    );
  });
});

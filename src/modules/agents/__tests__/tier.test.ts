import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 05 — the tier ladder, made real.
 *
 * Pinned: a change of rung is an event; a promotion to a new TIER records
 * the TIER_BONUS the rate table prices for it and nothing when it prices
 * none; a pinned tier is not recomputed; the GOLD Achieved screen fires on
 * an unacknowledged climb, once; benefits are real or absent; thresholds
 * come from config with the built-in ladder as the fallback, and a ladder
 * that does not climb is refused.
 */

const { repository, agents, payouts, config, audit } = vi.hoisted(() => ({
  repository: {
    findProfile: vi.fn(),
    findProfileByUser: vi.fn(),
    writeRung: vi.fn(),
    createEvent: vi.fn(),
    findUnacknowledged: vi.fn(),
    findEvent: vi.fn(),
    acknowledge: vi.fn(),
    listEvents: vi.fn(),
  },
  agents: { countOnboarded: vi.fn() },
  payouts: { rateFor: vi.fn(), recordIncentive: vi.fn() },
  config: { getConfigObject: vi.fn(), saveConfigObject: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../tier/prisma-tier.repository', () => ({ prismaTierRepository: repository }));
vi.mock('../prisma-agents.repository', () => ({ prismaAgentsRepository: agents }));
vi.mock('../../payouts', () => payouts);
vi.mock('../../app-config', () => config);
vi.mock('../../../shared/audit', () => audit);

import {
  acknowledgeTierEvent,
  benefitsFor,
  getMyTier,
  loadLadder,
  pinTier,
  saveLadder,
  syncTier,
} from '../tier/tier.service';
import { LADDER, validLadder } from '../tier-ladder';

const NOW = new Date('2026-09-11T06:00:00.000Z');

const profile = (over: Record<string, unknown> = {}) => ({
  id: 'agt_1',
  userId: 'usr_agent',
  city: 'Bengaluru',
  tier: 'BRONZE' as const,
  tierLevel: 'I' as const,
  tierPinnedAt: null,
  ...over,
});

const event = (over: Record<string, unknown> = {}) => ({
  id: 'evt_1',
  agentId: 'agt_1',
  fromTier: 'SILVER',
  fromLevel: 'III',
  toTier: 'GOLD',
  toLevel: 'I',
  reason: 'Onboarded 60 accounts',
  byUserId: null,
  at: NOW,
  acknowledgedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  config.getConfigObject.mockResolvedValue(null);
  config.saveConfigObject.mockResolvedValue({});
  payouts.rateFor.mockResolvedValue(null);
  payouts.recordIncentive.mockResolvedValue({ id: 'inc_1' });
  repository.writeRung.mockResolvedValue(undefined);
  repository.createEvent.mockImplementation(async (data) => ({ id: 'evt_new', acknowledgedAt: null, byUserId: null, ...data }));
  repository.findUnacknowledged.mockResolvedValue(null);
  repository.listEvents.mockResolvedValue([]);
  agents.countOnboarded.mockResolvedValue({ publishers: 0, advertisers: 0 });
  audit.logActivity.mockResolvedValue(undefined);
});

describe('syncTier', () => {
  it('writes the rung with its level and records the climb as an event', async () => {
    const { position, event: recorded } = await syncTier(profile(), 25, NOW);
    expect(position).toMatchObject({ tier: 'SILVER', level: 'I', label: 'Silver I' });
    expect(repository.writeRung).toHaveBeenCalledWith('agt_1', 'SILVER', 'I', null);
    expect(recorded).toMatchObject({ fromTier: 'BRONZE', fromLevel: 'I', toTier: 'SILVER', toLevel: 'I', reason: 'Onboarded 25 accounts' });
  });

  it('records a fall too, instead of letting the rung drop silently', async () => {
    const { event: recorded } = await syncTier(profile({ tier: 'SILVER', tierLevel: 'II' }), 3, NOW);
    expect(recorded).toMatchObject({ toTier: 'BRONZE', toLevel: 'I', reason: 'Ladder recomputed at 3 accounts' });
  });

  it('writes nothing when the rung already agrees', async () => {
    const { event: recorded } = await syncTier(profile({ tier: 'BRONZE', tierLevel: 'II' }), 7, NOW);
    expect(recorded).toBeNull();
    expect(repository.writeRung).not.toHaveBeenCalled();
  });

  it('leaves a pinned tier where ops put it, and still counts the step', async () => {
    const { position, event: recorded } = await syncTier(profile({ tier: 'GOLD', tierLevel: 'II', tierPinnedAt: NOW }), 3, NOW);
    expect(position).toMatchObject({ tier: 'GOLD', level: 'II', label: 'Gold II', stepDone: 3, stepTarget: 5 });
    expect(recorded).toBeNull();
    expect(repository.writeRung).not.toHaveBeenCalled();
  });

  it('records the TIER_BONUS on reaching a new tier when the rate table prices one', async () => {
    payouts.rateFor.mockResolvedValue('10000.00');
    await syncTier(profile({ tier: 'SILVER', tierLevel: 'III' }), 60, NOW);
    expect(payouts.rateFor).toHaveBeenCalledWith('TIER_BONUS', 'GOLD', NOW);
    expect(payouts.recordIncentive).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agt_1', event: 'TIER_BONUS', tier: 'GOLD' }),
      NOW,
    );
  });

  it('records no bonus for a level within a tier, nor when no rate is configured', async () => {
    payouts.rateFor.mockResolvedValue('10000.00');
    await syncTier(profile({ tier: 'GOLD', tierLevel: 'I' }), 80, NOW); // GOLD I → GOLD II
    expect(payouts.recordIncentive).not.toHaveBeenCalled();

    payouts.rateFor.mockResolvedValue(null);
    await syncTier(profile({ tier: 'SILVER', tierLevel: 'III' }), 60, NOW); // → GOLD I, unpriced
    expect(payouts.recordIncentive).not.toHaveBeenCalled();
  });
});

describe('the ladder\'s thresholds', () => {
  it('fall back to the built-in table when none are configured or they are malformed', async () => {
    expect(await loadLadder()).toEqual([...LADDER]);
    config.getConfigObject.mockResolvedValue({ rungs: [{ tier: 'BRONZE', level: 'I', from: 0 }, { tier: 'BRONZE', level: 'I', from: 5 }] });
    expect(await loadLadder()).toEqual([...LADDER]);
  });

  it('are read from config when they are a ladder', async () => {
    const rungs = [{ tier: 'BRONZE', level: 'I', from: 0 }, { tier: 'SILVER', level: 'I', from: 3 }];
    config.getConfigObject.mockResolvedValue({ rungs });
    expect(await loadLadder()).toEqual(rungs);
    const { position } = await syncTier(profile(), 3, NOW);
    expect(position.tier).toBe('SILVER');
  });

  it('refuse a ladder that does not climb', async () => {
    expect(validLadder([{ tier: 'BRONZE', level: 'I', from: 0 }, { tier: 'BRONZE', level: 'II', from: 0 }])).toMatch(/does not climb/);
    expect(validLadder([{ tier: 'BRONZE', level: 'I', from: 1 }, { tier: 'BRONZE', level: 'II', from: 5 }])).toMatch(/starts at 0/);
    expect(validLadder([{ tier: 'SILVER', level: 'I', from: 0 }, { tier: 'BRONZE', level: 'II', from: 5 }])).toMatch(/not above/);
    await expect(saveLadder([{ tier: 'BRONZE', level: 'I', from: 0 }])).rejects.toMatchObject({ statusCode: 400 });
    expect(config.saveConfigObject).not.toHaveBeenCalled();
  });
});

describe('benefits', () => {
  it('are real or absent: a priced bonus and a configured line, nothing else', async () => {
    payouts.rateFor.mockResolvedValue('10000.00');
    config.getConfigObject.mockImplementation(async (key: string) => (key === 'support-lines' ? { GOLD: '+91 80 4000 1234' } : null));
    const benefits = await benefitsFor('GOLD', NOW);
    expect(benefits).toEqual([
      { key: 'BONUS', title: '₹10,000 bonus', detail: 'Recorded on promotion — released by ADX finance' },
      { key: 'SUPPORT_LINE', title: 'Dedicated support line', detail: '+91 80 4000 1234' },
    ]);
  });

  it('are empty when nothing is configured', async () => {
    expect(await benefitsFor('SILVER', NOW)).toEqual([]);
  });
});

describe('the agent\'s view', () => {
  it('carries the unacknowledged climb once, and never a fall', async () => {
    repository.findProfileByUser.mockResolvedValue(profile({ tier: 'GOLD', tierLevel: 'I' }));
    agents.countOnboarded.mockResolvedValue({ publishers: 60, advertisers: 0 });
    repository.findUnacknowledged.mockResolvedValue(event());
    const view = await getMyTier('usr_agent', NOW);
    expect(view.current).toEqual({ tier: 'GOLD', level: 'I', label: 'Gold I', pinned: false });
    expect(view.promotion?.direction).toBe('UP');

    repository.findUnacknowledged.mockResolvedValue(event({ fromTier: 'GOLD', fromLevel: 'II', toTier: 'GOLD', toLevel: 'I' }));
    expect((await getMyTier('usr_agent', NOW)).promotion).toBeNull();
  });

  it('acknowledges its own event once and refuses somebody else\'s', async () => {
    repository.findProfileByUser.mockResolvedValue(profile());
    repository.findEvent.mockResolvedValue(event());
    repository.acknowledge.mockResolvedValue(event({ acknowledgedAt: NOW }));
    const view = await acknowledgeTierEvent('usr_agent', 'evt_1', NOW);
    expect(view.acknowledgedAt).toBe(NOW.toISOString());

    repository.findEvent.mockResolvedValue(event({ acknowledgedAt: NOW }));
    await acknowledgeTierEvent('usr_agent', 'evt_1', NOW);
    expect(repository.acknowledge).toHaveBeenCalledTimes(1);

    repository.findEvent.mockResolvedValue(event({ agentId: 'agt_other' }));
    await expect(acknowledgeTierEvent('usr_agent', 'evt_1', NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the ops pin', () => {
  it('pins with a reason, records the event and logs it', async () => {
    repository.findProfile.mockResolvedValue(profile());
    const view = await pinTier('agt_1', { tier: 'GOLD', level: 'II', reason: 'Regional lead' }, 'usr_admin', NOW);
    expect(repository.writeRung).toHaveBeenCalledWith('agt_1', 'GOLD', 'II', NOW);
    expect(repository.createEvent).toHaveBeenCalledWith(expect.objectContaining({ toTier: 'GOLD', toLevel: 'II', reason: 'Regional lead', byUserId: 'usr_admin' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'AGENT_TIER_PINNED', undefined, expect.objectContaining({ to: 'Gold II' }));
    expect(view.current).toMatchObject({ tier: 'GOLD', level: 'II', pinned: true });
  });

  it('unpins, and the ladder takes the rung back on that read', async () => {
    repository.findProfile.mockResolvedValue(profile({ tier: 'GOLD', tierLevel: 'II', tierPinnedAt: NOW }));
    agents.countOnboarded.mockResolvedValue({ publishers: 3, advertisers: 0 });
    const view = await pinTier('agt_1', { tier: null, reason: 'Review over' }, 'usr_admin', NOW);
    expect(repository.writeRung).toHaveBeenNthCalledWith(1, 'agt_1', 'GOLD', 'II', null);
    expect(view.current).toMatchObject({ tier: 'BRONZE', level: 'I', pinned: false });
    expect(repository.createEvent).toHaveBeenCalledWith(expect.objectContaining({ fromTier: 'GOLD', toTier: 'BRONZE' }));
  });
});

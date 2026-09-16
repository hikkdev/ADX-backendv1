import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A (Q31): the publisher KYC queue against the review SLA.
 *
 * Every row says how long it has been waiting and whether that is past the
 * window ops set in the platform settings row, and — unless the reviewer asks
 * for a different order — the late ones come first. The SLA is a number ops
 * change, not a constant, which is exactly why the ordering is done here over
 * the rows rather than in the database.
 */

const { repository, settings } = vi.hoisted(() => ({
  repository: { findKycQueue: vi.fn(), countKycQueue: vi.fn(async () => 0), findKycDetail: vi.fn() },
  settings: { getPlatformSettings: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../app-config', () => settings);
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn(), findAgentProfile: vi.fn(), getAgentWithUser: vi.fn() }));
vi.mock('../../access-grants', () => ({ liveGrantFor: vi.fn(), holdsLiveGrant: vi.fn() }));
vi.mock('../../users', () => ({ getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));

import { listKycQueue } from '../publishers.service';
import { kycQueueQuerySchema } from '../publishers.schema';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

const row = (id: string, submittedAt: Date | null) => ({
  id,
  kyc: submittedAt ? { status: 'PENDING', submittedAt } : null,
  agent: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  settings.getPlatformSettings.mockResolvedValue({ kyc: { reviewSlaHours: 48 } });
});

describe('the query', () => {
  it('takes an optional sort beside the existing filters', () => {
    expect(kycQueueQuerySchema.parse({ sort: 'newest' })).toEqual({ sort: 'newest' });
    expect(kycQueueQuerySchema.safeParse({ sort: 'breached' }).success).toBe(false);
  });
});

describe('the queue', () => {
  it('ages every row and flags the ones past the SLA', async () => {
    repository.findKycQueue.mockResolvedValue([row('p1', hoursAgo(50)), row('p2', hoursAgo(3))]);

    const result = await listKycQueue({}, NOW);

    expect(result.slaHours).toBe(48);
    expect(result.total).toBe(2);
    expect(result.breached).toBe(1);
    expect(result.items.find((item) => item.id === 'p1')).toMatchObject({ ageHours: 50, slaBreached: true });
    expect(result.items.find((item) => item.id === 'p2')).toMatchObject({ ageHours: 3, slaBreached: false });
  });

  it('puts breaches first with no sort asked for, keeping oldest-first inside each half', async () => {
    repository.findKycQueue.mockResolvedValue([
      row('fresh-old', hoursAgo(40)),
      row('late-oldest', hoursAgo(200)),
      row('fresh-new', hoursAgo(1)),
      row('late-newer', hoursAgo(60)),
    ]);

    const { items } = await listKycQueue({}, NOW);
    expect(items.map((item) => item.id)).toEqual(['late-oldest', 'late-newer', 'fresh-old', 'fresh-new']);
  });

  it('leaves the repository order alone when a sort is named', async () => {
    repository.findKycQueue.mockResolvedValue([row('fresh', hoursAgo(1)), row('late', hoursAgo(90))]);
    const { items } = await listKycQueue({ sort: 'newest' }, NOW);
    expect(items.map((item) => item.id)).toEqual(['fresh', 'late']);
    expect(repository.findKycQueue).toHaveBeenCalledWith({ sort: 'newest' });
  });

  it('follows the SLA ops set, not a constant', async () => {
    settings.getPlatformSettings.mockResolvedValue({ kyc: { reviewSlaHours: 4 } });
    repository.findKycQueue.mockResolvedValue([row('p1', hoursAgo(5))]);
    const result = await listKycQueue({}, NOW);
    expect(result.slaHours).toBe(4);
    expect(result.breached).toBe(1);
  });

  it('never breaches a row with no submission: nothing was promised about it', async () => {
    repository.findKycQueue.mockResolvedValue([row('p1', null)]);
    const { items, breached } = await listKycQueue({}, NOW);
    expect(items[0]).toMatchObject({ ageHours: null, slaBreached: false });
    expect(breached).toBe(0);
  });
});

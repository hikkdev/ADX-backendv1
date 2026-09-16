import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A (Q31): the advertiser KYC queue against the review SLA.
 *
 * Same promise as the publisher queue, made on a paginated list: each row
 * carries its age and whether it is late, the header carries how many are
 * late in the whole queue rather than on this page, and with no sort named
 * the oldest pending submissions — which is precisely the late ones — come
 * first, so a breach cannot hide on page four.
 */

const { repository, settings } = vi.hoisted(() => ({
  repository: { findPage: vi.fn(), countBreached: vi.fn(), countByState: vi.fn(), countEscalated: vi.fn(), countRequested: vi.fn(async () => 0) },
  settings: { getPlatformSettings: vi.fn() },
}));

vi.mock('../prisma-advertiser-kyc.repository', () => ({ prismaAdvertiserKycRepository: repository }));
vi.mock('../../../app-config', () => settings);
vi.mock('../../../advertisers', () => ({ applyKycDecisionByUserId: vi.fn() }));

import { listAdvertiserKycs } from '../advertiser-kyc.service';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  settings.getPlatformSettings.mockResolvedValue({ kyc: { reviewSlaHours: 48 } });
  repository.countBreached.mockResolvedValue(0);
  repository.countByState.mockResolvedValue({ AWAITING_DOCUMENTS: 0, REQUESTED: 0, PENDING: 0, VERIFIED: 0, REJECTED: 0, NEEDS_INFO: 0 });
  repository.countEscalated.mockResolvedValue(0);
  repository.findPage.mockResolvedValue({ items: [], total: 0 });
});

describe('E7-3: the list contract', () => {
  it('answers the publisher queue shape with the chips counted minus the status facet, and the old meta beside it', async () => {
    repository.findPage.mockResolvedValue({ items: [{ id: 'k1', status: 'PENDING', submittedAt: hoursAgo(1) }], total: 21 });
    repository.countBreached.mockResolvedValue(4);
    // N3-B: the chips are parties per STATE — awaiting-documents parties among them.
    repository.countByState.mockResolvedValue({ AWAITING_DOCUMENTS: 5, REQUESTED: 3, PENDING: 12, VERIFIED: 30, REJECTED: 2, NEEDS_INFO: 1 });

    const page = await listAdvertiserKycs({ status: 'PENDING', assignedToId: 'usr_ops' }, 2, 20, undefined, NOW);

    expect(page).toMatchObject({
      total: 21,
      page: 2,
      pageSize: 20,
      counts: { AWAITING_DOCUMENTS: 5, awaitingDocuments: 5, REQUESTED: 3, PENDING: 12, VERIFIED: 30, REJECTED: 2, NEEDS_INFO: 1, escalated: 0, requested: 0 },
      breached: 4,
      escalated: 0,
      slaHours: 48,
      meta: { page: 2, pageSize: 20, total: 21, totalPages: 2, breached: 4, slaHours: 48 },
    });
    expect(page.items[0]).toMatchObject({ id: 'k1', ageHours: 1, slaBreached: false });
    // The state facet (and its status alias) removed, the rest of the filter kept.
    expect(repository.countByState).toHaveBeenCalledWith({ state: undefined, status: undefined, assignedToId: 'usr_ops' });
  });
});

describe('the queue', () => {
  it('ages each row, flags the late ones, and counts breaches across the whole queue', async () => {
    repository.findPage.mockResolvedValue({
      items: [
        { id: 'k1', status: 'PENDING', submittedAt: hoursAgo(72) },
        { id: 'k2', status: 'PENDING', submittedAt: hoursAgo(6) },
      ],
      total: 40,
    });
    repository.countBreached.mockResolvedValue(11);

    const { items, meta } = await listAdvertiserKycs({}, 1, 20, undefined, NOW);

    expect(items[0]).toMatchObject({ id: 'k1', ageHours: 72, slaBreached: true });
    expect(items[1]).toMatchObject({ id: 'k2', ageHours: 6, slaBreached: false });
    expect(meta).toMatchObject({ total: 40, breached: 11, slaHours: 48 });
    // The cutoff is the SLA behind `now`, and it is the whole filter that is counted.
    expect(repository.countBreached).toHaveBeenCalledWith({}, hoursAgo(48));
  });

  it('never ages a decided record: the clock stops when a reviewer answers', async () => {
    repository.findPage.mockResolvedValue({
      items: [{ id: 'k3', status: 'VERIFIED', submittedAt: hoursAgo(500) }],
      total: 1,
    });
    const { items } = await listAdvertiserKycs({}, 1, 20, undefined, NOW);
    expect(items[0]).toMatchObject({ ageHours: null, slaBreached: false });
  });

  it('asks for oldest-first unless the reviewer names the arrival order', async () => {
    await listAdvertiserKycs({ status: 'PENDING' }, 2, 10, undefined, NOW);
    expect(repository.findPage).toHaveBeenCalledWith({ status: 'PENDING' }, 2, 10, undefined);

    await listAdvertiserKycs({}, 1, 10, 'newest', NOW);
    expect(repository.findPage).toHaveBeenLastCalledWith({}, 1, 10, 'newest');
  });
});

describe('Lot G (Q127/142): the escalated facet', () => {
  it('counts the escalated across the queue, carries it on counts, and passes the filter through', async () => {
    repository.countEscalated.mockResolvedValue(3);
    const page = await listAdvertiserKycs({ status: 'PENDING', escalated: true }, 1, 20, undefined, NOW);
    expect(page.escalated).toBe(3);
    expect(page.counts['escalated']).toBe(3);
    expect(repository.findPage).toHaveBeenCalledWith({ status: 'PENDING', escalated: true }, 1, 20, undefined);
    expect(repository.countEscalated).toHaveBeenCalledWith({ status: 'PENDING', escalated: true });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E10-2: the Pricing tab's history as a first-class read.
 *
 * `GET /listings/:id/reprice-log` is `pricing`'s LISTING_REPRICED_BY_FACTOR
 * audit rows on the listing, newest first, unpacked into
 * `{ at, factor, from, to, by }` — a read over the shared trail, not a second
 * record. A listing that does not exist is a 404, and the read never leaves
 * the listing's own rows.
 */

const { repository, audit } = vi.hoisted(() => ({
  repository: { findById: vi.fn() },
  audit: { findActivityRows: vi.fn(), logActivity: vi.fn() },
}));

/** G10: the kill switches on the routers pass in these tests; the flag itself is pinned through isFeatureEnabled. */
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../pricing', () => ({ suggestedRate: vi.fn(), factorProposals: vi.fn(), activeSurge: vi.fn(), classifySpot: vi.fn(), assertCityAllows: vi.fn() }));
vi.mock('../../rate-cards', () => ({ belowFloorFlags: vi.fn(), assertPublishable: vi.fn(), checkGate: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentProfile: vi.fn() }));
vi.mock('../../access-grants', () => ({ holdsLiveGrant: vi.fn() }));
vi.mock('../../feature-flags', () => ({ isFeatureEnabled: vi.fn(), ...passThroughFeatureGates() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  ...audit,
}));

import { REPRICE_LOG_ACTION, REPRICE_LOG_LIMIT, repriceLog } from '../listings.service';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'act_1',
  createdAt: new Date('2026-09-12T06:30:00.000Z'),
  userId: 'usr_ops',
  user: { id: 'usr_ops', name: 'Priya', email: 'priya@adx.in' },
  action: REPRICE_LOG_ACTION,
  module: 'pricing',
  targetType: 'Listing',
  targetId: 'lst_1',
  requestId: null,
  ipAddress: null,
  metadata: { factorId: 'fac_1', factorName: 'Corner site', applied: true, mode: 'BINDING', binding: true, surgeId: null },
  diff: { ratePerDay: { before: '10000.00', after: '11500.00' } },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue({ id: 'lst_1', status: 'ACTIVE' });
  audit.findActivityRows.mockResolvedValue([
    row(),
    row({
      id: 'act_0',
      createdAt: new Date('2026-09-01T06:30:00.000Z'),
      userId: 'usr_gone',
      user: null,
      metadata: { factorId: 'fac_2', factorName: 'Festival surge', applied: false, mode: 'BINDING', binding: true, surgeId: 'srg_1' },
      diff: { ratePerDay: { before: null, after: '10000.00' } },
    }),
  ]);
});

describe('repriceLog', () => {
  it('reads the listing reprice rows off the audit trail, newest first, shaped for the Pricing tab', async () => {
    const log = await repriceLog('lst_1');
    expect(audit.findActivityRows).toHaveBeenCalledWith(
      { action: REPRICE_LOG_ACTION, targetType: 'Listing', targetId: 'lst_1' },
      { skip: 0, take: REPRICE_LOG_LIMIT, sort: 'newest' },
    );
    expect(log).toEqual([
      {
        at: new Date('2026-09-12T06:30:00.000Z'),
        factor: { id: 'fac_1', name: 'Corner site', applied: true, mode: 'BINDING', surgeId: null },
        from: '10000.00',
        to: '11500.00',
        by: { id: 'usr_ops', name: 'Priya' },
      },
      {
        at: new Date('2026-09-01T06:30:00.000Z'),
        factor: { id: 'fac_2', name: 'Festival surge', applied: false, mode: 'BINDING', surgeId: 'srg_1' },
        from: null,
        to: '10000.00',
        by: { id: 'usr_gone', name: null },
      },
    ]);
  });

  it('is a 404 for a listing that does not exist and reads nothing', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(repriceLog('lst_missing')).rejects.toMatchObject({ statusCode: 404 });
    expect(audit.findActivityRows).not.toHaveBeenCalled();
  });

  it('survives a row with no metadata or diff', async () => {
    audit.findActivityRows.mockResolvedValue([row({ metadata: null, diff: null })]);
    const [entry] = await repriceLog('lst_1');
    expect(entry).toMatchObject({ factor: { id: null, name: null, applied: null }, from: null, to: null });
  });
});

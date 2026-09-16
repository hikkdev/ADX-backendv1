import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N3-B — the publisher queue's rows and chips at the service.
 *
 * A party with no record is AWAITING_DOCUMENTS with no age; a requested
 * one is REQUESTED; a submitted one is PENDING and aged; the chips count
 * publishers per state (`awaitingDocuments` among them) with the state
 * facet — and its aliases — removed, beside `escalated` and `requested`.
 */

const { repository } = vi.hoisted(() => ({
  repository: { findKycQueue: vi.fn(), countKycQueue: vi.fn<(filter: { state?: string; requested?: boolean }) => Promise<number>>(async () => 0), findKycDetail: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn(), findAgentProfile: vi.fn(), getAgentWithUser: vi.fn() }));
vi.mock('../../access-grants', () => ({ liveGrantFor: vi.fn(), holdsLiveGrant: vi.fn() }));
vi.mock('../../users', () => ({ getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn(), notify: vi.fn() }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })) }));
vi.mock('../../kyc', () => ({
  listDocumentReviews: vi.fn(async () => []),
  listDocumentReviewsWithReviewer: vi.fn(async () => []),
  kycUserLabels: vi.fn(async (ids: readonly (string | null | undefined)[]) => new Map(ids.filter((id): id is string => !!id).map((id) => [id, { id, name: null }]))),
  livenessStateFor: vi.fn(async () => null),
  kycCaseExtras: vi.fn(async () => ({})),
}));

import { listKycQueue } from '../publishers.service';

const NOW = new Date('2026-09-14T22:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const publisher = (id: string, kyc: Record<string, unknown> | null, over: Record<string, unknown> = {}) => ({
  id,
  name: `Publisher ${id}`,
  kycStatus: 'PENDING',
  createdAt: hoursAgo(1),
  agent: null,
  kyc,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findKycQueue.mockResolvedValue([]);
  repository.countKycQueue.mockResolvedValue(0);
});

describe('the rows', () => {
  it('a party with no record is AWAITING_DOCUMENTS with no age; requested is REQUESTED; submitted is PENDING and aged; decided is its decision', async () => {
    repository.findKycQueue.mockResolvedValue([
      publisher('pub_sub', { id: 'pk_sub', status: 'PENDING', submittedAt: hoursAgo(72), requestedAt: null }),
      publisher('pub_req', { id: 'pk_req', status: 'PENDING', submittedAt: null, requestedAt: hoursAgo(2), requestedById: 'usr_admin', requestedChannel: 'DIGIO' }),
      publisher('pub_new', null),
      publisher('pub_untouched', { id: 'pk_untouched', status: 'PENDING', submittedAt: null, requestedAt: null }),
      publisher('pub_ok', { id: 'pk_ok', status: 'VERIFIED', submittedAt: hoursAgo(500) }, { kycStatus: 'VERIFIED' }),
    ]);
    const page = await listKycQueue({}, NOW);
    expect(page.items.map((row) => [row.id, row.state, row.kycId, row.ageHours, row.slaBreached])).toEqual([
      ['pub_sub', 'PENDING', 'pk_sub', 72, true],
      ['pub_req', 'REQUESTED', 'pk_req', null, false],
      ['pub_new', 'AWAITING_DOCUMENTS', null, null, false],
      ['pub_untouched', 'AWAITING_DOCUMENTS', 'pk_untouched', null, false],
      ['pub_ok', 'VERIFIED', 'pk_ok', null, false],
    ]);
    expect(page.items[1]).toMatchObject({ requestedBy: { id: 'usr_admin', name: null } });
    expect(page.total).toBe(5);
    expect(page.breached).toBe(1);
  });
});

describe('the chips', () => {
  it('count publishers per state with the state facet and its aliases removed, `awaitingDocuments` beside `escalated` and `requested`', async () => {
    repository.countKycQueue.mockImplementation(async (filter: { state?: string; requested?: boolean }) =>
      filter.state === 'AWAITING_DOCUMENTS' ? 7 : filter.state === 'PENDING' ? 3 : filter.requested ? 2 : 0,
    );
    const page = await listKycQueue({ status: 'PENDING', assignedTo: 'me', viewerUserId: 'usr_ops' }, NOW);
    expect(page.counts).toEqual({
      AWAITING_DOCUMENTS: 7,
      awaitingDocuments: 7,
      REQUESTED: 0,
      PENDING: 3,
      NEEDS_INFO: 0,
      REJECTED: 0,
      VERIFIED: 0,
      escalated: 0,
      requested: 2,
    });
    // The page itself keeps the alias; each chip strips the state, the alias and the requested switch, keeping the rest.
    expect(repository.findKycQueue).toHaveBeenCalledWith({ status: 'PENDING', assignedToId: 'usr_ops' });
    expect(repository.countKycQueue).toHaveBeenCalledWith({ status: undefined, state: 'AWAITING_DOCUMENTS', requested: undefined, assignedToId: 'usr_ops' });
    expect(repository.countKycQueue).toHaveBeenCalledWith({ status: undefined, state: undefined, requested: true, assignedToId: 'usr_ops' });
  });
});

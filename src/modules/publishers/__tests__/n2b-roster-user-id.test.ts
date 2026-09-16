import { describe, expect, it, vi } from 'vitest';

/**
 * N2-B — the publisher roster rows carry `userId` (the app login behind the
 * publisher, null until they have one), on both shapes of `GET /publishers`:
 * the bare array (`?q=`, `?category=`) and the list contract (`?page=`). The
 * console opens the desk's KYC paths by that id — a request or a recording
 * before any row exists is keyed by the party's user — so the roster has to
 * say it. The rows are the repository's full rows; nothing is projected off.
 */

const { repository } = vi.hoisted(() => ({
  repository: { findAllForAdmin: vi.fn(), findRosterPage: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn(), findAgentProfile: vi.fn(), getAgentWithUser: vi.fn(), agentExists: vi.fn() }));
vi.mock('../../kyc', () => ({
  kycUserLabels: vi.fn(async () => new Map()),
  kycCaseExtras: vi.fn(),
  listDocumentReviewsWithReviewer: vi.fn(),
  livenessStateFor: vi.fn(),
  flaggedDocuments: vi.fn(),
  clearDocumentReviews: vi.fn(),
  flagDocuments: vi.fn(),
  recordDocumentReview: vi.fn(),
  hasSubmittedLiveness: vi.fn(),
  maskPan: vi.fn(),
  trimDigioPayload: vi.fn(),
  resolveManifestVersion: vi.fn(),
  escalateKyc: vi.fn(),
  assignCaseSchema: {},
  bulkAssignSchema: {},
  documentDecisionSchema: {},
  reuploadRequestSchema: {},
}));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })) }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn(), notify: vi.fn() }));

import { getAllPublishers, getPublisherRoster } from '../publishers.service';

const publisher = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  displayId: 'PUB-1209-2601',
  userId: 'usr_pub_1',
  name: 'Suraj Kumar Prints',
  mobile: '+919845012210',
  city: 'Bengaluru',
  kycStatus: 'VERIFIED',
  kyc: null,
  listings: [],
  user: null,
  ...over,
});

describe('GET /publishers — userId on every roster row', () => {
  it('the bare array carries userId, null where the publisher has no login yet', async () => {
    repository.findAllForAdmin.mockResolvedValue([publisher(), publisher({ id: 'pub_2', userId: null })]);
    const rows = await getAllPublishers(undefined, 'suraj');
    expect(rows[0]).toMatchObject({ id: 'pub_1', userId: 'usr_pub_1' });
    expect(rows[1]).toMatchObject({ id: 'pub_2', userId: null });
  });

  it('the list contract carries userId on each item', async () => {
    repository.findRosterPage.mockResolvedValue({ items: [publisher()], total: 1, counts: { PENDING: 0, VERIFIED: 1, REJECTED: 0, NEEDS_INFO: 0 } });
    const page = await getPublisherRoster({ q: 'suraj', page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ id: 'pub_1', userId: 'usr_pub_1' });
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 20 });
  });
});

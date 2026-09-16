import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G11-1: the escalation by name on the publisher KYC queue —
 * `escalatedTo` / `escalatedBy` as `{ id, name } | null` beside the ids on
 * `kyc`, inside the one label lookup the assignee already rides. The case
 * read gets both from `kyc.kycCaseExtras` (pinned in `kyc`'s own suite).
 */

const { repository, kyc } = vi.hoisted(() => ({
  repository: { findKycQueue: vi.fn(), countKycQueue: vi.fn(async () => 0), findKycDetail: vi.fn() },
  kyc: {
    listDocumentReviews: vi.fn(async () => []),
    listDocumentReviewsWithReviewer: vi.fn(async () => []),
    livenessStateFor: vi.fn(async () => null),
    kycUserLabels: vi.fn(async (ids: readonly (string | null | undefined)[]) => {
      const names: Record<string, string> = { usr_priya: 'Priya', usr_comp: 'Compliance Desk' };
      return new Map(ids.filter((id): id is string => !!id).map((id) => [id, { id, name: names[id] ?? null }]));
    }),
    kycCaseExtras: vi.fn(async () => ({ ageHours: 3, slaBreached: false, slaHours: 48, reviewedBy: null, assignedTo: null, recordedBy: null, escalatedTo: null, escalatedBy: null })),
  },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn(), findAgentProfile: vi.fn(), getAgentWithUser: vi.fn() }));
vi.mock('../../access-grants', () => ({ liveGrantFor: vi.fn(), holdsLiveGrant: vi.fn() }));
vi.mock('../../users', () => ({ getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })) }));
vi.mock('../../kyc', () => kyc);

import { listKycQueue } from '../publishers.service';

const now = new Date('2026-09-14T12:00:00.000Z');
const row = (id: string, kycOver: Record<string, unknown>) => ({
  id,
  name: `Publisher ${id}`,
  userId: `usr_${id}`,
  agent: null,
  kyc: { id: `kyc_${id}`, status: 'PENDING', submittedAt: now, assignedToId: null, escalatedAt: null, escalatedToUserId: null, escalatedById: null, ...kycOver },
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findKycQueue.mockResolvedValue([]);
});

describe('GET /publishers/kyc-queue — escalatedTo / escalatedBy on every row', () => {
  it('names both from one lookup, beside the assignee', async () => {
    repository.findKycQueue.mockResolvedValue([
      row('a', { assignedToId: 'usr_priya', escalatedAt: now, escalatedToUserId: 'usr_comp', escalatedById: 'usr_priya' }),
      row('b', {}),
      row('c', { escalatedAt: now, escalatedToUserId: 'usr_gone', escalatedById: 'usr_priya' }),
    ]);
    const { items } = await listKycQueue({}, now);
    expect(kyc.kycUserLabels).toHaveBeenCalledTimes(1);
    expect(items.map((item) => [item.id, item.assignedTo, item.escalatedTo, item.escalatedBy])).toEqual([
      ['a', { id: 'usr_priya', name: 'Priya' }, { id: 'usr_comp', name: 'Compliance Desk' }, { id: 'usr_priya', name: 'Priya' }],
      ['b', null, null, null],
      ['c', null, { id: 'usr_gone', name: null }, { id: 'usr_priya', name: 'Priya' }],
    ]);
  });

  it('a publisher with no KYC row yet has nobody on it', async () => {
    repository.findKycQueue.mockResolvedValue([{ ...row('d', {}), kyc: null }]);
    const { items } = await listKycQueue({}, now);
    expect(items[0]).toMatchObject({ assignedTo: null, escalatedTo: null, escalatedBy: null });
  });
});

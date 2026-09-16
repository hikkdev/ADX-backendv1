import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D7 — the KYC queue the console reviews, including the people who arrived
 * with no agent attached.
 *
 * Self-onboarding (DR 08) means a publisher can submit documents with nobody
 * from ADX having met them; those rows used to be invisible to ops, because
 * every publisher list on the API was an agent's own. This is the ADMIN
 * queue: what is waiting, who brought them (or nobody), and one case with
 * its documents and its agent for the workbench.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findKycQueue: vi.fn(),
    countKycQueue: vi.fn(async () => 0),
    findKycDetail: vi.fn(),
  },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn(), findAgentProfile: vi.fn(), getAgentWithUser: vi.fn() }));
vi.mock('../../access-grants', () => ({ liveGrantFor: vi.fn(), holdsLiveGrant: vi.fn() }));
vi.mock('../../users', () => ({ getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../kyc', () => ({
  listDocumentReviews: vi.fn(async () => []),
  // E10-1: the case read names the reviewer per tile; the queue names the assignee per row.
  listDocumentReviewsWithReviewer: vi.fn(async () => []),
  kycUserLabels: vi.fn(async (ids: readonly (string | null | undefined)[]) =>
    new Map(ids.filter((id): id is string => !!id).map((id) => [id, { id, name: null }])),
  ),
  livenessStateFor: vi.fn(async () => null),
  kycCaseExtras: vi.fn(async (row: { assignedToId?: string | null } | null) => ({
    ageHours: row ? 3 : null,
    slaBreached: false,
    slaHours: 48,
    reviewedBy: null,
    assignedTo: row?.assignedToId ? { id: row.assignedToId, name: 'Priya' } : null,
    recordedBy: null,
  })),
}));

import { getKycCase, listKycQueue } from '../publishers.service';
import { kycQueueQuerySchema } from '../publishers.schema';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findKycQueue.mockResolvedValue([]);
  repository.findKycDetail.mockResolvedValue(null);
});

describe('the query', () => {
  it('takes a status and the self-onboarded switch, upper-cased and coerced', () => {
    expect(kycQueueQuerySchema.parse({})).toEqual({});
    expect(kycQueueQuerySchema.parse({ status: 'pending', unassigned: 'true' })).toEqual({ status: 'PENDING', unassigned: true });
    expect(kycQueueQuerySchema.safeParse({ status: 'MAYBE' }).success).toBe(false);
  });
});

describe('listKycQueue', () => {
  it('asks for submitted rows, filtered as ops asked', async () => {
    await listKycQueue({ status: 'PENDING', unassigned: true });
    expect(repository.findKycQueue).toHaveBeenCalledWith({ status: 'PENDING', unassigned: true });
  });
});

describe('getKycCase', () => {
  it('returns the case with its agent, or 404', async () => {
    repository.findKycDetail.mockResolvedValue({ id: 'pub_1', kyc: { status: 'PENDING', assignedToId: 'usr_ops' }, agent: null });
    // E7-3: the age against the SLA and the assignee by name ride on the case.
    expect(await getKycCase('pub_1')).toMatchObject({
      id: 'pub_1',
      agent: null,
      ageHours: 3,
      slaBreached: false,
      slaHours: 48,
      assignedTo: { id: 'usr_ops', name: 'Priya' },
    });
    repository.findKycDetail.mockResolvedValue(null);
    await expect(getKycCase('pub_x')).rejects.toMatchObject({ statusCode: 404 });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot G (Q127/142) — escalation on the publisher KYC queue.
 *
 * The body of an escalation is `kyc`'s; what is pinned here is the
 * publisher side of it: the queue takes `?escalated=true|false`, carries
 * the escalated count (and `counts.escalated`) across the queue whatever
 * facet is applied, and the desk's escalate door checks the case exists,
 * hands it to `kyc.escalateKyc` as the reviewer, and answers the case as
 * the workbench draws it.
 */

const { repository, kyc } = vi.hoisted(() => ({
  repository: {
    findKycQueue: vi.fn(),
    countKycQueue: vi.fn(async () => 0),
    findKycDetail: vi.fn(),
  },
  kyc: {
    escalateKyc: vi.fn(async () => ({ party: 'PUBLISHER', kycId: 'pkyc_1', escalatedToUserId: 'usr_comp' })),
    listDocumentReviews: vi.fn(async () => []),
    listDocumentReviewsWithReviewer: vi.fn(async () => []),
    kycUserLabels: vi.fn(async (ids: readonly (string | null | undefined)[]) => new Map(ids.filter((id): id is string => !!id).map((id) => [id, { id, name: null }]))),
    livenessStateFor: vi.fn(async () => null),
    kycCaseExtras: vi.fn(async () => ({ ageHours: 3, slaBreached: false, slaHours: 48, reviewedBy: null, assignedTo: null, recordedBy: null })),
  },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn(), findAgentProfile: vi.fn(), getAgentWithUser: vi.fn() }));
vi.mock('../../access-grants', () => ({ liveGrantFor: vi.fn(), holdsLiveGrant: vi.fn() }));
vi.mock('../../users', () => ({ getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn(), notify: vi.fn() }));
vi.mock('../../uploads', () => ({ fileIdFromUrl: vi.fn(), purgeStoredFile: vi.fn() }));
vi.mock('../../kyc', () => kyc);

import { listKycQueue } from '../publishers.service';
import { escalateKycCase } from '../kyc/kyc-desk.service';
import { kycQueueQuerySchema } from '../publishers.schema';

const now = new Date('2026-09-14T04:00:00.000Z');
const row = (id: string, escalatedAt: Date | null) => ({
  id,
  name: `Publisher ${id}`,
  userId: `usr_${id}`,
  agentId: null,
  kyc: { id: `kyc_${id}`, status: 'PENDING', submittedAt: new Date(now.getTime() - 3600_000), assignedToId: null, escalatedAt },
  agent: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findKycQueue.mockResolvedValue([]);
  repository.findKycDetail.mockResolvedValue(row('pub_1', null));
});

describe('the query', () => {
  it('takes escalated=true|false, coerced', () => {
    expect(kycQueueQuerySchema.parse({ escalated: 'true' })).toEqual({ escalated: true });
    expect(kycQueueQuerySchema.parse({ escalated: 'false' })).toEqual({ escalated: false });
    expect(kycQueueQuerySchema.safeParse({ escalated: 'maybe' }).success).toBe(false);
  });
});

describe('listKycQueue', () => {
  it('counts the escalated over the queue it lists, and carries it on counts', async () => {
    repository.findKycQueue.mockResolvedValue([row('a', now), row('b', null), row('c', now)]);
    const page = await listKycQueue({ status: 'PENDING' }, now);
    expect(repository.findKycQueue).toHaveBeenCalledTimes(1);
    expect(page.escalated).toBe(2);
    // N3-B: the six state chips ride `counts` beside `escalated` and `requested`.
    expect(page.counts).toMatchObject({ escalated: 2, requested: 0, AWAITING_DOCUMENTS: 0, awaitingDocuments: 0 });
    expect(page.items).toHaveLength(3);
  });

  it('passes the escalated facet through, and still counts the escalated across the whole queue', async () => {
    repository.findKycQueue.mockImplementation(async (filter: { escalated?: boolean }) =>
      filter.escalated === true ? [row('a', now), row('c', now)] : filter.escalated === false ? [row('b', null)] : [row('a', now), row('b', null), row('c', now)],
    );
    const page = await listKycQueue({ status: 'PENDING', escalated: false }, now);
    expect(repository.findKycQueue).toHaveBeenCalledWith(expect.objectContaining({ status: 'PENDING', escalated: false }));
    expect(page.items.map((item) => item.id)).toEqual(['b']);
    expect(page.escalated).toBe(2);
  });
});

describe('the desk door', () => {
  it('checks the case exists, escalates as the reviewer through kyc, and answers the case', async () => {
    const result = await escalateKycCase('pub_1', { reason: 'Aadhaar looks edited' }, 'usr_ops');
    expect(kyc.escalateKyc).toHaveBeenCalledWith({ party: 'PUBLISHER', publisherId: 'pub_1' }, { reason: 'Aadhaar looks edited', byUserId: 'usr_ops', req: undefined }, expect.any(Date));
    expect(result).toMatchObject({ id: 'pub_1', ageHours: 3, documentReviews: [] });
  });

  it('404s a publisher with no KYC record, before the escalation', async () => {
    repository.findKycDetail.mockResolvedValue({ ...row('pub_1', null), kyc: null });
    await expect(escalateKycCase('pub_1', { reason: 'x' }, 'usr_ops')).rejects.toMatchObject({ statusCode: 404 });
    expect(kyc.escalateKyc).not.toHaveBeenCalled();
  });
});

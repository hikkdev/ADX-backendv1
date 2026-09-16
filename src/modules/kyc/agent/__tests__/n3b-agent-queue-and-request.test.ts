import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N3-B — agents in the KYC queue from the moment they are onboarded, and the
 * one-click Digio request beside the three parties' request routes.
 *
 * What is pinned: `GET /agent-kyc` lists every AgentProfile with its state
 * (AWAITING_DOCUMENTS with no record, REQUESTED after the ask, PENDING once
 * recorded) and `meta.counts` per state; `status=` is the alias of `state=`;
 * `POST /agent-kyc/:agentId/request` defaults to DIGIO, opens a session on
 * the agent's behalf with the `adx-agt-` reference, stamps the request,
 * tells the agent (KYC_REQUESTED, the agent deep link), audits
 * AGENT_KYC_REQUESTED, is 404 for no agent and 409 once verified; Digio's
 * answer lands on the agent's record (method DIGIO, VERIFIED / REJECTED,
 * submittedAt stamped) and tells the agent (KYC_DECISION).
 */

type AnyFn = (...args: any[]) => any;

const { repository, digio, notifications, audit } = vi.hoisted(() => ({
  repository: {
    findPage: vi.fn<AnyFn>(),
    countByState: vi.fn<AnyFn>(),
    findByAgentId: vi.fn<AnyFn>(),
    findAgentContact: vi.fn<AnyFn>(),
    record: vi.fn<AnyFn>(),
    review: vi.fn<AnyFn>(),
    requestKyc: vi.fn<AnyFn>(),
    upsertDigio: vi.fn<AnyFn>(),
    findByDigioRequestId: vi.fn<AnyFn>(),
    applyDigioWebhook: vi.fn<AnyFn>(),
  },
  digio: { requestDigioKyc: vi.fn<AnyFn>() },
  notifications: { notify: vi.fn<AnyFn>(async () => ({ notificationId: 'ntf_1', templateKey: 'kyc-requested', deliveries: [] })), createNotification: vi.fn<AnyFn>() },
  audit: { logActivity: vi.fn<AnyFn>(), auditDiff: vi.fn<AnyFn>(() => ({})) },
}));

vi.mock('../prisma-agent-kyc.repository', () => ({ prismaAgentKycRepository: repository }));
vi.mock('../../../../shared/integrations/digio-client', () => digio);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../../agents', () => ({ agentExists: vi.fn(async () => true), findAgentProfile: vi.fn() }));
vi.mock('../../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })) }));

import { AGENT_KYC_DEEP_LINK, listAgentKycs, requestAgentKyc } from '../agent-kyc.service';
import { handleAgentDigioWebhook, initiateAgentDigioKyc } from '../agent-digio.service';
import { listAgentKycsHandler } from '../agent-kyc.controller';

const NOW = new Date('2026-09-14T22:00:00.000Z');
const agent = { id: 'agt_1', userId: 'usr_agt', displayId: 'AGT-1009-2601', user: { name: 'Rahul', email: 'rahul@example.in', mobile: '+919812340001' } };
const slice = { id: 'agt_1', userId: 'usr_agt', displayId: 'AGT-1009-2601', city: 'Pune', createdAt: NOW, user: { name: 'Rahul', mobile: '+919812340001', email: 'rahul@example.in' } };
const counts = { AWAITING_DOCUMENTS: 4, REQUESTED: 1, PENDING: 2, NEEDS_INFO: 0, REJECTED: 0, VERIFIED: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findPage.mockResolvedValue({ items: [], total: 0 });
  repository.countByState.mockResolvedValue(counts);
  repository.findAgentContact.mockImplementation(async (id: string) => (id === 'agt_1' ? agent : null));
  repository.findByAgentId.mockResolvedValue(null);
  repository.requestKyc.mockImplementation(async (agentId: string, stamp: Record<string, unknown>) => ({ id: 'akyc_1', agentId, status: 'PENDING', submittedAt: null, requestedAt: stamp['at'], requestedById: stamp['requestedById'], requestedChannel: stamp['requestedChannel'], agent: slice }));
  repository.upsertDigio.mockResolvedValue({ id: 'akyc_1' });
  digio.requestDigioKyc.mockResolvedValue({ kycId: 'dg_agt_1', accessToken: 'tok', validTill: '2026-09-16T00:00:00.000Z', sdkUrl: 'https://app.digio.in/#dg_agt_1?token=tok', mock: false });
});

describe('GET /agent-kyc — every agent', () => {
  it('answers the rows with their state and the counts per state in meta; `status=` is the alias of `state=`; `q=` rides along', async () => {
    repository.findPage.mockResolvedValue({
      items: [
        { id: 'agt_new', agentId: 'agt_new', kycId: null, state: 'AWAITING_DOCUMENTS', status: null, submittedAt: null, agent: slice },
        { id: 'akyc_1', agentId: 'agt_1', kycId: 'akyc_1', state: 'REQUESTED', status: 'PENDING', submittedAt: null, requestedAt: NOW, agent: slice },
        { id: 'akyc_2', agentId: 'agt_2', kycId: 'akyc_2', state: 'PENDING', status: 'PENDING', submittedAt: NOW, agent: slice },
      ],
      total: 3,
    });
    const { items, meta } = await listAgentKycs({ status: 'PENDING' }, 1, 20);
    expect(items.map((row) => row.state)).toEqual(['AWAITING_DOCUMENTS', 'REQUESTED', 'PENDING']);
    expect(meta).toEqual({ page: 1, pageSize: 20, total: 3, totalPages: 1, counts: { ...counts, awaitingDocuments: 4 } });
    expect(repository.countByState).toHaveBeenCalledWith({ status: undefined, state: undefined });

    const res = { json: vi.fn() } as never;
    await listAgentKycsHandler({ query: { state: 'awaiting_documents', q: 'Rahul' }, user: { sub: 'usr_admin' } } as never, res);
    expect(repository.findPage).toHaveBeenLastCalledWith({ state: 'AWAITING_DOCUMENTS', q: 'Rahul' }, 1, 20);
    await listAgentKycsHandler({ query: { status: 'VERIFIED' }, user: { sub: 'usr_admin' } } as never, res);
    expect(repository.findPage).toHaveBeenLastCalledWith({ status: 'VERIFIED' }, 1, 20);
  });
});

describe('POST /agent-kyc/:agentId/request — the one click', () => {
  it('DIGIO (the default): opens the session with the agent’s own contact and the adx-agt- reference, stamps the request, tells the agent, audits', async () => {
    const result = await requestAgentKyc('agt_1', { channel: 'DIGIO', note: 'Before payday' }, 'usr_admin', undefined, NOW);
    expect(digio.requestDigioKyc).toHaveBeenCalledWith({ referenceId: `adx-agt-agt_1-${NOW.getTime()}`, customerName: 'Rahul', customerEmail: 'rahul@example.in', customerMobile: '+919812340001' });
    // The session on the agent's row; submittedAt waits for the webhook, so the queue reads REQUESTED.
    expect(repository.upsertDigio).toHaveBeenCalledWith('agt_1', { method: 'DIGIO', digioRequestId: 'dg_agt_1', digioReferenceId: `adx-agt-agt_1-${NOW.getTime()}`, digioStatus: 'pending' });
    expect(repository.requestKyc).toHaveBeenCalledWith('agt_1', { requestedById: 'usr_admin', requestedChannel: 'DIGIO', at: NOW });
    expect(notifications.notify).toHaveBeenCalledWith(
      'KYC_REQUESTED',
      'usr_agt',
      { partyName: 'Rahul', channel: 'Digio', note: 'Before payday', deepLink: AGENT_KYC_DEEP_LINK },
      expect.objectContaining({ inApp: expect.objectContaining({ type: 'KYC', relatedId: 'akyc_1' }) }),
    );
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'AGENT_KYC_REQUESTED',
      expect.objectContaining({ targetType: 'AgentKyc', targetId: 'akyc_1', module: 'kyc', metadata: { agentId: 'agt_1', channel: 'DIGIO', note: 'Before payday', digioKycId: 'dg_agt_1' } }),
    );
    expect(result).toMatchObject({ kyc: { requestedChannel: 'DIGIO' }, digio: { kycId: 'dg_agt_1' }, notified: true });
  });

  it('MANUAL only stamps, tells and audits; 404 for no agent; 409 once verified — nothing sent', async () => {
    const result = await requestAgentKyc('agt_1', { channel: 'MANUAL' }, 'usr_admin', undefined, NOW);
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    expect(result.digio).toBeNull();
    expect(notifications.notify).toHaveBeenCalledWith('KYC_REQUESTED', 'usr_agt', expect.objectContaining({ channel: 'at the ADX desk' }), expect.anything());

    await expect(requestAgentKyc('agt_x', { channel: 'DIGIO' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });

    vi.clearAllMocks();
    repository.findAgentContact.mockResolvedValue(agent);
    repository.findByAgentId.mockResolvedValue({ id: 'akyc_1', agentId: 'agt_1', status: 'VERIFIED' });
    await expect(requestAgentKyc('agt_1', { channel: 'DIGIO' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    expect(repository.requestKyc).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    await expect(initiateAgentDigioKyc(agent)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('Digio’s answer on the agent’s record', () => {
  it('claims the agent’s request id, applies VERIFIED with method DIGIO and a submittedAt, and tells the agent; leaves a stranger’s id alone', async () => {
    repository.findByDigioRequestId.mockResolvedValue({ id: 'akyc_1', agentId: 'agt_1', submittedAt: null, agent: slice });
    repository.applyDigioWebhook.mockResolvedValue({ id: 'akyc_1' });
    expect(await handleAgentDigioWebhook({ id: 'dg_agt_1', customer_identifier: 'rahul@example.in', status: 'approved', completed_at: '2026-09-15T08:00:00.000Z' }, NOW)).toBe(true);
    expect(repository.applyDigioWebhook).toHaveBeenCalledWith('akyc_1', {
      digioStatus: 'approved',
      digioPayload: expect.objectContaining({ id: 'dg_agt_1' }),
      digioVerifiedAt: new Date('2026-09-15T08:00:00.000Z'),
      status: 'VERIFIED',
      reviewedAt: NOW,
      rejectionReason: undefined,
      submittedAt: new Date('2026-09-15T08:00:00.000Z'),
    });
    expect(notifications.notify).toHaveBeenCalledWith('KYC_DECISION', 'usr_agt', expect.objectContaining({ partyName: 'Rahul', decision: 'verified' }), expect.objectContaining({ inApp: expect.objectContaining({ title: 'Identity verified', relatedId: 'akyc_1' }) }));

    vi.clearAllMocks();
    repository.findByDigioRequestId.mockResolvedValue({ id: 'akyc_1', agentId: 'agt_1', submittedAt: null, agent: slice });
    repository.applyDigioWebhook.mockResolvedValue({ id: 'akyc_1' });
    await handleAgentDigioWebhook({ id: 'dg_agt_1', customer_identifier: 'x', status: 'rejected', message: 'Face mismatch' }, NOW);
    expect(repository.applyDigioWebhook).toHaveBeenCalledWith('akyc_1', expect.objectContaining({ status: 'REJECTED', rejectionReason: 'Face mismatch', submittedAt: NOW }));
    expect(notifications.notify).toHaveBeenCalledWith('KYC_DECISION', 'usr_agt', expect.objectContaining({ decision: 'not verified', reason: 'Face mismatch' }), expect.anything());

    repository.findByDigioRequestId.mockResolvedValue(null);
    expect(await handleAgentDigioWebhook({ id: 'dg_pub', customer_identifier: 'x', status: 'approved' })).toBe(false);
  });
});

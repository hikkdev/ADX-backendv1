import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N3-B — the agent queue at the query: every AgentProfile (there is no
 * mirror column on the profile, so no base), left-joined to its record,
 * `state=` narrowing (AWAITING_DOCUMENTS being "no record or an untouched
 * one"), `q=` over the agent, the chips one count per state, and the row
 * shape — a fresh agent as AWAITING_DOCUMENTS with `agentId` set and every
 * record column null.
 */

type AnyFn = (...args: any[]) => any;

const { prisma } = vi.hoisted(() => ({
  prisma: {
    agentProfile: { findMany: vi.fn<AnyFn>(async () => []), count: vi.fn<AnyFn>(async () => 0), findUnique: vi.fn<AnyFn>() },
    agentKyc: { findUnique: vi.fn<AnyFn>(), upsert: vi.fn<AnyFn>(), update: vi.fn<AnyFn>(), findFirst: vi.fn<AnyFn>() },
  },
}));

vi.mock('../../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaAgentKycRepository as repository } from '../prisma-agent-kyc.repository';

const NOW = new Date('2026-09-14T22:00:00.000Z');
const slice = { id: 'agt_new', userId: 'usr_new', displayId: 'AGT-1', city: 'Pune', createdAt: NOW, user: { name: 'Rahul', mobile: '+91', email: null } };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.agentProfile.findMany.mockResolvedValue([]);
  prisma.agentProfile.count.mockResolvedValue(0);
});

describe('the agent queue is every agent', () => {
  it('a fresh agent is AWAITING_DOCUMENTS — agentId set, kycId null, the record columns null; one with a record is its state', async () => {
    prisma.agentProfile.findMany.mockResolvedValue([
      { ...slice, kyc: null },
      { ...slice, id: 'agt_1', kyc: { id: 'akyc_1', agentId: 'agt_1', status: 'PENDING', submittedAt: NOW, requestedAt: null, method: 'MANUAL' } },
    ]);
    prisma.agentProfile.count.mockResolvedValue(2);
    const { items, total } = await repository.findPage({}, 1, 20);
    expect(total).toBe(2);
    expect(items[0]).toMatchObject({ id: 'agt_new', agentId: 'agt_new', kycId: null, state: 'AWAITING_DOCUMENTS', status: null, submittedAt: null, agent: { id: 'agt_new', displayId: 'AGT-1', user: { name: 'Rahul' } } });
    expect(items[1]).toMatchObject({ id: 'akyc_1', agentId: 'agt_1', kycId: 'akyc_1', state: 'PENDING', submittedAt: NOW });
    expect(prisma.agentProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [] }, orderBy: [{ kyc: { submittedAt: { sort: 'asc', nulls: 'last' } } }, { createdAt: 'asc' }], select: expect.objectContaining({ kyc: true }) }),
    );
  });

  it('`state=` narrows (no mirror: AWAITING_DOCUMENTS is no record or an untouched one); `status=` is the alias; `q=` reaches the agent', async () => {
    await repository.findPage({ state: 'AWAITING_DOCUMENTS', q: 'Rahul' }, 1, 20);
    expect(prisma.agentProfile.findMany.mock.calls[0]![0].where.AND).toEqual([
      { OR: [{ kyc: null }, { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: null } } }] },
      { OR: [{ displayId: { contains: 'Rahul', mode: 'insensitive' } }, { user: { name: { contains: 'Rahul', mode: 'insensitive' } } }, { user: { mobile: { contains: 'Rahul' } } }] },
    ]);
    await repository.findPage({ status: 'REJECTED' }, 1, 20);
    expect(prisma.agentProfile.findMany.mock.calls[1]![0].where.AND).toEqual([{ kyc: { is: { status: 'REJECTED' } } }]);
  });

  it('the chips are one count per state, the state facet and its alias removed', async () => {
    prisma.agentProfile.count.mockImplementation(async ({ where }: { where: { AND: unknown[] } }) => (JSON.stringify(where.AND[0]).includes('"kyc":null') ? 5 : 1));
    expect(await repository.countByState({ state: 'PENDING', status: 'PENDING' })).toEqual({ AWAITING_DOCUMENTS: 5, REQUESTED: 1, PENDING: 1, NEEDS_INFO: 1, REJECTED: 1, VERIFIED: 1 });
    expect(prisma.agentProfile.count).toHaveBeenCalledTimes(6);
  });

  it('the request and the session are upserts on the agent’s row; the recording stamps DESK / MANUAL; Digio’s answer stamps DIGIO', async () => {
    prisma.agentKyc.upsert.mockResolvedValue({});
    await repository.requestKyc('agt_1', { requestedById: 'usr_admin', requestedChannel: 'DIGIO', at: NOW });
    expect(prisma.agentKyc.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { agentId: 'agt_1' }, update: { requestedAt: NOW, requestedById: 'usr_admin', requestedChannel: 'DIGIO' }, create: { agentId: 'agt_1', requestedAt: NOW, requestedById: 'usr_admin', requestedChannel: 'DIGIO' } }),
    );
    await repository.upsertDigio('agt_1', { method: 'DIGIO', digioRequestId: 'dg_1', digioReferenceId: 'adx-agt-agt_1-1', digioStatus: 'pending' });
    expect(prisma.agentKyc.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ where: { agentId: 'agt_1' }, create: expect.objectContaining({ agentId: 'agt_1', digioRequestId: 'dg_1' }) }));
    await repository.record('agt_1', { panNumber: 'ABCDE1234F' }, 'usr_admin');
    expect(prisma.agentKyc.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ recordedById: 'usr_admin', recordedVia: 'DESK', method: 'MANUAL', status: 'PENDING' }), update: expect.objectContaining({ recordedVia: 'DESK', method: 'MANUAL', rejectionReason: null }) }),
    );
    prisma.agentKyc.update.mockResolvedValue({});
    await repository.applyDigioWebhook('akyc_1', { digioStatus: 'approved', digioPayload: { id: 'dg_1' }, status: 'VERIFIED', submittedAt: NOW });
    expect(prisma.agentKyc.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'akyc_1' }, data: expect.objectContaining({ status: 'VERIFIED', method: 'DIGIO', recordedVia: 'DIGIO', recordedById: null, submittedAt: NOW }) }));
    await repository.applyDigioWebhook('akyc_1', { digioStatus: 'rejected', digioPayload: { id: 'dg_1' }, status: 'REJECTED', submittedAt: NOW });
    expect(prisma.agentKyc.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ method: expect.anything() }) }));
  });
});

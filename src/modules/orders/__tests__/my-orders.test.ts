import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Whose orders `GET /orders/my` answers with, and who may read one by id.
 *
 * One endpoint and three queries, so the precedence is the whole behaviour —
 * and it disagreed with the apps. A person can own a spot and also buy
 * advertising; the apps put that person on the publisher home, and this
 * answered their Bookings list with the campaigns they had bought. An explicit
 * `?as=` now lets a screen ask for the other list by name.
 *
 * `GET /orders/:id` was `authenticate` and nothing else: any signed-in user
 * could read any order — the publisher's name, mobile and address included.
 */

const { queries, agents } = vi.hoisted(() => ({
  queries: {
    getOrdersForAdvertiser: vi.fn(),
    getOrdersForPublisher: vi.fn(),
    getOrdersForAgent: vi.fn(),
    getAllOrders: vi.fn(),
    getOrderById: vi.fn(),
  },
  agents: { requireAgentProfile: vi.fn(), findAgentProfile: vi.fn(), dispatchAskFor: vi.fn(async () => ({})), isBelowRequiredGrade: vi.fn(async () => false), agentMeetsGrade: vi.fn(async () => true), getRoutingSettings: vi.fn(async () => ({ bands: { INDIVIDUAL: 'G1', SMALL_AGENCY: 'G2', LARGE_AGENCY: 'G3' }, leadBands: { STANDARD: 'G1', KEY: 'G3', ENTERPRISE: 'G4' }, enforce: true })) },
}));

vi.mock('../orders.queries', () => queries);
vi.mock('../../agents', () => agents);

import { getMyOrdersHandler, getOrderByIdHandler } from '../orders.controller';

const res = () => {
  const sent: { body?: unknown } = {};
  return { json: (body: unknown) => { sent.body = body; }, sent } as any;
};

const req = (roles: string[], query: Record<string, string> = {}, params: Record<string, string> = {}) =>
  ({ user: { sub: 'usr_1', roles }, query, params }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  queries.getOrdersForAdvertiser.mockResolvedValue(['advertiser order']);
  queries.getOrdersForPublisher.mockResolvedValue(['publisher order']);
  queries.getOrdersForAgent.mockResolvedValue(['agent job']);
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1' });
  agents.findAgentProfile.mockResolvedValue({ id: 'agt_1' });
});

describe('GET /orders/my', () => {
  it('answers an advertiser with the orders they placed', async () => {
    const out = res();
    await getMyOrdersHandler(req(['ADVERTISER']), out);
    expect(out.sent.body).toEqual({ success: true, data: ['advertiser order'] });
  });

  it('answers a publisher with the orders on their listings', async () => {
    const out = res();
    await getMyOrdersHandler(req(['PUBLISHER']), out);
    expect(out.sent.body).toEqual({ success: true, data: ['publisher order'] });
  });

  it('answers an agent with the jobs assigned to them', async () => {
    const out = res();
    await getMyOrdersHandler(req(['AGENT_PUBLISHER']), out);
    // The list is paged now, so the query travels with the agent id.
    expect(queries.getOrdersForAgent).toHaveBeenCalledWith('agt_1', expect.objectContaining({ page: 1 }));
    expect(out.sent.body).toEqual({ success: true, data: ['agent job'] });
  });

  /*
   * The disagreement, as a test. Both apps send this person to the publisher
   * home, so the publisher list is the one they are looking at.
   */
  it('gives the publisher list to somebody who is both, matching the app', async () => {
    const out = res();
    await getMyOrdersHandler(req(['ADVERTISER', 'PUBLISHER']), out);
    expect(queries.getOrdersForAdvertiser).not.toHaveBeenCalled();
    expect(out.sent.body).toEqual({ success: true, data: ['publisher order'] });
  });

  it('refuses a role with no order list of its own', async () => {
    await expect(getMyOrdersHandler(req(['SUPPORT']), res())).rejects.toThrow(
      'No order access for your role',
    );
  });

  /* The way out of the precedence: a screen names the list it wants. */
  it('gives the advertiser list to somebody who is both when asked for it by name', async () => {
    const out = res();
    await getMyOrdersHandler(req(['ADVERTISER', 'PUBLISHER'], { as: 'advertiser' }), out);
    expect(queries.getOrdersForPublisher).not.toHaveBeenCalled();
    expect(out.sent.body).toEqual({ success: true, data: ['advertiser order'] });
  });

  it('refuses an explicit list the caller does not hold the role for', async () => {
    await expect(
      getMyOrdersHandler(req(['PUBLISHER'], { as: 'agent' }), res()),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(queries.getOrdersForAgent).not.toHaveBeenCalled();
  });

  it('rejects an `as` it has never heard of rather than guessing', async () => {
    await expect(
      getMyOrdersHandler(req(['PUBLISHER'], { as: 'everyone' }), res()),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('GET /orders/:id', () => {
  const order = (over: Record<string, unknown> = {}) => ({
    id: 'ord_1',
    advertiserId: 'usr_adv',
    agentId: 'agt_holder',
    listing: { publisher: { userId: 'usr_pub' } },
    agentAssignments: [{ agentId: 'agt_offered' }],
    ...over,
  });

  const readAs = async (roles: string[], sub: string, agentProfile: { id: string } | null = null) => {
    agents.findAgentProfile.mockResolvedValue(agentProfile);
    const out = res();
    await getOrderByIdHandler({ user: { sub, roles }, query: {}, params: { id: 'ord_1' } } as any, out);
    return out.sent.body;
  };

  beforeEach(() => {
    queries.getOrderById.mockResolvedValue(order());
  });

  it('is read by the advertiser who placed it', async () => {
    expect(await readAs(['ADVERTISER'], 'usr_adv')).toMatchObject({ success: true });
  });

  it('is read by the publisher whose listing it books', async () => {
    expect(await readAs(['PUBLISHER'], 'usr_pub')).toMatchObject({ success: true });
  });

  it('is read by the agent holding it', async () => {
    expect(await readAs(['AGENT_PUBLISHER'], 'usr_agent', { id: 'agt_holder' })).toMatchObject({ success: true });
  });

  /* The offer stage: `agentId` may still be null while the job sits with an
     offered agent, who has to read it before they can accept it. */
  it('is read by an agent it has been offered to', async () => {
    queries.getOrderById.mockResolvedValue(order({ agentId: null }));
    expect(await readAs(['AGENT_PUBLISHER'], 'usr_agent', { id: 'agt_offered' })).toMatchObject({ success: true });
  });

  it('is read by ADX', async () => {
    expect(await readAs(['ADMIN'], 'usr_admin')).toMatchObject({ success: true });
  });

  it('is refused to a signed-in stranger, even one who is an agent', async () => {
    await expect(readAs(['AGENT_PUBLISHER'], 'usr_other', { id: 'agt_other' })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(readAs(['ADVERTISER'], 'usr_other')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('is still 404 when it does not exist at all', async () => {
    queries.getOrderById.mockResolvedValue(null);
    await expect(readAs(['ADMIN'], 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
  });
});

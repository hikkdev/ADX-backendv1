import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 29 Sep 2026 — the party rosters, made uniform: `GET /agents` takes the
 * cuts every party desk sends under the names every roster uses — the door
 * (`onboardedVia`, the profile's `sourceKind`), the type (the side the agent
 * works), the KYC state and the city — and each row carries the KYC state
 * the queue prints, the side, the person's email and the accounts the agent
 * brought in.
 */

type AnyFn = (...args: any[]) => any;

const { repository, pricing } = vi.hoisted(() => ({
  repository: { findPage: vi.fn<AnyFn>() },
  pricing: {
    cityKeyFor: vi.fn(async (name: string) => (name.toLowerCase() === 'pune' ? { cityId: 'city_pune', slug: 'pune' } : null)),
    assertCityAllows: vi.fn(),
    withCityKey: vi.fn(),
  },
}));

vi.mock('../prisma-agents.repository', () => ({ prismaAgentsRepository: repository }));
vi.mock('../../pricing', () => pricing);

import { getAllAgentsHandler } from '../agents.controller';
import { listAgentsQuerySchema } from '../agents.schema';
import { agentSideOf } from '../agents.service';

const T = new Date('2026-09-07T09:00:00.000Z');
const agent = (over: Record<string, unknown> = {}) => ({
  id: 'agt_1',
  userId: 'usr_1',
  displayId: 'AGT-0709-2601',
  city: 'Pune',
  sourceKind: 'FLEET',
  createdAt: T,
  user: { id: 'usr_1', name: 'Ravi', mobile: '+919000000001', email: 'ravi@example.com', isActive: true, roles: [{ role: 'AGENT_ADVERTISER' }] },
  kyc: { id: 'akyc_1', status: 'PENDING', submittedAt: T, requestedAt: null, requestedChannel: null, method: 'MANUAL' },
  onboardedCount: 6,
  ...over,
});

const call = async (query: Record<string, string>) => {
  const res = { json: vi.fn() };
  await getAllAgentsHandler({ query } as never, res as never);
  return res.json.mock.calls[0]?.[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findPage.mockResolvedValue({ items: [agent()], total: 1 });
});

describe('GET /agents — the cuts every party desk takes', () => {
  it('parses the door, the type and the KYC state case-insensitively', () => {
    expect(listAgentsQuerySchema.parse({ onboardedVia: 'walk_in', type: 'advertiser', kycState: 'needs_info' })).toMatchObject({
      onboardedVia: 'WALK_IN',
      type: 'ADVERTISER',
      kycState: 'NEEDS_INFO',
    });
    expect(listAgentsQuerySchema.safeParse({ onboardedVia: 'AGENT' }).success).toBe(false);
    expect(listAgentsQuerySchema.safeParse({ type: 'BUSINESS' }).success).toBe(false);
  });

  it('hands the door as the source kind and the type as the side, with the city resolved to its key', async () => {
    await call({ search: 'ravi', onboardedVia: 'fleet', type: 'advertiser', kycState: 'pending', city: 'Pune', limit: '200' });
    expect(repository.findPage).toHaveBeenCalledWith(
      { search: 'ravi', sourceKind: 'FLEET', side: 'ADVERTISER', kycState: 'PENDING', city: 'Pune', cityId: 'city_pune' },
      200,
      0,
    );
  });

  it('answers each row with its KYC state, its side and the accounts it brought in — and never the roles', async () => {
    const body = await call({});
    expect(body.meta).toEqual({ total: 1, limit: 50, offset: 0 });
    const [row] = body.data;
    expect(row.kyc).toMatchObject({ state: 'PENDING', kycId: 'akyc_1' });
    expect(row.side).toBe('ADVERTISER');
    expect(row.onboardedCount).toBe(6);
    expect(row.user).toEqual({ id: 'usr_1', name: 'Ravi', mobile: '+919000000001', email: 'ravi@example.com', isActive: true });
  });

  it('reads an agent with no KYC record as awaiting documents', async () => {
    repository.findPage.mockResolvedValue({ items: [agent({ kyc: null })], total: 1 });
    const body = await call({});
    expect(body.data[0].kyc.state).toBe('AWAITING_DOCUMENTS');
  });
});

describe('agentSideOf', () => {
  it('follows the application ladder: publisher unless only the advertiser role is held', () => {
    expect(agentSideOf(['AGENT_PUBLISHER'])).toBe('PUBLISHER');
    expect(agentSideOf(['AGENT_ADVERTISER'])).toBe('ADVERTISER');
    expect(agentSideOf(['AGENT_PUBLISHER', 'AGENT_ADVERTISER'])).toBe('PUBLISHER');
    expect(agentSideOf([])).toBe('PUBLISHER');
  });
});

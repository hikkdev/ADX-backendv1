import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 29 Sep 2026 — the party rosters, made uniform: what `findPage` asks the
 * database for the agent roster. Every cut is one AND part (the city's `OR`
 * and the search's `OR` used to share one object); the search reaches the
 * email, the AGT- id, the city and the phone as the console prints it; the
 * side is the ladder's rule over the roles; the KYC state is the queue's
 * where fragment without a mirror; the accounts brought in are counted.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: { agentProfile: { findMany: vi.fn(), count: vi.fn() } },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { kycPartyStateWhere } from '../../../shared/kyc-state';
import { prismaAgentsRepository as repository } from '../prisma-agents.repository';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.agentProfile.findMany.mockResolvedValue([{ id: 'agt_1', user: { roles: [] }, kyc: null, _count: { publishers: 4, advertisers: 1 } }]);
  prisma.agentProfile.count.mockResolvedValue(1);
});

// Account lifecycle (2 Oct 2026): the cuts, then the status facet (ACTIVE by default) beside them.
const parts = () => prisma.agentProfile.findMany.mock.calls[0]![0].where.AND[0].AND as Record<string, unknown>[];

describe('findPage — the agent roster', () => {
  it('ANDs the city, the search, the door, the side and the KYC state', async () => {
    await repository.findPage({ city: 'Pune', cityId: 'city_pune', search: '+91 90000 00001', sourceKind: 'FLEET', side: 'ADVERTISER', kycState: 'AWAITING_DOCUMENTS' }, 200, 0);
    expect(parts()).toContainEqual({ OR: [{ cityId: 'city_pune' }, { cityId: null, city: { equals: 'Pune', mode: 'insensitive' } }] });
    expect(parts()).toContainEqual({ sourceKind: 'FLEET' });
    expect(parts()).toContainEqual({ user: { roles: { some: { role: 'AGENT_ADVERTISER' }, none: { role: 'AGENT_PUBLISHER' } } } });
    expect(parts()).toContainEqual(kycPartyStateWhere('AWAITING_DOCUMENTS', false));
    const search = parts().find((part) => Array.isArray(part['OR']) && (part['OR'] as object[]).some((clause) => 'displayId' in clause)) as { OR: unknown[] };
    expect(search.OR).toContainEqual({ user: { mobile: { contains: '9000000001' } } });
    expect(search.OR).toContainEqual({ user: { email: { contains: '+91 90000 00001', mode: 'insensitive' } } });
    expect(search.OR).toContainEqual({ displayId: { contains: '+91 90000 00001', mode: 'insensitive' } });
  });

  it('reads the publisher side as the ladder does: the publisher role, or no advertiser role', async () => {
    await repository.findPage({ side: 'PUBLISHER' }, 50, 0);
    expect(parts()).toContainEqual({ user: { OR: [{ roles: { some: { role: 'AGENT_PUBLISHER' } } }, { roles: { none: { role: 'AGENT_ADVERTISER' } } }] } });
  });

  it('joins the email, the roles and the six KYC columns, and counts the accounts brought in', async () => {
    const page = await repository.findPage({}, 50, 0);
    const [args] = prisma.agentProfile.findMany.mock.calls[0]!;
    expect(args.include.user.select).toMatchObject({ email: true, roles: { select: { role: true } } });
    expect(args.include.kyc).toEqual({ select: { id: true, status: true, submittedAt: true, requestedAt: true, requestedChannel: true, method: true } });
    expect(args.include._count).toEqual({ select: { publishers: true, advertisers: true } });
    expect(page.items[0]).toMatchObject({ id: 'agt_1', onboardedCount: 5 });
    expect(page.items[0]).not.toHaveProperty('_count');
  });
});

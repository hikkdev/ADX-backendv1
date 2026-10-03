import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Account lifecycle (2 Oct 2026): the users directory's state chips gain ERASED, and CLOSED leaves the erased out so the four add up. */

const { prisma } = vi.hoisted(() => ({ prisma: { user: { count: vi.fn() } } }));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaUsersRepository as repository } from '../prisma-users.repository';
import { adminUsersQuerySchema } from '../users.schema';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.count.mockImplementation(async ({ where }: { where: { AND: object[] } }) => {
    const state = JSON.stringify(where.AND[1]);
    if (state.includes('"erasedAt":{"not":null}')) return 1;
    if (state.includes('"closedAt":{"not":null}')) return 2;
    if (state.includes('"isActive":false')) return 3;
    return 4;
  });
});

describe('the users directory facet', () => {
  it('parses ERASED', () => {
    expect(adminUsersQuerySchema.parse({ state: 'ERASED' })).toMatchObject({ state: 'ERASED' });
  });

  it('counts each of the four states', async () => {
    expect(await repository.countByState({})).toEqual({ ACTIVE: 4, INACTIVE: 3, CLOSED: 2, ERASED: 1 });
    expect(prisma.user.count.mock.calls[0]![0].where.AND[1]).toEqual({ closedAt: { not: null }, erasedAt: null });
  });
});

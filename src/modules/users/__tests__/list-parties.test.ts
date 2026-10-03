import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2 Oct 2026 (the owner: "I don't see a lot of users here reflected in the
 * user list as if they're not linked at all"). They were linked: the users
 * list named the person ("Vikram Rao") while the directories and the KYC
 * queues name the business ("Skyline Outdoor Media"). Pinned here:
 *
 *  - every `GET /users` row carries `parties`: the publisher, advertiser and
 *    print shop by business name, the agent and the employee by their
 *    profile's name, each with its id and account ID;
 *  - the search reaches those business names and IDs (and the person's own
 *    ADX-... id), print shops through a lookup since they have no relation on
 *    `User`;
 *  - the row carries `erasedAt`, so the console can say Erased.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    user: { findMany: vi.fn(), count: vi.fn() },
    printPartner: { findMany: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { adminListWhere, prismaUsersRepository as repository } from '../prisma-users.repository';
import { adminListPayload, listPartiesOf } from '../users.mapper';

const NOW = new Date('2026-10-02T10:00:00Z');

const user = (over: Record<string, unknown> = {}) =>
  ({
    id: 'usr_1',
    displayId: 'ADX-0210-2601',
    mobile: '+919845012210',
    name: 'Vikram Rao',
    email: 'vikram@skyline.in',
    language: 'en',
    isActive: true,
    closedAt: null,
    erasedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastLoginAt: NOW,
    twoFactorRequiredAt: null,
    totpSecretEnc: null,
    totpEnrolledAt: null,
    roles: [{ role: 'PUBLISHER' }],
    agentProfile: null,
    publisherProfile: null,
    advertiserProfile: null,
    employeeProfile: null,
    printPartner: null,
    placedOrders: [],
    onboardingSubmissions: [],
    roleConfig: null,
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findMany.mockResolvedValue([]);
  prisma.printPartner.findMany.mockResolvedValue([]);
  prisma.user.count.mockResolvedValue(0);
});

describe('the parties a login holds', () => {
  it('names the businesses by their own names and the profiles by theirs, in a fixed order', () => {
    const parties = listPartiesOf({
      name: 'Vikram Rao',
      publisherProfile: { id: 'pub_1', name: 'Skyline Outdoor Media', displayId: 'PUB-0210-2601' },
      advertiserProfile: { id: 'adv_1', name: 'Skyline Brands', displayId: null },
      printPartner: { id: 'pp_1', name: 'Rao Prints', displayId: 'PRT-0210-2601' },
      agentProfile: { id: 'agt_1', businessName: null, displayId: 'AGT-0210-2601' },
      employeeProfile: { id: 'emp_1', designation: 'Ops manager', displayId: 'EMP-0210-2601' },
    });
    expect(parties).toEqual([
      { kind: 'PUBLISHER', id: 'pub_1', name: 'Skyline Outdoor Media', displayId: 'PUB-0210-2601' },
      { kind: 'ADVERTISER', id: 'adv_1', name: 'Skyline Brands', displayId: null },
      { kind: 'PRINT_PARTNER', id: 'pp_1', name: 'Rao Prints', displayId: 'PRT-0210-2601' },
      // An agent with no business name is the person; an employee is their designation.
      { kind: 'AGENT', id: 'agt_1', name: 'Vikram Rao', displayId: 'AGT-0210-2601' },
      { kind: 'EMPLOYEE', id: 'emp_1', name: 'Ops manager', displayId: 'EMP-0210-2601' },
    ]);
  });

  it('is empty for a login that holds nothing, and skips a profile without an id', () => {
    expect(listPartiesOf({ name: 'Asha' })).toEqual([]);
    expect(listPartiesOf({ name: null, agentProfile: { businessName: 'x' }, employeeProfile: { id: 'emp_2', designation: null } })).toEqual([
      { kind: 'EMPLOYEE', id: 'emp_2', name: 'Employee', displayId: null },
    ]);
  });

  it('rides on every list row beside erasedAt', () => {
    const row = adminListPayload(
      user({
        erasedAt: NOW,
        publisherProfile: { id: 'pub_1', name: 'Skyline Outdoor Media', displayId: 'PUB-0210-2601', type: 'BUSINESS' },
      }),
    );
    expect(row.erasedAt).toEqual(NOW);
    expect(row.parties).toEqual([{ kind: 'PUBLISHER', id: 'pub_1', name: 'Skyline Outdoor Media', displayId: 'PUB-0210-2601' }]);
  });
});

describe('the search', () => {
  it('reaches the business names and IDs the login holds, and the person\'s own id', () => {
    const where = adminListWhere({ q: 'skyline' });
    const or = JSON.stringify(where.OR);
    expect(or).toContain('"displayId":{"contains":"skyline","mode":"insensitive"}');
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { publisherProfile: { is: { OR: [{ name: { contains: 'skyline', mode: 'insensitive' } }, { displayId: { contains: 'skyline', mode: 'insensitive' } }] } } },
        { advertiserProfile: { is: { OR: [{ name: { contains: 'skyline', mode: 'insensitive' } }, { displayId: { contains: 'skyline', mode: 'insensitive' } }] } } },
        { agentProfile: { is: { OR: [{ businessName: { contains: 'skyline', mode: 'insensitive' } }, { displayId: { contains: 'skyline', mode: 'insensitive' } }] } } },
        { employeeProfile: { is: { displayId: { contains: 'skyline', mode: 'insensitive' } } } },
      ]),
    );
    // No print shop matched: no id list rides along.
    expect(or).not.toContain('"in"');
    expect(adminListWhere({ q: 'skyline' }, ['usr_9']).OR).toEqual(expect.arrayContaining([{ id: { in: ['usr_9'] } }]));
    // No search, no OR at all.
    expect(adminListWhere({}).OR).toBeUndefined();
  });

  it('finds a print shop by name or ID and lists its login; the counts use the same match', async () => {
    prisma.printPartner.findMany.mockImplementation(async (args: { where: { OR?: unknown; userId?: unknown } }) =>
      args.where.OR ? [{ userId: 'usr_7' }] : [{ id: 'pp_1', name: 'Rao Prints', displayId: 'PRT-0210-2601', userId: 'usr_7' }],
    );
    prisma.user.findMany.mockResolvedValue([user({ id: 'usr_7' }), user({ id: 'usr_8' })]);

    const rows = (await repository.findAllForAdmin({ q: 'PRT-0210' })) as unknown as { id: string; printPartner: unknown }[];

    const lookup = prisma.printPartner.findMany.mock.calls[0]![0];
    expect(lookup.where.OR).toEqual([
      { name: { contains: 'PRT-0210', mode: 'insensitive' } },
      { legalName: { contains: 'PRT-0210', mode: 'insensitive' } },
      { displayId: { contains: 'PRT-0210', mode: 'insensitive' } },
    ]);
    expect(prisma.user.findMany.mock.calls[0]![0].where.OR).toEqual(expect.arrayContaining([{ id: { in: ['usr_7'] } }]));
    // The shop is attached to its login's row; the other row holds none.
    expect(rows.find((row) => row.id === 'usr_7')!.printPartner).toEqual({ id: 'pp_1', name: 'Rao Prints', displayId: 'PRT-0210-2601', userId: 'usr_7' });
    expect(rows.find((row) => row.id === 'usr_8')!.printPartner).toBeNull();

    await repository.countByState({ q: 'PRT-0210' });
    const counted = prisma.user.count.mock.calls[0]![0].where.AND[0];
    expect(counted.OR).toEqual(expect.arrayContaining([{ id: { in: ['usr_7'] } }]));
  });

  it('asks nothing about print shops when nothing is typed', async () => {
    await repository.findAllForAdmin({});
    // Only the per-row shop read runs, and only when there are rows.
    expect(prisma.printPartner.findMany).not.toHaveBeenCalled();
  });
});

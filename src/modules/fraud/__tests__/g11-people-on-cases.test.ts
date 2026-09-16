import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G11-1: the people on a fraud case by name — `openedBy`, `assignedTo`,
 * `decidedBy` and `escalatedTo` as `{ id, name } | null` beside the ids,
 * on the case file and on every list row, from one `users.findUserLabels`
 * lookup per read. A name is decoration: with the lookup failing, the case
 * still answers, names null.
 */

const { repository, suspension, users } = vi.hoisted(() => ({
  repository: { list: vi.fn(), findById: vi.fn(), findSummaryById: vi.fn(), findOpenForSubject: vi.fn() },
  suspension: { suspensionOf: vi.fn(async () => null), suspendParty: vi.fn(), reinstateParty: vi.fn(), SCOPES_BY_PARTY: {} },
  users: {
    userExists: vi.fn(async () => true),
    listAdminUserIds: vi.fn(async () => []),
    findUserLabels: vi.fn(async (ids: readonly string[]) => {
      const names: Record<string, string> = { usr_admin: 'Asha', usr_inv: 'Ravi', usr_legal: 'Legal Desk' };
      return new Map(ids.map((id) => [id, { id, name: names[id] ?? null }]));
    }),
  },
}));

vi.mock('../prisma-fraud.repository', () => ({ prismaFraudRepository: repository }));
vi.mock('../../suspension', () => suspension);
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../kyc', () => ({ escalateKycForFraudLink: vi.fn() }));

import { getCase, listCases } from '../fraud.service';

const now = new Date('2026-09-14T09:00:00.000Z');
const fraudCase = (over: Record<string, unknown> = {}) => ({
  id: 'frd_1',
  displayId: 'FRD-1409-0001',
  subjectType: 'PUBLISHER',
  subjectId: 'pub_1',
  kind: 'FAKE_PROOF',
  status: 'OPEN',
  summary: 'Install photos reused',
  openedByUserId: 'usr_admin',
  assignedToUserId: null,
  decidedByUserId: null,
  decidedAt: null,
  escalatedAt: null,
  escalatedToUserId: null,
  createdAt: now,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /fraud/cases/:id — the people by name', () => {
  it('names the four beside their ids, one lookup', async () => {
    repository.findById.mockResolvedValue({
      ...fraudCase({ status: 'ESCALATED', assignedToUserId: 'usr_inv', escalatedAt: now, escalatedToUserId: 'usr_legal', decidedByUserId: 'usr_gone' }),
      notes: [],
      evidence: [],
    });
    const file = await getCase('frd_1');
    expect(users.findUserLabels).toHaveBeenCalledTimes(1);
    expect(users.findUserLabels).toHaveBeenCalledWith(['usr_admin', 'usr_inv', 'usr_gone', 'usr_legal']);
    expect(file).toMatchObject({
      openedByUserId: 'usr_admin',
      openedBy: { id: 'usr_admin', name: 'Asha' },
      assignedTo: { id: 'usr_inv', name: 'Ravi' },
      decidedBy: { id: 'usr_gone', name: null },
      escalatedTo: { id: 'usr_legal', name: 'Legal Desk' },
      notes: [],
      evidence: [],
      suspension: null,
    });
  });

  it('is null for the people a case does not have yet', async () => {
    repository.findById.mockResolvedValue({ ...fraudCase(), notes: [], evidence: [] });
    expect(await getCase('frd_1')).toMatchObject({ openedBy: { id: 'usr_admin', name: 'Asha' }, assignedTo: null, decidedBy: null, escalatedTo: null });
  });

  it('still answers, names null, when the lookup fails', async () => {
    users.findUserLabels.mockRejectedValueOnce(new Error('users down'));
    repository.findById.mockResolvedValue({ ...fraudCase({ assignedToUserId: 'usr_inv' }), notes: [], evidence: [] });
    expect(await getCase('frd_1')).toMatchObject({ openedBy: { id: 'usr_admin', name: null }, assignedTo: { id: 'usr_inv', name: null } });
  });
});

describe('GET /fraud/cases — the people by name on every row', () => {
  it('carries the four on each row from one lookup for the page, the page shape kept', async () => {
    repository.list.mockResolvedValue({
      items: [fraudCase(), fraudCase({ id: 'frd_2', assignedToUserId: 'usr_inv', status: 'CONFIRMED', decidedByUserId: 'usr_admin' })],
      total: 2,
      page: 1,
      pageSize: 20,
      counts: { OPEN: 1, CONFIRMED: 1 },
    });
    const page = await listCases({ sort: 'NEWEST', page: 1, pageSize: 20 } as never);
    expect(users.findUserLabels).toHaveBeenCalledTimes(1);
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 20, counts: { OPEN: 1, CONFIRMED: 1 } });
    expect(page.items[0]).toMatchObject({ id: 'frd_1', openedBy: { id: 'usr_admin', name: 'Asha' }, assignedTo: null, decidedBy: null, escalatedTo: null });
    expect(page.items[1]).toMatchObject({ id: 'frd_2', assignedTo: { id: 'usr_inv', name: 'Ravi' }, decidedBy: { id: 'usr_admin', name: 'Asha' } });
  });
});

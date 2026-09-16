import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R-B — the publisher's action log: `POST /publishers/:id/activity` and
 * `GET /publishers/:id/activity`, the mirror of the advertiser's (decision
 * 14). Lot P's detail card read `AccountActivity` rows by `publisherId` and
 * nothing wrote them; this is the writer.
 *
 * Pinned: the same five kinds; the READ-level act rule — the agent the
 * account is attributed to may log without a live grant (a phone call is not
 * a write to the account), another agent may not (403), ADMIN may and the
 * row is recorded against the account's own agent (409 when it has none);
 * the log answers the list contract newest first with the chips per kind;
 * and the row a write lands is the one the summary feed reads back as
 * `ACTIVITY`.
 */

type AnyFn = (...args: any[]) => any;

const { repository, agents, grants, prisma } = vi.hoisted(() => ({
  repository: { findSummaryById: vi.fn<AnyFn>() },
  agents: { findAgentProfile: vi.fn<AnyFn>(), requireAgentProfile: vi.fn<AnyFn>() },
  grants: { liveGrantFor: vi.fn<AnyFn>() },
  prisma: {
    accountActivity: { create: vi.fn<AnyFn>(), findMany: vi.fn<AnyFn>(), count: vi.fn<AnyFn>(), groupBy: vi.fn<AnyFn>() },
    listing: { findMany: vi.fn<AnyFn>(async () => []) },
    order: { findMany: vi.fn<AnyFn>(async () => []) },
  },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../agents', () => agents);
vi.mock('../../access-grants', () => grants);
// The repository runs for real over an in-memory `accountActivity`, so the
// write and the two reads (the log, the feed) are proven to agree on the row.
vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { ApiError } from '../../../shared/errors';
import { listPublisherActivity, recordPublisherActivity } from '../book/publisher-activity.service';
import { ACCOUNT_ACTIVITY_KINDS, publisherActivityQuerySchema, publisherActivitySchema } from '../book/publisher-book.schema';
import { prismaPublisherSummaryRepository as summaryRepository } from '../book/prisma-publisher-summary.repository';

const NOW = new Date('2026-09-14T20:30:00.000Z');
const at = (iso: string) => new Date(iso);
const publisher = { id: 'pub_1', agentId: 'agt_1', name: 'Suraj Kumar Prints' };

let rows: Record<string, unknown>[] = [];
const ofPublisher = (where: { publisherId?: string; kind?: { in: string[] }; note?: { contains: string } }) =>
  rows.filter(
    (row) =>
      row['publisherId'] === where.publisherId &&
      (!where.kind || where.kind.in.includes(row['kind'] as string)) &&
      (!where.note || String(row['note'] ?? '').toLowerCase().includes(where.note.contains.toLowerCase())),
  );

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  repository.findSummaryById.mockResolvedValue(publisher);
  agents.findAgentProfile.mockResolvedValue({ id: 'agt_1' });
  grants.liveGrantFor.mockResolvedValue(null);
  prisma.listing.findMany.mockResolvedValue([]);
  prisma.order.findMany.mockResolvedValue([]);
  prisma.accountActivity.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row = { id: `act_${rows.length + 1}`, ...data };
    rows.push(row);
    return row;
  });
  prisma.accountActivity.findMany.mockImplementation(async ({ where, take, skip = 0 }: { where: Parameters<typeof ofPublisher>[0]; take: number; skip?: number }) =>
    ofPublisher(where)
      .sort((a, b) => (b['at'] as Date).getTime() - (a['at'] as Date).getTime())
      .slice(skip, skip + take),
  );
  prisma.accountActivity.count.mockImplementation(async ({ where }: { where: Parameters<typeof ofPublisher>[0] }) => ofPublisher(where).length);
  prisma.accountActivity.groupBy.mockImplementation(async ({ where }: { where: Parameters<typeof ofPublisher>[0] }) => {
    const byKind = new Map<string, number>();
    for (const row of ofPublisher(where)) byKind.set(row['kind'] as string, (byKind.get(row['kind'] as string) ?? 0) + 1);
    return [...byKind].map(([kind, n]) => ({ kind, _count: { _all: n } }));
  });
});

describe('the body', () => {
  it("takes the advertiser's five kinds and nothing else", () => {
    expect([...ACCOUNT_ACTIVITY_KINDS]).toEqual(['CHECK_IN', 'FOLLOW_UP', 'CALLED', 'MESSAGED', 'NOTE']);
    expect(publisherActivitySchema.safeParse({ kind: 'CALLED' }).success).toBe(true);
    expect(publisherActivitySchema.safeParse({ kind: 'CALLED', note: '  ' }).success).toBe(false);
    expect(publisherActivitySchema.safeParse({ kind: 'VISITED' }).success).toBe(false);
  });
});

describe('who may log', () => {
  it('the agent the account is attributed to, with no live grant', async () => {
    const view = await recordPublisherActivity('pub_1', { userId: 'usr_agent', isAdmin: false }, { kind: 'FOLLOW_UP', note: 'Called, renewing in Oct' }, NOW);
    expect(prisma.accountActivity.create).toHaveBeenCalledWith({
      data: { publisherId: 'pub_1', agentId: 'agt_1', kind: 'FOLLOW_UP', note: 'Called, renewing in Oct', createdByUserId: 'usr_agent', at: NOW },
    });
    expect(view).toEqual({ id: 'act_1', kind: 'FOLLOW_UP', note: 'Called, renewing in Oct', at: NOW.toISOString(), agentId: 'agt_1' });
    expect(grants.liveGrantFor).not.toHaveBeenCalled();
  });

  it('not another agent, nor a caller with no agent profile — 403, on the write and the read', async () => {
    agents.findAgentProfile.mockResolvedValue({ id: 'agt_other' });
    await expect(recordPublisherActivity('pub_1', { userId: 'usr_other', isAdmin: false }, { kind: 'CALLED' }, NOW)).rejects.toMatchObject({ statusCode: 403 });
    await expect(listPublisherActivity('pub_1', { userId: 'usr_other', isAdmin: false }, publisherActivityQuerySchema.parse({}))).rejects.toMatchObject({ statusCode: 403 });
    agents.findAgentProfile.mockResolvedValue(null);
    await expect(recordPublisherActivity('pub_1', { userId: 'usr_nobody', isAdmin: false }, { kind: 'CALLED' }, NOW)).rejects.toMatchObject({ statusCode: 403 });
    expect(prisma.accountActivity.create).not.toHaveBeenCalled();
  });

  it("ADMIN, recorded against the account's own agent — 409 when it has none", async () => {
    agents.findAgentProfile.mockResolvedValue(null);
    const view = await recordPublisherActivity('pub_1', { userId: 'usr_admin', isAdmin: true }, { kind: 'NOTE', note: 'Desk note' }, NOW);
    expect(view.agentId).toBe('agt_1');
    expect(prisma.accountActivity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ agentId: 'agt_1', createdByUserId: 'usr_admin', note: 'Desk note' }) });

    repository.findSummaryById.mockResolvedValue({ ...publisher, agentId: null });
    await expect(recordPublisherActivity('pub_1', { userId: 'usr_admin', isAdmin: true }, { kind: 'NOTE' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('nobody, when the id names nobody — 404', async () => {
    repository.findSummaryById.mockResolvedValue(null);
    await expect(recordPublisherActivity('pub_x', { userId: 'usr_admin', isAdmin: true }, { kind: 'NOTE' }, NOW)).rejects.toBeInstanceOf(ApiError);
    await expect(recordPublisherActivity('pub_x', { userId: 'usr_admin', isAdmin: true }, { kind: 'NOTE' }, NOW)).rejects.toMatchObject({ statusCode: 404 });
    await expect(listPublisherActivity('pub_x', { userId: 'usr_admin', isAdmin: true }, publisherActivityQuerySchema.parse({}))).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the log and the feed', () => {
  beforeEach(async () => {
    await recordPublisherActivity('pub_1', { userId: 'usr_agent', isAdmin: false }, { kind: 'FOLLOW_UP', note: 'Renewing in Oct' }, at('2026-09-10T08:00:00.000Z'));
    await recordPublisherActivity('pub_1', { userId: 'usr_agent', isAdmin: false }, { kind: 'CALLED' }, at('2026-09-12T09:00:00.000Z'));
    repository.findSummaryById.mockResolvedValue({ ...publisher, id: 'pub_2' });
    await recordPublisherActivity('pub_2', { userId: 'usr_agent', isAdmin: false }, { kind: 'NOTE', note: 'Someone else' }, at('2026-09-13T09:00:00.000Z'));
    repository.findSummaryById.mockResolvedValue(publisher);
  });

  it('answers the log on the list contract, newest first, the chips per kind', async () => {
    const page = await listPublisherActivity('pub_1', { userId: 'usr_agent', isAdmin: false }, publisherActivityQuerySchema.parse({ pageSize: '10' }));
    expect(page).toEqual({
      items: [
        { id: 'act_2', kind: 'CALLED', note: null, at: '2026-09-12T09:00:00.000Z', agentId: 'agt_1' },
        { id: 'act_1', kind: 'FOLLOW_UP', note: 'Renewing in Oct', at: '2026-09-10T08:00:00.000Z', agentId: 'agt_1' },
      ],
      total: 2,
      page: 1,
      pageSize: 10,
      counts: { CHECK_IN: 0, FOLLOW_UP: 1, CALLED: 1, MESSAGED: 0, NOTE: 0 },
    });
    expect(prisma.accountActivity.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { publisherId: 'pub_1' }, orderBy: { at: 'desc' }, skip: 0, take: 10 }));
  });

  it('narrows by kind and note without moving the chips, and the desk reads it too', async () => {
    const page = await listPublisherActivity('pub_1', { userId: 'usr_admin', isAdmin: true }, publisherActivityQuerySchema.parse({ status: 'CALLED', q: 'oct' }));
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    // The chips are counted with the kind facet removed and the search kept: "oct" reaches only the follow-up.
    expect(page.counts).toEqual({ CHECK_IN: 0, FOLLOW_UP: 1, CALLED: 0, MESSAGED: 0, NOTE: 0 });
    const called = await listPublisherActivity('pub_1', { userId: 'usr_admin', isAdmin: true }, publisherActivityQuerySchema.parse({ status: 'CALLED' }));
    expect(called.items.map((row) => row.id)).toEqual(['act_2']);
    expect(called.total).toBe(1);
  });

  it('is what the summary feed reads back as ACTIVITY', async () => {
    const feed = await summaryRepository.feedOf('pub_1', 30);
    expect(feed).toEqual([
      { kind: 'ACTIVITY', at: at('2026-09-12T09:00:00.000Z'), title: 'Called', detail: null },
      { kind: 'ACTIVITY', at: at('2026-09-10T08:00:00.000Z'), title: 'Followed up', detail: 'Renewing in Oct' },
    ]);
  });
});

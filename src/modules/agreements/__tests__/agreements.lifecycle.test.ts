import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * The life of an agreement version, walked from the client.
 *
 * One router and one in-memory repository, so what is tested is the sequence a
 * person at the console actually performs — draft, read it over, make it live,
 * draft the next, retire the old one, roll back — and what each step lets a
 * party see through `/current`. Per-endpoint checks would not catch the
 * failure that matters here: a version somebody accepted becoming editable.
 */

const { repository, state } = vi.hoisted(() => {
  type Row = Record<string, any>;
  const state = {
    templates: [] as Row[],
    acceptances: [] as Row[],
    parties: [] as Row[],
    seq: 0,
    reset() {
      this.templates = [];
      this.acceptances = [];
      this.parties = [];
      this.seq = 0;
    },
  };
  const nextId = (prefix: string) => `${prefix}_${++state.seq}`;
  const withCount = (t: Row) => ({
    ...t,
    acceptanceCount: state.acceptances.filter((a) => a.templateId === t.id).length,
  });
  const find = (id: string) => {
    const row = state.templates.find((t) => t.id === id);
    if (!row) throw new Error(`no template ${id}`);
    return row;
  };
  const acceptanceRow = (a: Row) => ({
    ...a,
    template: { title: find(a.templateId).title },
    acceptedBy: { id: a.acceptedByUserId, name: 'Rohan', mobile: '+919812340001' },
    publisher: a.publisherId ? { id: a.publisherId, displayId: 'PUB-1909-2601', name: 'Sharma Hoardings' } : null,
    advertiser: a.advertiserId ? { id: a.advertiserId, displayId: 'ADV-1909-2601', name: 'Zomato' } : null,
  });

  const repository = {
    listTemplates: vi.fn(async (kind?: string) =>
      state.templates
        .filter((t) => !kind || t.kind === kind)
        .sort((a, b) => b.version - a.version)
        .map(withCount),
    ),
    findTemplate: vi.fn(async (id: string) => {
      const t = state.templates.find((row) => row.id === id);
      return t ? withCount(t) : null;
    }),
    activeTemplate: vi.fn(async (kind: string) => {
      const t = state.templates.find((row) => row.kind === kind && row.isActive);
      return t ? withCount(t) : null;
    }),
    highestVersion: vi.fn(async (kind: string) =>
      Math.max(0, ...state.templates.filter((t) => t.kind === kind).map((t) => t.version)),
    ),
    createTemplate: vi.fn(async (data: Row) => {
      const now = new Date();
      const row = {
        id: nextId('tpl'),
        isActive: false,
        effectiveFrom: now,
        activatedAt: null,
        retiredAt: null,
        changeNote: null,
        createdByUserId: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      state.templates.push(row);
      return withCount(row);
    }),
    updateTemplate: vi.fn(async (id: string, patch: Row) => {
      const row = find(id);
      Object.assign(row, patch, { updatedAt: new Date() });
      return withCount(row);
    }),
    deleteTemplate: vi.fn(async (id: string) => {
      state.templates = state.templates.filter((t) => t.id !== id);
    }),
    activateTemplate: vi.fn(async (id: string, kind: string, at: Date, patch: Row = {}) => {
      for (const t of state.templates) {
        if (t.kind === kind && t.isActive && t.id !== id) {
          t.isActive = false;
          t.retiredAt = at;
        }
      }
      const row = find(id);
      Object.assign(row, { isActive: true, activatedAt: at, retiredAt: null, effectiveFrom: at }, patch);
      return withCount(row);
    }),
    listAcceptances: vi.fn(async (filter: Row) => ({
      rows: state.acceptances
        .filter(
          (a) =>
            (!filter.publisherId || a.publisherId === filter.publisherId) &&
            (!filter.advertiserId || a.advertiserId === filter.advertiserId) &&
            (!filter.templateId || a.templateId === filter.templateId) &&
            (!filter.kind || a.templateKind === filter.kind) &&
            (!filter.campaignId || a.campaignId === filter.campaignId) &&
            (!filter.orderId || a.orderId === filter.orderId),
        )
        .map(acceptanceRow),
      nextCursor: null,
    })),
    searchParties: vi.fn(async (q: string) =>
      state.parties.filter((p) =>
        [p.displayId, p.name, p.mobile].some((v) => v?.toLowerCase().includes(q.toLowerCase())),
      ),
    ),
    findParty: vi.fn(
      async (type: string, id: string) =>
        state.parties.find((p) => p.type === type && p.id === id) ?? null,
    ),
  };
  return { repository, state };
});

vi.mock('../prisma-agreements.repository', () => ({ prismaAgreementsRepository: repository }));

import { agreementRouter } from '../agreements.routes';
import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';

const app = express();
app.use(express.json());
app.use('/agreements', agreementRouter);
app.use(errorHandler);

const ADMIN = tokenFor(['ADMIN'], 'usr_ops');
const PUBLISHER = tokenFor(['PUBLISHER'], 'usr_pub');

const client = (token: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`),
  post: (path: string, body?: unknown) =>
    request(app).post(path).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  patch: (path: string, body?: unknown) =>
    request(app).patch(path).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer ${token}`),
});

const ops = client(ADMIN);
const publisher = client(PUBLISHER);

const draft = (kind: string, n: number, extra: Record<string, unknown> = {}) => ({
  kind,
  title: `${kind} terms v${n}`,
  body: `# Terms\n\nVersion ${n} of the ${kind} agreement.`,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.reset();
});

describe('who may do what', () => {
  it('refuses the desk to anyone without a token', async () => {
    const res = await request(app).get('/agreements/templates');
    expect(res.status).toBe(401);
  });

  it('keeps writing the terms an ADMIN job', async () => {
    expect((await publisher.get('/agreements/templates')).status).toBe(403);
    expect((await publisher.post('/agreements/templates', draft('PLATFORM', 1))).status).toBe(403);
  });

  it('lets any signed-in party read the live text, because they are about to accept it', async () => {
    await ops.post('/agreements/templates', draft('PLATFORM', 1, { activate: true }));
    const res = await publisher.get('/agreements/current/PLATFORM');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ kind: 'PLATFORM', version: 1, state: 'ACTIVE' });
  });
});

describe('the life of a version, from the desk', () => {
  it('walks draft → live → superseded → rolled back, and the party sees each step', async () => {
    /* The stall D9 exists to end: nothing is published, so nothing can be accepted. */
    let current = await publisher.get('/agreements/current/PLATFORM');
    expect(current.status).toBe(404);
    expect(current.body.error.code).toBe('NO_ACTIVE_TEMPLATE');

    /* Draft v1. It is not live: reading it over comes before going live. */
    const v1 = await ops.post('/agreements/templates', draft('PLATFORM', 1, { changeNote: 'First cut' }));
    expect(v1.status).toBe(201);
    expect(v1.body.data).toMatchObject({
      version: 1,
      state: 'DRAFT',
      isActive: false,
      activatedAt: null,
      changeNote: 'First cut',
      createdByUserId: 'usr_ops',
    });
    expect((await publisher.get('/agreements/current/PLATFORM')).status).toBe(404);

    /* Make it live. */
    const live1 = await ops.post(`/agreements/templates/${v1.body.data.id}/activate`);
    expect(live1.status).toBe(200);
    expect(live1.body.data).toMatchObject({ version: 1, state: 'ACTIVE', isActive: true });
    expect(live1.body.data.activatedAt).toBeTruthy();
    current = await publisher.get('/agreements/current/PLATFORM');
    expect(current.body.data).toMatchObject({ version: 1, body: expect.stringContaining('Version 1') });

    /* Draft v2 beside it, and edit the draft — that is allowed. */
    const v2 = await ops.post('/agreements/templates', draft('PLATFORM', 2));
    expect(v2.body.data).toMatchObject({ version: 2, state: 'DRAFT' });
    const edited = await ops.patch(`/agreements/templates/${v2.body.data.id}`, { title: 'Publisher terms (2026)' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.title).toBe('Publisher terms (2026)');

    /* The live version is frozen: it is what people are accepting. */
    const frozen = await ops.patch(`/agreements/templates/${v1.body.data.id}`, { body: 'changed' });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.message).toMatch(/what people accepted/);

    let list = await ops.get('/agreements/templates?kind=PLATFORM');
    expect(list.body.data.map((t: any) => [t.version, t.state])).toEqual([
      [2, 'DRAFT'],
      [1, 'ACTIVE'],
    ]);

    /* v2 goes live; v1 is retired, not deleted, and stays on record. */
    const live2 = await ops.post(`/agreements/templates/${v2.body.data.id}/activate`);
    expect(live2.body.data).toMatchObject({ version: 2, state: 'ACTIVE' });
    list = await ops.get('/agreements/templates?kind=PLATFORM');
    const retired = list.body.data.find((t: any) => t.version === 1);
    expect(retired).toMatchObject({ state: 'SUPERSEDED', isActive: false });
    expect(retired.retiredAt).toBeTruthy();
    current = await publisher.get('/agreements/current/PLATFORM');
    expect(current.body.data.version).toBe(2);

    /* Activating the live version again changes nothing. */
    const again = await ops.post(`/agreements/templates/${v2.body.data.id}/activate`);
    expect(again.status).toBe(200);
    expect(again.body.data.activatedAt).toBe(live2.body.data.activatedAt);

    /* A retired version cannot be edited either — somebody accepted it. */
    expect((await ops.patch(`/agreements/templates/${v1.body.data.id}`, { title: 'x' })).status).toBe(409);
    expect((await ops.delete(`/agreements/templates/${v1.body.data.id}`)).status).toBe(409);
    expect((await ops.delete(`/agreements/templates/${v2.body.data.id}`)).status).toBe(409);

    /* Rollback: v2 turns out wrong, v1 comes back. Nobody re-accepts anything. */
    const back = await ops.post(`/agreements/templates/${v1.body.data.id}/activate`);
    expect(back.body.data).toMatchObject({ version: 1, state: 'ACTIVE', retiredAt: null });
    list = await ops.get('/agreements/templates?kind=PLATFORM');
    expect(list.body.data.find((t: any) => t.version === 2)).toMatchObject({ state: 'SUPERSEDED' });
    current = await publisher.get('/agreements/current/PLATFORM');
    expect(current.body.data.version).toBe(1);
  });

  it('numbers a new version after every version that exists, drafts and retired included', async () => {
    const a = await ops.post('/agreements/templates', draft('LISTING', 1, { activate: true }));
    await ops.post('/agreements/templates', draft('LISTING', 2));
    const c = await ops.post('/agreements/templates', draft('LISTING', 3));
    expect(c.body.data.version).toBe(3);

    /* Discarding a draft is the one delete that exists. */
    expect((await ops.delete(`/agreements/templates/${c.body.data.id}`)).status).toBe(204);
    expect((await ops.get(`/agreements/templates/${c.body.data.id}`)).status).toBe(404);
    expect((await ops.get(`/agreements/templates/${a.body.data.id}`)).status).toBe(200);

    /* Publishing and activating in one call, for the console's "make it live now". */
    const d = await ops.post('/agreements/templates', draft('LISTING', 4, { activate: true }));
    expect(d.status).toBe(201);
    expect(d.body.data).toMatchObject({ version: 3, state: 'ACTIVE' });
    expect((await ops.get(`/agreements/templates/${a.body.data.id}`)).body.data.state).toBe('SUPERSEDED');
  });

  it('keeps the four kinds apart: going live on one side touches nothing on the other', async () => {
    const pub = await ops.post('/agreements/templates', draft('PLATFORM', 1, { activate: true }));
    const adv = await ops.post('/agreements/templates', draft('ADVERTISER_PLATFORM', 1, { activate: true }));
    await ops.post('/agreements/templates', draft('ADVERTISER_PLATFORM', 2, { activate: true }));

    expect((await ops.get(`/agreements/templates/${pub.body.data.id}`)).body.data.state).toBe('ACTIVE');
    expect((await ops.get(`/agreements/templates/${adv.body.data.id}`)).body.data.state).toBe('SUPERSEDED');
    expect((await publisher.get('/agreements/current/ADVERTISER_PLATFORM')).body.data.version).toBe(2);
  });

  /**
   * The two older publish routes set isActive without stamping activatedAt.
   * A version they published and later superseded must not read as a draft,
   * or it becomes editable under the people who accepted it.
   */
  it('treats a version anyone accepted as having been live, even with no activation stamp', async () => {
    const legacy = (await repository.createTemplate({ kind: 'PLATFORM', version: 1, title: 'old', body: 'old' })) as unknown as { id: string };
    state.acceptances.push({
      id: 'acc_1',
      templateId: legacy.id,
      templateKind: 'PLATFORM',
      templateVersion: 1,
      publisherId: 'pub_1',
      advertiserId: null,
      acceptedByUserId: 'usr_pub',
      acceptedAt: new Date(),
    });
    const read = await ops.get(`/agreements/templates/${legacy.id}`);
    expect(read.body.data).toMatchObject({ state: 'SUPERSEDED', acceptanceCount: 1 });
    expect((await ops.patch(`/agreements/templates/${legacy.id}`, { title: 'x' })).status).toBe(409);
  });

  it('rejects what it does not understand rather than guessing', async () => {
    expect((await ops.post('/agreements/templates', { kind: 'NDA', title: 'x', body: 'y' })).status).toBe(400);
    expect((await ops.post('/agreements/templates', { kind: 'PLATFORM', title: '', body: 'y' })).status).toBe(400);
    expect((await ops.get('/agreements/templates?kind=NDA')).status).toBe(400);
    expect((await publisher.get('/agreements/current/NDA')).status).toBe(400);
    const v1 = await ops.post('/agreements/templates', draft('PLATFORM', 1));
    expect((await ops.patch(`/agreements/templates/${v1.body.data.id}`, {})).status).toBe(400);
    expect((await ops.get('/agreements/templates/tpl_missing')).status).toBe(404);
  });

  it('loses a race for a version number with a 409, not a 500', async () => {
    repository.createTemplate.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    const res = await ops.post('/agreements/templates', draft('PLATFORM', 1));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Version 1 was created by somebody else/);
  });
});

describe('what a party accepted', () => {
  const party = {
    type: 'publisher',
    id: 'pub_1',
    displayId: 'PUB-1909-2601',
    name: 'Sharma Hoardings',
    mobile: '+919812340001',
    city: 'Bengaluru',
    kycStatus: 'VERIFIED',
    activatedAt: null,
    createdAt: new Date(),
  };

  const accept = (templateId: string, version: number, publisherId = 'pub_1') =>
    state.acceptances.push({
      id: `acc_${state.acceptances.length + 1}`,
      templateId,
      templateKind: 'PLATFORM',
      templateVersion: version,
      publisherId,
      advertiserId: null,
      attemptId: null,
      campaignId: null,
      acceptedByUserId: 'usr_pub',
      acceptedAt: new Date(),
      ipAddress: '10.0.0.1',
      userAgent: 'user-app/1.0',
      renderedDocument: null,
    });

  beforeEach(() => {
    state.parties.push({ ...party });
  });

  it('finds a party by identifier, name or mobile, but not from a single character', async () => {
    expect((await ops.get('/agreements/parties?q=PUB-1909')).body.data).toHaveLength(1);
    expect((await ops.get('/agreements/parties?q=sharma')).body.data).toHaveLength(1);
    expect((await ops.get('/agreements/parties?q=340001')).body.data).toHaveLength(1);
    expect((await ops.get('/agreements/parties?q=P')).body.data).toEqual([]);
    expect((await ops.get('/agreements/parties')).body.data).toEqual([]);
  });

  it('says where a party stands on the platform terms as versions come and go', async () => {
    /* Nothing published: the stall, named. */
    let view = await ops.get('/agreements/parties/publisher/pub_1');
    expect(view.status).toBe(200);
    expect(view.body.data.platform).toMatchObject({ kind: 'PLATFORM', currentVersion: null, accepted: null, outdated: false });
    expect(view.body.data.party.displayId).toBe('PUB-1909-2601');

    /* v1 live, accepted. */
    const v1 = await ops.post('/agreements/templates', draft('PLATFORM', 1, { activate: true }));
    accept(v1.body.data.id, 1);
    view = await ops.get('/agreements/parties/publisher/pub_1');
    expect(view.body.data.platform).toMatchObject({ currentVersion: 1, outdated: false });
    expect(view.body.data.platform.accepted).toMatchObject({
      templateVersion: 1,
      acceptedBy: { name: 'Rohan', mobile: '+919812340001' },
      ipAddress: '10.0.0.1',
      template: { title: 'PLATFORM terms v1' },
    });
    expect(view.body.data.acceptances).toHaveLength(1);

    /* v2 goes live: they hold old terms. Reported, not enforced. */
    await ops.post('/agreements/templates', draft('PLATFORM', 2, { activate: true }));
    view = await ops.get('/agreements/parties/publisher/pub_1');
    expect(view.body.data.platform).toMatchObject({ currentVersion: 2, outdated: true });
    expect(view.body.data.platform.accepted.templateVersion).toBe(1);

    /* Roll back to v1 and they are current again. */
    await ops.post(`/agreements/templates/${v1.body.data.id}/activate`);
    view = await ops.get('/agreements/parties/publisher/pub_1');
    expect(view.body.data.platform).toMatchObject({ currentVersion: 1, outdated: false });

    /* The acceptance counts show on the versions themselves. */
    const list = await ops.get('/agreements/templates?kind=PLATFORM');
    expect(list.body.data.find((t: any) => t.version === 1).acceptanceCount).toBe(1);
  });

  it('lists acceptances by party, by template and by kind, and 404s a party of the wrong type', async () => {
    const v1 = await ops.post('/agreements/templates', draft('PLATFORM', 1, { activate: true }));
    accept(v1.body.data.id, 1);
    accept(v1.body.data.id, 1, 'pub_2');

    expect((await ops.get('/agreements/acceptances?publisherId=pub_1')).body.data.rows).toHaveLength(1);
    expect((await ops.get(`/agreements/acceptances?templateId=${v1.body.data.id}`)).body.data.rows).toHaveLength(2);
    expect((await ops.get('/agreements/acceptances?kind=LISTING')).body.data.rows).toHaveLength(0);
    expect((await ops.get('/agreements/acceptances?kind=NDA')).status).toBe(400);

    expect((await ops.get('/agreements/parties/advertiser/pub_1')).status).toBe(404);
    // Lot D: an agent is a party too (JOB_TERMS), so an unknown one is 404 like the others.
    expect((await ops.get('/agreements/parties/agent/pub_1')).status).toBe(404);
  });
});

describe('E7-3: the desk reads', () => {
  it('activates with the re-acceptance switch in one step, platform kinds only', async () => {
    const v1 = await ops.post('/agreements/templates', draft('PLATFORM', 1));
    const live = await ops.post(`/agreements/templates/${v1.body.data.id}/activate`, { requiresReacceptance: true });
    expect(live.status).toBe(200);
    expect(live.body.data).toMatchObject({ state: 'ACTIVE', requiresReacceptance: true });
    expect(repository.activateTemplate).toHaveBeenCalledWith(v1.body.data.id, 'PLATFORM', expect.any(Date), { requiresReacceptance: true });

    /* Already live: only the switch moves, the stamps stay. */
    const activatedAt = live.body.data.activatedAt;
    const off = await ops.post(`/agreements/templates/${v1.body.data.id}/activate`, { requiresReacceptance: false });
    expect(off.body.data).toMatchObject({ state: 'ACTIVE', requiresReacceptance: false, activatedAt });
    expect(repository.activateTemplate).toHaveBeenCalledTimes(1);

    /* A transaction kind never asks twice. */
    const listing = await ops.post('/agreements/templates', draft('LISTING', 1));
    const refused = await ops.post(`/agreements/templates/${listing.body.data.id}/activate`, { requiresReacceptance: true });
    expect(refused.status).toBe(400);
    expect((await ops.get(`/agreements/templates/${listing.body.data.id}`)).body.data.state).toBe('DRAFT');

    /* Without a body, the activation is what it always was. */
    const plain = await ops.post(`/agreements/templates/${listing.body.data.id}/activate`);
    expect(plain.body.data.state).toBe('ACTIVE');
    expect(plain.body.data.requiresReacceptance).toBeFalsy();
  });

  it('filters the acceptances by the transaction anchors', async () => {
    const io = await ops.post('/agreements/templates', draft('INSERTION_ORDER', 1, { activate: true }));
    const base = { templateId: io.body.data.id, templateKind: 'INSERTION_ORDER', templateVersion: 1, publisherId: null, acceptedByUserId: 'usr_adv', acceptedAt: new Date() };
    state.acceptances.push({ id: 'acc_c1', ...base, advertiserId: 'adv_1', campaignId: 'cmp_1', orderId: null });
    state.acceptances.push({ id: 'acc_c2', ...base, advertiserId: 'adv_1', campaignId: 'cmp_2', orderId: null });
    state.acceptances.push({ id: 'acc_o1', ...base, advertiserId: 'adv_2', campaignId: null, orderId: 'ord_1' });

    const byCampaign = await ops.get('/agreements/acceptances?campaignId=cmp_2');
    expect(byCampaign.status).toBe(200);
    expect(repository.listAcceptances).toHaveBeenLastCalledWith(expect.objectContaining({ campaignId: 'cmp_2' }), expect.anything());
    expect(byCampaign.body.data.rows.map((row: { id: string }) => row.id)).toEqual(['acc_c2']);

    const byOrder = await ops.get('/agreements/acceptances?orderId=ord_1&packageSaleId=&attemptId=');
    expect(byOrder.status).toBe(400);
    const byOrderOk = await ops.get('/agreements/acceptances?orderId=ord_1');
    expect(byOrderOk.body.data.rows.map((row: { id: string }) => row.id)).toEqual(['acc_o1']);
  });
});

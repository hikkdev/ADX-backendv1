import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-8 (17 Sep 2026) — listing drafts, and the LST- reference.
 *
 * The owner: "allow draft facility for listings and campaigns. We can use
 * it to reach out to advertisers or publishers later with sales team or
 * onboarding team. We might need alphanumerical unique listing IDs too."
 *
 * Pinned, over the routes with the repository stubbed: a publisher saves a
 * draft (the wizard's answers, the step) and is given a reference off the
 * LISTING series; updates it in place; lists their own; throws one away;
 * may not touch another publisher's; finishing a listing from a draft
 * (`POST /listings { draftId }`) creates the listing WITH the draft's
 * reference and removes the draft; the desk lists every publisher's drafts
 * with the publisher's name and number, idle days, oldest first, filtered
 * by idle days; an agent or an advertiser has no drafts route.
 */

const { drafts, service, identifiers, features } = vi.hoisted(() => ({
  drafts: {
    listForPublisher: vi.fn(),
    findForPublisher: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    desk: vi.fn(),
  },
  service: { findOwnPublisher: vi.fn(), createListing: vi.fn() },
  identifiers: { allocateIdentifier: vi.fn() },
  features: () => ({
    requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

vi.mock('../prisma-drafts.repository', () => ({ prismaDraftsRepository: drafts }));
vi.mock('../listings.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../listings.service')>();
  return { ...actual, ...service };
});
vi.mock('../../identifiers', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../identifiers')>()), ...identifiers }));
vi.mock('../../feature-flags', () => features());

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { listingRouter } from '../listings.routes';
import { deskDrafts, idleDaysOf } from '../drafts.service';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/listings', listingRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const publisher = tokenFor(['PUBLISHER'], 'usr_pub');
const agent = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');
const advertiser = tokenFor(['ADVERTISER'], 'usr_adv');
const admin = tokenFor(['ADMIN'], 'usr_admin');

const NOW = new Date('2026-09-17T04:00:00Z');
const own = { id: 'pub_1', name: 'Asha Rao', mobile: '+919876543210', email: 'a@b.c', address: '12 MG Road', dateOfBirth: new Date('1990-04-12T00:00:00Z'), activatedAt: NOW };

const draft = (over: Record<string, unknown> = {}) => ({
  id: 'drf_1',
  displayId: 'LST-1709-2601',
  publisherId: 'pub_1',
  category: 'indoor',
  title: 'Gym mirror decal',
  stepIndex: 3,
  stepKey: 'details',
  answers: { category: 'indoor', venue_type_id: 'vt_gym', title: 'Gym mirror decal' },
  createdAt: new Date('2026-09-10T00:00:00Z'),
  updatedAt: new Date('2026-09-12T00:00:00Z'),
  ...over,
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeEach(() => {
  vi.clearAllMocks();
  service.findOwnPublisher.mockResolvedValue(own);
  identifiers.allocateIdentifier.mockResolvedValue('LST-1709-2601');
  drafts.create.mockImplementation(async (publisherId: string, displayId: string, input: Record<string, unknown>) => draft({ publisherId, displayId, ...input }));
  drafts.update.mockImplementation(async (id: string, input: Record<string, unknown>) => draft({ id, ...input }));
  drafts.findForPublisher.mockImplementation(async (publisherId: string, id: string) => (publisherId === 'pub_1' && id === 'drf_1' ? draft() : null));
  drafts.listForPublisher.mockResolvedValue([draft()]);
  drafts.remove.mockResolvedValue({});
  service.createListing.mockImplementation(async (input: Record<string, unknown>) => ({ id: 'lst_1', status: 'DRAFT', ...input }));
});

describe("the publisher's own drafts", () => {
  it('saves a new draft under a reference off the LISTING series', async () => {
    const res = await request(app()).post('/api/v1/listings/drafts').set(auth(publisher)).send({ category: 'indoor', title: 'Gym mirror decal', stepIndex: 3, stepKey: 'details', answers: { category: 'indoor', title: 'Gym mirror decal' } });
    expect(res.status).toBe(201);
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('LISTING');
    expect(drafts.create).toHaveBeenCalledWith('pub_1', 'LST-1709-2601', expect.objectContaining({ category: 'indoor', stepIndex: 3, answers: { category: 'indoor', title: 'Gym mirror decal' } }));
    expect(res.body.data).toMatchObject({ displayId: 'LST-1709-2601', stepIndex: 3 });
  });

  it('updates one in place, keeping its reference', async () => {
    const res = await request(app()).put('/api/v1/listings/drafts/drf_1').set(auth(publisher)).send({ stepIndex: 5, answers: { category: 'indoor', title: 'Gym mirror decal', width_ft: '4' } });
    expect(res.status).toBe(200);
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
    expect(drafts.update).toHaveBeenCalledWith('drf_1', expect.objectContaining({ stepIndex: 5 }));
  });

  it('lists its own, throws one away, and may not touch another publisher\'s', async () => {
    const list = await request(app()).get('/api/v1/listings/drafts').set(auth(publisher));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(drafts.listForPublisher).toHaveBeenCalledWith('pub_1');

    const gone = await request(app()).delete('/api/v1/listings/drafts/drf_1').set(auth(publisher));
    expect(gone.status).toBe(200);
    expect(drafts.remove).toHaveBeenCalledWith('drf_1');

    const other = await request(app()).put('/api/v1/listings/drafts/drf_other').set(auth(publisher)).send({ answers: {} });
    expect(other.status).toBe(404);
    expect(drafts.update).not.toHaveBeenCalled();
  });

  it('refuses a body with no answers, and a caller with no publisher account', async () => {
    expect((await request(app()).post('/api/v1/listings/drafts').set(auth(publisher)).send({ stepIndex: 1 })).status).toBe(400);
    service.findOwnPublisher.mockResolvedValue(null);
    expect((await request(app()).post('/api/v1/listings/drafts').set(auth(publisher)).send({ answers: {} })).status).toBe(403);
  });

  it('is the publisher\'s route alone', async () => {
    expect((await request(app()).get('/api/v1/listings/drafts').set(auth(agent))).status).toBe(403);
    expect((await request(app()).get('/api/v1/listings/drafts').set(auth(advertiser))).status).toBe(403);
  });
});

describe('finishing a listing from a draft', () => {
  const spot = { title: 'Gym mirror decal', category: 'INDOOR', city: 'Bengaluru', address: '12 MG Road', ratePerDay: '1500' };

  it('creates the listing with the draft\'s reference and removes the draft', async () => {
    const res = await request(app()).post('/api/v1/listings').set(auth(publisher)).send({ ...spot, draftId: 'drf_1' });
    expect(res.status).toBe(201);
    expect(service.createListing).toHaveBeenCalledWith(expect.objectContaining({ publisherId: 'pub_1', displayId: 'LST-1709-2601' }));
    expect(drafts.remove).toHaveBeenCalledWith('drf_1');
  });

  it('404s a draft that is not the caller\'s, before anything is created', async () => {
    const res = await request(app()).post('/api/v1/listings').set(auth(publisher)).send({ ...spot, draftId: 'drf_other' });
    expect(res.status).toBe(404);
    expect(service.createListing).not.toHaveBeenCalled();
  });

  it('a listing with no draft carries no reference in — the service mints one', async () => {
    const res = await request(app()).post('/api/v1/listings').set(auth(publisher)).send(spot);
    expect(res.status).toBe(201);
    expect(service.createListing.mock.calls[0]![0]).not.toHaveProperty('displayId');
    expect(drafts.remove).not.toHaveBeenCalled();
  });
});

describe('the desk', () => {
  const rows = [
    { ...draft(), publisher: { id: 'pub_1', displayId: 'PUB-1009-2601', name: 'Asha Rao', mobile: '+919876543210', city: 'Bengaluru', kycStatus: 'PENDING' } },
    { ...draft({ id: 'drf_2', displayId: 'LST-1709-2602', publisherId: 'pub_2', updatedAt: new Date('2026-09-16T12:00:00Z') }), publisher: { id: 'pub_2', displayId: 'PUB-1109-2601', name: 'Ravi', mobile: '+919999999999', city: 'Pune', kycStatus: 'VERIFIED' } },
  ];

  it('counts idle days from the last save', () => {
    expect(idleDaysOf(new Date('2026-09-12T00:00:00Z'), NOW)).toBe(5);
    expect(idleDaysOf(new Date('2026-09-17T03:00:00Z'), NOW)).toBe(0);
    expect(idleDaysOf(new Date('2026-09-18T00:00:00Z'), NOW)).toBe(0);
  });

  it('lists every publisher\'s drafts with the publisher beside each, oldest untouched first, the answers left out', async () => {
    drafts.desk.mockResolvedValue({ items: rows, total: 2 });
    const page = await deskDrafts({ page: 1, pageSize: 25, sort: 'IDLE' }, NOW);
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({ displayId: 'LST-1709-2601', idleDays: 5, publisher: { name: 'Asha Rao', mobile: '+919876543210' } });
    expect(page.items[0]).not.toHaveProperty('answers');
    expect(drafts.desk).toHaveBeenCalledWith(expect.objectContaining({ sort: 'IDLE' }), null);
  });

  it('turns idleDays into a cut-off, and is ADMIN\'s route', async () => {
    drafts.desk.mockResolvedValue({ items: [rows[0]], total: 1 });
    const res = await request(app()).get('/api/v1/listings/drafts/desk?idleDays=3&q=asha').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    const [query, idleBefore] = drafts.desk.mock.calls[0]!;
    expect(query).toMatchObject({ idleDays: 3, q: 'asha' });
    expect(idleBefore).toBeInstanceOf(Date);
    expect((await request(app()).get('/api/v1/listings/drafts/desk').set(auth(publisher))).status).toBe(403);
  });
});

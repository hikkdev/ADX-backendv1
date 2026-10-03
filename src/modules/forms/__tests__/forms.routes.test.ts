import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FM-1 — the doors, pinned at the route with the real routers over a
 * mocked repository: the public read is token-free and 404s what is not
 * live; a PUBLIC form's answer passes the limiter and the captcha and
 * needs no token; a SIGNED_IN form's answer is 401 without one and stores
 * the caller with one; the desk is ADMIN with content.*; "field-kinds" is
 * never read as a key.
 */

const { repository, limiters, leads, support, users, email } = vi.hoisted(() => ({
  repository: {
    list: vi.fn(),
    byKey: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    newSubmissionCounts: vi.fn(),
    currentVersions: vi.fn(),
    live: vi.fn(),
    draft: vi.fn(),
    byNumber: vi.fn(),
    versions: vi.fn(),
    highestNumber: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    deleteDraft: vi.fn(),
    publishDraft: vi.fn(),
    publishCopy: vi.fn(),
    userNames: vi.fn(),
    citiesByIds: vi.fn(),
    citiesByIdsOrNames: vi.fn(),
    createSubmission: vi.fn(),
    updateSubmission: vi.fn(),
    submission: vi.fn(),
    listSubmissions: vi.fn(),
    submissionsInBox: vi.fn(),
  },
  limiters: { publicRead: vi.fn(), formSubmit: vi.fn() },
  leads: { inboundLead: vi.fn() },
  support: { createTicket: vi.fn() },
  users: { systemUserId: vi.fn() },
  email: { sendEmail: vi.fn() },
}));

vi.mock('../prisma-forms.repository', () => ({ prismaFormsRepository: repository }));
vi.mock('../../../shared/security/rate-limit', () => ({
  publicReadLimiter: (req: unknown, res: unknown, next: () => void) => {
    limiters.publicRead(req);
    next();
  },
  formSubmitLimiter: (req: unknown, res: unknown, next: () => void) => {
    limiters.formSubmit(req);
    next();
  },
}));
vi.mock('../../../shared/audit', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/audit')>()), logActivity: vi.fn(async () => undefined) }));
vi.mock('../../../shared/email', () => email);
vi.mock('../../leads', () => leads);
vi.mock('../../support', () => support);
vi.mock('../../users', () => users);
vi.mock('../../listings', () => ({ LISTING_CATEGORIES: ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] }));

import { errorHandler } from '../../../shared/errors';
import { signAccessToken } from '../../../shared/auth';
import { tokenFor } from '../../../shared/testing';
import { appFormRouter, formRouter } from '../forms.routes';
import { emptyDefinition } from '../form-schema';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/forms', formRouter);
  api.use('/app/forms', appFormRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const NOW = new Date('2026-09-27T10:00:00Z');
const admin = tokenFor(['ADMIN'], 'usr_admin');
const viewer = signAccessToken('usr_viewer', ['ADMIN'], undefined, { perms: ['content.view'] });
const publisher = tokenFor(['PUBLISHER'], 'usr_pub');

const definition = { ...emptyDefinition(), successMessage: 'Got it', screens: [{ key: 'main', fields: [{ id: 'name', kind: 'text', label: 'Name', required: true }] }] };

const form = (over: Record<string, unknown> = {}) => ({
  id: 'frm_1',
  key: 'ask',
  title: 'Ask us',
  description: null,
  destination: 'INBOX',
  leadSide: null,
  audience: 'PUBLIC',
  notifyEmails: [],
  createdByUserId: 'usr_admin',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const version = (over: Record<string, unknown> = {}) => ({
  id: 'fv_1',
  formId: 'frm_1',
  number: 1,
  status: 'PUBLISHED',
  definition,
  changeNote: null,
  createdByUserId: 'usr_admin',
  publishedById: null,
  publishedAt: NOW,
  retiredAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.byKey.mockResolvedValue(form());
  repository.live.mockResolvedValue(version());
  repository.draft.mockResolvedValue(null);
  repository.versions.mockResolvedValue([]);
  repository.list.mockResolvedValue([form()]);
  repository.currentVersions.mockResolvedValue([version()]);
  repository.newSubmissionCounts.mockResolvedValue(new Map());
  repository.userNames.mockResolvedValue(new Map());
  repository.citiesByIds.mockResolvedValue([]);
  repository.citiesByIdsOrNames.mockResolvedValue([]);
  repository.highestNumber.mockResolvedValue(1);
  repository.createSubmission.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'sub_1', createdAt: NOW, updatedAt: NOW, leadId: null, ticketId: null, ...data }));
  repository.createDraft.mockImplementation(async (data: Record<string, unknown>) => version({ id: 'fv_2', status: 'DRAFT', ...data }));
});

describe('the public read', () => {
  it('answers the published form without a token, behind the read limiter', async () => {
    const res = await request(app()).get('/api/v1/app/forms/ask');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ key: 'ask', title: 'Ask us', audience: 'PUBLIC', version: 1 });
    expect(res.body.data.definition.screens[0].fields[0].id).toBe('name');
    expect(limiters.publicRead).toHaveBeenCalledTimes(1);
  });

  it('404s an archived or unpublished form', async () => {
    repository.byKey.mockResolvedValueOnce(form({ archivedAt: NOW }));
    expect((await request(app()).get('/api/v1/app/forms/ask')).status).toBe(404);
    repository.live.mockResolvedValueOnce(null);
    expect((await request(app()).get('/api/v1/app/forms/ask')).status).toBe(404);
  });
});

describe('answering', () => {
  it('a PUBLIC form takes an answer with no token, through the submit limiter', async () => {
    const res = await request(app()).post('/api/v1/app/forms/ask/submissions').send({ answers: { name: 'Asha' }, consent: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ id: 'sub_1', message: 'Got it' });
    expect(limiters.formSubmit).toHaveBeenCalledTimes(1);
    expect(repository.createSubmission).toHaveBeenCalledWith(expect.objectContaining({ userId: null, contactName: null, answers: { name: 'Asha' } }));
  });

  it('a SIGNED_IN form refuses no token and stores the caller with one', async () => {
    repository.byKey.mockResolvedValue(form({ audience: 'SIGNED_IN' }));
    const anon = await request(app()).post('/api/v1/app/forms/ask/submissions').send({ answers: { name: 'Asha' }, consent: true });
    expect(anon.status).toBe(401);
    expect(limiters.formSubmit).not.toHaveBeenCalled();
    const res = await request(app()).post('/api/v1/app/forms/ask/submissions').set('Authorization', `Bearer ${publisher}`).send({ answers: { name: 'Asha' }, consent: true });
    expect(res.status).toBe(201);
    expect(repository.createSubmission).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_pub' }));
  });

  it('names the problems: consent, a missing answer, an unknown form', async () => {
    const consent = await request(app()).post('/api/v1/app/forms/ask/submissions').send({ answers: { name: 'Asha' } });
    expect(consent.status).toBe(400);
    expect(consent.body.error?.message ?? consent.body.message).toMatch(/Consent/);
    const missing = await request(app()).post('/api/v1/app/forms/ask/submissions').send({ answers: {}, consent: true });
    expect(missing.status).toBe(400);
    repository.byKey.mockResolvedValueOnce(null);
    expect((await request(app()).post('/api/v1/app/forms/ghost/submissions').send({ answers: {}, consent: true })).status).toBe(404);
  });
});

describe('the desk', () => {
  it('is ADMIN only, and reads with content.view', async () => {
    expect((await request(app()).get('/api/v1/forms')).status).toBe(401);
    expect((await request(app()).get('/api/v1/forms').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    const res = await request(app()).get('/api/v1/forms').set('Authorization', `Bearer ${viewer}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ key: 'ask', live: { number: 1 } });
  });

  it('answers the field kinds before reading "field-kinds" as a key', async () => {
    const res = await request(app()).get('/api/v1/forms/field-kinds').set('Authorization', `Bearer ${viewer}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((k: { kind: string }) => k.kind)).toContain('location');
    expect(repository.byKey).not.toHaveBeenCalled();
  });

  it('writes need content.edit, publishing content.approve, discarding content.delete', async () => {
    const draft = { definition, changeNote: 'x' };
    expect((await request(app()).put('/api/v1/forms/ask/draft').set('Authorization', `Bearer ${viewer}`).send(draft)).status).toBe(403);
    const saved = await request(app()).put('/api/v1/forms/ask/draft').set('Authorization', `Bearer ${admin}`).send(draft);
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ number: 2, status: 'DRAFT' });
    expect((await request(app()).post('/api/v1/forms/ask/publish').set('Authorization', `Bearer ${viewer}`).send({})).status).toBe(403);
    expect((await request(app()).delete('/api/v1/forms/ask/draft').set('Authorization', `Bearer ${viewer}`)).status).toBe(403);
    const forbidden = await request(app()).put('/api/v1/forms/ask/draft').set('Authorization', `Bearer ${admin}`).send({ definition: { ...definition, screens: [{ key: 'm', fields: [{ id: 'aadhaar_no', kind: 'text', label: 'x' }] }] } });
    expect(forbidden.status).toBe(400);
    expect(JSON.stringify(forbidden.body)).toContain('FORBIDDEN_FIELD');
  });

  it('creates a form with 201 and refuses a bad body with 400', async () => {
    repository.byKey.mockResolvedValueOnce(null);
    repository.create.mockImplementation(async (data: Record<string, unknown>) => form(data));
    const res = await request(app()).post('/api/v1/forms').set('Authorization', `Bearer ${admin}`).send({ key: 'new-form', title: 'New', destination: 'lead', leadSide: 'publisher', notifyEmails: ['Ops@ADX.in'] });
    expect(res.status).toBe(201);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ destination: 'LEAD', leadSide: 'PUBLISHER', notifyEmails: ['ops@adx.in'] }));
    expect((await request(app()).post('/api/v1/forms').set('Authorization', `Bearer ${admin}`).send({ title: 'No key' })).status).toBe(400);
  });

  it('lists, exports and maps the answers, and files one', async () => {
    repository.listSubmissions.mockResolvedValue({ items: [], total: 0 });
    const list = await request(app()).get('/api/v1/forms/ask/submissions?status=new&from=2026-09-01&to=2026-09-30&page=1&pageSize=5').set('Authorization', `Bearer ${viewer}`);
    expect(list.status).toBe(200);
    expect(repository.listSubmissions).toHaveBeenCalledWith('frm_1', { status: 'NEW', from: new Date('2026-09-01T00:00:00.000Z'), to: new Date('2026-09-30T23:59:59.999Z'), cityId: undefined }, { skip: 0, take: 5 });
    expect(list.body.data.fields.map((f: { id: string }) => f.id)).toEqual(['name']);

    const csv = await request(app()).get('/api/v1/forms/ask/submissions.csv').set('Authorization', `Bearer ${viewer}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toMatch(/^id,createdAt,status/);

    repository.submissionsInBox.mockResolvedValue([]);
    expect((await request(app()).get('/api/v1/forms/ask/submissions/map?bbox=73,18,74,19').set('Authorization', `Bearer ${viewer}`)).status).toBe(200);
    expect(repository.submissionsInBox).toHaveBeenCalledWith('frm_1', { west: 73, south: 18, east: 74, north: 19 }, 2000);
    expect((await request(app()).get('/api/v1/forms/ask/submissions/map?bbox=74,18,73,19').set('Authorization', `Bearer ${viewer}`)).status).toBe(400);

    repository.submission.mockResolvedValue({ id: 'sub_1', formId: 'frm_1', status: 'NEW', answers: {}, createdAt: NOW });
    repository.updateSubmission.mockResolvedValue({ id: 'sub_1', formId: 'frm_1', status: 'ARCHIVED', answers: {}, createdAt: NOW });
    expect((await request(app()).patch('/api/v1/forms/ask/submissions/sub_1').set('Authorization', `Bearer ${viewer}`).send({ status: 'ARCHIVED' })).status).toBe(403);
    const filed = await request(app()).patch('/api/v1/forms/ask/submissions/sub_1').set('Authorization', `Bearer ${admin}`).send({ status: 'archived' });
    expect(filed.status).toBe(200);
    expect(filed.body.data.status).toBe('ARCHIVED');
  });
});

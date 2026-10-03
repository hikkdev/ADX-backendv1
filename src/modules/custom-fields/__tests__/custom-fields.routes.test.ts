import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CF-1 — the doors, pinned at the route with the real routers over a
 * mocked repository: the definitions are settings.*; a record's values
 * take the record's own group, chosen from `:entity` per request (an
 * admin holding supply.view reads a publisher's values and not an
 * advertiser's); an unknown entity is a 404; the owner's routes need a
 * token and only admit the caller's own record.
 */

const { repository, publishers, advertisers, listings } = vi.hoisted(() => ({
  repository: {
    listDefs: vi.fn(),
    defById: vi.fn(),
    defByKey: vi.fn(),
    createDef: vi.fn(),
    updateDef: vi.fn(),
    entityExists: vi.fn(),
    valuesFor: vi.fn(),
    writeValues: vi.fn(),
  },
  publishers: { findPublisherForUser: vi.fn() },
  advertisers: { getAdvertiserForUser: vi.fn() },
  listings: { getListingById: vi.fn() },
}));

vi.mock('../prisma-custom-fields.repository', () => ({ prismaCustomFieldsRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/audit')>()), logActivity: vi.fn(async () => undefined) }));
vi.mock('../../publishers', () => publishers);
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../listings', () => listings);

import { errorHandler } from '../../../shared/errors';
import { signAccessToken } from '../../../shared/auth';
import { tokenFor } from '../../../shared/testing';
import { appCustomFieldRouter, customFieldRouter } from '../custom-fields.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/custom-fields', customFieldRouter);
  api.use('/app/custom-fields', appCustomFieldRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const NOW = new Date('2026-09-27T10:00:00Z');
const admin = tokenFor(['ADMIN'], 'usr_admin');
const supplyOnly = signAccessToken('usr_supply', ['ADMIN'], undefined, { perms: ['supply.view', 'supply.edit', 'settings.view'] });
const publisher = tokenFor(['PUBLISHER'], 'usr_pub');

const def = (over: Record<string, unknown> = {}) => ({
  id: 'cfd_1',
  entity: 'PUBLISHER',
  key: 'preferred_contact_time',
  label: 'Preferred contact time',
  kind: 'text',
  options: null,
  hint: null,
  required: false,
  showOnDesk: true,
  showInApps: true,
  showOnWebsite: false,
  editableByOwner: true,
  sortOrder: 0,
  createdByUserId: 'usr_admin',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.listDefs.mockImplementation(async (filter: { entity?: string }) => (filter.entity === 'ADVERTISER' ? [def({ id: 'cfd_a', entity: 'ADVERTISER', key: 'industry_note', label: 'Industry note', showInApps: false })] : [def()]));
  repository.defById.mockResolvedValue(def());
  repository.defByKey.mockResolvedValue(null);
  repository.createDef.mockImplementation(async (data: Record<string, unknown>) => def({ ...data, id: 'cfd_new' }));
  repository.updateDef.mockImplementation(async (id: string, data: Record<string, unknown>) => def({ id, ...data }));
  repository.entityExists.mockResolvedValue(true);
  repository.valuesFor.mockResolvedValue([]);
  repository.writeValues.mockResolvedValue(undefined);
  publishers.findPublisherForUser.mockImplementation(async (userId: string) => (userId === 'usr_pub' ? { id: 'pub_1' } : null));
  advertisers.getAdvertiserForUser.mockResolvedValue(null);
  listings.getListingById.mockResolvedValue(null);
});

describe('the definitions desk', () => {
  it('is ADMIN with settings.view to read and settings.edit to write', async () => {
    expect((await request(app()).get('/api/v1/custom-fields?entity=publisher')).status).toBe(401);
    expect((await request(app()).get('/api/v1/custom-fields').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    const list = await request(app()).get('/api/v1/custom-fields?entity=publisher').set('Authorization', `Bearer ${supplyOnly}`);
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({ key: 'preferred_contact_time', kindLabel: 'Short text' });
    expect(repository.listDefs).toHaveBeenCalledWith({ entity: 'PUBLISHER', includeArchived: false });
    expect((await request(app()).post('/api/v1/custom-fields').set('Authorization', `Bearer ${supplyOnly}`).send({ entity: 'PUBLISHER', label: 'x', kind: 'text' })).status).toBe(403);
    const made = await request(app()).post('/api/v1/custom-fields').set('Authorization', `Bearer ${admin}`).send({ entity: 'listing', label: 'Facing road', kind: 'Select', options: [{ value: 'yes', label: 'Yes' }] });
    expect(made.status).toBe(201);
    expect(repository.createDef).toHaveBeenCalledWith(expect.objectContaining({ entity: 'LISTING', key: 'facing_road', kind: 'select' }));
    expect((await request(app()).post('/api/v1/custom-fields').set('Authorization', `Bearer ${admin}`).send({ entity: 'ORDER', label: 'x', kind: 'text' })).status).toBe(400);
    expect((await request(app()).patch('/api/v1/custom-fields/cfd_1').set('Authorization', `Bearer ${admin}`).send({ kind: 'number', label: 'Renamed' })).status).toBe(200);
    expect(repository.updateDef).toHaveBeenCalledWith('cfd_1', { label: 'Renamed' });
    expect((await request(app()).post('/api/v1/custom-fields/cfd_1/archive').set('Authorization', `Bearer ${admin}`)).status).toBe(200);
  });
});

describe('a record\'s values on the desk', () => {
  it('takes the record\'s own group, chosen from the entity', async () => {
    const mine = await request(app()).get('/api/v1/custom-fields/values/publisher/pub_1').set('Authorization', `Bearer ${supplyOnly}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject({ entity: 'PUBLISHER', entityId: 'pub_1', values: { preferred_contact_time: null } });
    const theirs = await request(app()).get('/api/v1/custom-fields/values/advertiser/adv_1').set('Authorization', `Bearer ${supplyOnly}`);
    expect(theirs.status).toBe(403);
    expect(theirs.body.error?.details ?? theirs.body.details).toMatchObject({ missing: ['demand.view'] });
    expect((await request(app()).get('/api/v1/custom-fields/values/advertiser/adv_1').set('Authorization', `Bearer ${admin}`)).status).toBe(200);
    expect((await request(app()).get('/api/v1/custom-fields/values/order/x').set('Authorization', `Bearer ${admin}`)).status).toBe(404);
    repository.entityExists.mockResolvedValueOnce(false);
    expect((await request(app()).get('/api/v1/custom-fields/values/publisher/ghost').set('Authorization', `Bearer ${admin}`)).status).toBe(404);
  });

  it('writes with the group\'s edit tier', async () => {
    const res = await request(app()).put('/api/v1/custom-fields/values/publisher/pub_1').set('Authorization', `Bearer ${supplyOnly}`).send({ values: { preferred_contact_time: 'mornings' } });
    expect(res.status).toBe(200);
    expect(repository.writeValues).toHaveBeenCalledWith('PUBLISHER', 'pub_1', [{ defId: 'cfd_1', value: 'mornings' }], [], 'usr_supply');
    expect((await request(app()).put('/api/v1/custom-fields/values/lead/lead_1').set('Authorization', `Bearer ${supplyOnly}`).send({ values: {} })).status).toBe(403);
    expect((await request(app()).put('/api/v1/custom-fields/values/publisher/pub_1').set('Authorization', `Bearer ${supplyOnly}`).send({ nope: true })).status).toBe(400);
  });
});

describe('the owner', () => {
  it('needs a token, reads what is shown to owners, and only their own record', async () => {
    expect((await request(app()).get('/api/v1/app/custom-fields/publisher')).status).toBe(401);
    const defs = await request(app()).get('/api/v1/app/custom-fields/publisher').set('Authorization', `Bearer ${publisher}`);
    expect(defs.status).toBe(200);
    expect(defs.body.data.map((d: { key: string }) => d.key)).toEqual(['preferred_contact_time']);
    expect((await request(app()).get('/api/v1/app/custom-fields/lead').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    expect((await request(app()).get('/api/v1/app/custom-fields/values/publisher/pub_1').set('Authorization', `Bearer ${publisher}`)).status).toBe(200);
    expect((await request(app()).get('/api/v1/app/custom-fields/values/publisher/pub_2').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    expect((await request(app()).get('/api/v1/app/custom-fields/values/publisher/pub_1').set('Authorization', `Bearer ${admin}`)).status).toBe(403);
    const write = await request(app()).put('/api/v1/app/custom-fields/values/publisher/pub_1').set('Authorization', `Bearer ${publisher}`).send({ values: { preferred_contact_time: 'evenings' } });
    expect(write.status).toBe(200);
    expect(repository.writeValues).toHaveBeenCalledWith('PUBLISHER', 'pub_1', [{ defId: 'cfd_1', value: 'evenings' }], [], 'usr_pub');
  });
});

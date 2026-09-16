import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot S over HTTP: `:party` is one of four words and anything else is a
 * 400 before any table is read; ADMIN at the router; a multipart CSV under
 * `file` and a JSON body both answer 201 VALIDATED; the list is on the list
 * contract; the report is text/csv; commit and revoke answer the service's
 * 409s.
 */

const { service, listingService, listings } = vi.hoisted(() => ({
  service: {
    validateImport: vi.fn(),
    listImports: vi.fn(),
    getImport: vi.fn(),
    commitImport: vi.fn(),
    revokeImport: vi.fn(),
    importReportCsv: vi.fn(),
  },
  listingService: {
    validateListingImport: vi.fn(),
    commitListingImport: vi.fn(),
    validateRateCardImport: vi.fn(),
    commitRateCardImport: vi.fn(),
  },
  listings: { assertCanCreateForPublisher: vi.fn(), LISTING_CATEGORIES: ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] },
}));

vi.mock('../party-imports.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../party-imports.service')>();
  return { ...actual, ...service };
});
vi.mock('../listing-imports.service', () => listingService);
vi.mock('../../listings', () => listings);

import { ApiError, errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { partyImportsRouter } from '../party-imports.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = express.Router();
  api.use('/party-imports', partyImportsRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'usr_admin');
const agent = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');

beforeEach(() => {
  vi.clearAllMocks();
  listings.assertCanCreateForPublisher.mockResolvedValue(undefined);
  listingService.validateListingImport.mockResolvedValue({ id: 'imp_l', party: 'LISTING', status: 'VALIDATED' });
  listingService.validateRateCardImport.mockResolvedValue({ id: 'imp_r', party: 'RATE_CARD', status: 'VALIDATED' });
  listingService.commitListingImport.mockResolvedValue({ id: 'imp_l', status: 'COMMITTED', attemptId: 'att_1' });
  service.validateImport.mockImplementation(async (party: string, input: { fileName?: string; rows: unknown[] }) => ({ id: 'imp_1', party, status: 'VALIDATED', fileName: input.fileName, rowCount: input.rows.length }));
  service.listImports.mockResolvedValue({ items: [{ id: 'imp_1' }], total: 1, page: 1, pageSize: 20, counts: { VALIDATED: 1, COMMITTED: 0, REVOKED: 0 } });
});

describe('/party-imports/:party', () => {
  it('400s a party that is not one of the four, before anything is read', async () => {
    const res = await request(app()).post('/api/v1/party-imports/publishers').set('Authorization', `Bearer ${admin}`).send({ rows: [{ mobile: '9000000001' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('advertisers, agents, print-partners, employees');
    expect(service.validateImport).not.toHaveBeenCalled();
    const list = await request(app()).get('/api/v1/party-imports/publishers').set('Authorization', `Bearer ${admin}`);
    expect(list.status).toBe(400);
  });

  it('is ADMIN only', async () => {
    const res = await request(app()).get('/api/v1/party-imports/agents').set('Authorization', `Bearer ${agent}`);
    expect(res.status).toBe(403);
    expect((await request(app()).get('/api/v1/party-imports/agents')).status).toBe(401);
  });

  it('POST takes a multipart CSV under `file` and answers 201 VALIDATED', async () => {
    const res = await request(app())
      .post('/api/v1/party-imports/print-partners')
      .set('Authorization', `Bearer ${admin}`)
      .field('note', 'the shops from the old sheet')
      .attach('file', Buffer.from('mobile,name,capabilities\n9000000001,Fresh Press,flex|vinyl\n'), 'shops.csv');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: 'imp_1', party: 'print-partners', status: 'VALIDATED', fileName: 'shops.csv', rowCount: 1 });
    expect(service.validateImport).toHaveBeenCalledWith(
      'print-partners',
      { fileName: 'shops.csv', note: 'the shops from the old sheet', rows: [{ rowNumber: 2, data: { mobile: '9000000001', name: 'Fresh Press', capabilities: 'flex|vinyl' } }] },
      'usr_admin',
      expect.anything(),
    );
  });

  it('POST takes a JSON body of rows and answers 201 VALIDATED; an empty body is a 400', async () => {
    const res = await request(app())
      .post('/api/v1/party-imports/employees')
      .set('Authorization', `Bearer ${admin}`)
      .send({ fileName: 'joiners.json', rows: [{ mobile: '9000000001', name: 'New Hire' }] });
    expect(res.status).toBe(201);
    expect(service.validateImport).toHaveBeenCalledWith('employees', { fileName: 'joiners.json', note: undefined, rows: [{ rowNumber: 1, data: { mobile: '9000000001', name: 'New Hire' } }] }, 'usr_admin', expect.anything());

    const empty = await request(app()).post('/api/v1/party-imports/employees').set('Authorization', `Bearer ${admin}`).send({});
    expect(empty.status).toBe(400);
  });

  it('GET lists on the list contract, filtered by status', async () => {
    const res = await request(app()).get('/api/v1/party-imports/advertisers?status=VALIDATED&page=1&pageSize=10').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ items: [{ id: 'imp_1' }], total: 1, page: 1, pageSize: 20, counts: { VALIDATED: 1 } });
    expect(service.listImports).toHaveBeenCalledWith('advertisers', { status: ['VALIDATED'], page: 1, pageSize: 10 });
    const bad = await request(app()).get('/api/v1/party-imports/advertisers?status=DONE').set('Authorization', `Bearer ${admin}`);
    expect(bad.status).toBe(400);
  });

  it('GET /:id, the report as CSV, commit and revoke', async () => {
    service.getImport.mockResolvedValue({ id: 'imp_1', rows: [] });
    service.importReportCsv.mockResolvedValue('rowNumber,outcome\r\n2,CREATED\r\n');
    service.commitImport.mockResolvedValue({ id: 'imp_1', status: 'COMMITTED' });
    service.revokeImport.mockRejectedValue(Object.assign(new Error('Only an uncommitted import can be revoked'), { statusCode: 409, code: 'CONFLICT' }));

    const one = await request(app()).get('/api/v1/party-imports/agents/imp_1').set('Authorization', `Bearer ${admin}`);
    expect(one.status).toBe(200);
    expect(service.getImport).toHaveBeenCalledWith('agents', 'imp_1');

    const report = await request(app()).get('/api/v1/party-imports/agents/imp_1/report.csv').set('Authorization', `Bearer ${admin}`);
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toContain('text/csv');
    expect(report.headers['content-disposition']).toContain('agents-import-imp_1.csv');
    expect(report.text).toBe('rowNumber,outcome\r\n2,CREATED\r\n');

    const commit = await request(app()).post('/api/v1/party-imports/agents/imp_1/commit').set('Authorization', `Bearer ${admin}`);
    expect(commit.status).toBe(200);
    expect(service.commitImport).toHaveBeenCalledWith('agents', 'imp_1', 'usr_admin', expect.anything());
  });
});

/**
 * Lot U over HTTP: `/party-imports/listings` and `/party-imports/rate-card`
 * take `?publisherId=` (400 without), let an AGENT_PUBLISHER through the
 * router (the act rule is the service's), and are read ahead of `/:party`;
 * `/party-imports/formats` is the guide, ADMIN only, with a CSV template
 * per kind.
 */
describe('Lot U: /party-imports/listings, /party-imports/rate-card', () => {
  it('POST needs ?publisherId=, takes a CSV or JSON rows, and answers 201 with the plan', async () => {
    const missing = await request(app()).post('/api/v1/party-imports/listings').set('Authorization', `Bearer ${admin}`).send({ rows: [{ title: 'X' }] });
    expect(missing.status).toBe(400);
    expect(listingService.validateListingImport).not.toHaveBeenCalled();

    const res = await request(app())
      .post('/api/v1/party-imports/listings?publisherId=pub_1')
      .set('Authorization', `Bearer ${agent}`)
      .attach('file', Buffer.from('title,category,address,ratePerDay\nFC Road Hoarding,OUTDOOR,"44, FC Road",1200\n'), 'spots.csv');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: 'imp_l', party: 'LISTING' });
    expect(listingService.validateListingImport).toHaveBeenCalledWith(
      'pub_1',
      { fileName: 'spots.csv', note: undefined, rows: [{ rowNumber: 2, data: { title: 'FC Road Hoarding', category: 'OUTDOOR', address: '44, FC Road', ratePerDay: '1200' } }] },
      { userId: 'usr_agent', isAdmin: false },
      expect.anything(),
    );

    const json = await request(app()).post('/api/v1/party-imports/rate-card?publisherId=pub_1').set('Authorization', `Bearer ${admin}`).send({ rows: [{ listing: 'ADX-LST-00001', ratePerDay: '1800' }] });
    expect(json.status).toBe(201);
    expect(listingService.validateRateCardImport).toHaveBeenCalledWith('pub_1', expect.objectContaining({ rows: [{ rowNumber: 1, data: { listing: 'ADX-LST-00001', ratePerDay: '1800' } }] }), { userId: 'usr_admin', isAdmin: true }, expect.anything());
  });

  it('GET lists with ?publisherId=; an agent must name the publisher and passes the act rule; commit answers the attempt id', async () => {
    const list = await request(app()).get('/api/v1/party-imports/listings?publisherId=pub_1&status=COMMITTED').set('Authorization', `Bearer ${admin}`);
    expect(list.status).toBe(200);
    expect(service.listImports).toHaveBeenCalledWith('listings', { publisherId: 'pub_1', status: ['COMMITTED'], page: 1, pageSize: 20 });

    const agentNoPublisher = await request(app()).get('/api/v1/party-imports/rate-card').set('Authorization', `Bearer ${agent}`);
    expect(agentNoPublisher.status).toBe(400);
    const agentList = await request(app()).get('/api/v1/party-imports/rate-card?publisherId=pub_1').set('Authorization', `Bearer ${agent}`);
    expect(agentList.status).toBe(200);
    expect(listings.assertCanCreateForPublisher).toHaveBeenCalledWith('pub_1', { userId: 'usr_agent', isAdmin: false });

    const commit = await request(app()).post('/api/v1/party-imports/listings/imp_l/commit').set('Authorization', `Bearer ${admin}`);
    expect(commit.status).toBe(200);
    expect(commit.body.data).toMatchObject({ status: 'COMMITTED', attemptId: 'att_1' });
    expect(listingService.commitListingImport).toHaveBeenCalledWith('imp_l', { userId: 'usr_admin', isAdmin: true }, 'usr_admin', expect.anything());

    // A publisher's own account is not a role the router lets through.
    const publisher = tokenFor(['PUBLISHER'], 'usr_pub');
    expect((await request(app()).get('/api/v1/party-imports/listings?publisherId=pub_1').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
  });

  it('GET /:id, report.csv and revoke read the import under the act rule for an agent', async () => {
    service.getImport.mockResolvedValue({ id: 'imp_l', publisherId: 'pub_1', rows: [] });
    service.importReportCsv.mockResolvedValue('rowNumber,outcome\r\n');
    service.revokeImport.mockResolvedValue({ id: 'imp_l', status: 'REVOKED' });
    listings.assertCanCreateForPublisher.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'This is not your publisher.'));

    const forbidden = await request(app()).get('/api/v1/party-imports/listings/imp_l').set('Authorization', `Bearer ${agent}`);
    expect(forbidden.status).toBe(403);
    const one = await request(app()).get('/api/v1/party-imports/listings/imp_l').set('Authorization', `Bearer ${agent}`);
    expect(one.status).toBe(200);
    expect(service.getImport).toHaveBeenCalledWith('listings', 'imp_l');

    const report = await request(app()).get('/api/v1/party-imports/rate-card/imp_l/report.csv').set('Authorization', `Bearer ${admin}`);
    expect(report.status).toBe(200);
    expect(report.headers['content-disposition']).toContain('rate-card-import-imp_l.csv');
    expect(service.importReportCsv).toHaveBeenCalledWith('rate-card', 'imp_l');

    const revoke = await request(app()).post('/api/v1/party-imports/listings/imp_l/revoke').set('Authorization', `Bearer ${admin}`);
    expect(revoke.status).toBe(200);
    expect(service.revokeImport).toHaveBeenCalledWith('listings', 'imp_l', 'usr_admin', expect.anything());
  });
});

describe('Lot U: /party-imports/formats', () => {
  it('is ADMIN only and answers every kind, one kind, and a template.csv; an unknown kind is 404', async () => {
    expect((await request(app()).get('/api/v1/party-imports/formats').set('Authorization', `Bearer ${agent}`)).status).toBe(403);

    const all = await request(app()).get('/api/v1/party-imports/formats').set('Authorization', `Bearer ${admin}`);
    expect(all.status).toBe(200);
    expect(all.body.data.map((format: { kind: string }) => format.kind)).toEqual(['publishers', 'advertisers', 'agents', 'print-partners', 'employees', 'listings', 'rate-card', 'leads', 'market-data', 'finance-reconciliation']);

    const one = await request(app()).get('/api/v1/party-imports/formats/rate-card').set('Authorization', `Bearer ${admin}`);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ kind: 'rate-card', templateCsvUrl: '/api/v1/party-imports/formats/rate-card/template.csv', columns: expect.arrayContaining([expect.objectContaining({ name: 'listing', required: true })]) });

    const template = await request(app()).get('/api/v1/party-imports/formats/listings/template.csv').set('Authorization', `Bearer ${admin}`);
    expect(template.status).toBe(200);
    expect(template.headers['content-type']).toContain('text/csv');
    expect(template.text.split('\r\n')[0]).toBe('externalRef,title,category,subType,description,address,city,state,latitude,longitude,mediaType,sizeClass,size,material,ratePerDay,monthlyPrice,slotsTotal,instantBooking,photos');
    expect(template.text.split('\r\n').filter(Boolean)).toHaveLength(3);

    expect((await request(app()).get('/api/v1/party-imports/formats/spaceships').set('Authorization', `Bearer ${admin}`)).status).toBe(404);
    // `formats` is not a party either: the guide answers before `/:party` could.
    expect(service.listImports).not.toHaveBeenCalledWith('formats', expect.anything());
  });
});

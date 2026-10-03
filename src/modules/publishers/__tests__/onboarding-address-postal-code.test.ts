import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Onboarding addresses (the owner, 1 Oct 2026): one address search bar on
 * every onboarding flow, filling the address all the way to the PIN code.
 * The publisher had no PIN column; `postalCode` now rides every route that
 * takes the publisher's `address` — the desk's (and the agent door's)
 * create, the desk's edit, and the publisher's own `PATCH /publishers/me` —
 * and lands on the row.
 *
 * Pinned: the field reaches the service from each route; a bad PIN is a 400
 * whose details name the field with a message a person can act on; the
 * repository writes the column on create and on update.
 */

const { service, onboarding, agents, audit, prisma } = vi.hoisted(() => ({
  service: {
    createPublisher: vi.fn(),
    getOwnedPublisher: vi.fn(),
    getAllPublishers: vi.fn(),
    getPublishersForAgent: vi.fn(),
    updatePublisher: vi.fn(),
    updatePublisherAtDesk: vi.fn(),
    withEntityType: (row: unknown) => row,
  },
  onboarding: { updateMyProfile: vi.fn() },
  agents: (() => {
    const o = { requireAgentProfile: vi.fn(), agentExists: vi.fn() };
    return { ...o, requireWorkingAgent: o.requireAgentProfile };
  })(),
  audit: { logActivity: vi.fn() },
  prisma: { publisher: { create: vi.fn(), update: vi.fn() } },
}));

vi.mock('../publishers.service', () => service);
vi.mock('../onboarding/publisher-onboarding.service', () => onboarding);
vi.mock('../../agents', () => agents);
vi.mock('../../listings', () => ({ getListingsForPublisher: vi.fn() }));
vi.mock('../../ai', () => ({ translateListings: vi.fn() }));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../access-control', async (importOriginal) => ({ ...(await importOriginal<object>()), actorLabelFor: vi.fn(async () => 'Admin') }));
vi.mock('../../../shared/database', async (importOriginal) => ({ ...(await importOriginal<object>()), prisma }));

import { errorHandler } from '../../../shared/errors';
import { asyncHandler } from '../../../shared/http';
import { tokenFor } from '../../../shared/testing';
import { authenticate, requireRole } from '../../../shared/auth';
import { PIN_CODE_MESSAGE } from '../../../shared/validation';
import { createPublisherHandler, updatePublisherHandler } from '../publishers.controller';
import { updateMyPublisherProfileHandler } from '../onboarding/publisher-onboarding.controller';
import { prismaPublishersRepository } from '../prisma-publishers.repository';

function appWith() {
  const app = express();
  app.use(express.json());
  app.post('/api/v1/publishers', authenticate, requireRole('AGENT_PUBLISHER', 'ADMIN'), asyncHandler(createPublisherHandler));
  app.patch('/api/v1/publishers/me', authenticate, requireRole('PUBLISHER'), asyncHandler(updateMyPublisherProfileHandler));
  app.patch('/api/v1/publishers/:publisherId', authenticate, requireRole('AGENT_PUBLISHER', 'ADMIN'), asyncHandler(updatePublisherHandler));
  app.use(errorHandler);
  return app;
}

const admin = tokenFor(['ADMIN'], 'usr_admin');
const agent = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');
const publisher = tokenFor(['PUBLISHER'], 'usr_pub');

beforeEach(() => {
  vi.clearAllMocks();
  service.createPublisher.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'pub_1', ...data }));
  service.updatePublisherAtDesk.mockImplementation(async (id: string, _admin: string, patch: Record<string, unknown>) => ({ id, ...patch }));
  service.updatePublisher.mockImplementation(async (id: string, _user: string, patch: Record<string, unknown>) => ({ id, ...patch }));
  onboarding.updateMyProfile.mockImplementation(async (_user: string, patch: Record<string, unknown>) => ({ id: 'pub_1', ...patch }));
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1' });
  audit.logActivity.mockResolvedValue(undefined);
  prisma.publisher.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'pub_1', ...data }));
  prisma.publisher.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'pub_1', ...data }));
});

const pinIssue = (res: request.Response) => res.body.error.details.fieldErrors.postalCode as string[];

describe('POST /publishers — the desk and the agent door', () => {
  it('takes the PIN beside the address, trimmed, from the desk and from an agent', async () => {
    const body = { name: 'Sharma Hoardings', mobile: '9876543210', address: '12 Mount Road', city: 'Chennai', state: 'Tamil Nadu', postalCode: ' 600001 ', latitude: 13.06, longitude: 80.27 };
    const desk = await request(appWith()).post('/api/v1/publishers').set('Authorization', `Bearer ${admin}`).send(body);
    expect(desk.status).toBe(201);
    expect(service.createPublisher).toHaveBeenLastCalledWith(expect.objectContaining({ address: '12 Mount Road', postalCode: '600001' }));
    expect(desk.body.data.postalCode).toBe('600001');

    const door = await request(appWith()).post('/api/v1/publishers').set('Authorization', `Bearer ${agent}`).send(body);
    expect(door.status).toBe(201);
    expect(service.createPublisher).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: 'agt_1', postalCode: '600001' }));
  });

  it('answers 400 for a bad PIN, naming the field with a message a person can act on, and creates nothing', async () => {
    const res = await request(appWith()).post('/api/v1/publishers').set('Authorization', `Bearer ${admin}`).send({ name: 'Sharma Hoardings', mobile: '9876543210', postalCode: '06001' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(pinIssue(res)).toEqual([PIN_CODE_MESSAGE]);
    expect(service.createPublisher).not.toHaveBeenCalled();
  });

  it('takes a create with no PIN at all — never required', async () => {
    const res = await request(appWith()).post('/api/v1/publishers').set('Authorization', `Bearer ${admin}`).send({ name: 'Sharma Hoardings', mobile: '9876543210', address: '12 Mount Road' });
    expect(res.status).toBe(201);
    expect(service.createPublisher.mock.calls[0]![0]).not.toHaveProperty('postalCode');
  });
});

describe('PATCH /publishers/:id — the desk and the agent under a grant', () => {
  it('passes the PIN to the edit; a blank box clears it', async () => {
    const res = await request(appWith()).patch('/api/v1/publishers/pub_1').set('Authorization', `Bearer ${admin}`).send({ postalCode: '560001' });
    expect(res.status).toBe(200);
    expect(service.updatePublisherAtDesk).toHaveBeenCalledWith('pub_1', 'usr_admin', { postalCode: '560001' }, expect.anything());
    expect(res.body.data.postalCode).toBe('560001');

    await request(appWith()).patch('/api/v1/publishers/pub_1').set('Authorization', `Bearer ${agent}`).send({ postalCode: '' });
    expect(service.updatePublisher).toHaveBeenCalledWith('pub_1', 'usr_agent', { postalCode: null }, expect.anything());
  });

  it('answers 400 for a bad PIN', async () => {
    const res = await request(appWith()).patch('/api/v1/publishers/pub_1').set('Authorization', `Bearer ${admin}`).send({ postalCode: '5600011' });
    expect(res.status).toBe(400);
    expect(pinIssue(res)).toEqual([PIN_CODE_MESSAGE]);
    expect(service.updatePublisherAtDesk).not.toHaveBeenCalled();
  });
});

describe("PATCH /publishers/me — the publisher's own onboarding", () => {
  it('passes the PIN to the profile update', async () => {
    const res = await request(appWith()).patch('/api/v1/publishers/me').set('Authorization', `Bearer ${publisher}`).send({ address: '12 MG Road', postalCode: '560001' });
    expect(res.status).toBe(200);
    expect(onboarding.updateMyProfile).toHaveBeenCalledWith('usr_pub', { address: '12 MG Road', postalCode: '560001' });
  });

  it('answers 400 for a bad PIN', async () => {
    const res = await request(appWith()).patch('/api/v1/publishers/me').set('Authorization', `Bearer ${publisher}`).send({ postalCode: 'ABC123' });
    expect(res.status).toBe(400);
    expect(pinIssue(res)).toEqual([PIN_CODE_MESSAGE]);
    expect(onboarding.updateMyProfile).not.toHaveBeenCalled();
  });
});

describe('the repository stores it', () => {
  it('writes postalCode on create, and leaves the column to its default when none was given', async () => {
    await prismaPublishersRepository.create({ agentId: null, name: 'Sharma Hoardings', mobile: '+919876543210', address: '12 Mount Road', postalCode: '600001' });
    expect(prisma.publisher.create.mock.calls[0]![0].data).toEqual(expect.objectContaining({ address: '12 Mount Road', postalCode: '600001' }));
    await prismaPublishersRepository.create({ agentId: null, name: 'Sharma Hoardings', mobile: '+919876543211' });
    expect(prisma.publisher.create.mock.calls[1]![0].data).not.toHaveProperty('postalCode');
  });

  it('writes postalCode on update, null included', async () => {
    await prismaPublishersRepository.update('pub_1', { postalCode: '600002' });
    expect(prisma.publisher.update.mock.calls[0]![0]).toEqual(expect.objectContaining({ where: { id: 'pub_1' }, data: expect.objectContaining({ postalCode: '600002' }) }));
    await prismaPublishersRepository.update('pub_1', { postalCode: null });
    expect(prisma.publisher.update.mock.calls[1]![0].data).toEqual(expect.objectContaining({ postalCode: null }));
  });
});

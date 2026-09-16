import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Q29 — ADX opens publisher accounts from the desk as well as agents opening
 * them at the door.
 *
 * The agent path is unchanged, byte for byte: attribution comes from the agent
 * behind the session and a body field can never move it. The admin path
 * attributes to nobody unless it names an agent, that agent has to exist, and
 * it leaves its own audit action so the two are distinguishable for ever.
 */

const { service, agents, audit } = vi.hoisted(() => ({
  service: {
    createPublisher: vi.fn(),
    getOnboardingStatus: vi.fn(),
    getOwnedPublisher: vi.fn(),
    getAllPublishers: vi.fn(),
    getPublishersForAgent: vi.fn(),
    reviewKyc: vi.fn(),
    submitKyc: vi.fn(),
    updatePublisher: vi.fn(),
    listKycQueue: vi.fn(),
    getKycCase: vi.fn(),
    restartDigioKyc: vi.fn(),
  },
  agents: { requireAgentProfile: vi.fn(), agentExists: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../publishers.service', () => service);
vi.mock('../../agents', () => agents);
vi.mock('../../listings', () => ({ getListingsForPublisher: vi.fn() }));
vi.mock('../../ai', () => ({ translateListings: vi.fn() }));
vi.mock('../../../shared/audit', () => audit);

import { errorHandler } from '../../../shared/errors';
import { asyncHandler } from '../../../shared/http';
import { tokenFor } from '../../../shared/testing';
import { createPublisherHandler } from '../publishers.controller';
import { authenticate, requireRole } from '../../../shared/auth';

function appWith() {
  const app = express();
  app.use(express.json());
  app.post(
    '/api/v1/publishers',
    authenticate,
    requireRole('AGENT_PUBLISHER', 'ADMIN'),
    asyncHandler(createPublisherHandler),
  );
  app.use(errorHandler);
  return app;
}

const body = { name: 'Sharma Hoardings', mobile: '9876543210' };
const admin = tokenFor(['ADMIN'], 'usr_admin');
const agent = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');

beforeEach(() => {
  vi.clearAllMocks();
  service.createPublisher.mockResolvedValue({ id: 'pub_1', mobile: '9876543210' });
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1' });
  agents.agentExists.mockResolvedValue(true);
  audit.logActivity.mockResolvedValue(undefined);
});

describe('the agent path', () => {
  it('is unchanged: attribution comes from the session', async () => {
    const res = await request(appWith()).post('/api/v1/publishers').set('Authorization', `Bearer ${agent}`).send(body);

    expect(res.status).toBe(201);
    expect(service.createPublisher).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agt_1' }));
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('ignores an attribution the agent tried to send', async () => {
    await request(appWith())
      .post('/api/v1/publishers')
      .set('Authorization', `Bearer ${agent}`)
      .send({ ...body, attributeToAgentId: 'agt_someone_else' });

    expect(service.createPublisher).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agt_1' }));
    expect(service.createPublisher.mock.calls[0]![0]).not.toHaveProperty('attributeToAgentId');
  });
});

describe('the admin path', () => {
  it('opens an account attributed to nobody', async () => {
    const res = await request(appWith()).post('/api/v1/publishers').set('Authorization', `Bearer ${admin}`).send(body);

    expect(res.status).toBe(201);
    expect(service.createPublisher).toHaveBeenCalledWith(expect.objectContaining({ agentId: null }));
    expect(agents.requireAgentProfile).not.toHaveBeenCalled();
  });

  it('attributes to the agent named in the body, and only from the body', async () => {
    await request(appWith())
      .post('/api/v1/publishers')
      .set('Authorization', `Bearer ${admin}`)
      .send({ ...body, attributeToAgentId: 'agt_9' });

    expect(agents.agentExists).toHaveBeenCalledWith('agt_9');
    expect(service.createPublisher).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agt_9' }));
  });

  it('refuses to credit a book to an agent nobody holds', async () => {
    agents.agentExists.mockResolvedValue(false);

    const res = await request(appWith())
      .post('/api/v1/publishers')
      .set('Authorization', `Bearer ${admin}`)
      .send({ ...body, attributeToAgentId: 'agt_nope' });

    expect(res.status).toBe(404);
    expect(service.createPublisher).not.toHaveBeenCalled();
  });

  it('leaves its own audit row against the Publisher', async () => {
    await request(appWith())
      .post('/api/v1/publishers')
      .set('Authorization', `Bearer ${admin}`)
      .send({ ...body, attributeToAgentId: 'agt_9' });

    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'PUBLISHER_CREATED_BY_ADMIN',
      expect.objectContaining({
        targetType: 'Publisher',
        targetId: 'pub_1',
        module: 'publishers',
        metadata: expect.objectContaining({ attributedToAgentId: 'agt_9' }),
      }),
    );
  });
});

describe('everyone else', () => {
  it('is refused, as before', async () => {
    const res = await request(appWith())
      .post('/api/v1/publishers')
      .set('Authorization', `Bearer ${tokenFor(['PUBLISHER'])}`)
      .send(body);
    expect(res.status).toBe(403);
  });
});

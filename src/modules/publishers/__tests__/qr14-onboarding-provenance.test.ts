import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-14 — who onboarded whom.
 *
 * Pinned: the desk stamps DESK with the admin and their console role, the
 * agent door stamps AGENT with "Agent"; the provenance helpers write the
 * shape every door shares; the detail read and the roster name the person
 * behind the stamp; and the roster takes the door and the person as
 * filters.
 */

const { service, agents, audit, access } = vi.hoisted(() => ({
  service: {
    createPublisher: vi.fn(),
    getOnboardingStatus: vi.fn(),
    getOwnedPublisher: vi.fn(),
    getAllPublishers: vi.fn(),
    getPublishersForAgent: vi.fn(),
    getPublisherRoster: vi.fn(),
    reviewKyc: vi.fn(),
    submitKyc: vi.fn(),
    updatePublisher: vi.fn(),
    updatePublisherAtDesk: vi.fn(),
    listKycQueue: vi.fn(),
    getKycCase: vi.fn(),
    restartDigioKyc: vi.fn(),
  },
  agents: { requireAgentProfile: vi.fn(), agentExists: vi.fn() },
  audit: { logActivity: vi.fn() },
  access: { actorLabelFor: vi.fn() },
}));

vi.mock('../publishers.service', () => service);
vi.mock('../../agents', () => agents);
vi.mock('../../access-control', () => access);
vi.mock('../../listings', () => ({ getListingsForPublisher: vi.fn() }));
vi.mock('../../ai', () => ({ translateListings: vi.fn() }));
vi.mock('../../../shared/audit', () => audit);

import { errorHandler } from '../../../shared/errors';
import { asyncHandler } from '../../../shared/http';
import { tokenFor } from '../../../shared/testing';
import { doorProvenance, onboardingFactsOf, ONBOARDING_SOURCE_LABEL, selfProvenance } from '../../../shared/onboarding';
import { createPublisherHandler, getPublishersHandler } from '../publishers.controller';
import { authenticate, requireRole } from '../../../shared/auth';
import { publisherRosterQuerySchema } from '../publishers.schema';

function appWith() {
  const app = express();
  app.use(express.json());
  app.post('/api/v1/publishers', authenticate, requireRole('AGENT_PUBLISHER', 'ADMIN'), asyncHandler(createPublisherHandler));
  app.get('/api/v1/publishers', authenticate, asyncHandler(getPublishersHandler));
  app.use(errorHandler);
  return app;
}

const admin = tokenFor(['ADMIN'], 'usr_admin');
const agent = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');

beforeEach(() => {
  vi.clearAllMocks();
  service.createPublisher.mockResolvedValue({ id: 'pub_1', mobile: '+919876543210', name: 'Sharma Hoardings', displayId: 'PUB-1709-2601', agentId: null });
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1' });
  access.actorLabelFor.mockImplementation(async (_id: string, roles: string[]) => (roles.includes('ADMIN') ? 'Ops manager' : 'Agent'));
});

describe('the helpers', () => {
  it('write the shape every door shares', () => {
    const at = new Date('2026-09-17T09:00:00.000Z');
    expect(selfProvenance(at)).toEqual({ onboardedVia: 'SELF', onboardedById: null, onboardedByRole: null, onboardedAt: at });
    expect(doorProvenance('DESK', 'usr_admin', 'Ops manager', at)).toEqual({ onboardedVia: 'DESK', onboardedById: 'usr_admin', onboardedByRole: 'Ops manager', onboardedAt: at });
    expect(onboardingFactsOf({ onboardedVia: 'QR', onboardedById: 'usr_agent', onboardedByRole: 'Agent', onboardedAt: at }, 'Ravi Agent')).toEqual({
      via: 'QR',
      viaLabel: ONBOARDING_SOURCE_LABEL.QR,
      byId: 'usr_agent',
      byName: 'Ravi Agent',
      byRole: 'Agent',
      at,
    });
    expect(onboardingFactsOf({ onboardedVia: null, onboardedById: null, onboardedByRole: null, onboardedAt: null }, null)).toEqual({ via: null, viaLabel: null, byId: null, byName: null, byRole: null, at: null });
  });
});

describe('the doors', () => {
  it('the desk stamps DESK with the admin and their console role', async () => {
    const res = await request(appWith()).post('/api/v1/publishers').set('Authorization', `Bearer ${admin}`).send({ name: 'Sharma Hoardings', mobile: '9876543210' });
    expect(res.status).toBe(201);
    expect(access.actorLabelFor).toHaveBeenCalledWith('usr_admin', ['ADMIN']);
    expect(service.createPublisher).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: null, onboardedVia: 'DESK', onboardedById: 'usr_admin', onboardedByRole: 'Ops manager', onboardedAt: expect.any(Date) }),
    );
  });

  it('the agent door stamps AGENT with the agent', async () => {
    const res = await request(appWith()).post('/api/v1/publishers').set('Authorization', `Bearer ${agent}`).send({ name: 'Sharma Hoardings', mobile: '9876543210' });
    expect(res.status).toBe(201);
    expect(service.createPublisher).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agt_1', onboardedVia: 'AGENT', onboardedById: 'usr_agent', onboardedByRole: 'Agent' }),
    );
  });
});

describe('the roster', () => {
  it('takes the door and the person as filters, and refuses an unknown door', () => {
    expect(publisherRosterQuerySchema.safeParse({ page: 1, onboardedVia: 'desk', onboardedById: 'usr_admin' }).success).toBe(true);
    const parsed = publisherRosterQuerySchema.safeParse({ page: 1, onboardedVia: 'desk' });
    expect(parsed.success && parsed.data.onboardedVia).toBe('DESK');
    expect(publisherRosterQuerySchema.safeParse({ page: 1, onboardedVia: 'FAX' }).success).toBe(false);
  });

  it('passes them to the service on the list contract', async () => {
    service.getPublisherRoster.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25, counts: {} });
    const res = await request(appWith()).get('/api/v1/publishers?page=1&onboardedVia=DESK&onboardedById=usr_admin').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(service.getPublisherRoster).toHaveBeenCalledWith(expect.objectContaining({ onboardedVia: 'DESK', onboardedById: 'usr_admin' }));
  });
});

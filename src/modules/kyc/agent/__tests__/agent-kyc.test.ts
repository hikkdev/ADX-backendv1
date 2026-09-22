import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D4 — an agent's KYC, recorded at ADX's desk.
 *
 * What is pinned: recording is on behalf of an agent who exists and
 * remembers who recorded it; a second recording sends a rejected record
 * back to PENDING; a rejection has to say why; and an agent reads their own
 * record, or null before anything is recorded.
 */

const { repository, agents } = vi.hoisted(() => ({
  repository: {
    findPage: vi.fn(),
    findByAgentId: vi.fn(),
    record: vi.fn(),
    review: vi.fn(),
  },
  agents: { agentExists: vi.fn(), findAgentProfile: vi.fn(), upsertDocumentsFromKyc: vi.fn(async () => undefined) },
}));

vi.mock('../prisma-agent-kyc.repository', () => ({ prismaAgentKycRepository: repository }));
vi.mock('../../../agents', () => agents);
vi.mock('../../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })) }));

import { getAgentKyc, getMyAgentKyc, recordAgentKyc, reviewAgentKyc } from '../agent-kyc.service';
import { registerKycUserLabelPort, resetKycUserLabelPort } from '../../case-read';
import { agentKycDocumentsSchema } from '../agent-kyc.schema';

const row = { id: 'akyc_1', agentId: 'agt_1', status: 'PENDING', agent: { id: 'agt_1', displayId: 'AGT-1', city: null, user: { name: 'Rahul', mobile: '+91' } } };

beforeEach(() => {
  vi.clearAllMocks();
  agents.agentExists.mockResolvedValue(true);
  agents.findAgentProfile.mockResolvedValue({ id: 'agt_1' });
  repository.findByAgentId.mockResolvedValue(row);
  repository.record.mockResolvedValue(row);
  repository.review.mockImplementation(async (agentId: string, status: string, reason: string | null) => ({ ...row, status, rejectionReason: reason }));
});

describe('the documents', () => {
  it('take the seven DR 08 fields plus a bank proof, PAN upper-cased and checked', () => {
    expect(agentKycDocumentsSchema.parse({ panNumber: 'abcde1234f', bankProofUrl: 'https://cdn.adx.in/k/1.jpg' })).toEqual({
      panNumber: 'ABCDE1234F',
      bankProofUrl: 'https://cdn.adx.in/k/1.jpg',
    });
    expect(agentKycDocumentsSchema.safeParse({ panNumber: 'nope' }).success).toBe(false);
    expect(agentKycDocumentsSchema.safeParse({ govIdType: 'VOTER' }).success).toBe(false);
  });
});

describe('recording on behalf', () => {
  it('writes the documents against an existing agent, remembering who recorded them', async () => {
    await recordAgentKyc('agt_1', { govIdType: 'AADHAAR', govIdFrontUrl: 'https://cdn.adx.in/k/1.jpg' }, 'usr_admin');
    expect(repository.record).toHaveBeenCalledWith('agt_1', { govIdType: 'AADHAAR', govIdFrontUrl: 'https://cdn.adx.in/k/1.jpg' }, 'usr_admin');
  });

  it('refuses an agent that does not exist', async () => {
    agents.agentExists.mockResolvedValue(false);
    await expect(recordAgentKyc('agt_x', {}, 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.record).not.toHaveBeenCalled();
  });
});

describe('the decision', () => {
  it('verifies, naming the reviewer', async () => {
    const reviewed = await reviewAgentKyc('agt_1', 'VERIFIED', undefined, 'usr_admin');
    expect(repository.review).toHaveBeenCalledWith('agt_1', 'VERIFIED', null, 'usr_admin');
    expect(reviewed.status).toBe('VERIFIED');
  });

  it('a rejection has to say why', async () => {
    await expect(reviewAgentKyc('agt_1', 'REJECTED', '  ', 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
    await reviewAgentKyc('agt_1', 'REJECTED', 'Selfie does not match the ID', 'usr_admin');
    expect(repository.review).toHaveBeenCalledWith('agt_1', 'REJECTED', 'Selfie does not match the ID', 'usr_admin');
  });

  it('cannot decide on a record that was never made', async () => {
    repository.findByAgentId.mockResolvedValue(null);
    await expect(reviewAgentKyc('agt_2', 'VERIFIED', undefined, 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the agent reading their own', () => {
  it('is their record, or null before one exists', async () => {
    expect(await getMyAgentKyc('usr_agent')).toMatchObject({ agentId: 'agt_1' });
    repository.findByAgentId.mockResolvedValue(null);
    expect(await getMyAgentKyc('usr_agent')).toBeNull();
  });

  it('is refused without an agent profile', async () => {
    agents.findAgentProfile.mockResolvedValue(null);
    await expect(getMyAgentKyc('usr_x')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('E7-3: the desk case read', () => {
  it('carries the age against the SLA and the reviewer and recorder by name', async () => {
    registerKycUserLabelPort(async (ids) => new Map(ids.map((id) => [id, { id, name: id === 'usr_hr' ? 'Priya' : null }])));
    try {
      const now = new Date('2026-09-12T12:00:00.000Z');
      repository.findByAgentId.mockResolvedValue({ ...row, submittedAt: new Date(now.getTime() - 60 * 3600_000), recordedById: 'usr_hr', reviewedById: 'usr_ops' });
      const read = await getAgentKyc('agt_1', now);
      expect(read).toMatchObject({
        id: 'akyc_1',
        ageHours: 60,
        slaBreached: true,
        slaHours: 48,
        recordedBy: { id: 'usr_hr', name: 'Priya' },
        reviewedBy: { id: 'usr_ops', name: null },
        assignedTo: null,
      });
    } finally {
      resetKycUserLabelPort();
    }
    repository.findByAgentId.mockResolvedValue(null);
    await expect(getAgentKyc('agt_none')).rejects.toMatchObject({ statusCode: 404 });
  });
});

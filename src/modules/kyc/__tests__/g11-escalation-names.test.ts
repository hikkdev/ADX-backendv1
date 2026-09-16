import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G11-1: the escalation on a KYC case by name — `escalatedTo` and
 * `escalatedBy` as `{ id, name } | null` beside the ids, on the advertiser
 * case read and on every advertiser queue row, through the same label port
 * and inside the same lookup the assignee already rides. The publisher twin
 * is pinned in `publishers/__tests__/g11-escalation-names.test.ts`.
 */

const { repository, reviews, settings } = vi.hoisted(() => ({
  repository: { findPage: vi.fn(), countBreached: vi.fn(), countByState: vi.fn(), countEscalated: vi.fn(async () => 0), countRequested: vi.fn(async () => 0), findById: vi.fn() },
  reviews: { listFor: vi.fn(async () => []), upsert: vi.fn(), clear: vi.fn() },
  settings: { getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })) },
}));

vi.mock('../advertiser/prisma-advertiser-kyc.repository', () => ({ prismaAdvertiserKycRepository: repository }));
vi.mock('../document-review/prisma-document-review.repository', () => ({ prismaDocumentReviewRepository: reviews }));
vi.mock('../../app-config', () => settings);
vi.mock('../../advertisers', () => ({ applyKycDecisionByUserId: vi.fn(), getAdvertiserForUser: vi.fn() }));
vi.mock('../user/user-kyc.service', () => ({ livenessStateFor: vi.fn(async () => null), hasSubmittedLiveness: vi.fn() }));

import { kycCaseExtras, registerKycUserLabelPort, resetKycUserLabelPort } from '../case-read';
import { getAdvertiserKycCase, listAdvertiserKycs } from '../advertiser/advertiser-kyc.service';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const names: Record<string, string> = { usr_priya: 'Priya', usr_ravi: 'Ravi', usr_comp: 'Compliance Desk' };
const port = vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, { id, name: names[id] ?? null }])));

beforeEach(() => {
  vi.clearAllMocks();
  repository.countBreached.mockResolvedValue(0);
  repository.countByState.mockResolvedValue({ AWAITING_DOCUMENTS: 0, REQUESTED: 0, PENDING: 0, VERIFIED: 0, REJECTED: 0, NEEDS_INFO: 0 });
  repository.findPage.mockResolvedValue({ items: [], total: 0 });
  registerKycUserLabelPort(port);
});
afterEach(() => resetKycUserLabelPort());

describe('kycCaseExtras — the escalation by name', () => {
  it('names escalatedTo and escalatedBy in the one lookup the three people already share', async () => {
    const extras = await kycCaseExtras(
      { status: 'PENDING', submittedAt: NOW, reviewedById: null, assignedToId: 'usr_priya', recordedById: null, escalatedToUserId: 'usr_comp', escalatedById: 'usr_ravi' },
      NOW,
    );
    expect(extras).toMatchObject({
      assignedTo: { id: 'usr_priya', name: 'Priya' },
      escalatedTo: { id: 'usr_comp', name: 'Compliance Desk' },
      escalatedBy: { id: 'usr_ravi', name: 'Ravi' },
    });
    expect(port).toHaveBeenCalledTimes(1);
    expect(port).toHaveBeenCalledWith(['usr_priya', 'usr_comp', 'usr_ravi']);
  });

  it('is null on a case never escalated, and null for a party with no KYC row yet', async () => {
    expect(await kycCaseExtras({ status: 'PENDING', submittedAt: NOW, assignedToId: null }, NOW)).toMatchObject({ escalatedTo: null, escalatedBy: null });
    expect(await kycCaseExtras(null, NOW)).toMatchObject({ escalatedTo: null, escalatedBy: null });
  });

  it('still answers { id, name: null } when the port is not registered', async () => {
    resetKycUserLabelPort();
    expect(await kycCaseExtras({ status: 'PENDING', submittedAt: NOW, escalatedToUserId: 'usr_comp', escalatedById: 'usr_ravi' }, NOW)).toMatchObject({
      escalatedTo: { id: 'usr_comp', name: null },
      escalatedBy: { id: 'usr_ravi', name: null },
    });
  });
});

describe('GET /advertiser-kyc — escalatedTo / escalatedBy on every row', () => {
  it('carries both beside the ids, one lookup for the page', async () => {
    repository.findPage.mockResolvedValue({
      items: [
        { id: 'k1', status: 'PENDING', submittedAt: NOW, assignedToId: 'usr_ravi', escalatedAt: NOW, escalatedToUserId: 'usr_comp', escalatedById: 'usr_priya' },
        { id: 'k2', status: 'PENDING', submittedAt: NOW, assignedToId: null, escalatedAt: null, escalatedToUserId: null, escalatedById: null },
        { id: 'k3', status: 'PENDING', submittedAt: NOW, assignedToId: null, escalatedAt: NOW, escalatedToUserId: 'usr_gone', escalatedById: 'usr_ravi' },
      ],
      total: 3,
    });
    const { items } = await listAdvertiserKycs({}, 1, 20, undefined, NOW);
    expect(port).toHaveBeenCalledTimes(1);
    expect(items[0]).toMatchObject({
      assignedTo: { id: 'usr_ravi', name: 'Ravi' },
      escalatedToUserId: 'usr_comp',
      escalatedTo: { id: 'usr_comp', name: 'Compliance Desk' },
      escalatedBy: { id: 'usr_priya', name: 'Priya' },
    });
    expect(items[1]).toMatchObject({ escalatedTo: null, escalatedBy: null });
    expect(items[2]).toMatchObject({ escalatedTo: { id: 'usr_gone', name: null }, escalatedBy: { id: 'usr_ravi', name: 'Ravi' } });
  });
});

describe('GET /advertiser-kyc/:id/case — the escalation by name', () => {
  it('spreads escalatedTo and escalatedBy over the case', async () => {
    repository.findById.mockResolvedValue({
      id: 'kyc_1',
      advertiserId: 'usr_adv',
      status: 'PENDING',
      submittedAt: NOW,
      assignedToId: null,
      reviewedById: null,
      escalatedAt: NOW,
      escalatedToUserId: 'usr_comp',
      escalatedById: 'usr_priya',
    });
    const view = await getAdvertiserKycCase('kyc_1', NOW);
    expect(view).toMatchObject({ escalatedTo: { id: 'usr_comp', name: 'Compliance Desk' }, escalatedBy: { id: 'usr_priya', name: 'Priya' } });
  });
});

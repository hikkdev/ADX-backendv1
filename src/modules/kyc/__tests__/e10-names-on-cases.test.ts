import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E10-1: the people on a KYC case by name, not id — the assignee on every
 * advertiser queue row, and the reviewer on every per-document decision a
 * case read carries. Both ride the label port bootstrap fills from
 * `users.findUserLabels`; unregistered, the name is null and the row still
 * answers.
 */

const { repository, reviews, settings } = vi.hoisted(() => ({
  repository: { findPage: vi.fn(), countBreached: vi.fn(), countByState: vi.fn(), countEscalated: vi.fn(async () => 0), countRequested: vi.fn(async () => 0), findById: vi.fn() },
  reviews: { listFor: vi.fn(), upsert: vi.fn(), clear: vi.fn() },
  settings: { getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })) },
}));

vi.mock('../advertiser/prisma-advertiser-kyc.repository', () => ({ prismaAdvertiserKycRepository: repository }));
vi.mock('../document-review/prisma-document-review.repository', () => ({ prismaDocumentReviewRepository: reviews }));
vi.mock('../../app-config', () => settings);
vi.mock('../../advertisers', () => ({ applyKycDecisionByUserId: vi.fn(), getAdvertiserForUser: vi.fn() }));
vi.mock('../user/user-kyc.service', () => ({ livenessStateFor: vi.fn(async () => null), hasSubmittedLiveness: vi.fn() }));

import { registerKycUserLabelPort, resetKycUserLabelPort } from '../case-read';
import { listDocumentReviewsWithReviewer } from '../document-review/document-review.service';
import { getAdvertiserKycCase, listAdvertiserKycs } from '../advertiser/advertiser-kyc.service';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const names: Record<string, string> = { usr_priya: 'Priya', usr_ravi: 'Ravi' };

beforeEach(() => {
  vi.clearAllMocks();
  repository.countBreached.mockResolvedValue(0);
  repository.countByState.mockResolvedValue({ AWAITING_DOCUMENTS: 0, REQUESTED: 0, PENDING: 0, VERIFIED: 0, REJECTED: 0, NEEDS_INFO: 0 });
  repository.findPage.mockResolvedValue({ items: [], total: 0 });
  reviews.listFor.mockResolvedValue([]);
  registerKycUserLabelPort(async (ids) => new Map(ids.map((id) => [id, { id, name: names[id] ?? null }])));
});
afterEach(() => resetKycUserLabelPort());

describe('listDocumentReviewsWithReviewer', () => {
  it('names the reviewer on each decision, one lookup for the list', async () => {
    reviews.listFor.mockResolvedValue([
      { id: 'r1', field: 'selfieUrl', decision: 'APPROVED', note: null, reviewedById: 'usr_priya' },
      { id: 'r2', field: 'panUrl', decision: 'FLAGGED', note: 'Blurred', reviewedById: 'usr_gone' },
    ]);
    const rows = await listDocumentReviewsWithReviewer('ADVERTISER', 'kyc_1');
    expect(reviews.listFor).toHaveBeenCalledWith('ADVERTISER', 'kyc_1');
    expect(rows).toEqual([
      expect.objectContaining({ field: 'selfieUrl', reviewedById: 'usr_priya', reviewedBy: { id: 'usr_priya', name: 'Priya' } }),
      expect.objectContaining({ field: 'panUrl', reviewedById: 'usr_gone', reviewedBy: { id: 'usr_gone', name: null } }),
    ]);
  });

  it('still answers, names null, when no port is registered', async () => {
    resetKycUserLabelPort();
    reviews.listFor.mockResolvedValue([{ id: 'r1', field: 'selfieUrl', decision: 'APPROVED', note: null, reviewedById: 'usr_priya' }]);
    const rows = await listDocumentReviewsWithReviewer('PUBLISHER', 'kyc_1');
    expect(rows[0]!.reviewedBy).toEqual({ id: 'usr_priya', name: null });
  });
});

describe('GET /advertiser-kyc — assignedTo on every row', () => {
  it('carries { id, name } | null beside assignedToId', async () => {
    repository.findPage.mockResolvedValue({
      items: [
        { id: 'k1', status: 'PENDING', submittedAt: NOW, assignedToId: 'usr_ravi' },
        { id: 'k2', status: 'PENDING', submittedAt: NOW, assignedToId: null },
      ],
      total: 2,
    });
    const { items } = await listAdvertiserKycs({}, 1, 20, undefined, NOW);
    expect(items[0]).toMatchObject({ assignedToId: 'usr_ravi', assignedTo: { id: 'usr_ravi', name: 'Ravi' } });
    expect(items[1]).toMatchObject({ assignedToId: null, assignedTo: null });
  });
});

describe('GET /advertiser-kyc/:id/case — the reviewer on each tile', () => {
  it('reads the decisions with the reviewer named', async () => {
    repository.findById.mockResolvedValue({ id: 'kyc_1', advertiserId: 'usr_adv', status: 'PENDING', submittedAt: NOW, assignedToId: null, reviewedById: null });
    reviews.listFor.mockResolvedValue([{ id: 'r1', field: 'selfieUrl', decision: 'APPROVED', note: null, reviewedById: 'usr_priya' }]);
    const view = await getAdvertiserKycCase('kyc_1', NOW);
    expect(view.documentReviews).toEqual([expect.objectContaining({ reviewedBy: { id: 'usr_priya', name: 'Priya' } })]);
  });
});

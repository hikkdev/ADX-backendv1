import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';
import type { CreativeStatus } from '../../../shared/database';

/**
 * Lot D (Q44/Q120/Q138): every artwork goes through ops.
 *
 * What is held onto: an upload is a submission with its checks computed
 * and its flags set; a re-upload keeps what was refused; the venue's stance
 * is read for real and a "with approval" venue is told, never voted on; ops
 * alone approve and the advertiser hears either way; ADX-designed artwork
 * waits for the advertiser's own tap, which an admin cannot give.
 */

const { repository, listings, notifications, orders, audit } = vi.hoisted(() => ({
  repository: {
    createCreative: vi.fn(),
    updateCreative: vi.fn(),
    findCreative: vi.fn(),
    findCreatives: vi.fn(),
    listCreativesPage: vi.fn(),
    findSpotsByOrderIds: vi.fn(),
    findCampaign: vi.fn(),
  },
  listings: { getContentRules: vi.fn(), getListingWithPublisher: vi.fn() },
  notifications: { createNotification: vi.fn(async () => ({})) },
  orders: { notifyAdmins: vi.fn(async () => undefined), placeOrder: vi.fn() },
  audit: { logActivity: vi.fn(async () => undefined) },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../listings', () => listings);
vi.mock('../../notifications', () => notifications);
vi.mock('../../orders', () => orders);
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity: audit.logActivity,
}));

import {
  acceptDesignedCreative,
  creativeGateForOrder,
  currentCreatives,
  dimensionsCheck,
  listReviewQueue,
  outstandingCreatives,
  requestDesignChanges,
  reviewCreative,
  reviewCreatives,
  submitCreative,
  venueStanceCheck,
} from '../moderation.service';

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  title: 'MG Road Billboard',
  city: 'Bengaluru',
  widthFt: new Decimal('20'),
  heightFt: new Decimal('10'),
  ...over,
});

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'spt_1',
  campaignId: 'cmp_1',
  listingId: 'lst_1',
  status: 'BOOKED',
  listing: listing(),
  ...over,
});

const creative = (over: Record<string, unknown> = {}) =>
  ({
    id: 'crt_1',
    campaignId: 'cmp_1',
    spotId: 'spt_1',
    path: 'STATIC_IMAGES',
    status: 'IN_REVIEW',
    fileUrl: 'https://cdn/a.png',
    widthPx: 2000,
    heightPx: 1000,
    resubmissionOfId: null,
    reviewNote: null,
    designedByAdx: false,
    ...over,
  }) as { id: string; spotId: string | null; status: CreativeStatus; fileUrl: string | null; resubmissionOfId: string | null } & Record<string, unknown>;

const campaign = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cmp_1',
    reference: 'ADX-CMP-2026-482913',
    name: 'Anita coffee, April',
    advertiserId: 'adv_1',
    agentId: 'agt_1',
    createdByUserId: 'usr_adv',
    creativePath: 'STATIC_IMAGES',
    trackingMethod: 'QR_OR_DEEPLINK',
    contentCategoryId: 'cat_food',
    spots: [spot()],
    creatives: [],
    codes: [{ id: 'code_1', spotId: 'spt_1', code: 'AB23CD45' }],
    ...over,
  }) as never;

const upload = (over: Record<string, unknown> = {}) => ({
  spotId: 'spt_1',
  fileUrl: 'https://cdn/a.png',
  fileName: 'a.png',
  fileSize: 1000,
  mimeType: 'image/png',
  widthPx: 2000,
  heightPx: 1000,
  durationMs: null,
  trackingCodeId: 'code_1',
  designedByAdx: false,
  ...over,
});

const advertiser = { userId: 'usr_adv', isAdmin: false, advertiserId: 'adv_1', agentId: null };
const agent = { userId: 'usr_agt', isAdmin: false, advertiserId: null, agentId: 'agt_1' };
const admin = { userId: 'usr_ops', isAdmin: true, advertiserId: null, agentId: null };

beforeEach(() => {
  vi.clearAllMocks();
  listings.getContentRules.mockResolvedValue([]);
  listings.getListingWithPublisher.mockResolvedValue({ id: 'lst_1', publisher: { userId: 'usr_pub' } });
  repository.createCreative.mockImplementation(async (data) => ({ id: 'crt_new', ...data }));
  repository.updateCreative.mockImplementation(async (id, patch) => ({ id, ...patch }));
});

describe('which creatives count', () => {
  it('keeps only the newest row per slot — a re-upload supersedes what it points at', () => {
    const rows = [
      creative({ id: 'old', status: 'REJECTED' }),
      creative({ id: 'new', status: 'IN_REVIEW', resubmissionOfId: 'old' }),
      creative({ id: 'other', spotId: 'spt_2', status: 'APPROVED' }),
    ];
    expect(currentCreatives(rows).map((row) => row.id)).toEqual(['new', 'other']);
    expect(outstandingCreatives(rows).map((row) => row.id)).toEqual(['new']);
  });

  it('a creative with no file is not outstanding — there is nothing to review', () => {
    expect(outstandingCreatives([creative({ fileUrl: null, status: 'PENDING_UPLOAD' })])).toEqual([]);
  });
});

describe('the computed checks', () => {
  it('compares the shape, not the size, and tolerates a little drift', () => {
    expect(dimensionsCheck({ widthPx: 2000, heightPx: 1000 }, listing()).result).toBe('PASS');
    expect(dimensionsCheck({ widthPx: 2040, heightPx: 1000 }, listing()).result).toBe('PASS');
    expect(dimensionsCheck({ widthPx: 1000, heightPx: 1000 }, listing()).result).toBe('FAIL');
  });

  it('is UNKNOWN, never a guess, when either side is unmeasured', () => {
    expect(dimensionsCheck({ widthPx: null, heightPx: null }, listing()).result).toBe('UNKNOWN');
    expect(dimensionsCheck({ widthPx: 2000, heightPx: 1000 }, listing({ widthFt: null })).result).toBe('UNKNOWN');
    expect(dimensionsCheck({ widthPx: 2000, heightPx: 1000 }, null).result).toBe('UNKNOWN');
  });

  it('fails the venue check where the category is prohibited or not allowed', async () => {
    listings.getContentRules.mockResolvedValue([{ contentCategoryId: 'cat_food', stance: 'PROHIBITED' }]);
    const verdict = await venueStanceCheck(campaign(), 'spt_1');
    expect(verdict.check).toMatchObject({ code: 'VENUE_STANCE', result: 'FAIL' });
    expect(verdict.check.note).toContain('MG Road Billboard');
  });

  it('flags a venue that wants approval without voting, and names the publisher to tell', async () => {
    listings.getContentRules.mockResolvedValue([{ contentCategoryId: 'cat_food', stance: 'REQUIRES_APPROVAL' }]);
    const verdict = await venueStanceCheck(campaign(), 'spt_1');
    expect(verdict.check.result).toBe('PASS');
    expect(verdict.flags).toEqual(['VENUE_REQUIRES_APPROVAL']);
    expect(verdict.requiresApprovalFrom).toEqual([{ listingId: 'lst_1', title: 'MG Road Billboard' }]);
  });

  it('flags a missing category instead of running a check it cannot run', async () => {
    const verdict = await venueStanceCheck(campaign({ contentCategoryId: null }), 'spt_1');
    expect(verdict.check.result).toBe('UNKNOWN');
    expect(verdict.flags).toEqual(['CONTENT_CATEGORY_MISSING']);
    expect(listings.getContentRules).not.toHaveBeenCalled();
  });

  it('reads every booked spot for a campaign-level creative', async () => {
    const two = campaign({ spots: [spot(), spot({ id: 'spt_2', listingId: 'lst_2', listing: listing({ id: 'lst_2', title: 'Airport Gantry' }) })] });
    await venueStanceCheck(two, null);
    expect(listings.getContentRules).toHaveBeenCalledTimes(2);
  });
});

describe('submitting', () => {
  it('lands IN_REVIEW with submittedAt, the two checks and no flags when everything is in order', async () => {
    const now = new Date('2026-03-20T10:00:00Z');
    const created = await submitCreative(campaign(), upload(), now);
    expect(repository.createCreative).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'IN_REVIEW',
        submittedAt: now,
        flags: [],
        resubmissionOfId: null,
        trackingCodeId: 'code_1',
        designedByAdx: false,
      }),
    );
    const checks = repository.createCreative.mock.calls[0]![0].checks as { code: string; result: string }[];
    expect(checks.map((check) => `${check.code}:${check.result}`)).toEqual(['DIMENSIONS_MATCH:PASS', 'VENUE_STANCE:PASS']);
    expect(created.id).toBe('crt_new');
  });

  it('flags QR_MISSING on a QR-tracked campaign whose artwork names no code', async () => {
    await submitCreative(campaign(), upload({ trackingCodeId: null }));
    expect(repository.createCreative.mock.calls[0]![0].flags).toEqual(['QR_MISSING']);
  });

  it('does not flag QR_MISSING when the campaign is not QR-tracked', async () => {
    await submitCreative(campaign({ trackingMethod: 'NONE' }), upload({ trackingCodeId: null }));
    expect(repository.createCreative.mock.calls[0]![0].flags).toEqual([]);
  });

  it('refuses a code that belongs to another campaign', async () => {
    await expect(submitCreative(campaign(), upload({ trackingCodeId: 'code_other' }))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('links a re-upload to the refused row it replaces', async () => {
    const previous = creative({ id: 'crt_old', status: 'CHANGES_REQUESTED' });
    await submitCreative(campaign({ creatives: [previous] }), upload());
    expect(repository.createCreative).toHaveBeenCalledWith(expect.objectContaining({ resubmissionOfId: 'crt_old' }));
  });

  it('tells the publisher when their venue wants a look, and flags it for the desk', async () => {
    listings.getContentRules.mockResolvedValue([{ contentCategoryId: 'cat_food', stance: 'REQUIRES_APPROVAL' }]);
    await submitCreative(campaign(), upload());
    expect(repository.createCreative.mock.calls[0]![0].flags).toEqual(['VENUE_REQUIRES_APPROVAL']);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_pub', title: 'Artwork needs your approval' }),
    );
  });

  it('ADX-designed artwork lands AWAITING_ADVERTISER and the advertiser is told', async () => {
    await submitCreative(campaign(), upload({ designedByAdx: true }));
    expect(repository.createCreative).toHaveBeenCalledWith(expect.objectContaining({ status: 'AWAITING_ADVERTISER', designedByAdx: true }));
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_adv', title: 'Your artwork is ready to approve' }),
    );
  });

  it('refuses without a creative path or with a spot from another campaign', async () => {
    await expect(submitCreative(campaign({ creativePath: null }), upload())).rejects.toMatchObject({ statusCode: 409 });
    await expect(submitCreative(campaign(), upload({ spotId: 'spt_9' }))).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the advertiser answering ADX-designed artwork', () => {
  const waiting = campaign({ creatives: [creative({ status: 'AWAITING_ADVERTISER', designedByAdx: true })] });

  it('the advertiser accepts: IN_REVIEW for ops, stamped with who tapped', async () => {
    const now = new Date('2026-03-20T10:00:00Z');
    await acceptDesignedCreative(waiting, 'crt_1', advertiser, now);
    expect(repository.updateCreative).toHaveBeenCalledWith('crt_1', {
      status: 'IN_REVIEW',
      advertiserAcceptedAt: now,
      advertiserAcceptedById: 'usr_adv',
      submittedAt: now,
    });
    expect(orders.notifyAdmins).toHaveBeenCalledWith('Advertiser accepted ADX artwork', expect.any(String), 'cmp_1');
  });

  it('their agent may too, on the campaign the agent built', async () => {
    await acceptDesignedCreative(waiting, 'crt_1', agent);
    expect(repository.updateCreative).toHaveBeenCalled();
  });

  it('an admin may not accept on their behalf — ADX would be approving itself', async () => {
    await expect(acceptDesignedCreative(waiting, 'crt_1', admin)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('sends it back with the note, for ops', async () => {
    await requestDesignChanges(waiting, 'crt_1', 'Logo is the old one', advertiser);
    expect(repository.updateCreative).toHaveBeenCalledWith('crt_1', expect.objectContaining({ status: 'CHANGES_REQUESTED', reviewNote: 'Logo is the old one' }));
    expect(orders.notifyAdmins).toHaveBeenCalledWith('Advertiser sent ADX artwork back', expect.stringContaining('Logo is the old one'), 'cmp_1');
  });

  it('only artwork that is waiting can be answered', async () => {
    const reviewed = campaign({ creatives: [creative({ status: 'IN_REVIEW' })] });
    await expect(acceptDesignedCreative(reviewed, 'crt_1', advertiser)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the desk', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    ...creative(over),
    campaign: { id: 'cmp_1', reference: 'ADX-CMP-2026-482913', name: 'Anita coffee, April', createdByUserId: 'usr_adv' },
    spot: { id: 'spt_1', listingId: 'lst_1', listing: listing() },
  });

  beforeEach(() => {
    repository.findCreative.mockResolvedValue(row());
  });

  it('approves: status, reviewer, audit row with the diff, and a note to the advertiser', async () => {
    const now = new Date('2026-03-21T09:00:00Z');
    await reviewCreative('crt_1', { decision: 'APPROVED' }, { userId: 'usr_ops' }, now);
    expect(repository.updateCreative).toHaveBeenCalledWith('crt_1', {
      status: 'APPROVED',
      reviewNote: null,
      reviewedById: 'usr_ops',
      reviewedAt: now,
    });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_ops',
      'CREATIVE_REVIEWED',
      expect.objectContaining({
        module: 'campaigns',
        targetType: 'CampaignCreative',
        targetId: 'crt_1',
        diff: { status: { before: 'IN_REVIEW', after: 'APPROVED' } },
      }),
    );
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_adv', title: 'Artwork approved', relatedId: 'cmp_1' }),
    );
  });

  it('a refusal carries the note to the advertiser and stores the reviewer’s checks', async () => {
    await reviewCreative(
      'crt_1',
      { decision: 'CHANGES_REQUESTED', note: 'Phone number is cut off', checks: [{ code: 'TEXT_LEGIBLE', result: 'FAIL' }] },
      { userId: 'usr_ops' },
    );
    expect(repository.updateCreative).toHaveBeenCalledWith(
      'crt_1',
      expect.objectContaining({ status: 'CHANGES_REQUESTED', reviewNote: 'Phone number is cut off', checks: [{ code: 'TEXT_LEGIBLE', result: 'FAIL' }] }),
    );
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Artwork needs changes', message: expect.stringContaining('Phone number is cut off') }),
    );
  });

  it('will not review artwork the advertiser has not yet accepted, or that has no file', async () => {
    repository.findCreative.mockResolvedValue(row({ status: 'AWAITING_ADVERTISER' }));
    await expect(reviewCreative('crt_1', { decision: 'APPROVED' }, { userId: 'usr_ops' })).rejects.toMatchObject({ statusCode: 409 });
    repository.findCreative.mockResolvedValue(row({ fileUrl: null }));
    await expect(reviewCreative('crt_1', { decision: 'APPROVED' }, { userId: 'usr_ops' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('a bulk decision is one decision per creative, and a bad one does not stop the rest', async () => {
    repository.findCreative.mockImplementation(async (id: string) => (id === 'crt_gone' ? null : row({ id })));
    const result = await reviewCreatives(['crt_1', 'crt_gone', 'crt_2', 'crt_2'], { decision: 'APPROVED' }, { userId: 'usr_ops' });
    expect(result.reviewed).toEqual(['crt_1', 'crt_2']);
    expect(result.failed).toEqual([{ creativeId: 'crt_gone', reason: 'Creative not found' }]);
    expect(audit.logActivity).toHaveBeenCalledTimes(2);
  });
});

describe('the print gate', () => {
  it('passes an order with no campaign spot behind it', async () => {
    repository.findSpotsByOrderIds.mockResolvedValue([]);
    expect(await creativeGateForOrder('ord_9')).toEqual({ approved: true, reason: null });
  });

  it('refuses while the spot’s artwork, or campaign-level artwork, is short of APPROVED', async () => {
    repository.findSpotsByOrderIds.mockResolvedValue([spot({ id: 'spt_1' })]);
    repository.findCampaign.mockResolvedValue(campaign({ creatives: [creative({ status: 'IN_REVIEW' })] }));
    expect((await creativeGateForOrder('ord_1')).approved).toBe(false);

    repository.findCampaign.mockResolvedValue(campaign({ creatives: [creative({ spotId: null, status: 'CHANGES_REQUESTED' })] }));
    const verdict = await creativeGateForOrder('ord_1');
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toContain('changes requested');
  });

  it('passes once the newest artwork on the slot is approved, another spot’s notwithstanding', async () => {
    repository.findSpotsByOrderIds.mockResolvedValue([spot({ id: 'spt_1' })]);
    repository.findCampaign.mockResolvedValue(
      campaign({
        creatives: [
          creative({ id: 'old', status: 'REJECTED' }),
          creative({ id: 'new', status: 'APPROVED', resubmissionOfId: 'old' }),
          creative({ id: 'elsewhere', spotId: 'spt_2', status: 'IN_REVIEW' }),
        ],
      }),
    );
    expect(await creativeGateForOrder('ord_1')).toEqual({ approved: true, reason: null });
  });
});

describe('the review queue (E7-2)', () => {
  it('passes the facets through and carries the four chips beside the status histogram', async () => {
    repository.listCreativesPage.mockResolvedValue({
      items: [],
      total: 0,
      counts: { IN_REVIEW: 4, APPROVED: 9, CHANGES_REQUESTED: 1, REJECTED: 0, flagged: 2, static: 8, video: 3, resubmitted: 1 },
    });
    const page = await listReviewQueue({ status: ['IN_REVIEW'], flagged: true, kind: 'STATIC_IMAGES', sort: 'OLDEST', page: 1, pageSize: 20 } as never);
    expect(repository.listCreativesPage).toHaveBeenCalledWith(expect.objectContaining({ status: ['IN_REVIEW'], flagged: true, kind: 'STATIC_IMAGES' }));
    expect(page.counts).toMatchObject({ IN_REVIEW: 4, flagged: 2, static: 8, video: 3, resubmitted: 1 });
  });
});

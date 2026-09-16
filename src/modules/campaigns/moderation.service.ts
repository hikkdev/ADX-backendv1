import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { logger } from '../../shared/logging';
import { toListPage } from '../../shared/pagination';
import { Decimal } from '../../shared/money';
import type { CreativeStatus, Prisma } from '../../shared/database';
import { getContentRules, getListingWithPublisher } from '../listings';
import { createNotification } from '../notifications';
import { notifyAdmins } from '../orders';
import { prismaCampaignsRepository as repository } from './prisma-campaigns.repository';
import type { CampaignAggregate, CreativeReviewRow, CreativeRow } from './campaigns.repository';
import type { ReviewQueueQuery } from './campaigns.schema';
import type { Request } from 'express';

/**
 * Creative moderation — Lot D (Q44/Q120/Q138).
 *
 * Every artwork an advertiser uploads goes through ops before it is printed
 * or goes live. The upload lands IN_REVIEW with two computed checks — do the
 * pixels fit the hoarding, and will the venue take this content — and a set
 * of flags the reviewer reads before deciding. Ops alone approve; the
 * advertiser is told either way.
 *
 * The gate is deliberately in two places and neither is the wallet. A
 * campaign is paid for before its artwork is approved — authorisation takes
 * the hold with the artwork still in review, because the money is the
 * advertiser's commitment and the review is ADX's — and then nothing prints
 * (`orders.markPrintReady`) and nothing goes LIVE (`runCampaignTransitions`)
 * until every creative with a file is APPROVED.
 *
 * ADX-designed artwork runs the other way round: ops upload it, the
 * advertiser tap-accepts or sends it back with a note, and only then does it
 * enter ops review like any other upload.
 */

/* ------------------------------------------------------------------ */
/* Which creatives count                                               */
/* ------------------------------------------------------------------ */

/**
 * A re-upload after a refusal is a new row pointing at the one it replaces,
 * so the desk keeps what it refused. Everything that reads "the campaign's
 * artwork" — the review count, the launch gate, the print gate — wants only
 * the newest row per slot: the ones nothing has superseded.
 */
export function currentCreatives<T extends { id: string; resubmissionOfId: string | null }>(creatives: T[]): T[] {
  const superseded = new Set(creatives.map((creative) => creative.resubmissionOfId).filter(Boolean));
  return creatives.filter((creative) => !superseded.has(creative.id));
}

/** The artwork that still stands between a paid campaign and its launch. */
export function outstandingCreatives<T extends { id: string; resubmissionOfId: string | null; fileUrl: string | null; status: CreativeStatus }>(
  creatives: T[],
): T[] {
  return currentCreatives(creatives).filter((creative) => creative.fileUrl && creative.status !== 'APPROVED');
}

/* ------------------------------------------------------------------ */
/* The computed checks                                                 */
/* ------------------------------------------------------------------ */

export type CreativeCheck = {
  code: 'DIMENSIONS_MATCH' | 'VENUE_STANCE' | 'QR_PRESENT' | 'TEXT_LEGIBLE' | 'BRAND_SAFE';
  result: 'PASS' | 'FAIL' | 'UNKNOWN';
  note?: string | undefined;
};

export const CREATIVE_FLAGS = {
  /** The venue takes this content only with the publisher's say-so — a notification went to them. */
  VENUE_REQUIRES_APPROVAL: 'VENUE_REQUIRES_APPROVAL',
  /** The wizard never said what the creative advertises, so the venue check could not run. */
  CONTENT_CATEGORY_MISSING: 'CONTENT_CATEGORY_MISSING',
  /** A QR-tracked campaign whose artwork does not name the code it embeds. */
  QR_MISSING: 'QR_MISSING',
} as const;

/** How far the artwork's aspect ratio may sit from the hoarding's before it reads as the wrong shape. */
const ASPECT_TOLERANCE = 0.05;

/**
 * Pixels against feet. The absolute size means nothing — a hoarding is
 * printed at whatever resolution the shop uses — so what is compared is the
 * shape. UNKNOWN when either side is unmeasured, never a guess.
 */
export function dimensionsCheck(
  creative: { widthPx: number | null; heightPx: number | null },
  listing: { widthFt: Prisma.Decimal | string | number | null; heightFt: Prisma.Decimal | string | number | null } | null,
): CreativeCheck {
  if (!listing || !listing.widthFt || !listing.heightFt) {
    return { code: 'DIMENSIONS_MATCH', result: 'UNKNOWN', note: 'The spot has no stated size' };
  }
  if (!creative.widthPx || !creative.heightPx) {
    return { code: 'DIMENSIONS_MATCH', result: 'UNKNOWN', note: 'The upload carries no pixel size' };
  }
  const wanted = new Decimal(listing.widthFt as never).dividedBy(new Decimal(listing.heightFt as never));
  const got = new Decimal(creative.widthPx).dividedBy(creative.heightPx);
  const drift = got.minus(wanted).abs().dividedBy(wanted);
  const shape = `${new Decimal(listing.widthFt as never).toFixed(0)}×${new Decimal(listing.heightFt as never).toFixed(0)} ft against ${creative.widthPx}×${creative.heightPx} px`;
  return drift.lessThanOrEqualTo(ASPECT_TOLERANCE)
    ? { code: 'DIMENSIONS_MATCH', result: 'PASS', note: shape }
    : { code: 'DIMENSIONS_MATCH', result: 'FAIL', note: `Wrong shape: ${shape}` };
}

type VenueVerdict = {
  check: CreativeCheck;
  flags: string[];
  /** Publishers whose venue takes the content only with their approval — told below. */
  requiresApprovalFrom: { listingId: string; title: string }[];
};

/**
 * The campaign's content category against every booked spot the creative
 * will hang on — the one spot for a per-spot upload, all of them for a
 * campaign-level one. PROHIBITED or NOT_ALLOWED anywhere fails the check;
 * REQUIRES_APPROVAL is a flag and a note to the publisher, never a vote;
 * no category at all is a flag for the desk, because the check could not run.
 */
export async function venueStanceCheck(
  campaign: Pick<CampaignAggregate, 'contentCategoryId' | 'spots'>,
  spotId: string | null,
): Promise<VenueVerdict> {
  if (!campaign.contentCategoryId) {
    return {
      check: { code: 'VENUE_STANCE', result: 'UNKNOWN', note: 'No content category on the campaign' },
      flags: [CREATIVE_FLAGS.CONTENT_CATEGORY_MISSING],
      requiresApprovalFrom: [],
    };
  }
  const spots = campaign.spots.filter(
    (spot) => spot.status !== 'CANCELLED' && (spotId === null || spot.id === spotId),
  );
  const refused: string[] = [];
  const requiresApprovalFrom: VenueVerdict['requiresApprovalFrom'] = [];
  for (const spot of spots) {
    const rules = await getContentRules(spot.listingId);
    const rule = rules.find((row) => row.contentCategoryId === campaign.contentCategoryId);
    if (!rule) continue;
    if (rule.stance === 'PROHIBITED' || rule.stance === 'NOT_ALLOWED') refused.push(spot.listing.title);
    if (rule.stance === 'REQUIRES_APPROVAL') requiresApprovalFrom.push({ listingId: spot.listingId, title: spot.listing.title });
  }
  if (refused.length > 0) {
    return {
      check: { code: 'VENUE_STANCE', result: 'FAIL', note: `Not allowed at ${refused.join(', ')}` },
      flags: requiresApprovalFrom.length > 0 ? [CREATIVE_FLAGS.VENUE_REQUIRES_APPROVAL] : [],
      requiresApprovalFrom,
    };
  }
  return {
    check: {
      code: 'VENUE_STANCE',
      result: 'PASS',
      ...(requiresApprovalFrom.length > 0
        ? { note: `Needs the publisher's approval at ${requiresApprovalFrom.map((row) => row.title).join(', ')}` }
        : {}),
    },
    flags: requiresApprovalFrom.length > 0 ? [CREATIVE_FLAGS.VENUE_REQUIRES_APPROVAL] : [],
    requiresApprovalFrom,
  };
}

/** Tells a publisher whose venue wants a look. Best-effort: a lost note never fails an upload. */
async function askPublisherApproval(
  campaign: Pick<CampaignAggregate, 'id' | 'reference' | 'name'>,
  listings: { listingId: string; title: string }[],
): Promise<void> {
  for (const { listingId, title } of listings) {
    try {
      const listing = await getListingWithPublisher(listingId);
      const userId = listing?.publisher?.userId;
      if (!userId) continue;
      await createNotification({
        userId,
        type: 'BOOKING',
        title: 'Artwork needs your approval',
        subtitle: title,
        message: `${campaign.reference} (${campaign.name}) has uploaded artwork for ${title}. Your listing says this content needs your approval before it runs — ADX will check with you.`,
        suggestedAction: 'Review the artwork',
        relatedId: campaign.id,
        relatedType: 'CAMPAIGN',
      });
    } catch (err) {
      logger.warn('Could not notify the publisher of a venue-approval flag', { campaignId: campaign.id, listingId, err });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Submitting                                                          */
/* ------------------------------------------------------------------ */

export type SubmitCreativeInput = {
  spotId: string | null;
  fileUrl: string;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  durationMs: number | null;
  trackingCodeId: string | null;
  designedByAdx: boolean;
};

/**
 * An upload becomes a submission.
 *
 * IN_REVIEW with `submittedAt`, or AWAITING_ADVERTISER when ops uploaded
 * ADX-designed artwork. The checks are computed here and stored with the row;
 * the flags too. A previous creative on the same slot that was REJECTED or
 * CHANGES_REQUESTED is kept and pointed at as `resubmissionOfId`; one still
 * in review is superseded the same way, because the desk should see the
 * newest thing the advertiser meant. An APPROVED one is replaced too — a
 * new file is a new review.
 */
export async function submitCreative(
  campaign: CampaignAggregate,
  input: SubmitCreativeInput,
  now = new Date(),
): Promise<CreativeRow> {
  if (!campaign.creativePath) {
    throw new ApiError(409, 'CONFLICT', 'Choose a creative path before uploading artwork.');
  }
  const spot = input.spotId ? campaign.spots.find((row) => row.id === input.spotId) : null;
  if (input.spotId && !spot) {
    throw new ApiError(404, 'NOT_FOUND', 'That spot is not part of this campaign.');
  }
  if (input.trackingCodeId && !campaign.codes.some((code) => code.id === input.trackingCodeId)) {
    throw new ApiError(404, 'NOT_FOUND', 'That tracking code is not part of this campaign.');
  }

  const previous = currentCreatives(campaign.creatives).find((creative) => creative.spotId === (input.spotId ?? null));

  const venue = await venueStanceCheck(campaign, input.spotId ?? null);
  const checks: CreativeCheck[] = [dimensionsCheck(input, spot?.listing ?? null), venue.check];
  const flags = [...venue.flags];
  if (campaign.trackingMethod === 'QR_OR_DEEPLINK' && !input.trackingCodeId) flags.push(CREATIVE_FLAGS.QR_MISSING);

  const created = await repository.createCreative({
    campaignId: campaign.id,
    spotId: input.spotId ?? null,
    path: campaign.creativePath,
    status: input.designedByAdx ? 'AWAITING_ADVERTISER' : 'IN_REVIEW',
    fileUrl: input.fileUrl,
    fileName: input.fileName,
    fileSize: input.fileSize,
    mimeType: input.mimeType,
    widthPx: input.widthPx,
    heightPx: input.heightPx,
    durationMs: input.durationMs,
    submittedAt: now,
    flags,
    checks: checks as unknown as Prisma.InputJsonValue,
    resubmissionOfId: previous?.id ?? null,
    designedByAdx: input.designedByAdx,
    trackingCodeId: input.trackingCodeId,
  });

  if (venue.requiresApprovalFrom.length > 0) await askPublisherApproval(campaign, venue.requiresApprovalFrom);

  if (input.designedByAdx) {
    notifyUser(campaign.createdByUserId, {
      title: 'Your artwork is ready to approve',
      subtitle: campaign.name,
      message: `ADX has designed the artwork for ${campaign.reference}. Accept it, or send it back with what to change.`,
      suggestedAction: 'Review the artwork',
      relatedId: campaign.id,
      relatedType: 'CAMPAIGN',
    });
  }

  return created;
}

/* ------------------------------------------------------------------ */
/* The advertiser's answer to ADX-designed artwork                     */
/* ------------------------------------------------------------------ */

export type CreativeActor = { userId: string; isAdmin: boolean; advertiserId: string | null; agentId: string | null };

/**
 * The tap-accept is the advertiser's — or their agent's, on the campaign the
 * agent built. Not ops': an admin accepting ADX's own design on the
 * advertiser's behalf would be ADX approving itself.
 */
function assertAdvertiserSide(campaign: { advertiserId: string; agentId: string | null }, actor: CreativeActor): void {
  if (actor.advertiserId && campaign.advertiserId === actor.advertiserId) return;
  if (actor.agentId && campaign.agentId === actor.agentId) return;
  throw new ApiError(403, 'FORBIDDEN', 'Only the advertiser or their agent can answer ADX-designed artwork.');
}

function creativeOf(campaign: CampaignAggregate, creativeId: string): CreativeRow {
  const creative = campaign.creatives.find((row) => row.id === creativeId);
  if (!creative) throw new ApiError(404, 'NOT_FOUND', 'That artwork is not part of this campaign.');
  return creative;
}

export async function acceptDesignedCreative(
  campaign: CampaignAggregate,
  creativeId: string,
  actor: CreativeActor,
  now = new Date(),
): Promise<CreativeRow> {
  assertAdvertiserSide(campaign, actor);
  const creative = creativeOf(campaign, creativeId);
  if (creative.status !== 'AWAITING_ADVERTISER') {
    throw new ApiError(409, 'CONFLICT', 'This artwork is not waiting for the advertiser.');
  }
  const updated = await repository.updateCreative(creativeId, {
    status: 'IN_REVIEW',
    advertiserAcceptedAt: now,
    advertiserAcceptedById: actor.userId,
    submittedAt: now,
  });
  notifyAdmins(
    'Advertiser accepted ADX artwork',
    `${campaign.reference} (${campaign.name}) accepted the ADX-designed artwork. It is in the review queue.`,
    campaign.id,
  ).catch(() => {});
  return updated;
}

export async function requestDesignChanges(
  campaign: CampaignAggregate,
  creativeId: string,
  note: string,
  actor: CreativeActor,
  now = new Date(),
): Promise<CreativeRow> {
  assertAdvertiserSide(campaign, actor);
  const creative = creativeOf(campaign, creativeId);
  if (creative.status !== 'AWAITING_ADVERTISER') {
    throw new ApiError(409, 'CONFLICT', 'This artwork is not waiting for the advertiser.');
  }
  const updated = await repository.updateCreative(creativeId, {
    status: 'CHANGES_REQUESTED',
    reviewNote: note,
    reviewedById: actor.userId,
    reviewedAt: now,
  });
  notifyAdmins(
    'Advertiser sent ADX artwork back',
    `${campaign.reference} (${campaign.name}) asked for changes: ${note}`,
    campaign.id,
  ).catch(() => {});
  return updated;
}

/* ------------------------------------------------------------------ */
/* The desk                                                            */
/* ------------------------------------------------------------------ */

export type CreativeDecision = 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';

const DECISION_COPY: Record<CreativeDecision, { title: string; line: string }> = {
  APPROVED: { title: 'Artwork approved', line: 'is approved and will print as submitted.' },
  REJECTED: { title: 'Artwork rejected', line: 'was rejected. Upload new artwork to keep the campaign on schedule.' },
  CHANGES_REQUESTED: { title: 'Artwork needs changes', line: 'needs a change before it can run. Upload the revised artwork.' },
};

function notifyUser(
  userId: string,
  body: { title: string; subtitle?: string; message: string; suggestedAction?: string; relatedId: string; relatedType: 'CAMPAIGN' },
): void {
  createNotification({ userId, type: 'BOOKING', ...body }).catch((err) =>
    logger.warn('Could not notify the advertiser of a creative decision', { userId, err }),
  );
}

/** Reviewable: submitted, and not already decided the same way. */
const REVIEWABLE: CreativeStatus[] = ['IN_REVIEW', 'UPLOADED', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED'];

/**
 * One decision on one creative. A note is required unless it is approved —
 * the schema says so — and the reviewer's own checks, when sent, replace the
 * computed ones so the record shows what the desk actually looked at.
 * Audited CREATIVE_REVIEWED with the status diff; the advertiser is told.
 */
export async function reviewCreative(
  creativeId: string,
  decision: { decision: CreativeDecision; note?: string | undefined; checks?: CreativeCheck[] | undefined },
  reviewer: { userId: string; req?: Request | undefined },
  now = new Date(),
): Promise<CreativeReviewRow> {
  const creative = await repository.findCreative(creativeId);
  if (!creative) throw new ApiError(404, 'NOT_FOUND', 'Creative not found');
  if (!creative.fileUrl) throw new ApiError(409, 'CONFLICT', 'Nothing has been uploaded for this creative yet.');
  if (!REVIEWABLE.includes(creative.status)) {
    throw new ApiError(409, 'CONFLICT', `This artwork is ${creative.status.toLowerCase().replace(/_/g, ' ')} and not ready for ops review.`);
  }

  const patch = {
    status: decision.decision,
    reviewNote: decision.note ?? null,
    reviewedById: reviewer.userId,
    reviewedAt: now,
    ...(decision.checks ? { checks: decision.checks as unknown as Prisma.InputJsonValue } : {}),
  };
  const updated = await repository.updateCreative(creativeId, patch);

  await logActivity(reviewer.userId, 'CREATIVE_REVIEWED', {
    req: reviewer.req,
    module: 'campaigns',
    targetType: 'CampaignCreative',
    targetId: creativeId,
    diff: auditDiff(
      { status: creative.status, reviewNote: creative.reviewNote },
      { status: updated.status, reviewNote: updated.reviewNote },
    ),
    metadata: { campaignId: creative.campaignId, spotId: creative.spotId, decision: decision.decision },
  });

  const copy = DECISION_COPY[decision.decision];
  const where = creative.spot ? ` for ${creative.spot.listing.title}` : '';
  notifyUser(creative.campaign.createdByUserId, {
    title: copy.title,
    subtitle: creative.campaign.name,
    message: `The artwork${where} on ${creative.campaign.reference} ${copy.line}${decision.note ? ` Note from ADX: ${decision.note}` : ''}`,
    suggestedAction: decision.decision === 'APPROVED' ? 'View campaign' : 'Upload new artwork',
    relatedId: creative.campaignId,
    relatedType: 'CAMPAIGN',
  });

  return { ...creative, ...updated };
}

/** The same decision across several creatives; each is its own audit row and notification. */
export async function reviewCreatives(
  creativeIds: string[],
  decision: { decision: CreativeDecision; note?: string | undefined },
  reviewer: { userId: string; req?: Request | undefined },
  now = new Date(),
): Promise<{ reviewed: string[]; failed: { creativeId: string; reason: string }[] }> {
  const reviewed: string[] = [];
  const failed: { creativeId: string; reason: string }[] = [];
  for (const creativeId of [...new Set(creativeIds)]) {
    try {
      await reviewCreative(creativeId, decision, reviewer, now);
      reviewed.push(creativeId);
    } catch (err) {
      failed.push({ creativeId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { reviewed, failed };
}

export async function getCreativeForReview(creativeId: string): Promise<CreativeReviewRow> {
  const creative = await repository.findCreative(creativeId);
  if (!creative) throw new ApiError(404, 'NOT_FOUND', 'Creative not found');
  return creative;
}

export async function listReviewQueue(query: ReviewQueueQuery) {
  const { items, total, counts } = await repository.listCreativesPage({
    ...(query.status ? { status: query.status as never } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.flagged !== undefined ? { flagged: query.flagged } : {}),
    ...(query.resubmitted !== undefined ? { resubmitted: query.resubmitted } : {}),
    ...(query.q ? { q: query.q } : {}),
    sort: query.sort,
    page: query.page,
    pageSize: query.pageSize,
  });
  return toListPage(items, total, counts, query);
}

/* ------------------------------------------------------------------ */
/* The gates                                                           */
/* ------------------------------------------------------------------ */

/**
 * Whether an order's artwork is approved — `orders.markPrintReady` asks this
 * through the port bootstrap registers, because `orders` cannot import this
 * module. The order's spot has its own creative, or the campaign has one
 * for every spot; either way nothing with a file may be short of APPROVED.
 * An order with no campaign spot behind it — placed outside the booking flow
 * — has no artwork to gate and passes.
 */
export async function creativeGateForOrder(orderId: string): Promise<{ approved: boolean; reason: string | null }> {
  const [spot] = await repository.findSpotsByOrderIds([orderId]);
  if (!spot) return { approved: true, reason: null };
  const campaign = await repository.findCampaign(spot.campaignId);
  if (!campaign) return { approved: true, reason: null };

  const relevant = outstandingCreatives(campaign.creatives).filter(
    (creative) => creative.spotId === null || creative.spotId === spot.id,
  );
  if (relevant.length === 0) return { approved: true, reason: null };
  return {
    approved: false,
    reason: `Artwork on ${campaign.reference} is ${relevant.map((creative) => creative.status.toLowerCase().replace(/_/g, ' ')).join(', ')}`,
  };
}

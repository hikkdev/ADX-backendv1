import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { Decimal } from '../../shared/money';
import { getAdvertiserForUser } from '../advertisers';
import { findAgentProfile } from '../agents';
import { listContentCategories } from '../listings';
import { IMAGE_CACHE_CONTROL, clampSize } from '../qr';
import { withSpotReviews } from './spot-review.port';
import {
  analyticsQuerySchema,
  authorizeSchema,
  bulkCreativeReviewSchema,
  campaignAnalyticsQuerySchema,
  cancelSchema,
  cartSchema,
  createCampaignSchema,
  creativeReviewSchema,
  interactionSchema,
  inventoryQuerySchema,
  landingPageListQuerySchema,
  landingPagePatchSchema,
  listCampaignsQuerySchema,
  patchCampaignSchema,
  redemptionSchema,
  requestChangesSchema,
  reviewQueueQuerySchema,
  unpublishLandingPageSchema,
  uploadCreativeSchema,
} from './campaigns.schema';
import {
  generateLandingPage,
  getLandingPage,
  landingPageSummary,
  listLandingPages,
  patchLandingPage,
  publishLandingPage,
  renderLandingPage,
  unpublishLandingPage,
  withLandingUrl,
} from './landing-page.service';
import {
  acceptDesignedCreative,
  getCreativeForReview,
  listReviewQueue,
  requestDesignChanges,
  reviewCreative,
  reviewCreatives,
  submitCreative,
} from './moderation.service';
import {
  createDraft,
  discardDraft,
  getCampaign,
  campaignRefundSummary,
  listCampaignsPage,
  patchDraft,
  triggerPlan,
  withMarketWarning,
  type Actor,
} from './campaigns.service';
import { authorizeCampaign, authorizeOnBehalf, cancelCampaign, reviewCampaign, setCart, submitForPayment } from './checkout.service';
import { matchingInventory } from './inventory.service';
import { campaignAnalytics, portfolioAnalytics } from './analytics.service';
import { linkCodesToEngine, printedUrl, recordInteraction, recordRedemptions, resolveScan, trackingUrl } from './tracking.service';
import { renderDynamic } from '../../shared/qr-engine';
import type { CampaignAggregate } from './campaigns.repository';
import { prismaCampaignsRepository as repository } from './prisma-campaigns.repository';

function parse<T>(schema: { safeParse: (v: unknown) => any }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  return parsed.data as T;
}

/**
 * The campaign, plus what its trigger will actually do.
 *
 * Four screens collect a trigger and nothing on the platform reads one, so the
 * payload says so rather than letting the wizard imply a scheduler that does
 * not exist. Attached to every response the wizard reads a campaign from, since
 * the screen that has to tell the truth is the one that just asked the
 * question.
 */
function withTriggerPlan<T extends { triggerType: any; triggerConfig: any; targetMarkets?: string[] | null }>(campaign: T) {
  // Lot D (Q107): the multi-market warning rides on the same reads.
  return withMarketWarning({ ...campaign, triggers: triggerPlan(campaign) });
}

/**
 * Resolves who is asking.
 *
 * Both sides of the same flow arrive here: an advertiser in their own app, and
 * an agent in theirs. Neither is trusted to say which they are — the token's
 * user id is looked up against both tables, so a client cannot book as somebody
 * else by sending their id.
 */
async function resolveActor(req: Request): Promise<Actor> {
  const userId = req.user!.sub;
  const [advertiser, agent] = await Promise.all([
    getAdvertiserForUser(userId),
    findAgentProfile(userId),
  ]);
  return {
    userId,
    isAdmin: req.user!.roles.includes('ADMIN'),
    advertiserId: advertiser?.id ?? null,
    agentId: agent?.id ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* The wizard                                                          */
/* ------------------------------------------------------------------ */

export async function createCampaignHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof createCampaignSchema>>(createCampaignSchema, req.body);
  const actor = await resolveActor(req);

  const advertiserId = body.advertiserId ?? actor.advertiserId;
  if (!advertiserId) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Say which advertiser this campaign is for. Your account is not an advertiser.'
    );
  }

  const campaign = await createDraft({
    advertiserId,
    brandId: body.brandId ?? null,
    name: body.name ?? null,
    visitId: body.visitId ?? null,
    actor,
  });
  res.status(201).json({ success: true, data: withTriggerPlan(campaign) });
}

export async function listCampaignsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<z.infer<typeof listCampaignsQuerySchema>>(listCampaignsQuerySchema, req.query);
  const actor = await resolveActor(req);
  res.json({ success: true, data: await listCampaignsPage(actor, query) });
}

/**
 * The detail view — what `GET /campaigns/:id` answers, and (T-B) what the
 * cart write and the submit-for-payment answer too, so a console updates
 * the campaign it holds from the write without a second read.
 *
 * E6: the refund the cancel recorded, if any, rides on the detail read.
 * E7-2: each spot says whether it was reviewed, through the reviews port.
 * E11-2: the landing page, narrowly — id, slug, status, url, publishedAt — or null.
 * T-B: `city` and `spotCount` are the list row's two derived columns
 * (`targetLocation`, the spots counted), carried here so the row and the
 * detail agree on them.
 */
async function campaignDetailView(campaign: CampaignAggregate) {
  const [refund, marked, landingPage] = await Promise.all([
    campaignRefundSummary(campaign.id),
    withSpotReviews(campaign),
    landingPageSummary(campaign.id),
  ]);
  return { ...withTriggerPlan(marked), city: campaign.targetLocation, spotCount: campaign.spots.length, refund, landingPage };
}

export async function getCampaignHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  res.json({ success: true, data: await campaignDetailView(campaign) });
}

/**
 * One screen's answers.
 *
 * The three branch blocks arrive as `{ trigger }`, `{ creative }`, `{ tracking }`
 * — each a discriminated union — and are passed through whole rather than
 * flattened here. Flattening needed a rule for the config a payload does not
 * mention, and the rule needs the stored row to apply it: a save that carries
 * only the discriminant is the wizard choosing a path, not the advertiser
 * clearing the detail they typed on the screen after it. `patchDraft` has the
 * row, so it does the flattening; here the type and its config simply stay
 * together.
 */
export async function patchCampaignHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof patchCampaignSchema>>(patchCampaignSchema, req.body);
  const actor = await resolveActor(req);

  const { trigger, creative, tracking, budget, discount, startDate, endDate, pois, ...rest } = body;

  const campaign = await patchDraft(
    req.params['id'] as string,
    {
      ...rest,
      ...(budget !== undefined ? { budget: budget === null ? null : new Decimal(budget) } : {}),
      ...(discount !== undefined
        ? { discount: discount === null ? null : new Decimal(discount) }
        : {}),
      ...(startDate !== undefined
        ? { startDate: startDate === null ? null : new Date(startDate) }
        : {}),
      ...(endDate !== undefined ? { endDate: endDate === null ? null : new Date(endDate) } : {}),
      ...(trigger ? { trigger } : {}),
      ...(creative ? { creative } : {}),
      ...(tracking ? { tracking } : {}),
      ...(pois ? { pois } : {}),
    },
    actor
  );

  res.json({ success: true, data: withTriggerPlan(campaign) });
}

export async function discardCampaignHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  await discardDraft(req.params['id'] as string, actor);
  res.json({ success: true, data: { discarded: true } });
}

/* ------------------------------------------------------------------ */
/* Inventory and the cart                                              */
/* ------------------------------------------------------------------ */

export async function inventoryHandler(req: Request, res: Response): Promise<void> {
  const query = parse<z.infer<typeof inventoryQuerySchema>>(inventoryQuerySchema, req.query);
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  res.json({ success: true, data: await matchingInventory(campaign, query) });
}

export async function setCartHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof cartSchema>>(cartSchema, req.body);
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  // T-B: the cart write answers the detail view the GET answers.
  res.json({ success: true, data: await campaignDetailView(await setCart(campaign, body.items)) });
}

/* ------------------------------------------------------------------ */
/* Creatives                                                           */
/* ------------------------------------------------------------------ */

/**
 * An upload is a submission (Lot D, Q44): it lands IN_REVIEW with the
 * computed checks, or AWAITING_ADVERTISER when an ADMIN uploads ADX-designed
 * artwork. `designedByAdx` from anybody else is ignored rather than refused —
 * the advertiser's own file is the advertiser's own file.
 */
export async function uploadCreativeHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof uploadCreativeSchema>>(uploadCreativeSchema, req.body);
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);

  const creative = await submitCreative(campaign, {
    spotId: body.spotId ?? null,
    fileUrl: body.fileUrl,
    fileName: body.fileName ?? null,
    fileSize: body.fileSize ?? null,
    mimeType: body.mimeType ?? null,
    widthPx: body.widthPx ?? null,
    heightPx: body.heightPx ?? null,
    durationMs: body.durationMs ?? null,
    trackingCodeId: body.trackingCodeId ?? null,
    designedByAdx: Boolean(body.designedByAdx) && actor.isAdmin,
  });

  // T-B: the upload answers the desk's row — the artwork with its campaign
  // and spot — the same read `GET /campaigns/creatives/:creativeId` makes.
  res.status(201).json({ success: true, data: await getCreativeForReview(creative.id) });
}

/* Lot D (Q120): the advertiser's answer to ADX-designed artwork. */

export async function acceptCreativeHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  res.json({ success: true, data: await acceptDesignedCreative(campaign, req.params['creativeId'] as string, actor) });
}

export async function requestCreativeChangesHandler(req: Request, res: Response): Promise<void> {
  const { note } = parse<z.infer<typeof requestChangesSchema>>(requestChangesSchema, req.body);
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  res.json({
    success: true,
    data: await requestDesignChanges(campaign, req.params['creativeId'] as string, note, actor),
  });
}

/* Lot D (Q44): the desk. ADMIN at the route. */

export async function reviewQueueHandler(req: Request, res: Response): Promise<void> {
  const query = parse<z.infer<typeof reviewQueueQuerySchema>>(reviewQueueQuerySchema, req.query);
  res.json({ success: true, data: await listReviewQueue(query) });
}

export async function getCreativeHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getCreativeForReview(req.params['creativeId'] as string) });
}

export async function reviewCreativeHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof creativeReviewSchema>>(creativeReviewSchema, req.body);
  const creativeId = req.params['creativeId'] as string;
  const campaignId = req.params['id'] as string;
  const creative = await getCreativeForReview(creativeId);
  if (creative.campaignId !== campaignId) {
    throw new ApiError(404, 'NOT_FOUND', 'That artwork is not part of this campaign.');
  }
  const reviewed = await reviewCreative(
    creativeId,
    { decision: body.decision, note: body.note, checks: body.checks },
    { userId: req.user!.sub, req },
  );
  res.json({ success: true, data: reviewed });
}

export async function bulkReviewHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof bulkCreativeReviewSchema>>(bulkCreativeReviewSchema, req.body);
  const result = await reviewCreatives(
    body.creativeIds,
    { decision: body.decision, note: body.note },
    { userId: req.user!.sub, req },
  );
  res.json({ success: true, data: result });
}

/** Lot D (Q138): the seeded content categories, for the wizard's question. */
export async function contentCategoriesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listContentCategories() });
}

export async function deleteCreativeHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  const creativeId = req.params['creativeId'] as string;
  if (!campaign.creatives.some((creative) => creative.id === creativeId)) {
    throw new ApiError(404, 'NOT_FOUND', 'That artwork is not part of this campaign.');
  }
  await repository.deleteCreative(creativeId);
  res.json({ success: true, data: { deleted: true } });
}

/* ------------------------------------------------------------------ */
/* Review, authorize, cancel                                           */
/* ------------------------------------------------------------------ */

export async function reviewHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  res.json({ success: true, data: await reviewCampaign(campaign) });
}

/**
 * Lot C (Q88): ops send a prepared campaign to the advertiser to pay. ADMIN
 * or the campaign's agent — the service says which; audited against the
 * campaign with the status it left and the hour the spots are held until.
 */
export async function submitForPaymentHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  const before = campaign.status;
  const result = await submitForPayment(campaign, actor);
  await logActivity(actor.userId, 'CAMPAIGN_SUBMITTED_FOR_PAYMENT', {
    req,
    module: 'campaigns',
    targetType: 'Campaign',
    targetId: campaign.id,
    diff: auditDiff({ status: before }, { status: 'PENDING_PAYMENT' }),
    metadata: { reference: campaign.reference, total: result.review.total, reservedUntil: result.reservedUntil.toISOString() },
  });
  // T-B: the envelope stays; the campaign in it is the detail view the GET answers.
  res.json({ success: true, data: { campaign: await campaignDetailView(result.campaign), review: result.review, reservedUntil: result.reservedUntil } });
}

export async function authorizeHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof authorizeSchema>>(authorizeSchema, req.body ?? {});
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  // Lot C (Q88): an ADMIN is spending the advertiser's balance for them —
  // typed confirmation, a second admin above the threshold, and its own
  // audit row with the money and status columns before and after.
  const result = actor.isAdmin
    ? await authorizeOnBehalf(campaign, { confirm: body.confirm, approvedByUserId: body.approvedByUserId }, actor)
    : await authorizeCampaign(campaign);
  if (actor.isAdmin) {
    await logActivity(actor.userId, 'CAMPAIGN_AUTHORIZED_ON_BEHALF', {
      req,
      module: 'campaigns',
      targetType: 'Campaign',
      targetId: campaign.id,
      diff: auditDiff(
        { status: campaign.status, total: campaign.total === null ? null : String(campaign.total), walletHoldId: campaign.walletHoldId },
        { status: result.campaign.status, total: result.review.total, walletHoldId: result.campaign.walletHoldId },
      ),
      metadata: {
        reference: campaign.reference,
        advertiserId: campaign.advertiserId,
        approvedByUserId: 'approvedByUserId' in result ? result.approvedByUserId : null,
      },
    });
  }
  res.json({
    success: true,
    data: {
      campaign: result.campaign,
      review: result.review,
      failedSpots: result.failedSpots,
      // Lot B (Q1): the CAMPAIGN_ASSIST recorded for the agent, or null.
      incentive: result.incentive,
      // E6: the invoice issued inside the authorisation, or null.
      invoice: result.invoice,
      codes: result.campaign.codes.map((code) => ({
        id: code.id,
        spotId: code.spotId,
        code: code.code,
        url: trackingUrl(code.code),
        // QR-1: what the hoarding carries — the engine's short URL when hosted.
        printedUrl: printedUrl(code),
        engine: code.engineCodeId ? ('GENQR' as const) : ('LOCAL' as const),
        promoCode: code.promoCode,
      })),
    },
  });
}

export async function cancelHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof cancelSchema>>(cancelSchema, req.body);
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  res.json({ success: true, data: await cancelCampaign(campaign, body.reason, new Date(), actor.userId) });
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

export async function campaignAnalyticsHandler(req: Request, res: Response): Promise<void> {
  // E11-2: `days` is the comparison window (default 7) — the previous window
  // is the same length immediately before it.
  const query = parse<z.infer<typeof campaignAnalyticsQuerySchema>>(campaignAnalyticsQuerySchema, req.query);
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  res.json({ success: true, data: await campaignAnalytics(campaign, new Date(), { days: query.days }) });
}

export async function portfolioAnalyticsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<z.infer<typeof analyticsQuerySchema>>(analyticsQuerySchema, req.query);
  const actor = await resolveActor(req);
  res.json({ success: true, data: await portfolioAnalytics(actor, query) });
}

const codeView = (code: CampaignAggregate['codes'][number]) => ({
  id: code.id,
  spotId: code.spotId,
  code: code.code,
  url: trackingUrl(code.code),
  // QR-1: what the hoarding carries, and who hosts the code in front of /t/.
  printedUrl: printedUrl(code),
  engine: code.engineCodeId ? ('GENQR' as const) : ('LOCAL' as const),
  shortUrl: code.shortUrl,
  engineLinkedAt: code.engineLinkedAt,
  method: code.method,
  destination: code.destination,
  promoCode: code.promoCode,
  scans: code.scans,
  clicks: code.clicks,
  redemptions: code.redemptions,
});

export async function trackingCodesHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  res.json({ success: true, data: campaign.codes.map(codeView) });
}

/**
 * QR-1: `POST /campaigns/:id/tracking-codes/sync-engine` — puts the
 * engine's dynamic code in front of every QR code the campaign has that is
 * not yet hosted. For a campaign paid for while the engine was down or
 * before it was configured. Ops only; idempotent; the engine's own refusal
 * is thrown as it is (503 not configured, 409 quota, 502 down).
 */
export async function syncTrackingCodesHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  const linked = await linkCodesToEngine(campaign.id);
  if (linked.length > 0) {
    await logActivity(req.user!.sub, 'TRACKING_CODES_ENGINE_LINKED', {
      req,
      targetType: 'Campaign',
      targetId: campaign.id,
      module: 'campaigns',
      metadata: { reference: campaign.reference, linked: linked.length, codes: linked.map((code) => code.code) },
    });
  }
  const after = await getCampaign(campaign.id, actor);
  res.json({ success: true, data: { linked: linked.length, codes: after.codes.map(codeView) } });
}

/**
 * Lot D (Q139): the QR for one tracking code, so the artwork can embed it.
 * QR-1: `.png` (the default, as before) or `.svg`, drawn by the engine when
 * one hosts the code — GenQR's styled artwork encoding the short URL — and
 * locally otherwise, of the short URL when one is stored, else of `/t/`.
 * `X-QR-Engine` and `X-QR-Styled` say what came back.
 */
export async function trackingCodeImageHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  const code = campaign.codes.find((row) => row.code === req.params['code']);
  if (!code) throw new ApiError(404, 'NOT_FOUND', 'That code is not part of this campaign.');
  // Two literal routes share this handler; the extension on the path says which.
  const format = req.path.endsWith('.svg') ? 'svg' : 'png';
  const image = await renderDynamic(code, trackingUrl(code.code), format, clampSize(req.query['size']));
  res.set('Content-Type', image.contentType);
  res.set('Cache-Control', IMAGE_CACHE_CONTROL);
  res.set('X-QR-Engine', image.engine);
  res.set('X-QR-Styled', image.styled ? 'true' : 'false');
  res.send(image.body);
}

export async function redemptionsHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof redemptionSchema>>(redemptionSchema, req.body);
  const actor = await resolveActor(req);
  const campaign = await getCampaign(req.params['id'] as string, actor);
  res.json({ success: true, data: await recordRedemptions(campaign.id, body.count) });
}

/* ------------------------------------------------------------------ */
/* The public redirect                                                 */
/* ------------------------------------------------------------------ */

/**
 * Where a scanned QR lands. No authentication — it is a person with a phone in
 * front of a hoarding, not an API client.
 *
 * A code with no destination still counts the scan and then says so, rather than
 * 404ing: the scan happened, and the advertiser should see it.
 */
export async function scanHandler(req: Request, res: Response): Promise<void> {
  const code = req.params['code'] as string;
  const { destination, landingSlug } = await resolveScan(code, {
    userAgent: req.get('user-agent') ?? null,
    referer: req.get('referer') ?? null,
    // Set by the CDN when there is one in front. Never inferred from the IP here.
    city: req.get('cf-ipcity') ?? null,
  });

  if (destination) {
    res.redirect(302, destination);
    return;
  }

  // Lot E (Q106): the ADX page stands in when no destination was given. The
  // code rides along as `c` so the page's beacon can say which hoarding.
  if (landingSlug) {
    res.redirect(302, `/p/${encodeURIComponent(landingSlug)}?c=${encodeURIComponent(code)}`);
    return;
  }

  res
    .status(200)
    .type('text/plain')
    .send('Thanks for scanning. This campaign has no landing page.');
}

/**
 * Lot E (Q106): the landing page itself. Public — the reader is a stranger
 * with a phone. Rendered server-side into one document with no external
 * asset. A slug nothing PUBLISHED answers to falls through (`next()`), so
 * the package payment link mounted after this router under the same `/p`
 * prefix keeps working; its tokens are long and random, a slug is words.
 */
export async function landingPageHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  const slug = req.params['slug'] as string;
  const page = await repository.findPublishedLandingPageBySlug(slug);
  if (!page) {
    next();
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  res.status(200).type('text/html').send(renderLandingPage(page, page.campaignName));
}

/* ------------------------------------------------------------------ */
/* The landing-page builder (Lot E, Q7/Q106)                           */
/* ------------------------------------------------------------------ */

export async function generateLandingPageHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  // E11-2: `url` beside the blocks, the way the GET and the publish answer.
  res.status(201).json({ success: true, data: withLandingUrl(await generateLandingPage(req.params['id'] as string, actor)) });
}

export async function getLandingPageHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const page = await getLandingPage(req.params['id'] as string, actor);
  res.json({ success: true, data: withLandingUrl(page) });
}

export async function patchLandingPageHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof landingPagePatchSchema>>(landingPagePatchSchema, req.body);
  const actor = await resolveActor(req);
  res.json({ success: true, data: withLandingUrl(await patchLandingPage(req.params['id'] as string, actor, body)) });
}

export async function publishLandingPageHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const page = await publishLandingPage(req.params['id'] as string, actor);
  res.json({ success: true, data: withLandingUrl(page) });
}

/** ADMIN: every page, by status — the review list. */
export async function listLandingPagesHandler(req: Request, res: Response): Promise<void> {
  const query = parse<z.infer<typeof landingPageListQuerySchema>>(landingPageListQuerySchema, req.query);
  const page = await listLandingPages(query);
  res.json({ success: true, data: { ...page, page: query.page, pageSize: query.pageSize } });
}

/** ADMIN: a page comes down, with the reason on the trail and in the owner's inbox. */
export async function unpublishLandingPageHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof unpublishLandingPageSchema>>(unpublishLandingPageSchema, req.body);
  res.json({
    success: true,
    data: await unpublishLandingPage(req.params['id'] as string, req.user!.sub, body.reason),
  });
}

/**
 * Lot D (Q7): an interaction on the landing page. Public and rate-limited,
 * like the scan; a bot's event is answered 200 and not counted.
 */
export async function interactionHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof interactionSchema>>(interactionSchema, req.body);
  const result = await recordInteraction(req.params['code'] as string, body, {
    userAgent: req.get('user-agent') ?? null,
    referer: req.get('referer') ?? null,
    city: req.get('cf-ipcity') ?? null,
  });
  res.json({ success: true, data: result });
}

import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { platformStanding } from '../agreements';
import { deskDrafts, listMyDrafts, removeDraft, saveDraft, takeDraft } from './drafts.service';
import { deskDraftsQuerySchema, saveDraftSchema } from './drafts.schema';
import { profileBasicsMissing, profileIncompleteMessage } from '../../shared/kyc-state';
import { logActivity } from '../../shared/audit';
import { assertMayActFor, getAdvertiserForUser } from '../advertisers';
import { requireAgentProfile } from '../agents';
import { translateListings } from '../ai';
import type { ListingCategory } from '../../shared/database';
import {
  adminListingsQuerySchema,
  reviewQueueQuerySchema,
  browseCategoriesQuerySchema,
  browseQuerySchema,
  browseWindowSchema,
  createListingSchema,
  savedSpacesQuerySchema,
  sendBackListingSchema,
  updateListingSchema,
} from './listings.schema';
import {
  browseCategories,
  browseVenues,
  browseListings,
  getBrowseListing,
  listSavedListings,
  saveListing,
  unsaveListing,
  type BrowseViewer,
} from './browse.service';
import { getSpotPage, renderSpotPage, spotPageLinks } from './spot-page.service';
import { listingAudience } from './audience.service';
import { audienceQuerySchema } from './listings.schema';

/* ── DR 01 browse — the advertiser's discovery ─────────────────────── */

/**
 * Lot D (Q5): the advertiser account a browse or a save is for.
 *
 * The caller's own advertiser, or — for an agent selling from the same list
 * — the one they name in `advertiserId`, checked through the demand-side
 * policy: attributed agent for a read, a live PROFILE grant for a write. A
 * caller with neither (ops, a publisher) browses unsaved; for a save that
 * is a 403, because there is no book to save into.
 */
async function resolveViewer(req: Request, requested: string | undefined, mode: 'READ' | 'WRITE'): Promise<BrowseViewer> {
  if (requested) {
    await assertMayActFor(req, requested, mode);
    return { advertiserId: requested };
  }
  const own = await getAdvertiserForUser(req.user!.sub);
  return { advertiserId: own?.id ?? null };
}

async function requireSavingAdvertiser(req: Request, requested: string | undefined): Promise<string> {
  const viewer = await resolveViewer(req, requested, 'WRITE');
  if (!viewer.advertiserId) {
    throw new ApiError(403, 'FORBIDDEN', 'Your account is not an advertiser. Say which advertiser you are saving this for.');
  }
  return viewer.advertiserId;
}

const optionalId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export async function browseListingsHandler(req: Request, res: Response): Promise<void> {
  const parsed = browseQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  const { lat, lng, radiusKm, from, to, page, pageSize, advertiserId, ...facets } = parsed.data;
  const viewer = await resolveViewer(req, advertiserId, 'READ');
  const result = await browseListings(
    {
      ...facets,
      ...(from ? { from: new Date(from) } : {}),
      ...(to ? { to: new Date(to) } : {}),
      ...(lat !== undefined && lng !== undefined ? { near: { latitude: lat, longitude: lng, radiusKm } } : {}),
    },
    page,
    pageSize,
    viewer,
  );
  // The page travels whole — items and total together — because the phone's
  // client reads `data` alone, and "128 spaces in MG Road" is the total.
  res.json({ success: true, data: result });
}

/**
 * G12-B: GET /listings/browse/categories?city=&lat=&lng=&radiusKm= — the
 * category grid for the place, resolved the way the browse page resolves
 * it. Any signed-in caller, like browse; nothing here is per viewer.
 */
export async function browseCategoriesHandler(req: Request, res: Response): Promise<void> {
  const parsed = browseCategoriesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  const { city, lat, lng, radiusKm } = parsed.data;
  const result = await browseCategories({
    ...(city ? { city } : {}),
    ...(lat !== undefined && lng !== undefined ? { near: { latitude: lat, longitude: lng, radiusKm } } : {}),
  });
  res.json({ success: true, data: result });
}

/** QR-20: GET /listings/browse/venues?city=&lat=&lng=&radiusKm= — the sub-category tiles for the place, every active venue type counted. */
export async function browseVenuesHandler(req: Request, res: Response): Promise<void> {
  const parsed = browseCategoriesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  const { city, lat, lng, radiusKm } = parsed.data;
  const result = await browseVenues({
    ...(city ? { city } : {}),
    ...(lat !== undefined && lng !== undefined ? { near: { latitude: lat, longitude: lng, radiusKm } } : {}),
  });
  res.json({ success: true, data: result });
}

export async function browseListingHandler(req: Request, res: Response): Promise<void> {
  const viewer = await resolveViewer(req, optionalId(req.query['advertiserId']), 'READ');
  // Lot G (Q116/136): the campaign's dates, when the page has them, so
  // `slotsLeft` is counted over the flight rather than today.
  const parsed = browseWindowSchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  const window = {
    ...(parsed.data.from ? { from: new Date(parsed.data.from) } : {}),
    ...(parsed.data.to ? { to: new Date(parsed.data.to) } : {}),
  };
  res.json({ success: true, data: await getBrowseListing(req.params['listingId'] as string, viewer, window) });
}

/**
 * E11-2: the public spot page a shared link opens — `GET /s/:displayId`,
 * root-mounted and public. One self-contained document for an ACTIVE
 * listing; 404 for anything else, so the link dies with the spot.
 */
export async function spotPageHandler(req: Request, res: Response): Promise<void> {
  const displayId = String(req.params['displayId'] ?? '').trim();
  const spot = await getSpotPage(displayId);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).type('text/html').send(renderSpotPage(spot, spotPageLinks(spot.displayId || displayId)));
}

/* ── Audience — G7 (Q109) ──────────────────────────────────────────── */

/**
 * GET /listings/:listingId/audience?period=YYYY-MM
 *
 * The footfall / data-panel vendor's view of the spot's catchment for one
 * month. ADX, the publisher's side of the listing, or an advertiser (or
 * their agent, naming them) who has the spot in a campaign — the service
 * decides. The vendor is asked once per (listing, vendor, month); every
 * later read is the stored snapshot.
 */
export async function listingAudienceHandler(req: Request, res: Response): Promise<void> {
  const parsed = audienceQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  const viewer = await resolveViewer(req, parsed.data.advertiserId, 'READ');
  const data = await listingAudience(
    req.params['listingId'] as string,
    parsed.data.period,
    { userId: req.user!.sub, isAdmin: (req.user?.roles ?? []).includes('ADMIN'), advertiserId: viewer.advertiserId },
  );
  res.json({ success: true, data });
}

/* ── Saved spaces — Lot D (Q5/Q104) ────────────────────────────────── */

export async function saveListingHandler(req: Request, res: Response): Promise<void> {
  const advertiserId = await requireSavingAdvertiser(req, optionalId(req.body?.advertiserId ?? req.query['advertiserId']));
  res.json({ success: true, data: await saveListing(advertiserId, req.params['listingId'] as string) });
}

export async function unsaveListingHandler(req: Request, res: Response): Promise<void> {
  const advertiserId = await requireSavingAdvertiser(req, optionalId(req.body?.advertiserId ?? req.query['advertiserId']));
  res.json({ success: true, data: await unsaveListing(advertiserId, req.params['listingId'] as string) });
}

/** `GET /advertisers/:advertiserId/saved` — the owner, ADX, or the attributed agent. */
export async function savedListingsHandler(req: Request, res: Response): Promise<void> {
  const parsed = savedSpacesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  const advertiserId = req.params['advertiserId'] as string;
  await assertMayActFor(req, advertiserId, 'READ');
  res.json({ success: true, data: await listSavedListings(advertiserId, parsed.data) });
}
import {
  acceptSuggestedRate,
  assertAgentAssignable,
  assertCanCreateForPublisher,
  assertCanEditListing,
  createListing,
  findOwnPublisher,
  getContentRules,
  getReviewCase,
  getReviewQueue,
  listContentCategories,
  getAllListings,
  getListingForAdmin,
  getSimilarListings,
  publishListing,
  repriceLog,
  sendBackListing,
  submitListingForReview,
  suggestedRateOffer,
  updateListing,
  verifyListingVehicleRc,
} from './listings.service';

export async function createListingHandler(req: Request, res: Response): Promise<void> {
  const parsed = createListingSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const roles = req.user?.roles ?? [];
  const isAdmin = roles.includes('ADMIN');
  const { agentId: requestedAgentId, publisherId, draftId, ...rest } = parsed.data;

  /**
   * Two variants of the same seven steps.
   *
   * DR 02 draws a publisher listing a spot on their own phone, and an agent
   * sitting with them doing it. The difference reaches the database as one
   * field: a self-serve listing has no agent.
   *
   * A publisher's own record is resolved from their login rather than read from
   * the body, and anything they sent as `publisherId` is discarded — otherwise
   * the field would be a way to file a listing under somebody else's account.
   */
  const selfServe = !isAdmin && !roles.includes('AGENT_PUBLISHER');
  if (selfServe) {
    const own = await findOwnPublisher(req.user!.sub);
    if (!own) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'You have no publisher account yet, so there is nothing to list a spot under',
      );
    }
    // QR-3: the door. A publisher on their own phone lists nothing until
    // ADX has their name, email and address — the same rule the home's
    // readiness figure draws, so the "+" the app disables and this refusal
    // agree. An agent at the door follows the ladder, which asks for the
    // basics before the spots; ADX may file a spot under any record.
    const missing = profileBasicsMissing(own);
    if (missing.length > 0) {
      throw new ApiError(409, 'PROFILE_INCOMPLETE', profileIncompleteMessage(missing), { missing });
    }
    // QR-8: a listing finished from a saved draft takes the draft's reference
    // and the draft goes — one id from the first save to going live.
    const draft = draftId ? await takeDraft(own.id, draftId) : null;
    const listing = await createListing({
      ...rest,
      publisherId: own.id,
      category: rest.category as ListingCategory,
      ...(draft ? { displayId: draft.displayId } : {}),
    });
    if (draft) await removeDraft(own.id, draft.id);
    res.status(201).json({ success: true, data: listing });
    return;
  }

  if (!publisherId) {
    throw new ApiError(400, 'BAD_REQUEST', 'Say which publisher this spot belongs to');
  }

  // Checked before anything is written, and before an agent id is resolved: the
  // question is whether this caller may act for this publisher at all.
  await assertCanCreateForPublisher(publisherId, {
    userId: req.user!.sub,
    isAdmin,
  });

  const agentId = requestedAgentId
    ? await assertAgentAssignable(requestedAgentId, isAdmin)
    : (await requireAgentProfile(req.user!.sub)).id;

  const listing = await createListing({
    ...rest,
    publisherId,
    agentId,
    category: rest.category as ListingCategory,
  });
  res.status(201).json({ success: true, data: listing });
}

export async function getAllListingsHandler(req: Request, res: Response): Promise<void> {
  const parsed = adminListingsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  const page = await getAllListings(parsed.data);
  // The page travels whole, the way browse does — the table prints the total
  // and labels its chips from `counts`, so splitting them across calls would
  // make the header and the rows disagree mid-scroll. Only the rows are
  // translated; a count has no language.
  res.json({
    success: true,
    data: { ...page, items: await translateListings(page.items, req.user!.sub) },
  });
}

/**
 * The detail view — what `GET /listings/:listingId` answers, and (T-B)
 * what a patch answers: the listing with its publisher, agent, photos and
 * media type (`getListingForAdmin`), translated for the reader.
 */
async function listingDetailView(listingId: string, userId: string) {
  const listing = await getListingForAdmin(listingId);
  const [translated] = await translateListings([listing], userId);
  return translated ?? listing;
}

export async function getListingHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listingDetailView(req.params['listingId'] as string, req.user!.sub) });
}

/** E10-2: the Pricing tab's history — the factor reprices on this listing, newest first. */
export async function repriceLogHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await repriceLog(req.params['listingId'] as string) });
}

export async function updateListingHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateListingSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const listingId = req.params['listingId'] as string;
  await assertCanEditListing(listingId, {
    userId: req.user!.sub,
    isAdmin: (req.user?.roles ?? []).includes('ADMIN'),
  });
  await updateListing(listingId, parsed.data);
  // T-B: the patch answers the detail view the GET answers, one read after the write.
  res.json({ success: true, data: await listingDetailView(listingId, req.user!.sub) });
}

/**
 * The publisher says they are done, and ADX's clock starts.
 *
 * Guarded exactly as an edit is — a listing you may not edit is not one you may
 * put in front of ADX for review.
 */
export async function submitListingHandler(req: Request, res: Response): Promise<void> {
  const listingId = req.params['listingId'] as string;
  const roles = req.user?.roles ?? [];
  const isAdmin = roles.includes('ADMIN');
  await assertCanEditListing(listingId, { userId: req.user!.sub, isAdmin });
  // QR-6 (the owner, 17 Sep 2026): the commercial agreement is presented
  // when a listing is submitted — not in the setup checklist. A publisher on
  // their own phone submits nothing until they have accepted the live
  // publisher platform agreement (`agreements.platformStanding`: the live
  // version, or any version unless ADX asked for re-acceptance); the app
  // shows the text on this refusal, records the click and retries. While
  // ADX has published no agreement there is nothing to accept and nothing
  // gates. An agent's ladder carries its own acceptance and is not gated.
  if (!isAdmin && !roles.includes('AGENT_PUBLISHER')) {
    const own = await findOwnPublisher(req.user!.sub);
    if (own) {
      const standing = await platformStanding('PLATFORM', { publisherId: own.id });
      if (standing.currentVersion !== null && !standing.satisfied) {
        throw new ApiError(
          409,
          'AGREEMENT_REQUIRED',
          'Read and accept the ADX publisher agreement to send this listing for review. It is saved as a draft until then.',
          { agreement: 'PLATFORM', version: standing.currentVersion },
        );
      }
    }
  }
  const listing = await submitListingForReview(listingId);
  res.json({ success: true, data: listing });
}

/**
 * Lot E: the offer ADX's applied factors make on the publisher's own spot.
 *
 * Guarded as an edit is — the publisher, or their agent — but never as an
 * admin route: `/me` is the party's own view, and the desk reads the same
 * figure at `/pricing/listings/:id/suggested-rate`.
 */
export async function suggestedRateHandler(req: Request, res: Response): Promise<void> {
  const listingId = req.params['listingId'] as string;
  await assertCanEditListing(listingId, { userId: req.user!.sub, isAdmin: false });
  res.json({ success: true, data: await suggestedRateOffer(listingId) });
}

/** Lot E: the publisher takes the offer, and the rate is written as their decision. */
export async function acceptSuggestedRateHandler(req: Request, res: Response): Promise<void> {
  const listingId = req.params['listingId'] as string;
  await assertCanEditListing(listingId, { userId: req.user!.sub, isAdmin: false });
  res.json({ success: true, data: await acceptSuggestedRate(listingId, req.user!.sub) });
}

/**
 * ADX approves: the listing goes onto the marketplace.
 *
 * ADMIN-only at the route. Publishing puts a rate in front of advertisers and
 * into every neighbour's comparable pool, and the publisher's own "I am done"
 * is `/submit` — letting them publish as well would make the desk optional.
 * The decision is written to the activity log because a listing going live is
 * exactly the kind of act somebody asks "who did that?" about later.
 */
/** AG-4: the desk checks a vehicle-spot's RC with Cashfree; `vehicleNumber` in the body sets or corrects the registration first. */
export async function verifyListingVehicleRcHandler(req: Request, res: Response): Promise<void> {
  const listingId = req.params['listingId'] as string;
  const raw = (req.body ?? {}) as { vehicleNumber?: unknown };
  const vehicleNumber = typeof raw.vehicleNumber === 'string' && raw.vehicleNumber.trim() ? raw.vehicleNumber.trim() : undefined;
  res.json({ success: true, data: await verifyListingVehicleRc(listingId, { vehicleNumber }, req.user!.sub) });
}

export async function publishListingHandler(req: Request, res: Response): Promise<void> {
  const listingId = req.params['listingId'] as string;
  const listing = await publishListing(listingId);
  await logActivity(req.user!.sub, 'LISTING_PUBLISHED', req, { listingId });
  res.json({ success: true, data: listing });
}

/* ------------------------------------------------------------------ */
/* The review desk — DR 10                                             */
/* ------------------------------------------------------------------ */

export async function reviewQueueHandler(req: Request, res: Response): Promise<void> {
  const parsed = reviewQueueQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  res.json({ success: true, data: await getReviewQueue(parsed.data) });
}

export async function reviewCaseHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getReviewCase(req.params['listingId'] as string) });
}

/**
 * ADX says no, with a reason. The reason is stored on the listing where the
 * publisher's own app reads it, and logged with the decision.
 */
export async function sendBackListingHandler(req: Request, res: Response): Promise<void> {
  const parsed = sendBackListingSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const listingId = req.params['listingId'] as string;
  const listing = await sendBackListing(listingId, parsed.data);
  await logActivity(req.user!.sub, 'LISTING_SENT_BACK', req, {
    listingId,
    outcome: parsed.data.outcome,
    reason: parsed.data.reason,
  });
  res.json({ success: true, data: listing });
}

/**
 * The list of things a publisher can take a position on — DR 02 step 6.
 *
 * Open to any signed-in caller because the listing form needs it, on both the
 * publisher's phone and the console. Ops manages the list itself in the seed;
 * there is no create endpoint yet, on purpose — a publisher inventing a content
 * category would be inventing a rule nobody else can honour.
 */
export async function contentCategoriesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listContentCategories() });
}

export async function listingContentRulesHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getContentRules(req.params['listingId'] as string) });
}

export async function similarListingsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getSimilarListings(req.params['id'] as string) });
}


/* ── QR-8: listing drafts ──────────────────────────────────────────────── */

/** GET /listings/drafts — the caller's own saved drafts, newest first. */
export async function listMyListingDraftsHandler(req: Request, res: Response): Promise<void> {
  const own = await findOwnPublisher(req.user!.sub);
  if (!own) throw new ApiError(403, 'FORBIDDEN', 'You have no publisher account yet, so there is nothing to save a draft under');
  res.json({ success: true, data: await listMyDrafts(own.id) });
}

/** POST /listings/drafts — save a new draft (mints its LST- reference); PUT /listings/drafts/:id — update one. */
export async function saveListingDraftHandler(req: Request, res: Response): Promise<void> {
  const parsed = saveDraftSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const own = await findOwnPublisher(req.user!.sub);
  if (!own) throw new ApiError(403, 'FORBIDDEN', 'You have no publisher account yet, so there is nothing to save a draft under');
  const id = typeof req.params['draftId'] === 'string' ? req.params['draftId'] : null;
  const draft = await saveDraft(own.id, id, parsed.data);
  res.status(id ? 200 : 201).json({ success: true, data: draft });
}

/** DELETE /listings/drafts/:id — the caller throws a draft away. */
export async function deleteListingDraftHandler(req: Request, res: Response): Promise<void> {
  const own = await findOwnPublisher(req.user!.sub);
  if (!own) throw new ApiError(403, 'FORBIDDEN', 'You have no publisher account yet');
  await removeDraft(own.id, req.params['draftId'] as string);
  res.json({ success: true, data: { deleted: true } });
}

/** GET /listings/drafts/desk — ADMIN: every publisher's half-written spot, for the sales and onboarding teams. */
export async function deskListingDraftsHandler(req: Request, res: Response): Promise<void> {
  const parsed = deskDraftsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await deskDrafts(parsed.data) });
}

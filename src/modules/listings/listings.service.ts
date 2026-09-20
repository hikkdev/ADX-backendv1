import { ApiError } from '../../shared/errors';
import { PROFILE_BASIC_LABEL, profileBasicsMissing } from '../../shared/kyc-state';
import { allocateIdentifier } from '../identifiers';
import { auditDiff, findActivityRows, logActivity } from '../../shared/audit';
import { toListPage, type ListPage } from '../../shared/pagination';
import { assertPublishable, belowFloorFlags, checkGate } from '../rate-cards';
import { Decimal, money } from '../../shared/money';
import { holdsLiveGrant } from '../access-grants';
import { findAgentProfile } from '../agents';
import { isFeatureEnabled } from '../feature-flags';
import { createNotification } from '../notifications';
import { activeSurge, assertCityAllows, citySupport, cityKeyFor, classifySpot, suggestedRate, withCityKey } from '../pricing';
import { areaFrom, ratePerDayFrom } from './listing-pricing';
import { prismaListingsRepository as repository } from './prisma-listings.repository';
import { assertSlotsAllowed, carriesLoop, slotsHeldFor, slotsLeft, todayWindow } from './slots.service';
import type {
  ListingCategory,
  ListingStatus,
  PricingUnit,
  RateGrade,
} from '../../shared/database';
import type {
  ContentRule,
  ListingPatch,
  NewListing,
  ReviewCaseListing,
  ReviewDocument,
  ReviewQueueListing,
} from './listings.repository';
import type { AdminListingsQuery, ReviewQueueQuery, SendBackOutcome } from './listings.schema';

/**
 * A listing as the API receives it, before the pricing engine has classified it.
 *
 * `mediaTypeName` is words; `mediaTypeId` is a decision already taken. Sending
 * the name is what puts a new spot through the similarity threshold.
 */
export type ListingDraft = Omit<
  NewListing,
  'ratePerDay' | 'ratePerDaySurgeUntil' | 'areaSqFt'
> & {
  /** QR-8: the reference carried over from a saved draft; minted here when absent. */
  displayId?: string | null;
  /** DR 02 step 6. Written after the listing exists, so it has an id to hang on. */
  contentRules?: ContentRule[];
  mediaTypeName?: string;
  sizeClassSlug?: string;
  materialSlug?: string;
  /** A venue by name rather than id, resolved against the controlled list. */
  venueTypeSlug?: string;
  /** Canonical. Either this or `monthlyPrice`; the other is derived. */
  ratePerDay?: string;
  /** The old shape, still accepted so existing callers keep working. */
  monthlyPrice?: number;
};

/**
 * A flat 30, matching the repository's derivation in the other direction.
 *
 * The real month length would make a daily rate wobble by 3% depending on which
 * month a publisher happened to list in, which is worse than approximate.
 */
const DAYS_PER_MONTH = 30;

/**
 * One rate, however it arrived.
 *
 * `monthlyPrice` is a JSON float into a Float column — the wrong type for money
 * — and is on its way out. Converting at the edge means only this line has to
 * know that, and everything downstream sees a decimal string.
 */
function canonicalRate(
  draft: Pick<ListingDraft, 'ratePerDay' | 'monthlyPrice' | 'pricingUnit' | 'basePrice'> & {
    /** The area to price against, when the unit is a per-square-foot one. */
    areaSqFt?: string | null;
  }
): string {
  // The publisher's own unit wins where they stated one. It is the figure they
  // typed, and `ratePerDayFrom` already rejects the ways a conversion can end
  // at nothing — so a mall quoting per square foot per month never has to do
  // the division that is how a rate gets mistyped by a factor of thirty.
  if (draft.basePrice !== undefined && draft.pricingUnit !== undefined) {
    return ratePerDayFrom({
      unit: draft.pricingUnit,
      basePrice: draft.basePrice,
      areaSqFt: draft.areaSqFt ?? null,
    });
  }

  const rate =
    draft.ratePerDay !== undefined
      ? new Decimal(draft.ratePerDay)
      : draft.monthlyPrice !== undefined
        ? new Decimal(draft.monthlyPrice).dividedBy(DAYS_PER_MONTH)
        : null;
  if (rate === null) throw new ApiError(400, 'BAD_REQUEST', 'A listing needs a price');
  // Checked *after* rounding, which is the value that reaches the column. A
  // monthly price of 0.01 is a positive daily rate of 0.00033 and rounds to
  // zero, so testing the unrounded number would let it through to trip the
  // positivity CHECK as a 500 instead of arriving here as a 400.
  const rounded = money(rate);
  if (new Decimal(rounded).lessThanOrEqualTo(0)) {
    throw new ApiError(400, 'BAD_REQUEST', 'A listing price must be greater than zero');
  }
  return rounded;
}

/**
 * Creates a listing, classifying it for the pricing engine on the way in.
 *
 * Two things happen here that cannot happen in the repository. A media type
 * given by name is resolved through the similarity threshold, which is the only
 * moment the taxonomy grows and the only place fragmentation can be caught. And
 * the surge state is recorded at the instant the price is set — the indicator
 * invites a publisher to price higher during a window, so that rate must be
 * marked or it becomes a baseline in every neighbour's comparable set and stays
 * there long after the event.
 */
export async function createListing(draft: ListingDraft) {
  const {
    mediaTypeName,
    sizeClassSlug,
    materialSlug,
    venueTypeSlug,
    contentRules,
    ratePerDay: _raw,
    ...data
  } = draft;

  // Derived, never accepted. An area that disagrees with its own width and
  // height is a spot that prices one way and measures another, and the
  // per-square-foot units make that disagreement a billing error.
  const areaSqFt =
    data.widthFt !== undefined && data.heightFt !== undefined
      ? areaFrom(data.widthFt, data.heightFt)
      : undefined;

  const ratePerDay = canonicalRate({ ...draft, areaSqFt });

  // Q31 / Lot V: a city whose rollout stage has supply intake off cannot
  // take new inventory (PLANNED, PAUSED, WITHDRAWN). A name the catalogue
  // does not know still can — the field is free text, and only a deliberate
  // stage refuses.
  await assertCityAllows(data.city, 'supplyIntake');

  // Lot D (Q105): opting into instant booking is gated; leaving it off is not.
  if (data.instantBooking === true) await assertInstantBookingAllowed(data.publisherId);

  const classified = await classifySpot({
    category: data.category,
    venueTypeId: data.venueTypeId,
    venueTypeSlug,
    mediaTypeId: data.mediaTypeId,
    mediaTypeName,
    sizeClassId: data.sizeClassId,
    sizeClassSlug,
    materialId: data.materialId,
    materialSlug,
    widthFt: data.widthFt,
    heightFt: data.heightFt,
  });

  // Lot G (Q116/136): more than one slot needs a screen — read off the
  // sub-type, or the media type the classifier just resolved. Refused before
  // anything is written.
  if (data.slotsTotal !== undefined) {
    await assertSlotsAllowed(data.slotsTotal, { subType: data.subType, mediaTypeId: classified.mediaTypeId ?? data.mediaTypeId });
  }

  const surge =
    data.latitude !== undefined && data.longitude !== undefined
      ? await activeSurge({
          latitude: data.latitude,
          longitude: data.longitude,
          city: data.city ?? null,
        })
      : null;

  // QR-8: the reference is minted at creation — the LISTING series,
  // LST-DDMM-YYNN — unless the caller carries one over from a draft. Every
  // listing has a name from its first moment; the desk and the publisher
  // quote the same one from draft to live. (Rows from before QR-8 keep their
  // ADX-LST-nnnnn; `submitListingForReview` mints for any still without.)
  const displayId = data.displayId ?? (await allocateIdentifier('LISTING'));
  // Lot X-B: the city key rides with the typed city (null for a town the catalogue lacks).
  const created = await repository.create({
    ...(await withCityKey(data)),
    displayId,
    ratePerDay,
    ...(areaSqFt ? { areaSqFt } : {}),
    ...(classified.venueTypeId ? { venueTypeId: classified.venueTypeId } : {}),
    ...(classified.mediaTypeId ? { mediaTypeId: classified.mediaTypeId } : {}),
    ...(classified.sizeClassId ? { sizeClassId: classified.sizeClassId } : {}),
    ...(classified.materialId ? { materialId: classified.materialId } : {}),
    // coverUntil, not endsAt: the pool stays clear until the last of the
    // overlapping windows closes, though the advertiser is told about the
    // strongest one.
    ratePerDaySurgeUntil: surge?.coverUntil ?? null,
  });

  // After the insert, because a rule needs a listing id to hang on. A failure
  // here leaves a listing with no stated content rules rather than no listing,
  // which is the safer of the two: an unstated stance is reviewed by a person,
  // and a lost listing is a publisher's work thrown away.
  if (contentRules?.length) await repository.setContentRules(created.id, contentRules);

  return created;
}

/** The controlled list a publisher takes a position on. */
export async function listContentCategories() {
  return repository.listContentCategories();
}

export async function getContentRules(listingId: string) {
  return repository.contentRulesFor(listingId);
}

export async function getListingsForPublisher(publisherId: string) {
  return repository.findForPublisher(publisherId);
}

/**
 * The DR 10 admin table, one page at a time.
 *
 * Was an unbounded `findMany` of every listing in the database with every
 * publisher, agent and photo joined, and no way to search, filter or sort it.
 * The page carries its own total and status histogram because the screen
 * prints both.
 */
/**
 * One listing for the console's detail page. 404 when there is no such spot.
 * G11-1: carries `carriesLoop` — the one rule `slots.service` refuses a slot
 * count with — and the media type it was filed under, `{ name, formatGroup } | null`.
 */
export async function getListingForAdmin(listingId: string) {
  const listing = await repository.findOneForAdmin(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'No such listing');
  return { ...listing, carriesLoop: carriesLoop({ subType: listing.subType, mediaType: listing.mediaType }) };
}

export async function getAllListings(query: AdminListingsQuery) {
  // Lot X-B: `?city=` is a slug (or a name, for the console's older links) — matched by key, the spelling as the fallback.
  const keyed = query.city ? { ...query, cityId: (await cityKeyFor(query.city))?.cityId ?? null } : query;
  const { items, total, counts } = await repository.findAllForAdmin(keyed);
  // Lot E: the rate-card badge on every row — under the floor of the card in
  // force, or not. One flag per row; the verdict itself is the gate route's.
  const flags = await belowFloorFlags(items.map((row) => row.id));
  const stamped = items.map((row) => ({ ...row, belowFloor: flags[row.id] ?? false }));
  return toListPage(stamped, total, counts, query);
}

/**
 * A patch, with the same surge provenance a create records.
 *
 * Editing a price during a window is exactly what the indicator invites, so the
 * edit has to be marked the same way — otherwise raising a rate is a route into
 * everyone else's baseline that creating one is not.
 */
export async function updateListing(
  listingId: string,
  data: Omit<ListingPatch, 'ratePerDaySurgeUntil' | 'areaSqFt'> & {
    category?: NewListing['category'];
    mediaTypeName?: string;
    sizeClassSlug?: string;
    materialSlug?: string;
    venueTypeSlug?: string;
    contentRules?: ContentRule[];
  }
) {
  const {
    monthlyPrice,
    category,
    mediaTypeName,
    sizeClassSlug,
    materialSlug,
    venueTypeSlug,
    mediaTypeId,
    sizeClassId,
    materialId,
    venueTypeId,
    contentRules,
    ...rest
  } = data;
  // Lot X-B: a corrected city carries its key on every branch below; a patch of other fields leaves the key alone.
  const patch = await withCityKey(rest);

  const remeasuring = patch.widthFt !== undefined || patch.heightFt !== undefined;
  const reclassifying =
    mediaTypeName !== undefined ||
    sizeClassSlug !== undefined ||
    materialSlug !== undefined ||
    venueTypeSlug !== undefined ||
    mediaTypeId !== undefined ||
    sizeClassId !== undefined ||
    materialId !== undefined ||
    venueTypeId !== undefined ||
    // New dimensions re-derive the class, which is the whole point of measuring
    // rather than picking. Without this a corrected width would leave the
    // listing in the pool its first mistyped measurement put it in.
    remeasuring;
  const explicitlyRepricing =
    patch.ratePerDay !== undefined ||
    monthlyPrice !== undefined ||
    patch.basePrice !== undefined ||
    // A unit change with the same figure is a different rate.
    patch.pricingUnit !== undefined;

  // Replaces the whole set when it is sent at all, so unticking a category
  // actually removes it. Sent before the branches below, because none of them
  // touch it and every one of them returns.
  if (contentRules) await repository.setContentRules(listingId, contentRules);

  // Looked up before every branch, not only the ones that need the row. A bare
  // title patch against an unknown id used to reach `prisma.listing.update`,
  // which throws P2025 — not an ApiError, so the handler rendered it as a 500,
  // while the very same id on a price patch answered 404. One id, two answers,
  // depending on which field the caller happened to touch.
  const listing = await repository.findById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');

  // Lot D (Q105): switching instant booking on is gated on the flag and on
  // the publisher having an address; switching it off asks nothing.
  if (patch.instantBooking === true && listing.publisherId) {
    await assertInstantBookingAllowed(listing.publisherId);
  }

  // A new area only changes the rate when the unit is measured in area. A
  // spot quoted per day is worth the same whatever the tape says, and
  // repricing it would mean re-deriving a number nobody asked to change.
  const repricing =
    explicitlyRepricing ||
    (remeasuring && listing.basePrice !== null && areaDependent(listing.pricingUnit));

  if (!reclassifying && !repricing) {
    // Lot G (Q116/136): the loop is re-checked when the count or the sub-type
    // moves; the media type is the listing's own on this path.
    await assertLoopAfterPatch(listing, patch, listing.mediaTypeId);
    // `category` is destructured out of `patch` above, so it has to be put back
    // on every path that writes. It used not to be on this one: a patch that
    // touched nothing else answered 200 and wrote an empty object, and since
    // category gates the media-type similarity threshold, an ops correction here
    // was a silent no-op for the life of the listing.
    return repository.update(listingId, { ...patch, ...(category ? { category } : {}) });
  }

  // A patch may move one side of the pair. The other comes off the listing, so
  // editing a width does not silently un-measure the height.
  const widthFt = patch.widthFt ?? listing.widthFt?.toString();
  const heightFt = patch.heightFt ?? listing.heightFt?.toString();
  const areaSqFt =
    remeasuring && widthFt !== undefined && heightFt !== undefined
      ? areaFrom(widthFt, heightFt)
      : undefined;

  const classified = reclassifying
    ? await classifySpot({
        // A patch may name a new category, but the listing already has one and
        // the media-type threshold is gated on it.
        category: category ?? listing.category,
        venueTypeId,
        venueTypeSlug,
        mediaTypeId,
        mediaTypeName,
        sizeClassId,
        sizeClassSlug,
        materialId,
        materialSlug,
        // Only when the tape actually moved. Re-deriving on every unrelated
        // patch would let a class ops corrected by hand snap back on the next
        // title edit.
        ...(remeasuring ? { widthFt, heightFt } : {}),
        listingId,
      })
    : null;

  const measured = {
    ...(areaSqFt === undefined ? {} : { areaSqFt }),
    ...(classified?.venueTypeId ? { venueTypeId: classified.venueTypeId } : {}),
    ...(classified?.mediaTypeId ? { mediaTypeId: classified.mediaTypeId } : {}),
    ...(classified?.sizeClassId ? { sizeClassId: classified.sizeClassId } : {}),
    ...(classified?.materialId ? { materialId: classified.materialId } : {}),
  };

  // Lot G (Q116/136): a reclassification may move the spot off a screen, so
  // the loop is re-checked against the media type the patch lands on.
  await assertLoopAfterPatch(listing, patch, measured.mediaTypeId ?? listing.mediaTypeId, reclassifying);

  if (!repricing) {
    return repository.update(listingId, {
      ...patch,
      ...(category ? { category } : {}),
      ...measured,
    });
  }

  const surge =
    listing.latitude !== null && listing.longitude !== null
      ? await activeSurge({
          latitude: listing.latitude,
          longitude: listing.longitude,
          city: listing.city,
        })
      : null;

  // The unit and the figure each fall back to what the listing already holds:
  // changing only the unit reprices the stored figure, and changing only the
  // figure keeps the stored unit. Sending neither leaves the pair alone and the
  // rate is whatever `ratePerDay` or `monthlyPrice` says.
  const areaForPricing = areaSqFt ?? listing.areaSqFt?.toString() ?? null;
  const priced = repricedFrom({ patch, monthlyPrice, listing, areaSqFt: areaForPricing });

  return repository.update(listingId, {
    ...patch,
    ...(category ? { category } : {}),
    ...measured,
    ...(monthlyPrice === undefined ? {} : { monthlyPrice }),
    ...priced,
    ratePerDaySurgeUntil: surge?.coverUntil ?? null,
  });
}

/**
 * Lot G (Q116/136): the loop gate on a patch. Asked only when the patch
 * touches the count, the sub-type or (`evidenceMoved`) the media type — a
 * title edit asks nothing — and only when the count that results is above
 * one. A patch that brings the count back to 1 in the same breath passes.
 */
async function assertLoopAfterPatch(
  listing: { slotsTotal: number; subType: string | null },
  patch: { slotsTotal?: number; subType?: string },
  mediaTypeId: string | null | undefined,
  evidenceMoved = false,
): Promise<void> {
  if (patch.slotsTotal === undefined && patch.subType === undefined && !evidenceMoved) return;
  // A row from before the column defaults to one, like the column itself.
  const slotsTotal = patch.slotsTotal ?? listing.slotsTotal ?? 1;
  await assertSlotsAllowed(slotsTotal, { subType: patch.subType ?? listing.subType, mediaTypeId });
}

/** Units whose rate depends on how big the spot is. */
function areaDependent(unit: PricingUnit): boolean {
  return unit === 'PER_SQFT_PER_DAY' || unit === 'PER_SQFT_PER_MONTH';
}

/**
 * Lot D (Q6/Q105): whether this publisher may switch a spot to instant booking.
 *
 * Two gates. The feature ships behind the `instant-booking` flag, bucketed
 * by publisher so ops can roll it out to a share of supply (409
 * FEATURE_OFF). And an instant order skips the accept screen, which is
 * where the publisher would normally say where the agent collects the
 * material — so the address has to already be on file, judged by the same
 * fallback the accept screen uses (street address, else city and state;
 * 409 NO_MEETING_PLACE). The order is still asked who installs; only the
 * publisher's tap is skipped.
 */
async function assertInstantBookingAllowed(publisherId: string): Promise<void> {
  if (!(await isFeatureEnabled('instant-booking', publisherId))) {
    throw new ApiError(409, 'FEATURE_OFF', 'Instant booking is not switched on for this account yet.');
  }
  const place = await repository.publisherMeetingPlace(publisherId);
  const hasAddress =
    Boolean(place?.address?.trim()) || Boolean([place?.city, place?.state].filter(Boolean).join(', ').trim());
  if (!hasAddress) {
    throw new ApiError(
      409,
      'NO_MEETING_PLACE',
      'Add your address before switching on instant booking — an accepted order needs somewhere to send the agent.',
    );
  }
}

/**
 * The new rate, and the unit and figure that still derive it.
 *
 * The pair is stored so a publisher reads back the number they typed, which
 * only holds while the pair and the rate agree. Three things can arrive:
 *
 *   - a bare daily rate, which is a decision: the pair is rewritten to match it,
 *     because leaving "150 per sq ft per month" beside a rate that no longer
 *     comes from it would show the publisher a figure their listing contradicts;
 *   - a new unit or a new figure, merged over whatever the listing already
 *     holds, so changing one does not require restating the other;
 *   - neither, when only the tape moved — the stored pair reprices itself,
 *     which is the entire reason a per-square-foot listing stores one.
 */
function repricedFrom(input: {
  patch: { ratePerDay?: string; basePrice?: string; pricingUnit?: PricingUnit };
  monthlyPrice: number | undefined;
  listing: { pricingUnit: PricingUnit; basePrice: { toString(): string } | null };
  areaSqFt: string | null;
}): { ratePerDay: string; pricingUnit?: PricingUnit; basePrice?: string } {
  const { patch, monthlyPrice, listing, areaSqFt } = input;

  if (patch.ratePerDay !== undefined) {
    const rate = canonicalRate({ ratePerDay: patch.ratePerDay });
    return { ratePerDay: rate, pricingUnit: 'PER_DAY', basePrice: rate };
  }
  if (monthlyPrice !== undefined) {
    return {
      ratePerDay: canonicalRate({ monthlyPrice }),
      pricingUnit: 'PER_MONTH',
      basePrice: money(new Decimal(monthlyPrice)),
    };
  }

  const pricingUnit = patch.pricingUnit ?? listing.pricingUnit;
  const basePrice = patch.basePrice ?? listing.basePrice?.toString();
  if (basePrice === undefined) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'This listing has no base price to convert, so send basePrice along with the unit'
    );
  }
  return {
    ratePerDay: canonicalRate({ pricingUnit, basePrice, areaSqFt }),
    pricingUnit,
    basePrice,
  };
}

/** Who is asking, and what they are allowed to be asking for. */
export type ListingActor = { userId: string; isAdmin: boolean };

/**
 * Whether this caller may change this listing.
 *
 * There was no check at all. Any agent-publisher account could edit any
 * listing, and since this session widened the patch surface to `basePrice`,
 * `pricingUnit`, `ratePerDay`, `venueTypeId` and `mediaTypeId`, that meant any
 * agent could reprice a competitor's spot — and listings feed the comparable
 * pools, so repricing one moves the range every neighbour is measured against.
 * A quiet way to move a market.
 *
 * Four ways in, and they are deliberately narrow:
 *
 *   - ADX itself.
 *   - The publisher, from their own app.
 *   - The agent who onboarded that publisher. This is the ongoing relationship
 *     the platform is built around, and it is `Publisher.agentId` rather than
 *     `Listing.agentId`: a publisher who has moved to another agent has moved,
 *     and the agent who happened to key the listing in last year has not kept a
 *     claim on it.
 *   - An agent holding a live delegated grant — the publisher raised a ticket,
 *     ADX assigned someone, and the publisher scanned them in. See
 *     `access-grants`.
 *
 * An unclaimed listing (scraped, no publisher yet) belongs to nobody, so only
 * ADX can touch it.
 */
export async function assertCanEditListing(
  listingId: string,
  actor: ListingActor
): Promise<void> {
  if (actor.isAdmin) return;

  const listing = await repository.findWithPublisher(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');

  const publisher = listing.publisher;
  if (!publisher) {
    throw new ApiError(403, 'FORBIDDEN', 'This listing has no publisher yet, so only ADX can edit it');
  }
  if (publisher.userId === actor.userId) return;

  const agent = await findAgentProfile(actor.userId);
  if (agent) {
    if (publisher.agentId === agent.id) return;
    if (await holdsLiveGrant(agent.id, publisher.id, 'LISTINGS', listingId)) return;
  }

  throw new ApiError(
    403,
    'FORBIDDEN',
    'This is not your publisher. Ask them to raise a support ticket and scan you in.'
  );
}

/**
 * Whether this caller may add a spot to this publisher's account.
 *
 * The same hole `assertCanEditListing` closes, one verb earlier and left open
 * longer. `POST /listings` took a `publisherId` from the body and asked nothing
 * about it, so any agent-publisher account could file a listing — at a price of
 * their choosing — under somebody else's name. That price then enters the
 * comparable pool for every spot within 200 m of it, so the damage is not
 * confined to the account it was filed against.
 *
 * Same three ways in as an edit, minus the publisher themselves: this is only
 * reached when somebody is acting *for* a publisher, and a publisher listing
 * their own spot goes down the self-serve path where the id comes from the login
 * and the body is ignored.
 */
export async function assertCanCreateForPublisher(
  publisherId: string,
  actor: ListingActor
): Promise<void> {
  if (actor.isAdmin) return;

  const publisher = await repository.findPublisherById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');

  const agent = await findAgentProfile(actor.userId);
  if (agent) {
    if (publisher.agentId === agent.id) return;
    // A grant that says "help me with my listings" covers adding one. It is
    // scoped to the publisher, so it cannot reach anybody else's account, and
    // it closes on its own like every other grant.
    if (await holdsLiveGrant(agent.id, publisher.id, 'LISTINGS')) return;
  }

  throw new ApiError(
    403,
    'FORBIDDEN',
    'This is not your publisher. Ask them to raise a support ticket and scan you in.'
  );
}

/**
 * The reference a listing from before QR-8 is given at submit, when its row
 * still has none: the LISTING series (`LST-DDMM-YYNN`), the same one a new
 * listing is minted from at creation. The old `ADX-LST-nnnnn` counter is
 * retired — it was a row count, and two publishers submitting in the same
 * second could draw the same number.
 */
async function nextListingReference(): Promise<string> {
  return allocateIdentifier('LISTING');
}

/**
 * The publisher sends their spot for review.
 *
 * This is the step that was missing, and its absence is why nothing could ever
 * be booked: a created listing takes the Prisma default DRAFT, inventory
 * matching only looks at ACTIVE, and the one route that promotes a listing was
 * declared in the mobile client and called by nothing. Supply and demand were
 * each built and were not joined.
 *
 * Submitting is deliberately not publishing. The publisher says "I am done";
 * ADX decides whether it goes on the marketplace, which is what the frame's
 * "review within 24 hours" promises. Idempotent, because the button is on a
 * screen somebody will press twice.
 */
export async function submitListingForReview(listingId: string, now = new Date()) {
  const listing = await repository.findById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');

  if (listing.status === 'PENDING_REVIEW') return listing;
  if (listing.status !== 'DRAFT') {
    throw new ApiError(
      409,
      'CONFLICT',
      `This listing is ${listing.status.toLowerCase().replace(/_/g, ' ')} and is not waiting to be sent for review.`
    );
  }

  const displayId = listing.displayId ?? (await nextListingReference());
  return repository.submitForReview(listingId, displayId, now);
}

/* ------------------------------------------------------------------ */
/* The review desk — DR 10                                             */
/* ------------------------------------------------------------------ */

/**
 * The rate-card verdict, as `rate-cards` answers it. Re-derived from the
 * function rather than imported as a type because the module's index exports
 * the function and not the alias, and the shape is the contract either way.
 */
export type GateVerdict = Awaited<ReturnType<typeof checkGate>>;

/** How many of a listing's documents stand where. */
export type DocumentSummary = { total: number; pending: number; verified: number; rejected: number };

/**
 * One row of the queue: what a reviewer scans before opening the case.
 *
 * Money and measurements are decimal strings, as everywhere on this API. The
 * deprecated `monthlyPrice` float is deliberately not here — the desk compares
 * the canonical daily rate against the card's daily floor, and a second figure
 * in a second unit is how the two get compared wrongly.
 */
export type ReviewQueueRow = {
  id: string;
  displayId: string | null;
  title: string;
  category: ListingCategory;
  subType: string | null;
  status: ListingStatus;
  city: string | null;
  address: string;
  placement: string | null;
  widthFt: string | null;
  heightFt: string | null;
  areaSqFt: string | null;
  publisher: { id: string; name: string; displayId: string | null; city: string | null } | null;
  agent: { id: string; displayId: string | null; name: string | null } | null;
  photoCount: number;
  documentSummary: DocumentSummary;
  /** The publisher's asking price: the canonical daily rate and the pair they typed. */
  asking: { ratePerDay: string | null; basePrice: string | null; pricingUnit: PricingUnit };
  rateGrade: RateGrade | null;
  gate: GateVerdict;
  submittedAt: Date | null;
  createdAt: Date;
  /**
   * The reason this listing was last sent back, when it was. Still on the row
   * after a resubmission, so the reviewer can check the fix against the ask.
   */
  priorReason: string | null;
};

export type ReviewCase = ReviewQueueRow & {
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  targetAudience: string | null;
  uniqueSellingPoint: string | null;
  footfallNote: string | null;
  estimatedDailyFootfall: number | null;
  illumination: string | null;
  facing: string | null;
  elevation: string | null;
  visibility: string | null;
  trafficGrade: string | null;
  minBookingDays: number | null;
  availableNow: boolean;
  availableFrom: Date | null;
  availableHoursFrom: string | null;
  availableHoursTo: string | null;
  peakPeriodNote: string | null;
  rateCardUrl: string | null;
  publisherMobile: string | null;
  vocabulary: {
    mediaType: string | null;
    sizeClass: string | null;
    material: string | null;
    venueType: string | null;
  };
  contentRules: ReviewCaseListing['contentRules'];
  photos: { id: string; url: string; type: string; createdAt: Date }[];
  documents: ReviewDocument[];
};

const asString = (value: { toString(): string } | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toString();

/**
 * Two places, always. A Decimal's own `toString` drops trailing zeros, so
 * "1500.00" from the column would reach the desk as "1500" beside a floor the
 * gate formats as "1600.00" — the same money in two spellings on one row.
 *
 * Through `toString()` rather than the Decimal itself: Prisma's Decimal
 * constructor refuses an instance of any other Decimal class with
 * "Invalid argument", and the repository port promises a value that prints as
 * money, not one particular class. A string is the one shape every Decimal
 * agrees on.
 */
const asMoney = (value: { toString(): string } | null | undefined): string | null =>
  value === null || value === undefined ? null : money(value.toString());

function summariseDocuments(documents: ReviewDocument[]): DocumentSummary {
  return documents.reduce<DocumentSummary>(
    (summary, document) => ({
      total: summary.total + 1,
      pending: summary.pending + (document.status === 'PENDING' ? 1 : 0),
      verified: summary.verified + (document.status === 'VERIFIED' ? 1 : 0),
      rejected: summary.rejected + (document.status === 'REJECTED' ? 1 : 0),
    }),
    { total: 0, pending: 0, verified: 0, rejected: 0 }
  );
}

function toQueueRow(listing: ReviewQueueListing, gate: GateVerdict): ReviewQueueRow {
  return {
    id: listing.id,
    displayId: listing.displayId,
    title: listing.title,
    category: listing.category,
    subType: listing.subType,
    status: listing.status,
    city: listing.city,
    address: listing.address,
    placement: listing.placement,
    widthFt: asString(listing.widthFt),
    heightFt: asString(listing.heightFt),
    areaSqFt: asString(listing.areaSqFt),
    publisher: listing.publisher
      ? {
          id: listing.publisher.id,
          name: listing.publisher.name,
          displayId: listing.publisher.displayId,
          city: listing.publisher.city,
        }
      : null,
    agent: listing.agent
      ? { id: listing.agent.id, displayId: listing.agent.displayId, name: listing.agent.user.name }
      : null,
    photoCount: listing.photos.length,
    documentSummary: summariseDocuments(listing.documents),
    asking: {
      ratePerDay: asMoney(listing.ratePerDay),
      basePrice: asMoney(listing.basePrice),
      pricingUnit: listing.pricingUnit,
    },
    rateGrade: listing.rateGrade,
    gate,
    submittedAt: listing.submittedAt,
    createdAt: listing.createdAt,
    priorReason: listing.rejectionReason,
  };
}

/**
 * Everything waiting on ADX's desk, oldest wait first.
 *
 * The gate is asked per row rather than once, because the verdict depends on
 * the card in force for that listing's media type, grade and city — there is
 * no single answer for the queue. It is a handful of indexed reads per row on
 * a list that is tens long, and it is what makes "asking price against the
 * floor" a column instead of a click.
 */
/**
 * The review desk's queue, one page at a time.
 *
 * Paging matters more here than on most lists: every row costs a rate-card
 * gate check, so an unbounded queue was N external calls per render.
 * `counts` is empty on purpose — the queue is one status by definition, so
 * there is no chip row for a histogram to label.
 */
export async function getReviewQueue(query: ReviewQueueQuery): Promise<ListPage<ReviewQueueRow>> {
  const { items, total } = await repository.findPendingReview(query);
  const gates = await Promise.all(items.map((listing) => checkGate(listing.id)));
  return toListPage(
    items.map((listing, index) => toQueueRow(listing, gates[index]!)),
    total,
    {},
    query,
  );
}

/** One listing with everything the desk reads before deciding. */
export async function getReviewCase(listingId: string): Promise<ReviewCase> {
  const listing = await repository.findReviewCase(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  const gate = await checkGate(listingId);

  return {
    ...toQueueRow(listing, gate),
    description: listing.description,
    latitude: listing.latitude,
    longitude: listing.longitude,
    targetAudience: listing.targetAudience,
    uniqueSellingPoint: listing.uniqueSellingPoint,
    footfallNote: listing.footfallNote,
    estimatedDailyFootfall: listing.estimatedDailyFootfall,
    illumination: listing.illumination,
    facing: listing.facing,
    elevation: listing.elevation,
    visibility: listing.visibility,
    trafficGrade: listing.trafficGrade,
    minBookingDays: listing.minBookingDays,
    availableNow: listing.availableNow,
    availableFrom: listing.availableFrom,
    availableHoursFrom: listing.availableHoursFrom,
    availableHoursTo: listing.availableHoursTo,
    peakPeriodNote: listing.peakPeriodNote,
    rateCardUrl: listing.rateCardUrl,
    publisherMobile: listing.publisher?.mobile ?? null,
    vocabulary: {
      mediaType: listing.mediaType?.name ?? null,
      sizeClass: listing.sizeClass?.name ?? null,
      material: listing.material?.name ?? null,
      venueType: listing.venueType?.name ?? null,
    },
    contentRules: listing.contentRules,
    photos: listing.photos.map((photo) => ({
      id: photo.id,
      url: photo.url,
      type: photo.type,
      createdAt: photo.createdAt,
    })),
    documents: listing.documents,
  };
}

/**
 * The desk says no, with a reason the publisher reads.
 *
 * Only a listing that is actually waiting for review can be sent back — a
 * draft was never submitted, a live listing is past this desk, and answering
 * either with a rejection would write a reason onto a row nobody is waiting on.
 *
 * `CHANGES_REQUESTED` lands the listing back at DRAFT with the reason on it;
 * `submitListingForReview` takes it from there exactly as it took the first
 * submission, and `publishListing` clears the reason once the fix is accepted.
 * `REJECTED` is terminal, and the reason stays as the record of why.
 */
export async function sendBackListing(
  listingId: string,
  input: { reason: string; outcome: SendBackOutcome }
) {
  const listing = await repository.findById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  if (listing.status !== 'PENDING_REVIEW') {
    throw new ApiError(
      409,
      'CONFLICT',
      `This listing is ${listing.status.toLowerCase().replace(/_/g, ' ')} and is not waiting for review.`
    );
  }
  return repository.sendBack(listingId, {
    status: input.outcome === 'REJECTED' ? 'REJECTED' : 'DRAFT',
    reason: input.reason,
  });
}

/**
 * Publishing is a state transition, not a patch: only DRAFT and PENDING_REVIEW
 * can be published, and doing so stamps `publishedAt` and clears any reason a
 * previous send-back left on the row. That is why `status` is absent from the
 * update schema.
 */
export async function publishListing(listingId: string) {
  const listing = await repository.findById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  /*
   * The third state is Q31's: with `listings.autoPublishOnVerification` off,
   * an accepted site visit leaves the listing at AWAITING_SITE_VERIFICATION
   * and the desk publishes it by hand. Only one that has actually been
   * verified qualifies — this is the human look the switch asks for, not a
   * way to skip the site visit.
   */
  const awaitingHumanLook =
    listing.status === 'AWAITING_SITE_VERIFICATION' && listing.verifiedAt !== null;
  if (listing.status !== 'DRAFT' && listing.status !== 'PENDING_REVIEW' && !awaitingHumanLook) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Listing must be in DRAFT or PENDING_REVIEW state, or verified and awaiting publication, to publish',
    );
  }

  /*
   * The rate-card gate DR 10 draws.
   *
   * It passes when no approved card prices this kind of spot here, which is
   * every listing until ops build one — refusing to publish because ADX has not
   * yet decided what a spot is worth would punish the publisher for an ADX
   * omission. Where a card does cover it, a price below the card's floor needs
   * a person to sign it off first.
   */
  await assertPublishable(listingId);

  // Lot V: a SEEDING city gathers listings but publishes none; PAUSED and
  // WITHDRAWN publish nothing new. The gate reads the city's `publishing`
  // switch; a city outside the catalogue publishes as ever. Lot X-B: by the
  // key the row carries, the spelling only for a row that has none.
  await assertCityAllows(listing.city, 'publishing', listing.cityId);

  // QR-5 (the owner, 17 Sep 2026): a spot goes live once its publisher's
  // BASICS are in — name, email, address, date of birth. The identity check
  // no longer holds a spot back (QR-2 did that for a day): an unverified
  // publisher lists and goes live, marked unverified and ranked below the
  // verified when an advertiser browses. The desk sees the reason when the
  // basics are missing, not a silent skip.
  if (listing.publisherId) await assertPublisherBasics(listing.publisherId);

  return repository.publish(listingId);
}

/** QR-5: the gate a spot has to clear to go live — the publisher's basics. 409 `PROFILE_INCOMPLETE` names what is missing. */
export async function assertPublisherBasics(publisherId: string): Promise<void> {
  const publisher = await repository.findPublisherById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  const missing = profileBasicsMissing(publisher);
  if (missing.length === 0) return;
  throw new ApiError(409, 'PROFILE_INCOMPLETE', `This publisher's profile is missing ${missing.map((key) => PROFILE_BASIC_LABEL[key]).join(', ')}. A spot goes live once the basics are in; the identity check moves it up the list, it does not hold it back.`, { missing });
}

export async function getSimilarListings(listingId: string) {
  const listing = await repository.findById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  return repository.findSimilar(listing);
}

/** The publisher record behind a login, for a publisher listing their own spot. */
export async function findOwnPublisher(userId: string) {
  return repository.findPublisherByUserId(userId);
}

/**
 * An explicit `agentId` on create is ADMIN-only. Callers without one fall back
 * to their own agent profile, resolved by the controller.
 */
export async function assertAgentAssignable(agentId: string, isAdmin: boolean): Promise<string> {
  if (!isAdmin) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Only admins can create a listing on behalf of another agent',
    );
  }
  if (!(await repository.agentExists(agentId))) {
    throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  }
  return agentId;
}

/**
 * Reads and writes the `orders` module needs on a listing.
 *
 * Order progression flips `availableNow` — occupied when a slot is confirmed,
 * free again on cancellation or campaign end. Exposed here so orders never
 * writes to the Listing table itself.
 */
export async function getListingWithPublisher(listingId: string) {
  return repository.findWithPublisher(listingId);
}

/**
 * Lot G (Q116/136): on a loop the flag is derived, not a switch — it goes
 * off only when the screen is full today, because one confirmed slot of six
 * is not "occupied". A static wall flips as it always did.
 */
export async function setListingAvailability(listingId: string, availableNow: boolean) {
  if (!availableNow) {
    const listing = await repository.findById(listingId);
    if (listing && listing.slotsTotal > 1) {
      const held = await slotsHeldFor([listingId], todayWindow());
      if (slotsLeft(listing.slotsTotal, held.get(listingId)) > 0) return;
    }
  }
  await repository.setAvailability(listingId, availableNow);
}

/**
 * Lot A (Q21): retires every spot a closing publisher holds.
 *
 * INACTIVE rather than deleted — orders, accruals and ledger legs still point
 * at these rows, and "the listing is gone" is a different and untrue statement
 * from "the listing is off the market". Returns the ids, for the closure record.
 */
export async function retireListingsForPublisher(publisherId: string): Promise<string[]> {
  const retired = await repository.retireForPublisher(publisherId);
  return retired.map((listing) => listing.id);
}

/** Plain listing lookup, used by `order-milestones` to resolve a plan. */
/** K-B1: `{ id, label, displayId }` per listing id, one query — the QR desk names a SITE code's spot with it. */
export const findListingLabels = (ids: readonly string[]) => repository.findLabelsByIds([...new Set(ids)]);

export async function getListingById(listingId: string) {
  return repository.findById(listingId);
}

/* ------------------------------------------------------------------ */
/* E10-2: the Pricing tab's history                                     */
/* ------------------------------------------------------------------ */

export const REPRICE_LOG_ACTION = 'LISTING_REPRICED_BY_FACTOR';
export const REPRICE_LOG_LIMIT = 200;

export type RepriceLogEntry = {
  at: Date;
  /** The factor that moved the rate — its name, its id, and whether it was applied or removed. */
  factor: { id: string | null; name: string | null; applied: boolean | null; mode: string | null; surgeId: string | null };
  from: string | null;
  to: string | null;
  /** Who pressed it; `name` null when the account is gone. */
  by: { id: string | null; name: string | null };
};

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * `GET /listings/:id/reprice-log` — every `LISTING_REPRICED_BY_FACTOR` audit
 * row on the listing, newest first, shaped for the Pricing tab. The rows
 * are `pricing`'s writes; this is a read over the shared audit trail, not a
 * second record, so the history is exactly what the audit desk would show
 * filtered to the listing — with the diff and the metadata unpacked.
 */
export async function repriceLog(listingId: string): Promise<RepriceLogEntry[]> {
  const listing = await repository.findById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  const rows = await findActivityRows(
    { action: REPRICE_LOG_ACTION, targetType: 'Listing', targetId: listingId },
    { skip: 0, take: REPRICE_LOG_LIMIT, sort: 'newest' },
  );
  return rows.map((row) => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const diff = (row.diff ?? {}) as Record<string, { before?: unknown; after?: unknown } | undefined>;
    const rate = diff['ratePerDay'] ?? {};
    return {
      at: row.createdAt,
      factor: {
        id: str(meta['factorId']),
        name: str(meta['factorName']),
        applied: typeof meta['applied'] === 'boolean' ? meta['applied'] : null,
        mode: str(meta['mode']),
        surgeId: str(meta['surgeId']),
      },
      from: str(rate.before),
      to: str(rate.after),
      by: { id: row.userId ?? null, name: row.user?.name ?? null },
    };
  });
}

/* ------------------------------------------------------------------ */
/* Lot E: the suggested rate, and the price case's teeth               */
/* ------------------------------------------------------------------ */

/**
 * The offer ADX's applied factors make on this listing, beside what it
 * charges today.
 *
 * ADVISORY factors are the offer; BINDING ones already moved the price, and
 * the `mode` on each applied factor says which is which. `differs` is the
 * one bit the screen needs to decide whether to draw the Accept button.
 */
export async function suggestedRateOffer(listingId: string) {
  const listing = await repository.findById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  const offer = await suggestedRate(listingId);
  const current = listing.ratePerDay === null ? null : money(new Decimal(listing.ratePerDay.toString()));
  return {
    listingId,
    currentRatePerDay: current,
    offer,
    differs: current === null || !new Decimal(current).equals(new Decimal(offer.ratePerDay)),
  };
}

/**
 * The publisher takes the offer. Written through `updateListing` — the same
 * door a typed rate goes through, with the same surge stamp — and audited
 * as their decision, not ADX's.
 */
export async function acceptSuggestedRate(listingId: string, actorUserId: string) {
  const view = await suggestedRateOffer(listingId);
  if (!view.differs) {
    throw new ApiError(409, 'CONFLICT', 'This listing is already at the suggested rate.');
  }
  const updated = await updateListing(listingId, { ratePerDay: view.offer.ratePerDay });
  await logActivity(actorUserId, 'LISTING_SUGGESTED_RATE_ACCEPTED', {
    targetType: 'Listing',
    targetId: listingId,
    module: 'listings',
    diff: auditDiff({ ratePerDay: view.currentRatePerDay }, { ratePerDay: view.offer.ratePerDay }),
    metadata: { base: view.offer.base, applied: view.offer.applied },
  });
  return updated;
}

/**
 * Lot E (Q97): a live listing comes off the market.
 *
 * INACTIVE, like a closing publisher's spots — never deleted, because orders
 * and accruals still point at the row. Reached from `rate-cards` through
 * its enforcement port when a CARD_REVISION case is rejected after its
 * grace; that module has already checked no order is running. Audited here
 * with the reason, and the publisher is told.
 */
export async function unpublishListing(
  listingId: string,
  input: {
    reason: string;
    actorUserId: string;
    /**
     * Lot V: `CITY_WITHDRAWN` — the city wind-down took it down, not a price
     * case. The audit row carries the cause, and the in-app "raise the rate"
     * line is not sent: `geo` tells the publisher once per city instead.
     */
    cause?: 'PRICE_CASE' | 'CITY_WITHDRAWN';
  }
) {
  const listing = await repository.findById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  if (listing.status !== 'ACTIVE') {
    throw new ApiError(
      409,
      'CONFLICT',
      `This listing is ${listing.status.toLowerCase().replace(/_/g, ' ')}, not live, so there is nothing to take off the market.`
    );
  }

  const updated = await repository.update(listingId, { status: 'INACTIVE', availableNow: false });
  await logActivity(input.actorUserId, 'LISTING_UNPUBLISHED', {
    targetType: 'Listing',
    targetId: listingId,
    module: 'listings',
    diff: auditDiff({ status: listing.status }, { status: 'INACTIVE' }),
    metadata: { reason: input.reason, cause: input.cause ?? 'PRICE_CASE' },
  });

  const owner = await repository.findWithPublisher(listingId);
  if (owner?.publisher?.userId && input.cause !== 'CITY_WITHDRAWN') {
    void createNotification({
      userId: owner.publisher.userId,
      type: 'SYSTEM',
      title: 'Your listing was taken off the market',
      subtitle: listing.title,
      message: `"${listing.title}" is no longer live. ${input.reason} Raise the rate and submit it again to relist it.`,
      relatedId: listingId,
      relatedType: 'LISTING',
    }).catch(() => {});
  }

  return updated;
}

/**
 * Lot D (Q104): `reviews` recomputed a spot's stars — the published reviews'
 * average and count — and hands the aggregate here. The one write another
 * module makes to `Listing`, through this door so the columns stay this
 * module's; a decimal string, like every figure that crosses a boundary.
 */
export async function setListingRatingSnapshot(
  listingId: string,
  snapshot: { ratingAvg: string | null; reviewCount: number },
): Promise<void> {
  await repository.setRatingSnapshot(listingId, snapshot);
}

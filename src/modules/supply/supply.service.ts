import { ApiError } from '../../shared/errors';
import { Decimal, money } from '../../shared/money';
import {
  buildCityKeyResolver,
  buildCityResolver,
  checkSpotVocabulary,
  classifySpot,
  citySupport,
  listCities,
  strongestSurgeFor,
  surgeWindowsAt,
} from '../pricing';
import type {
  ComplianceCaseStatus,
  ContactAttemptChannel,
  Listing,
  ListingAttemptOrigin,
  ListingAttemptStatus,
  ListingClaimStatus,
  ListingDocumentKind,
  VerificationType,
  RightsBasis,
  ListingDocument,
} from '../../shared/database';
import type { PageQuery } from '../../shared/pagination';
import { getPlatformSettings } from '../app-config';
import { createNotification } from '../notifications';
import { listAdminUserIds } from '../users';
import { assertPublisherLicenceSigned, isCurrentAcceptance, requestPublisherLicence } from '../agreements';
import { prismaSupplyRepository as repository } from './prisma-supply.repository';
import type { AttemptListingInput, ResolvedAttemptListing } from './supply.repository';

/* ------------------------------------------------------------------ */
/* Policy constants                                                    */
/* ------------------------------------------------------------------ */

/** Re-verification cadence in days, by how easily the spot can be removed. */
export const CADENCE_DAYS = { PERMANENT: 180, REMOVABLE: 90 } as const;

/** How long before expiry a listing enters its risk window and reminders start. */
export const RISK_WINDOW_DAYS = { PERMANENT: 15, REMOVABLE: 7 } as const;

/** Accepted GPS drift for a self re-verification, metres. Widened with a QR scan. */
export const GPS_TOLERANCE_M = 15;
export const GPS_TOLERANCE_WITH_QR_M = 40;

/** A lapsed listing's hold converts to a penalty after this long. */
export const HOLD_CONVERTS_AFTER_HOURS = 24;

/** Compliance opens three days into a lapse and runs for 48 hours. */
export const COMPLIANCE_OPENS_AFTER_DAYS = 3;
export const COMPLIANCE_WINDOW_HOURS = 48;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const addDays = (from: Date, days: number) => new Date(from.getTime() + days * DAY_MS);
const addHours = (from: Date, hours: number) => new Date(from.getTime() + hours * HOUR_MS);

/**
 * Great-circle distance in metres. Used to match a verification photo against
 * the listing's stored coordinates.
 */
export function distanceMetres(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Where a listing sits against its verification clock, for display and ranking. */
export type VerificationState = 'UNVERIFIED' | 'FRESH' | 'RISKY' | 'LAPSED';

export function verificationState(listing: Listing, now = new Date()): VerificationState {
  if (!listing.verificationExpiresAt) return 'UNVERIFIED';
  if (listing.verificationExpiresAt.getTime() <= now.getTime()) return 'LAPSED';
  const windowDays = RISK_WINDOW_DAYS[listing.removability];
  return listing.verificationExpiresAt.getTime() - now.getTime() <= windowDays * DAY_MS
    ? 'RISKY'
    : 'FRESH';
}

/* ------------------------------------------------------------------ */
/* Funnel                                                              */
/* ------------------------------------------------------------------ */

export function getFunnel() {
  return repository.funnel();
}

export function getPublisherFunnelRows(limit = 50, offset = 0) {
  return repository.publisherFunnelRows(Math.min(limit, 200), offset);
}

/*
 * Agreement templates are written by the `agreements` module alone (Lot D):
 * the legacy GET/POST /supply/agreements/templates pair, which published and
 * activated in one step without stamping `activatedAt`, is retired — the
 * console uses /agreements/templates.
 */

/* ------------------------------------------------------------------ */
/* Acceptance                                                          */
/* ------------------------------------------------------------------ */

/**
 * Renders the listing agreement for an attempt. The body enumerates every spot
 * in the batch and states that only those whose documents clear get published,
 * which is what lets a publisher accept with ten of two hundred submitted.
 */
export function renderListingAgreement(body: string, listings: Listing[]): string {
  const enumeration = listings
    .map((l, i) => `${i + 1}. ${l.title} — ${l.address}${l.city ? `, ${l.city}` : ''}`)
    .join('\n');
  return body.includes('{{listings}}')
    ? body.replace('{{listings}}', enumeration)
    : `${body}\n\n## Inventory covered by this agreement\n\n${enumeration}`;
}

export async function acceptPlatformAgreement(input: {
  publisherId: string;
  acceptedByUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const template = await repository.activeTemplate('PLATFORM');
  if (!template) {
    throw new ApiError(409, 'NO_ACTIVE_TEMPLATE', 'No platform agreement is published');
  }

  const existing = await repository.findAcceptance(input.publisherId, template.id);
  if (existing) return existing;

  const acceptance = await repository.createAcceptance({
    templateId: template.id,
    templateKind: 'PLATFORM',
    templateVersion: template.version,
    publisherId: input.publisherId,
    acceptedByUserId: input.acceptedByUserId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });

  // Gate 3 of the funnel. Activation is KYC plus this acceptance, so it is
  // stamped here rather than inferred on every read.
  await repository.markPublisherActivated(input.publisherId);
  return acceptance;
}

export async function acceptListingAgreement(input: {
  attemptId: string;
  acceptedByUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const attempt = await repository.findAttempt(input.attemptId);
  if (!attempt) throw new ApiError(404, 'NOT_FOUND', 'Attempt not found');
  if (!attempt.publisherId) {
    throw new ApiError(409, 'CONFLICT', 'This attempt has no publisher to accept for it');
  }
  if (attempt.status === 'ACCEPTED') {
    throw new ApiError(409, 'CONFLICT', 'This attempt has already been accepted');
  }
  if (attempt.listings.length === 0) {
    throw new ApiError(409, 'CONFLICT', 'Nothing to accept: the attempt has no listings');
  }
  // The agreement enumerates every spot it covers. If the repository capped the
  // set, signing it would put a partial inventory list into a legal document,
  // so refuse rather than truncate.
  if (attempt.listings.length < attempt._count.listings) {
    throw new ApiError(
      409,
      'CONFLICT',
      `This attempt holds ${attempt._count.listings} listings, more than one agreement can enumerate. Split it into smaller attempts.`,
    );
  }

  // Lot D (Q55): the platform click stands unless the live PLATFORM version
  // demands re-acceptance — then it has to be the live version. One rule,
  // `agreements.isCurrentAcceptance`, applied here rather than restated.
  const [platform, platformTemplate] = await Promise.all([
    repository.findPlatformAcceptance(attempt.publisherId),
    repository.activeTemplate('PLATFORM'),
  ]);
  if (!isCurrentAcceptance(platform, platformTemplate)) {
    throw new ApiError(
      409,
      'PLATFORM_AGREEMENT_REQUIRED',
      'The current platform agreement must be accepted before any listing agreement',
    );
  }

  const template = await repository.activeTemplate('LISTING');
  if (!template) {
    throw new ApiError(409, 'NO_ACTIVE_TEMPLATE', 'No listing agreement is published');
  }

  // DS-3: once the master licence has been asked for, the next attempt waits on its signature.
  await assertPublisherLicenceSigned(attempt.publisherId);

  const acceptance = await repository.createAcceptance({
    templateId: template.id,
    templateKind: 'LISTING',
    templateVersion: template.version,
    publisherId: attempt.publisherId,
    attemptId: attempt.id,
    acceptedByUserId: input.acceptedByUserId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    renderedDocument: renderListingAgreement(template.body, attempt.listings),
  });

  await repository.setAttemptStatus(attempt.id, 'ACCEPTED');
  // Acceptance is attempt-level; publication stays per-listing, so every
  // listing simply moves on to its own document gate.
  await repository.advanceAttemptListings(attempt.id);

  // DS-3: under the FIRST_SUBMISSION setting the master licence is asked for
  // here, at the publisher's first submission — idempotent, never blocking.
  await requestPublisherLicence(attempt.publisherId, 'FIRST_SUBMISSION', input.acceptedByUserId);

  return acceptance;
}

/* ------------------------------------------------------------------ */
/* Attempts                                                            */
/* ------------------------------------------------------------------ */

export async function createAttempt(input: {
  publisherId?: string | null;
  origin: ListingAttemptOrigin;
  createdByUserId?: string | null;
  sourceFilename?: string | null;
  note?: string | null;
}) {
  if (input.origin !== 'SCRAPE' && !input.publisherId) {
    throw new ApiError(400, 'BAD_REQUEST', 'Only SCRAPE attempts may be created unowned');
  }
  return repository.createAttempt(input);
}

export function listAttempts(
  filter: { status?: ListingAttemptStatus; publisherId?: string; origin?: ListingAttemptOrigin },
  page: PageQuery = {},
) {
  return repository.listAttempts(filter, page);
}

export async function getAttempt(attemptId: string) {
  const attempt = await repository.findAttempt(attemptId);
  if (!attempt) throw new ApiError(404, 'NOT_FOUND', 'Attempt not found');
  const progress = await repository.attemptProgress(attemptId);
  return { ...attempt, progress };
}

/**
 * A flat 30, matching the derivation the other way in the repository.
 *
 * The real month length would make a daily rate wobble by 3% depending on which
 * month the spreadsheet was uploaded in.
 */
const DAYS_PER_MONTH = 30;

/**
 * Classifies and prices a batch on its way in.
 *
 * Media types are resolved **once per distinct name**, not once per row. A
 * scraped batch of five hundred spots is usually a handful of real media types
 * described five hundred slightly different ways, and matching each row
 * separately would be five hundred round trips to answer a dozen questions.
 *
 * Surge windows are fetched **once for the batch** and applied to each row in
 * memory. A spreadsheet is uploaded at one instant, so the set of open windows
 * is the same for every row; only which of them covers a given spot differs,
 * and that is a pure geometric test.
 */
export async function addListingsToAttempt(attemptId: string, rows: AttemptListingInput[]) {
  const attempt = await repository.findAttempt(attemptId);
  if (!attempt) throw new ApiError(404, 'NOT_FOUND', 'Attempt not found');
  if (attempt.status === 'ACCEPTED') {
    throw new ApiError(
      409,
      'CONFLICT',
      'Listings cannot be added after the agreement has been accepted',
    );
  }

  // Keyed on the whole description, so two rows describing the same kind of
  // spot resolve once. A five-hundred-row scrape is usually a dozen distinct
  // descriptions repeated.
  const describe = (row: AttemptListingInput): string =>
    [
      row.category,
      row.mediaTypeId ?? row.mediaTypeName?.trim().toLowerCase() ?? '',
      row.sizeClassId ?? row.sizeClassSlug ?? '',
      row.materialId ?? row.materialSlug ?? '',
    ].join('|');

  // Every row is checked before any of them is classified, because classifying
  // writes: it can create a media type, a match log and a vocabulary proposal.
  // Aborting halfway used to leave those behind for a batch that was rejected,
  // and the corrected re-upload would then match against them.
  const problems = await checkSpotVocabulary(
    rows.map((row) => ({
      category: row.category,
      mediaTypeId: row.mediaTypeId,
      mediaTypeName: row.mediaTypeName,
      sizeClassId: row.sizeClassId,
      sizeClassSlug: row.sizeClassSlug,
      materialId: row.materialId,
      materialSlug: row.materialSlug,
    }))
  );
  const priceProblems = rows.flatMap((row, index) => {
    const rate =
      row.ratePerDay !== undefined
        ? new Decimal(row.ratePerDay)
        : new Decimal(row.monthlyPrice ?? 0).dividedBy(DAYS_PER_MONTH);
    return new Decimal(money(rate)).greaterThan(0)
      ? []
      : [{ row: index + 1, reason: 'A listing price must be greater than zero' }];
  });

  const allProblems = [...problems, ...priceProblems].sort((a, b) => a.row - b.row);
  if (allProblems.length > 0) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `${allProblems.length} row${allProblems.length === 1 ? '' : 's'} could not be imported`,
      { problems: allProblems },
    );
  }

  const classified = new Map<string, Awaited<ReturnType<typeof classifySpot>>>();
  for (const row of rows) {
    const key = describe(row);
    if (classified.has(key)) continue;
    classified.set(
      key,
      await classifySpot({
        category: row.category,
        mediaTypeId: row.mediaTypeId,
        mediaTypeName: row.mediaTypeName,
        sizeClassId: row.sizeClassId,
        sizeClassSlug: row.sizeClassSlug,
        materialId: row.materialId,
        materialSlug: row.materialSlug,
      })
    );
  }

  // Both fetched once for the batch: the calendar is the same for every row,
  // and the city table is small enough that resolving per row would be five
  // hundred round trips to answer a handful of distinct questions.
  // Lot X-B: the same table resolves the key every row carries beside its typed city.
  const [windows, cities] = await Promise.all([surgeWindowsAt(), listCities()]);
  const resolveCityName = buildCityResolver(cities);
  const resolveCityKey = buildCityKeyResolver(cities);

  const resolved: ResolvedAttemptListing[] = rows.map((input, index) => {
    // Every name-or-slug field is stripped here rather than spread onward: they
    // have been resolved into ids above, and TypeScript does not flag excess
    // properties through a spread, so leaving one in would reach `createMany`
    // as an unknown column and fail the whole batch at runtime.
    const { mediaTypeName, sizeClassSlug, materialSlug, ...row } = input;
    const rate =
      row.ratePerDay !== undefined
        ? new Decimal(row.ratePerDay)
        : new Decimal(row.monthlyPrice ?? 0).dividedBy(DAYS_PER_MONTH);

    const rounded = money(rate);

    const surge =
      row.latitude != null && row.longitude != null
        ? strongestSurgeFor(windows, {
            latitude: row.latitude,
            longitude: row.longitude,
            citySlug: resolveCityName(row.city),
          })
        : null;

    const spot = classified.get(describe(input))!;

    return {
      ...row,
      ratePerDay: rounded,
      mediaTypeId: spot.mediaTypeId,
      sizeClassId: spot.sizeClassId,
      materialId: spot.materialId,
      ratePerDaySurgeUntil: surge?.coverUntil ?? null,
      cityId: resolveCityKey(row.city)?.cityId ?? null,
    };
  });

  const count = await repository.addListingsToAttempt(attemptId, resolved);
  return { added: count };
}

/**
 * Lot U: a listing that already exists joins an attempt.
 *
 * The listing importer creates each spot through `listings.createListing`
 * — photos, content rules, the loop, the instant-booking gate, the
 * media-type resolution, everything a console Create does — and then files
 * it under the batch's one agreement here, so the publisher accepts once.
 * Nothing is created: the row is the listing's, and this only moves it
 * under the attempt at AWAITING_AGREEMENT, the same way an approved claim
 * moves a scraped listing under its claimant's attempt.
 *
 * Three refusals, all 409: the attempt is already accepted (the agreement
 * enumerates its spots, and one signed cannot grow); the listing belongs to
 * another publisher (an agreement covers its signer's spots); the listing
 * already sits under an attempt (one agreement per spot).
 */
export async function attachListingToAttempt(attemptId: string, listingId: string) {
  const attempt = await repository.findAttempt(attemptId);
  if (!attempt) throw new ApiError(404, 'NOT_FOUND', 'Attempt not found');
  if (attempt.status === 'ACCEPTED') {
    throw new ApiError(409, 'CONFLICT', 'Listings cannot be added after the agreement has been accepted');
  }
  if (!attempt.publisherId) {
    throw new ApiError(409, 'CONFLICT', 'An unowned attempt takes no existing listing');
  }
  const listing = await repository.findListing(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  if (listing.publisherId !== attempt.publisherId) {
    throw new ApiError(409, 'CONFLICT', 'This listing belongs to another publisher');
  }
  if (listing.attemptId && listing.attemptId !== attemptId) {
    throw new ApiError(409, 'CONFLICT', 'This listing is already under another attempt');
  }
  return repository.assignListingOwner(listingId, attempt.publisherId, attemptId);
}

/** Closes the batch and puts it in front of the publisher to accept. */
export async function requestAttemptAcceptance(attemptId: string) {
  const attempt = await repository.findAttempt(attemptId);
  if (!attempt) throw new ApiError(404, 'NOT_FOUND', 'Attempt not found');
  if (attempt.listings.length === 0) {
    throw new ApiError(409, 'CONFLICT', 'Add at least one listing first');
  }
  return repository.setAttemptStatus(attemptId, 'AWAITING_ACCEPTANCE');
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export async function submitDocument(input: {
  listingId: string;
  kind: ListingDocumentKind;
  url: string;
  /** QR-24: the day the permit or agreement runs out, YYYY-MM-DD. */
  expiresAt?: string | null;
}) {
  const listing = await repository.findListing(input.listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  const { expiresAt, ...rest } = input;
  return repository.addDocument({ ...rest, expiresAt: expiresAt ? endOfDay(expiresAt) : null });
}

export function getDocuments(listingId: string) {
  return repository.listDocuments(listingId);
}

/**
 * Desk verification. Clearing the last outstanding document moves the listing
 * on to its site visit — documents are checked before an agent travels, so a
 * failed paper check never wastes a visit.
 */
export async function reviewDocument(input: {
  documentId: string;
  approve: boolean;
  rejectionReason?: string | null;
  reviewedByUserId: string;
}) {
  const document = await repository.findDocument(input.documentId);
  if (!document) throw new ApiError(404, 'NOT_FOUND', 'Document not found');
  if (!input.approve && !input.rejectionReason) {
    throw new ApiError(400, 'BAD_REQUEST', 'A rejection needs a reason the publisher can act on');
  }

  const reviewed = await repository.reviewDocument(input.documentId, {
    status: input.approve ? 'VERIFIED' : 'REJECTED',
    rejectionReason: input.rejectionReason ?? null,
    reviewedByUserId: input.reviewedByUserId,
  });

  const cleared = await repository.documentsCleared(document.listingId);
  await repository.markDocumentsCleared(document.listingId, cleared ? new Date() : null);

  const listing = await repository.findListing(document.listingId);
  if (listing && cleared && listing.status === 'AWAITING_DOCUMENTS') {
    await repository.setListingStatus(listing.id, 'AWAITING_SITE_VERIFICATION');
  }
  if (listing && !cleared && listing.status === 'AWAITING_SITE_VERIFICATION') {
    await repository.setListingStatus(listing.id, 'AWAITING_DOCUMENTS');
  }
  // QR-24: an approved permit or agreement with a later end date renews the term.
  if (listing && input.approve) await renewRightsFromDocument(listing, reviewed);

  return reviewed;
}

/* ------------------------------------------------------------------ */
/* Rights — QR-24                                                      */
/* ------------------------------------------------------------------ */

/**
 * QR-24 (the owner, 17 Sep 2026): a hoarding, a digital billboard, a shelter
 * — many spots are held on a lease, a licence or a permit a civic body
 * renews every year, and a publisher who stopped holding it must stop
 * selling it. The listing says how it is held and until when; the sweep
 * reminds the publisher thirty and seven days out and marks the spot lapsed
 * on the day — no new booking until a renewed document is reviewed and
 * approved at the desk, which extends the term. Running campaigns are not
 * touched: the advertiser booked in good faith, and the lapse is the
 * publisher's to fix.
 */
export const RIGHTS_REMINDER_DAYS = [30, 7] as const;
/** The documents that evidence a right to the space; an approved one with a later end date renews the term. */
export const RIGHTS_DOCUMENT_KINDS: ListingDocumentKind[] = ['DISPLAY_AGREEMENT', 'MUNICIPAL_PERMIT', 'OWNER_NOC'];

/** The last instant of a calendar day in India, so a permit "valid until 31 March" is good all of the 31st there — and prints as the 31st, not the 1st. */
function endOfDay(day: string): Date {
  return new Date(`${day}T23:59:59.999+05:30`);
}

export type RightsState = 'OWNED' | 'CURRENT' | 'ENDING' | 'LAPSED';

/** OWNED needs no term; ENDING is inside the first reminder window; LAPSED is past the day, whether or not the sweep has stamped it. */
export function rightsState(
  listing: { rightsBasis: RightsBasis; rightsValidUntil: Date | null; rightsLapsedAt: Date | null },
  now = new Date(),
): RightsState {
  if (listing.rightsBasis === 'OWNED') return 'OWNED';
  if (listing.rightsLapsedAt) return 'LAPSED';
  if (!listing.rightsValidUntil) return 'CURRENT';
  if (listing.rightsValidUntil.getTime() <= now.getTime()) return 'LAPSED';
  return listing.rightsValidUntil.getTime() - now.getTime() <= RIGHTS_REMINDER_DAYS[0] * DAY_MS ? 'ENDING' : 'CURRENT';
}

/**
 * The publisher (their own spot), an agent or ADX sets how the space is
 * held. A term already past lapses the spot at once; OWNED clears the term
 * and any lapse — the publisher is saying nobody's permit stands over it.
 */
export async function setRights(
  listingId: string,
  input: { basis: RightsBasis; validUntil?: string | null },
  actor: { userId: string; roles: string[] },
  now = new Date(),
) {
  const listing = await repository.findListing(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  const privileged = actor.roles.includes('ADMIN') || actor.roles.includes('AGENT_PUBLISHER');
  if (!privileged) {
    const own = await repository.publisherIdOfUser(actor.userId);
    if (!own || own !== listing.publisherId) throw new ApiError(403, 'FORBIDDEN', 'You can only say how you hold your own spot.');
  }
  if (input.basis === 'OWNED') {
    return repository.setRights(listingId, { rightsBasis: 'OWNED', rightsValidUntil: null, rightsLapsedAt: null, rightsRemindedAt: null });
  }
  if (!input.validUntil) throw new ApiError(400, 'VALIDATION_ERROR', 'A lease, licence or permit needs the day it runs out.');
  const validUntil = endOfDay(input.validUntil);
  const lapsed = validUntil.getTime() <= now.getTime();
  return repository.setRights(listingId, {
    rightsBasis: input.basis,
    rightsValidUntil: validUntil,
    rightsLapsedAt: lapsed ? now : null,
    rightsRemindedAt: null,
    ...(lapsed ? { availableNow: false } : {}),
  });
}

/** The desk's queue: every term ending within `horizonDays`, and every lapse, soonest first. */
export async function getRightsQueue(now = new Date(), horizonDays = 60) {
  const rows = await repository.rightsDue(addDays(now, horizonDays));
  return rows.map((row) => ({
    ...row,
    state: rightsState(row, now),
    daysLeft: row.rightsValidUntil ? Math.ceil((row.rightsValidUntil.getTime() - now.getTime()) / DAY_MS) : null,
  }));
}

async function tellPublisher(listing: { id: string; title: string; publisherId: string | null }, note: { title: string; message: string; suggestedAction: string }) {
  if (!listing.publisherId) return;
  const userId = await repository.publisherUserId(listing.publisherId);
  if (!userId) return;
  try {
    await createNotification({ userId, type: 'SYSTEM', subtitle: listing.title, relatedId: listing.id, relatedType: 'LISTING', ...note });
  } catch {
    // Best effort: the sweep's stamp is the record; a notification that failed to send is not a reason to stop it.
  }
}

async function tellAdmins(listing: { id: string; title: string }, note: { title: string; message: string }) {
  try {
    const admins = await listAdminUserIds();
    await Promise.all(admins.map((userId) => createNotification({ userId, type: 'SYSTEM', subtitle: listing.title, relatedId: listing.id, relatedType: 'LISTING', suggestedAction: 'Open the renewals queue', ...note })));
  } catch {
    // As above.
  }
}

const dayLabel = (date: Date) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(date);

/**
 * The tick. A reminder goes once per window — thirty days out, then seven —
 * which `rightsRemindedAt` records; a term past its day lapses the spot,
 * takes it off the shelf, and tells the publisher and ADX once.
 */
export async function runRightsSweep(now = new Date()) {
  const rows = await repository.rightsDue(addDays(now, RIGHTS_REMINDER_DAYS[0]));
  let lapsed = 0;
  let reminded = 0;
  for (const row of rows) {
    if (!row.rightsValidUntil) continue;
    const until = row.rightsValidUntil;
    if (until.getTime() <= now.getTime()) {
      if (row.rightsLapsedAt) continue;
      await repository.setRights(row.id, { rightsLapsedAt: now, availableNow: false });
      lapsed += 1;
      await tellPublisher(row, {
        title: 'Your right to this spot has run out',
        message: `The ${basisWord(row.rightsBasis)} on ${row.title} ended on ${dayLabel(until)}. It takes no new booking until you upload the renewed document and ADX approves it.`,
        suggestedAction: 'Upload the renewed permit or agreement',
      });
      await tellAdmins(row, { title: 'A spot\'s right to the space has lapsed', message: `${row.publisherName ?? 'The publisher'} held ${row.title} on a ${basisWord(row.rightsBasis)} that ended on ${dayLabel(until)}. It is off the shelf until a renewal is approved.` });
      continue;
    }
    const daysLeft = Math.ceil((until.getTime() - now.getTime()) / DAY_MS);
    // The tightest window the day falls in: seven days out is the seven-day reminder, not a late thirty-day one.
    const window = RIGHTS_REMINDER_DAYS.filter((days) => daysLeft <= days).pop();
    if (window === undefined) continue;
    // Sent once per window: a reminder stamped before this window opened does not count for it.
    const windowOpened = until.getTime() - window * DAY_MS;
    if (row.rightsRemindedAt && row.rightsRemindedAt.getTime() >= windowOpened) continue;
    await repository.setRights(row.id, { rightsRemindedAt: now });
    reminded += 1;
    await tellPublisher(row, {
      title: `Your ${basisWord(row.rightsBasis)} on ${row.title} ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      message: `It runs out on ${dayLabel(until)}. Upload the renewed document before then and the spot stays on the shelf; after that day it takes no new booking until ADX approves the renewal.`,
      suggestedAction: 'Upload the renewed permit or agreement',
    });
  }
  return { considered: rows.length, lapsed, reminded };
}

function basisWord(basis: RightsBasis): string {
  return basis === 'LEASED' ? 'lease' : basis === 'LICENSED' ? 'licence' : basis === 'PERMIT' ? 'permit' : 'right';
}

/** An approved permit or agreement whose end date is later than the term on file extends it and lifts a lapse. */
async function renewRightsFromDocument(listing: Listing, document: ListingDocument, now = new Date()) {
  if (!document.expiresAt || !RIGHTS_DOCUMENT_KINDS.includes(document.kind)) return;
  if (listing.rightsBasis === 'OWNED') return;
  if (listing.rightsValidUntil && document.expiresAt.getTime() <= listing.rightsValidUntil.getTime()) return;
  const lapsed = document.expiresAt.getTime() <= now.getTime();
  await repository.setRights(listing.id, {
    rightsValidUntil: document.expiresAt,
    rightsLapsedAt: lapsed ? (listing.rightsLapsedAt ?? now) : null,
    rightsRemindedAt: null,
    ...(lapsed ? {} : { availableNow: true }),
  });
  if (!lapsed) {
    await tellPublisher(listing, {
      title: 'Renewal approved',
      message: `${listing.title} is good until ${dayLabel(document.expiresAt)} and back on the shelf.`,
      suggestedAction: 'Open the listing',
    });
  }
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

/**
 * A capture from the field or from the publisher's own GPS camera. The photo is
 * matched against the listing's stored coordinates; a QR scan at the site
 * widens the accepted radius because the two together are much harder to fake.
 *
 * A visit may carry one photo or a whole named sequence — the decal straight
 * on, the decal from an angle, the fixture, the wider zone. They arrive
 * together and become **one** verification, because they are one visit: four
 * separate submissions would give a reviewer four things to accept and no way
 * to tell they were the same trip.
 */
export async function submitVerification(input: {
  listingId: string;
  type: VerificationType;
  /** The single-shot shape. Kept: a publisher's re-verification still sends it. */
  photoUrl?: string;
  /** The guided shape: every named proof from one visit. */
  photos?: { url: string; label?: string | null }[];
  latitude: number;
  longitude: number;
  qrScanned?: boolean;
  capturedAt: Date;
  submittedByUserId?: string | null;
  orderId?: string | null;
}) {
  const listing = await repository.findListing(input.listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');

  // Whichever shape came in, normalise to a list. The first shot is mirrored
  // onto `photoUrl` so the admin queue, the review screen and every existing
  // reader of a verification's single photo keep working untouched.
  const shots = input.photos?.length
    ? input.photos
    : input.photoUrl
      ? [{ url: input.photoUrl, label: null }]
      : [];
  if (shots.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A verification needs at least one photo');
  }

  let distance: number | null = null;
  if (listing.latitude !== null && listing.longitude !== null) {
    distance = distanceMetres(
      { latitude: listing.latitude, longitude: listing.longitude },
      { latitude: input.latitude, longitude: input.longitude },
    );
  }

  const verification = await repository.createVerification({
    listingId: input.listingId,
    type: input.type,
    latitude: input.latitude,
    longitude: input.longitude,
    capturedAt: input.capturedAt,
    submittedByUserId: input.submittedByUserId ?? null,
    orderId: input.orderId ?? null,
    photoUrl: shots[0]!.url,
    photos: shots.map((shot, index) => ({
      url: shot.url,
      label: shot.label ?? null,
      order: index,
    })),
    qrScanned: input.qrScanned ?? false,
    distanceMeters: distance,
  });

  const tolerance = input.qrScanned ? GPS_TOLERANCE_WITH_QR_M : GPS_TOLERANCE_M;
  const withinTolerance = distance === null || distance <= tolerance;

  return { verification, distanceMeters: distance, withinTolerance, tolerance };
}

/**
 * Told to the desk when auto-publish is off: the site visit cleared and the
 * spot is one click from live. A failure to notify must not undo an accepted
 * verification, so it is caught — the listing is correct either way, and the
 * publish queue is the record that matters.
 */
async function notifyAdminsOfHeldListing(listing: { id: string; title: string }): Promise<void> {
  try {
    const adminIds = await listAdminUserIds();
    await Promise.all(
      adminIds.map((userId) =>
        createNotification({
          userId,
          type: 'SYSTEM',
          title: 'Verified — waiting for a human look',
          subtitle: listing.title,
          message: `${listing.title} passed its site verification. Auto-publish is off, so it stays unpublished until someone publishes it.`,
          suggestedAction: 'Review and publish the listing',
          relatedId: listing.id,
          relatedType: 'LISTING',
        }),
      ),
    );
  } catch {
    // Deliberately swallowed: see above.
  }
}

/** Lot V: whether the listing's city publishes right now — a city the catalogue lacks always does. */
async function cityPublishes(city: string | null): Promise<boolean> {
  const view = await citySupport(city);
  return !view.resolved || view.switches.publishing;
}

/**
 * Accepting a verification restarts the clock for the listing's full cadence
 * and releases any hold the lapse had opened.
 */
export async function reviewVerification(input: {
  verificationId: string;
  approve: boolean;
  rejectionReason?: string | null;
  reviewedByUserId: string;
}) {
  const verification = await repository.findVerification(input.verificationId);
  if (!verification) throw new ApiError(404, 'NOT_FOUND', 'Verification not found');
  if (!input.approve && !input.rejectionReason) {
    throw new ApiError(400, 'BAD_REQUEST', 'A rejection needs a reason so it can be retried');
  }

  const reviewed = await repository.reviewVerification(input.verificationId, {
    status: input.approve ? 'ACCEPTED' : 'REJECTED',
    rejectionReason: input.rejectionReason ?? null,
    reviewedByUserId: input.reviewedByUserId,
  });
  if (!input.approve) return reviewed;

  const listing = await repository.findListing(verification.listingId);
  if (!listing) return reviewed;

  const now = new Date();
  await repository.markListingVerified(listing.id, {
    verifiedAt: now,
    verificationExpiresAt: addDays(now, CADENCE_DAYS[listing.removability]),
  });
  await repository.releaseHolds(listing.id);

  const openCase = await repository.findOpenCaseForListing(listing.id);
  if (openCase) await repository.setCaseStatus(openCase.id, 'RESOLVED');

  // First verification publishes the listing; a re-verification lifts a
  // suspension. Neither touches a listing still waiting on its documents.
  //
  // Q31 puts the first half behind a switch: with
  // `listings.autoPublishOnVerification` off, a cleared site visit leaves the
  // listing exactly where it was — AWAITING_SITE_VERIFICATION, the status it
  // is already in, not a new one — and the desk is told there is something to
  // look at. A market that wants a human eye on every spot before it goes
  // live gets that without a deploy, and a re-verification still lifts a
  // suspension either way: that listing was already published once.
  //
  // Lot V: the city's `publishing` switch sits over both halves. A SEEDING
  // city gathers and verifies listings but publishes none, so a cleared
  // visit there holds the listing exactly as auto-publish-off does — the
  // verification is accepted, the desk is told, nothing goes live. The
  // publish desk's own gate refuses until the city launches.
  if (listing.status === 'AWAITING_SITE_VERIFICATION') {
    const { autoPublishOnVerification } = (await getPlatformSettings()).listings;
    if (autoPublishOnVerification && (await cityPublishes(listing.city))) {
      await repository.setListingStatus(listing.id, 'ACTIVE');
    } else {
      await notifyAdminsOfHeldListing(listing);
    }
  } else if (listing.status === 'SUSPENDED') {
    if (await cityPublishes(listing.city)) await repository.setListingStatus(listing.id, 'ACTIVE');
    else await notifyAdminsOfHeldListing(listing);
  }

  return reviewed;
}

export function getVerifications(listingId: string) {
  return repository.listVerifications(listingId);
}

/** Listings whose verification has lapsed or is inside the risk window. */
export async function getVerificationQueue(now = new Date()) {
  const horizon = addDays(now, Math.max(...Object.values(RISK_WINDOW_DAYS)));
  const rows = await repository.verificationsDue(horizon);
  return rows.map((row) => ({
    ...row,
    state: row.verificationExpiresAt
      ? row.verificationExpiresAt.getTime() <= now.getTime()
        ? 'LAPSED'
        : row.verificationExpiresAt.getTime() - now.getTime() <=
            RISK_WINDOW_DAYS[row.removability] * DAY_MS
          ? 'RISKY'
          : 'FRESH'
      : 'UNVERIFIED',
  }));
}

/* ------------------------------------------------------------------ */
/* Enforcement                                                         */
/* ------------------------------------------------------------------ */

/**
 * Walks lapsed listings one step down the ladder. Intended to run on a
 * schedule; safe to run repeatedly because every step checks its own guard.
 *
 * Earnings holds record the obligation only — moving money needs the ledger the
 * money workstream will build.
 */
export async function runEnforcementSweep(now = new Date()) {
  const lapsed = (await repository.verificationsDue(now)).filter(
    (row) => row.status === 'ACTIVE' && row.verificationExpiresAt !== null && row.publisherId,
  );

  // One query for every listing that already has an open case, instead of one
  // per row. At ten thousand lapsed listings the per-row version was thirty
  // thousand serialised round trips to a database in another region.
  const withOpenCase = new Set(
    await repository.listingIdsWithOpenCase(lapsed.map((row) => row.listingId)),
  );

  const holds = lapsed.map((row) => ({
    listingId: row.listingId,
    publisherId: row.publisherId as string,
    convertsAt: addHours(row.verificationExpiresAt as Date, HOLD_CONVERTS_AFTER_HOURS),
  }));

  const cases = lapsed
    .filter((row) => {
      if (withOpenCase.has(row.listingId)) return false;
      const lapsedDays = (now.getTime() - (row.verificationExpiresAt as Date).getTime()) / DAY_MS;
      return lapsedDays >= COMPLIANCE_OPENS_AFTER_DAYS;
    })
    .map((row) => ({
      listingId: row.listingId,
      publisherId: row.publisherId,
      dueAt: addHours(now, COMPLIANCE_WINDOW_HOURS),
    }));

  const holdsOpened = holds.length ? await repository.openHolds(holds) : 0;
  const casesOpened = cases.length ? await repository.openComplianceCases(cases) : 0;

  const overdue = await repository.casesPastDue(now);
  const suspended = overdue.length
    ? await repository.suspendForCases(overdue.map((item) => ({ id: item.id, listingId: item.listingId })))
    : 0;

  return { lapsed: lapsed.length, holdsOpened, casesOpened, suspended };
}

/* ------------------------------------------------------------------ */
/* Compliance cases                                                    */
/* ------------------------------------------------------------------ */

export function listComplianceCases(status?: ComplianceCaseStatus, page: PageQuery = {}) {
  return repository.listCases(status, page);
}

export async function logContactAttempt(input: {
  caseId: string;
  channel: ContactAttemptChannel;
  outcome: string;
  note?: string | null;
  attemptedByUserId?: string | null;
}) {
  const found = await repository.findCase(input.caseId);
  if (!found) throw new ApiError(404, 'NOT_FOUND', 'Compliance case not found');
  const attempt = await repository.addContactAttempt(input);
  if (found.status === 'OPEN') await repository.setCaseStatus(found.id, 'CONTACTED');
  return attempt;
}

export async function resolveComplianceCase(caseId: string) {
  const found = await repository.findCase(caseId);
  if (!found) throw new ApiError(404, 'NOT_FOUND', 'Compliance case not found');
  return repository.setCaseStatus(caseId, 'RESOLVED');
}

/* ------------------------------------------------------------------ */
/* Claims                                                              */
/* ------------------------------------------------------------------ */

export async function claimListing(input: {
  listingId: string;
  claimantPublisherId: string;
  evidenceNote?: string | null;
}) {
  const listing = await repository.findListing(input.listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  if (listing.status !== 'UNCLAIMED') {
    throw new ApiError(409, 'CONFLICT', 'This listing already has an owner');
  }
  return repository.createClaim(input);
}

export function listClaims(status?: ListingClaimStatus, page: PageQuery = {}) {
  return repository.listClaims(status, page);
}

/**
 * Approving a claim moves the listing into a fresh attempt for the claimant, so
 * the listing agreement applies to it exactly as it would to a new listing.
 */
export async function decideClaim(input: {
  claimId: string;
  approve: boolean;
  decisionNote?: string | null;
  decidedByUserId: string;
}) {
  const claim = await repository.findClaim(input.claimId);
  if (!claim) throw new ApiError(404, 'NOT_FOUND', 'Claim not found');
  if (claim.status !== 'PENDING') {
    throw new ApiError(409, 'CONFLICT', 'This claim has already been decided');
  }

  const decided = await repository.decideClaim(input.claimId, {
    status: input.approve ? 'APPROVED' : 'REJECTED',
    decisionNote: input.decisionNote ?? null,
    decidedByUserId: input.decidedByUserId,
  });
  if (!input.approve) return decided;

  const attempt = await repository.createAttempt({
    publisherId: claim.claimantPublisherId,
    origin: 'SELF',
    createdByUserId: input.decidedByUserId,
    note: `Claim ${claim.id}`,
  });
  await repository.assignListingOwner(claim.listingId, claim.claimantPublisherId, attempt.id);
  await repository.setAttemptStatus(attempt.id, 'AWAITING_ACCEPTANCE');

  return decided;
}

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
  ListingRead as Listing,
  ListingAttemptOrigin,
  ListingAttemptStatus,
  ListingClaimStatus,
  ListingDocumentKind,
  VerificationType,
  RightsBasis,
  ListingDocument,
} from '../../shared/database';
import type { Request } from 'express';
import type { PageQuery } from '../../shared/pagination';
import { findActivityRows, logActivity } from '../../shared/audit';
import { getPlatformSettings } from '../app-config';
import { createNotification, notify } from '../notifications';
import { dispatchAskFor, findAssignableAgentInCity } from '../agents';
import { createVisit, getVisit } from '../visits';
import { listAdminUserIds } from '../users';
import { assertPublisherLicenceSigned, isCurrentAcceptance, requestPublisherLicence } from '../agreements';
import { adoptListingDocument, type DocumentFiler } from '../uploads';
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

/**
 * Files a paper on a listing.
 *
 * ST-2 (28 Sep 2026): the papers a listing is checked against are private,
 * whatever the client uploaded them as. When the URL names a PUBLIC file in
 * the upload register — and the filer uploaded it, or is the desk — `uploads`
 * adopts it (moved to the private prefix, re-filed as LISTING_DOCUMENT) and
 * the document is stored with its `/files/:id` URL. An outside link is
 * stored as given, and so is the URL of a file that could not be moved: a
 * paper is never refused or lost over its file. `filer` is absent only for
 * a caller that is not a person; the platform may then move any paper.
 */
export async function submitDocument(input: {
  listingId: string;
  kind: ListingDocumentKind;
  url: string;
  /** QR-24: the day the permit or agreement runs out, YYYY-MM-DD. */
  expiresAt?: string | null;
  /** ST-2: who is filing it, and the host a moved file's `/files/:id` URL is recorded under. */
  filer?: DocumentFiler;
  baseUrl?: string;
}) {
  const listing = await repository.findListing(input.listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  const { expiresAt, filer, baseUrl, url, ...rest } = input;
  const adopted = await adoptListingDocument(url, { filer: filer ?? null, baseUrl: baseUrl ?? '' });
  return repository.addDocument({ ...rest, url: adopted.url, expiresAt: expiresAt ? endOfDay(expiresAt) : null });
}

export function getDocuments(listingId: string) {
  return repository.listDocuments(listingId);
}

/**
 * ST-2 (28 Sep 2026): the listings a stored file is filed on, for the
 * private-file door (`uploads`' `FileAccessPort.listingDocumentMayView`,
 * composed in bootstrap). A venue paper or an audience report went private,
 * and who may read one is decided by the listing it sits on — so the file is
 * found by how the URLs end: `/files/<id>`, and `/<objectName>` for a URL a
 * document recorded while the file was still public. An object name shorter
 * than twelve characters is not trusted to be unique and is not matched.
 */
export function listingsNamingFile(ref: { fileId: string; objectName?: string | null }) {
  const suffixes = [`/files/${ref.fileId}`];
  if (ref.objectName && ref.objectName.length >= 12 && !ref.objectName.includes('/')) suffixes.push(`/${ref.objectName}`);
  return repository.listingsNamingFile(suffixes);
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
      // Account lifecycle (2 Oct 2026): the lapse is a fact and is recorded; a
      // suspended, deactivated or closed publisher is not asked to renew.
      if (row.publisherWorking) await tellPublisher(row, {
        title: 'Your right to this spot has run out',
        message: `The ${basisWord(row.rightsBasis)} on ${row.title} ended on ${dayLabel(until)}. It takes no new booking until you upload the renewed document and ADX approves it.`,
        suggestedAction: 'Upload the renewed permit or agreement',
      });
      await tellAdmins(row, { title: 'A spot\'s right to the space has lapsed', message: `${row.publisherName ?? 'The publisher'} held ${row.title} on a ${basisWord(row.rightsBasis)} that ended on ${dayLabel(until)}. It is off the shelf until a renewal is approved.` });
      continue;
    }
    // Account lifecycle (2 Oct 2026): no reminder to a publisher who is not a working account.
    if (!row.publisherWorking) continue;
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

/** The renewals desk's "Remind publisher to renew": the audit action that is its clock, and how long the clock runs. */
export const RIGHTS_REMINDER_ACTION = 'LISTING_RIGHTS_REMINDED';
export const RIGHTS_DESK_REMINDER_INTERVAL_HOURS = 24;

export type RightsReminder = {
  listingId: string;
  /** Whether the reminder said the term has run out (expired) or only that it is ending. */
  expired: boolean;
  validUntil: Date;
  remindedAt: Date;
  nextAllowedAt: Date;
};

/**
 * `POST /supply/listings/:listingId/rights/remind` — 3 Oct 2026: the
 * renewals desk asks the publisher to renew a lease, licence or permit now,
 * between the sweep's thirty- and seven-day reminders or after the lapse.
 * The same in-app notice the sweep sends (relatedType LISTING, so a tap
 * opens the listing and its Renew door); `rightsRemindedAt` is stamped, so
 * the sweep counts it as the reminder for the window it falls in.
 *
 * Once per 24 hours per listing with the audit trail as the clock, as
 * `remindReverification` keeps its own. Refused for an owned spot or one
 * with no end date (409), one with no publisher, no login or an account
 * that is not working (409), and a second reminder inside the day (429).
 */
export async function remindRightsRenewal(listingId: string, byUserId: string, now = new Date(), req?: Request): Promise<RightsReminder> {
  const listing = await repository.findListing(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  if (listing.rightsBasis === 'OWNED' || !listing.rightsValidUntil) {
    throw new ApiError(409, 'CONFLICT', 'This spot is not held on a lease, licence or permit with an end date, so there is nothing to renew.');
  }
  if (!listing.publisherId) {
    throw new ApiError(409, 'CONFLICT', 'This listing has no publisher, so there is nobody to remind.');
  }
  const publisher = await repository.publisherContact(listing.publisherId);
  if (!publisher?.userId) {
    throw new ApiError(409, 'CONFLICT', 'This publisher has no login yet, so there is nobody to remind.');
  }
  if (!publisher.working) {
    throw new ApiError(409, 'CONFLICT', "This publisher's account is not working, so no reminder goes out.");
  }

  const intervalMs = RIGHTS_DESK_REMINDER_INTERVAL_HOURS * HOUR_MS;
  const [last] = await findActivityRows(
    { action: RIGHTS_REMINDER_ACTION, targetType: 'Listing', targetId: listing.id, from: new Date(now.getTime() - intervalMs) },
    { skip: 0, take: 1, sort: 'newest' },
  );
  if (last) {
    const nextAllowedAt = new Date(last.createdAt.getTime() + intervalMs);
    throw new ApiError(
      429,
      'TOO_MANY_REQUESTS',
      `The publisher was reminded within the last ${RIGHTS_DESK_REMINDER_INTERVAL_HOURS} hours. The next reminder can go after ${nextAllowedAt.toISOString()}.`,
      { lastRemindedAt: last.createdAt, nextAllowedAt },
    );
  }

  const until = listing.rightsValidUntil;
  const expired = Boolean(listing.rightsLapsedAt) || until.getTime() <= now.getTime();
  const word = basisWord(listing.rightsBasis);
  const daysLeft = Math.ceil((until.getTime() - now.getTime()) / DAY_MS);
  await createNotification({
    userId: publisher.userId,
    type: 'SYSTEM',
    subtitle: listing.title,
    relatedId: listing.id,
    relatedType: 'LISTING',
    title: expired
      ? `Your ${word} on ${listing.title} has run out`
      : `Your ${word} on ${listing.title} ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    message: expired
      ? `It ended on ${dayLabel(until)}. The spot takes no new booking until you upload the renewed document and ADX approves it.`
      : `It runs out on ${dayLabel(until)}. Upload the renewed document before then and the spot stays on the shelf.`,
    suggestedAction: 'Upload the renewed permit or agreement',
  });
  await repository.setRights(listing.id, { rightsRemindedAt: now });
  await logActivity(byUserId, RIGHTS_REMINDER_ACTION, {
    ...(req ? { req } : {}),
    module: 'supply',
    targetType: 'Listing',
    targetId: listing.id,
    metadata: { publisherId: listing.publisherId, rightsBasis: listing.rightsBasis, validUntil: until.toISOString(), expired },
  });
  return { listingId: listing.id, expired, validUntil: until, remindedAt: now, nextAllowedAt: new Date(now.getTime() + intervalMs) };
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
/* The verification queue's actions (3 Oct 2026)                       */
/* ------------------------------------------------------------------ */

/*
 * The owner, of Listings › Verification: "If verifications lapsed, what
 * action can we take here?" Three answers live here — remind the publisher,
 * send an agent, give more time — beside the suspension module's own
 * Suspend / Reinstate, which the console calls as it always has. None of
 * them marks a listing verified: only an accepted check (`reviewVerification`)
 * restarts the clock for a full cadence.
 */

/** The audit action that is the reminder's clock, and how long it runs. */
export const REVERIFICATION_REMINDER_ACTION = 'LISTING_REVERIFICATION_REMINDED';
export const REVERIFICATION_REMINDER_INTERVAL_HOURS = 24;
/** "Give more time": the most one decision may add, in days. */
export const REVERIFICATION_EXTEND_MAX_DAYS = 30;
export const REVERIFICATION_EXTENDED_ACTION = 'LISTING_REVERIFICATION_EXTENDED';
/** "Send an agent": the audit row that remembers which visit went, and the tag the visit carries on the dispatch board. */
export const SITE_CHECK_ACTION = 'LISTING_SITE_CHECK_DISPATCHED';
export const SITE_CHECK_TAG = 'Re-verification';
export const COMPLIANCE_RESOLVED_ACTION = 'COMPLIANCE_CASE_RESOLVED';

/** A listing on the re-verification clock: verified once, and live or suspended. */
const ON_THE_CLOCK: Listing['status'][] = ['ACTIVE', 'SUSPENDED'];

async function requireListing(listingId: string): Promise<Listing> {
  const listing = await repository.findListing(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  return listing;
}

export type ReverificationReminder = {
  listingId: string;
  /** Whether the reminder said the check is overdue (earnings paused) or only due. */
  lapsed: boolean;
  dueAt: Date;
  remindedAt: Date;
  nextAllowedAt: Date;
};

/**
 * `POST /supply/listings/:listingId/reverification/remind` — ADX asks the
 * publisher for a fresh photo of the spot. One `notify` call: the in-app row
 * names the listing (relatedType LISTING), so a tap opens the listing where
 * the "Is the spot still standing?" card is, and the push the seeded
 * `listing-reverification-reminder` template sends carries the same record.
 * No SMS — no DLT-registered kind exists for it.
 *
 * Once per 24 hours per listing: the audit trail is the clock (the last
 * `LISTING_REVERIFICATION_REMINDED` against the listing), as
 * `POST /campaigns/:id/remind-payment` keeps its own, so the limit survives
 * a restart and a second console. Refused for a listing that is not on the
 * clock (409), one with no publisher, no login or an account that is not
 * working (409), and a second reminder inside the day (429).
 */
export async function remindReverification(listingId: string, byUserId: string, now = new Date(), req?: Request): Promise<ReverificationReminder> {
  const listing = await requireListing(listingId);
  if (!listing.verificationExpiresAt || !ON_THE_CLOCK.includes(listing.status)) {
    throw new ApiError(409, 'CONFLICT', 'This listing is not waiting on a re-verification, so there is nothing to remind about.');
  }
  if (!listing.publisherId) {
    throw new ApiError(409, 'CONFLICT', 'This listing has no publisher, so there is nobody to remind.');
  }
  const publisher = await repository.publisherContact(listing.publisherId);
  if (!publisher?.userId) {
    throw new ApiError(409, 'CONFLICT', 'This publisher has no login yet, so there is nobody to remind.');
  }
  if (!publisher.working) {
    throw new ApiError(409, 'CONFLICT', "This publisher's account is not working, so no reminder goes out.");
  }

  const intervalMs = REVERIFICATION_REMINDER_INTERVAL_HOURS * HOUR_MS;
  const [last] = await findActivityRows(
    { action: REVERIFICATION_REMINDER_ACTION, targetType: 'Listing', targetId: listing.id, from: new Date(now.getTime() - intervalMs) },
    { skip: 0, take: 1, sort: 'newest' },
  );
  if (last) {
    const nextAllowedAt = new Date(last.createdAt.getTime() + intervalMs);
    throw new ApiError(
      429,
      'TOO_MANY_REQUESTS',
      `The publisher was reminded within the last ${REVERIFICATION_REMINDER_INTERVAL_HOURS} hours. The next reminder can go after ${nextAllowedAt.toISOString()}.`,
      { lastRemindedAt: last.createdAt, nextAllowedAt },
    );
  }

  const dueAt = listing.verificationExpiresAt;
  const lapsed = dueAt.getTime() <= now.getTime();
  const due = dayLabel(dueAt);
  const detail = lapsed
    ? `${listing.title} is overdue for its photo check, so its earnings are paused. Open the listing and take a fresh photo from the spot.`
    : `${listing.title} needs a fresh photo from the spot by ${due}, or its earnings pause.`;
  await notify(
    'LISTING_REVERIFICATION_DUE',
    publisher.userId,
    { listing: listing.title, due, detail },
    {
      inApp: {
        type: 'SYSTEM',
        title: 'Is your spot still standing?',
        subtitle: listing.title,
        message: detail,
        suggestedAction: 'Take a fresh photo',
        relatedId: listing.id,
        relatedType: 'LISTING',
      },
    },
  );
  await logActivity(byUserId, REVERIFICATION_REMINDER_ACTION, {
    ...(req ? { req } : {}),
    module: 'supply',
    targetType: 'Listing',
    targetId: listing.id,
    metadata: { publisherId: listing.publisherId, dueAt: dueAt.toISOString(), lapsed },
  });
  return { listingId: listing.id, lapsed, dueAt, remindedAt: now, nextAllowedAt: new Date(now.getTime() + intervalMs) };
}

export type ReverificationExtension = {
  listingId: string;
  previousDueAt: Date;
  dueAt: Date;
  days: number;
  /** Earnings holds the lapse had opened, released now. */
  holdsReleased: number;
  /** The open compliance case closed with it, if there was one. */
  caseResolved: string | null;
};

/**
 * `POST /supply/listings/:listingId/reverification/extend { days, reason }`
 * — ADX gives the publisher more time. The due date moves `days` past the
 * later of now and the date on file (a lapsed listing gets `days` from
 * today, not from a date already behind it); `verifiedAt` stays the last real
 * check. The lapse's earnings holds are released and its open compliance
 * case is closed — the lapse is no longer current — so the earnings run
 * until the new date, when the sweep picks the listing up again if nothing
 * was sent. Audited with the reason and the before and after; the publisher
 * is told the new date in the app.
 *
 * Refused (409) for a listing never verified (there is no date to move), one
 * not live, and one suspended: a desk suspension is reinstated first; a
 * suspension for the lapse itself is lifted only by an accepted check.
 */
export async function extendReverification(
  listingId: string,
  input: { days: number; reason: string },
  byUserId: string,
  now = new Date(),
  req?: Request,
): Promise<ReverificationExtension> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > REVERIFICATION_EXTEND_MAX_DAYS) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Give between 1 and ${REVERIFICATION_EXTEND_MAX_DAYS} days.`);
  }
  const listing = await requireListing(listingId);
  if (!listing.verificationExpiresAt) {
    throw new ApiError(409, 'CONFLICT', 'This listing has never been verified, so there is no due date to move. It needs its first site check.');
  }
  if (listing.suspensionScopes.length > 0) {
    throw new ApiError(409, 'CONFLICT', 'This listing is suspended. Reinstate it first, then give it more time.');
  }
  if (listing.status === 'SUSPENDED') {
    throw new ApiError(
      409,
      'CONFLICT',
      'This listing was suspended when its verification lapsed, so more time cannot be given. It comes back when a new check is accepted — remind the publisher or send an agent.',
    );
  }
  if (listing.status !== 'ACTIVE') {
    throw new ApiError(409, 'CONFLICT', 'Only a live listing can be given more time.');
  }

  const previousDueAt = listing.verificationExpiresAt;
  const from = Math.max(previousDueAt.getTime(), now.getTime());
  const dueAt = addDays(new Date(from), input.days);
  await repository.setVerificationExpiry(listing.id, dueAt);
  const holdsReleased = await repository.releaseHolds(listing.id);
  const openCase = await repository.findOpenCaseForListing(listing.id);
  if (openCase) await repository.setCaseStatus(openCase.id, 'RESOLVED');

  await logActivity(byUserId, REVERIFICATION_EXTENDED_ACTION, {
    ...(req ? { req } : {}),
    module: 'supply',
    targetType: 'Listing',
    targetId: listing.id,
    diff: { verificationExpiresAt: { before: previousDueAt.toISOString(), after: dueAt.toISOString() } },
    metadata: { days: input.days, reason: input.reason, holdsReleased, caseResolved: openCase?.id ?? null },
  });
  await tellPublisher(listing, {
    title: 'More time to re-verify your spot',
    message: `ADX moved the photo check for ${listing.title} to ${dayLabel(dueAt)}. Send a fresh photo from the spot before then.`,
    suggestedAction: 'Take a fresh photo',
  });

  return { listingId: listing.id, previousDueAt, dueAt, days: input.days, holdsReleased, caseResolved: openCase?.id ?? null };
}

/** A dispatched visit still on somebody's day: answered and slotted, under way, or an offer still inside its window. */
function visitStillOpen(visit: { status: string; expiresInSeconds: number | null }): boolean {
  if (visit.status === 'SCHEDULED' || visit.status === 'IN_PROGRESS') return true;
  return visit.status === 'REQUESTED' && (visit.expiresInSeconds ?? 0) > 0;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * `POST /supply/listings/:listingId/reverification/site-check { agentId?, note? }`
 * — ADX sends an agent to look at the spot.
 *
 * There is no order behind a re-verification, so the order-milestone lane
 * (which every AGENT_INITIAL visit rides) cannot carry it; the trip that is
 * not a step on an order is `visits`' FieldVisit, and this books one through
 * `createVisit` exactly as the dispatch board does: an AUDIT visit to the
 * listing's publisher, at the spot's pin, tagged "Re-verification", offered
 * to the agent with the 25-minute window and the VISIT_OFFER notice. Without
 * `agentId` the agent is the dispatch sweep's pick (`findAssignableAgent`'s
 * ranking) from the listing's own city. The visit is remembered in the audit
 * row, and a second is refused while the first is still open.
 */
export async function dispatchSiteCheck(
  listingId: string,
  input: { agentId?: string | undefined; note?: string | undefined },
  byUserId: string,
  now = new Date(),
  req?: Request,
) {
  const listing = await requireListing(listingId);
  if (!ON_THE_CLOCK.includes(listing.status)) {
    throw new ApiError(409, 'CONFLICT', 'Only a live or suspended listing is re-verified on site.');
  }
  if (!listing.publisherId) {
    throw new ApiError(409, 'CONFLICT', 'This listing has no publisher, so a visit cannot be booked against it.');
  }

  const [previous] = await findActivityRows(
    { action: SITE_CHECK_ACTION, targetType: 'Listing', targetId: listing.id },
    { skip: 0, take: 1, sort: 'newest' },
  );
  const previousVisitId = (previous?.metadata as { visitId?: unknown } | null | undefined)?.visitId;
  if (typeof previousVisitId === 'string') {
    const visit = await getVisit(previousVisitId, byUserId, true).catch(() => null);
    if (visit && visitStillOpen(visit)) {
      throw new ApiError(
        409,
        'CONFLICT',
        `An agent is already booked for this spot (${visit.displayId ?? visit.id}, ${visit.pill.label.toLowerCase()}). Wait for that visit, or cancel it on the dispatch board.`,
        { visitId: visit.id },
      );
    }
  }

  let agentId = input.agentId ?? null;
  if (!agentId) {
    if (!listing.city && !listing.cityId) {
      throw new ApiError(409, 'CONFLICT', 'This listing has no city, so ADX cannot pick an agent near it.');
    }
    const ask = await dispatchAskFor(null, { latitude: listing.latitude, longitude: listing.longitude });
    agentId = (await findAssignableAgentInCity({ cityId: listing.cityId, city: listing.city }, ask, now))?.id ?? null;
    if (!agentId) {
      throw new ApiError(409, 'CONFLICT', `No agent is free in ${listing.city ?? 'this city'} right now. Try again later, or book one from the dispatch board.`);
    }
  }

  const publisher = await repository.publisherContact(listing.publisherId);
  const reference = listing.displayId ?? listing.id;
  const notes = [
    `Re-verification of ${reference} (${listing.title})${publisher ? ` for ${publisher.name}` : ''}.`,
    'Stand at the spot, photograph it whole with location on, and say whether it is still standing.',
    input.note?.trim() || null,
  ]
    .filter(Boolean)
    .join(' ');
  const visit = await createVisit(
    {
      kind: 'AUDIT',
      publisherId: listing.publisherId,
      agentId,
      businessName: clip(listing.title, 160),
      ...(listing.address ? { locality: clip(listing.address, 120) } : {}),
      ...(listing.city ? { city: clip(listing.city, 80) } : {}),
      ...(listing.latitude !== null && listing.longitude !== null ? { latitude: listing.latitude, longitude: listing.longitude } : {}),
      campaignTag: SITE_CHECK_TAG,
      notes: clip(notes, 1000),
    },
    { userId: byUserId, isAdmin: true },
    now,
  );

  await logActivity(byUserId, SITE_CHECK_ACTION, {
    ...(req ? { req } : {}),
    module: 'supply',
    targetType: 'Listing',
    targetId: listing.id,
    metadata: { visitId: visit.id, visitDisplayId: visit.displayId, agentId, picked: !input.agentId },
  });
  return { listingId: listing.id, picked: !input.agentId, visit };
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

/**
 * Closes a case. 3 Oct 2026: the desk says how it ended — `outcome`, free
 * text like a contact attempt's, and a `note` — and the decision is audited
 * with both (the case row has no columns for them; the trail is the record).
 * Both stay optional so an older console that sends nothing still resolves.
 */
export async function resolveComplianceCase(
  caseId: string,
  input: { outcome?: string | undefined; note?: string | undefined } = {},
  byUserId?: string,
  req?: Request,
) {
  const found = await repository.findCase(caseId);
  if (!found) throw new ApiError(404, 'NOT_FOUND', 'Compliance case not found');
  const resolved = await repository.setCaseStatus(caseId, 'RESOLVED');
  if (byUserId) {
    await logActivity(byUserId, COMPLIANCE_RESOLVED_ACTION, {
      ...(req ? { req } : {}),
      module: 'supply',
      targetType: 'ComplianceCase',
      targetId: caseId,
      diff: { status: { before: found.status, after: 'RESOLVED' } },
      metadata: { listingId: found.listingId, outcome: input.outcome ?? null, note: input.note ?? null },
    });
  }
  return resolved;
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

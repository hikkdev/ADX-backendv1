import type { Request } from 'express';
import { applyKycDecision, applyKycDecisionByUserId, findAdvertiser, getAdvertiserForUser } from '../../advertisers';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { auditDiff, logActivity } from '../../../shared/audit';
import type { Advertiser, AdvertiserKyc, KycStatus } from '../../../shared/database';
import { kycStateCounts } from '../../../shared/kyc-state';
import { createNotification, notify } from '../../notifications';
import {
  KYC_DEEP_LINK,
  kycChannelLabel,
  pageMeta,
  type AssignCaseInput,
  type DocumentDecisionInput,
  type KycEscalateInput,
  type KycRequestInput,
  type ReuploadRequestInput,
} from '../kyc.schema';
import { escalateKyc } from '../escalation.service';
import { initiateAdvertiserDigioKyc } from './advertiser-digio.service';
import { prismaAdvertiserKycRepository as repository } from './prisma-advertiser-kyc.repository';
import type { AdvertiserKycFilter, AdvertiserKycKey, AdvertiserKycSort } from './advertiser-kyc.repository';
import { slaAge, slaCutoff } from '../../../shared/time';
import { getPlatformSettings } from '../../app-config';
import { clearDocumentReviews, flagDocuments, flaggedDocuments, listDocumentReviewsWithReviewer, recordDocumentReview } from '../document-review/document-review.service';
import { hasSubmittedLiveness, livenessStateFor } from '../user/user-kyc.service';
import { resolveManifestVersion } from '../manifest-pin';
import { kycCaseExtras, kycLabelFor, kycUserLabels } from '../case-read';
import { ADVERTISER_KYC_DOCUMENT_FIELDS, type CreateAdvertiserKycInput, type UpdateAdvertiserKycInput } from './advertiser-kyc.schema';

/* ── N3-B: the record is keyed by the profile ────────────────────────────── */

/**
 * N3-B: an `AdvertiserKyc` row belongs to an Advertiser PROFILE
 * (`advertiserProfileId`), and carries the advertiser's user id
 * (`advertiserId`, the legacy key) only when the profile has an app account.
 * Every read and write resolves the profile first, then the user; the desk's
 * `:id` on every route is the KYC row id, then the profile id, then the user
 * id. A record the desk makes for an advertiser with no user carries the
 * profile alone and is linked to the user when the owner signs in and the
 * profile is claimed (`advertisers.attachUser`).
 */
export type ResolvedAdvertiserCase = { kyc: AdvertiserKyc | null; advertiser: Advertiser | null };

/** The profile a record belongs to — by its profile key, else by its user. */
async function profileForRecord(row: AdvertiserKyc): Promise<Advertiser | null> {
  if (row.advertiserProfileId) return findAdvertiser(row.advertiserProfileId);
  if (row.advertiserId) return getAdvertiserForUser(row.advertiserId);
  return null;
}

/** The record a profile owns — by the profile first, then (a legacy row) by its user. */
async function recordForProfile(advertiser: Advertiser): Promise<AdvertiserKyc | null> {
  return (await repository.findByProfileId(advertiser.id)) ?? (advertiser.userId ? repository.findByAdvertiserId(advertiser.userId) : null);
}

/**
 * The key a write over this party is addressed by: the profile and its user.
 * A legacy row that has no profile key yet is addressed by its own id, so
 * the write adopts the profile key instead of making a second row beside it.
 */
const keyFor = (advertiser: Advertiser | null, userId: string | null, current: AdvertiserKyc | null = null): AdvertiserKycKey => ({
  ...(current && !current.advertiserProfileId ? { id: current.id } : {}),
  advertiserProfileId: advertiser?.id ?? current?.advertiserProfileId ?? null,
  advertiserId: advertiser?.userId ?? current?.advertiserId ?? userId,
});

/**
 * `:id` resolved: the KYC row id first, then the Advertiser profile id, then
 * the advertiser's user id. Both halves may be null: a row whose profile is
 * gone, a profile with no record yet, an id that names nothing.
 */
export async function resolveAdvertiserCase(id: string): Promise<ResolvedAdvertiserCase> {
  const byRow = await repository.findById(id);
  if (byRow) return { kyc: byRow, advertiser: await profileForRecord(byRow) };
  const advertiser = (await findAdvertiser(id)) ?? (await getAdvertiserForUser(id));
  if (advertiser) return { kyc: await recordForProfile(advertiser), advertiser };
  // A legacy user-keyed row for a user with no profile.
  return { kyc: await repository.findByAdvertiserId(id), advertiser: null };
}

/** The self paths (`/me`) resolve through the caller's profile; a user with no profile keeps the legacy user key. */
async function resolveSelf(userId: string): Promise<{ key: AdvertiserKycKey; advertiser: Advertiser | null; kyc: AdvertiserKyc | null }> {
  const advertiser = await getAdvertiserForUser(userId);
  const kyc = advertiser ? await recordForProfile(advertiser) : await repository.findByAdvertiserId(userId);
  return { key: keyFor(advertiser, userId, kyc), advertiser, kyc };
}

/**
 * N3-B: `Advertiser.kycStatus` mirrors the record on every status write —
 * by the profile the record names, else (a legacy row) by its user. A
 * record with neither has no profile to mirror onto.
 */
async function mirrorStatus(kyc: Pick<AdvertiserKyc, 'advertiserProfileId' | 'advertiserId' | 'status'>): Promise<void> {
  if (kyc.advertiserProfileId) {
    await applyKycDecision(kyc.advertiserProfileId, kyc.status);
    return;
  }
  if (kyc.advertiserId) await applyKycDecisionByUserId(kyc.advertiserId, kyc.status);
}

/**
 * The ADMIN queue. N3-B: every Advertiser is in it from the moment the
 * profile exists — as AWAITING_DOCUMENTS until something is requested or
 * submitted — left-joined to its record, each row carrying its `state`.
 * Every submitted row carries how long it has been waiting and whether that
 * is past the review SLA ops set in the platform settings row (Q31,
 * `kyc.reviewSlaHours`), and with no sort named the late ones come first —
 * across pages, not just within one; parties with nothing in follow, by
 * when they arrived.
 */
export async function listAdvertiserKycs(
  where: AdvertiserKycFilter,
  page: number,
  pageSize: number,
  sort?: AdvertiserKycSort,
  now = new Date(),
) {
  const { reviewSlaHours } = (await getPlatformSettings()).kyc;
  const [{ items, total }, breached, stateCounts, escalated, requested] = await Promise.all([
    repository.findPage(where, page, pageSize, sort),
    repository.countBreached(where, slaCutoff(reviewSlaHours, now)),
    // E7-3 / N3-B: the chips — parties per state over the filter with the state facet removed.
    repository.countByState({ ...where, state: undefined, status: undefined }),
    // Lot G (Q127/142): the escalated, across the queue, with that facet removed.
    repository.countEscalated(where),
    // Lot N: the requested-and-not-submitted, across the queue, with that facet removed.
    repository.countRequested(where),
  ]);
  const counts = { ...kycStateCounts(stateCounts), escalated, requested };
  // E10-1: the assignee by name beside the id, one lookup for the page;
  // G11-1: the escalation's two people ride the same lookup; Lot N: so do
  // who requested the KYC and who recorded it.
  const labels = await kycUserLabels(
    items.flatMap((item) => [item.assignedToId, item.escalatedToUserId, item.escalatedById, item.requestedById, item.recordedById]),
  );
  return {
    items: items.map((item) => ({
      ...item,
      ...slaAge(item.status === 'PENDING' ? item.submittedAt : null, reviewSlaHours, now),
      assignedTo: kycLabelFor(labels, item.assignedToId),
      escalatedTo: kycLabelFor(labels, item.escalatedToUserId),
      escalatedBy: kycLabelFor(labels, item.escalatedById),
      requestedBy: kycLabelFor(labels, item.requestedById),
      recordedBy: kycLabelFor(labels, item.recordedById),
    })),
    total,
    page,
    pageSize,
    counts,
    breached,
    escalated,
    requested,
    slaHours: reviewSlaHours,
    /** @deprecated E7-3: the old sibling, kept one release; the page shape above is the contract. */
    meta: { ...pageMeta(page, pageSize, total), breached, slaHours: reviewSlaHours },
  };
}

/** `GET /advertiser-kyc/me` — N3-B: through the caller's profile, then the legacy user key. */
export async function getMyAdvertiserKyc(userId: string) {
  const { kyc } = await resolveSelf(userId);
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  return kyc;
}

export async function getAdvertiserKycById(id: string) {
  const kyc = await repository.findById(id);
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  return kyc;
}

/**
 * N2-B / N3-B: the desk's `:id` on `GET /:id` and `PUT /:id` is the KYC row
 * id the queue lists, **or** the Advertiser profile id, **or** the
 * advertiser's user id — in that order, the way `POST /:id/request`
 * resolves it. Null when none of them names a row.
 */
export async function findAdvertiserKycByEitherId(id: string) {
  return (await resolveAdvertiserCase(id)).kyc;
}

/**
 * Lot D (Q42/Q131): the case as the workbench draws it — the row, every
 * per-document decision, and the liveness video's state for the advertiser's
 * user (none for an advertiser with no app account yet). N2-B / N3-B:
 * `:id` is the row id, the profile id or the user id.
 */
export async function getAdvertiserKycCase(id: string, now = new Date()) {
  const { kyc, advertiser } = await resolveAdvertiserCase(id);
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  const userId = kyc.advertiserId ?? advertiser?.userId ?? null;
  const [documentReviews, liveness, extras] = await Promise.all([
    // E10-1: each tile's decision with who made it.
    listDocumentReviewsWithReviewer('ADVERTISER', kyc.id),
    userId ? livenessStateFor(userId) : Promise.resolve(null),
    // E7-3: the age against the SLA, the reviewer and the assignee by name.
    kycCaseExtras(kyc, now),
  ]);
  return { ...kyc, documentReviews, liveness, ...extras };
}

/**
 * One KYC record per advertiser. Unlike user KYC, a second submission is a
 * conflict rather than an overwrite — the advertiser is expected to use
 * PUT /me to resubmit. N3-B: keyed by the caller's profile; the mirror goes PENDING.
 */
export async function createAdvertiserKyc(userId: string, input: CreateAdvertiserKycInput) {
  const { key, kyc: existing } = await resolveSelf(userId);
  if (existing) throw new ApiError(409, 'CONFLICT', 'KYC already submitted for this advertiser');
  const { manifestVersion, ...data } = input;
  const created = await repository.create(key, data);
  await pinManifest(key, manifestVersion);
  await mirrorStatus(created);
  return created;
}

/** Lot F: the manifest version is pinned once, at the first submission, and never moves. */
async function pinManifest(key: AdvertiserKycKey, sent: number | undefined): Promise<void> {
  const version = await resolveManifestVersion(sent);
  if (version !== null) await repository.pinManifestVersion(key, version);
}

/**
 * The owner's own submit — `PUT /advertiser-kyc/me` — first time and every
 * time after: the columns sent are written, the rest kept, the record goes
 * (back) to PENDING. Lot D (Q42) / Lot F: while NEEDS_INFO the body may be
 * partial — only the flagged DR 08 columns — and whatever was decided about
 * the fields sent no longer applies, so those decisions are cleared; the
 * fields not sent keep their files and their decisions. The first submission
 * pins the manifest version the phone rendered. N3-B: keyed by the caller's
 * profile; the mirror goes PENDING.
 */
export async function resubmitAdvertiserKyc(
  userId: string,
  input: UpdateAdvertiserKycInput,
) {
  const { manifestVersion, ...data } = input;
  const { key, kyc: current } = await resolveSelf(userId);
  // N2-B: a verified advertiser has nothing to resubmit — the desk moves the
  // record to NEEDS_INFO (or a decision rejects it) before anything is taken over it.
  assertNotVerified(current?.status);
  // E9 (the E7 verifier): while NEEDS_INFO a body naming no document field
  // attaches nothing, and must not bounce the case back to PENDING.
  assertResubmissionCarriesDocuments(current?.status, Object.keys(data), ADVERTISER_KYC_DOCUMENT_FIELDS);
  const resubmitted = await repository.resubmit(key, data);
  await pinManifest(key, manifestVersion);
  const sent = Object.keys(data);
  if (sent.length) await clearDocumentReviews('ADVERTISER', resubmitted.id, sent);
  await mirrorStatus(resubmitted);
  return resubmitted;
}

/**
 * E9 (the E7 verifier): a NEEDS_INFO case is waiting for documents. A body
 * that names none of the document columns — a type change, a bare manifest
 * pin, nothing at all — is refused 400 `EMPTY_RESUBMISSION` rather than
 * written: it would return the case to PENDING with the same files and
 * clear nothing, and the desk would review what it already flagged. The
 * publisher twin (`publishers/kyc/kyc-desk.service`) applies the same rule
 * to its own column set.
 */
export function assertResubmissionCarriesDocuments(status: KycStatus | string | null | undefined, sent: readonly string[], documentFields: readonly string[]): void {
  if (status !== 'NEEDS_INFO') return;
  if (sent.some((field) => documentFields.includes(field))) return;
  throw new ApiError(400, 'EMPTY_RESUBMISSION', 'Attach at least one of the flagged documents — nothing was sent back for review.', {
    documentFields: [...documentFields],
  });
}

/**
 * N2-B: every write over a record — the desk's and the party's own — stops
 * at VERIFIED with 409 `KYC_ALREADY_VERIFIED`, the way the publisher's
 * does. NEEDS_INFO (the desk asking for tiles again) is what reopens it.
 */
function assertNotVerified(status: KycStatus | string | null | undefined): void {
  if (status !== 'VERIFIED') return;
  throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This advertiser is already verified; record nothing over it');
}

/**
 * Admin edit by id — Lot N: the desk recording the advertiser's KYC on their
 * behalf (`PUT /advertiser-kyc/:id`). The files were uploaded by the admin
 * under purpose ADVERTISER_KYC with `ownerUserId` naming the advertiser.
 * Stamps `recordedById` the admin, `recordedVia` DESK, `method` MANUAL, and
 * `submittedAt` on a first recording; does NOT reset status — that is what
 * review is for. Audited `ADVERTISER_KYC_RECORDED_AT_DESK` with the diff.
 *
 * N2-B / N3-B: `:id` is the row id, the profile id **or** the advertiser's
 * user id (row first), and a profile with no row **creates** it — keyed by
 * the profile, `advertiserId` null when the profile has no user yet,
 * `kycType` from the body or the advertiser's entity type, PENDING,
 * `submittedAt` now — so the console can record at the desk before any
 * request; the mirror goes PENDING. A VERIFIED record is 409
 * `KYC_ALREADY_VERIFIED`; an id behind which there is no advertiser is 404.
 */
export async function updateAdvertiserKycById(id: string, input: UpdateAdvertiserKycInput, byUserId?: string, req?: Request, now = new Date()) {
  const { kyc: before, advertiser } = await resolveAdvertiserCase(id);
  const { manifestVersion: _ignored, ...data } = input;
  const stamp = byUserId ? { recordedById: byUserId, recordedVia: 'DESK' as const, method: 'MANUAL' as const, at: now } : undefined;

  if (before) {
    assertNotVerified(before.status);
    if (!stamp) return repository.updateById(before.id, data);
    const after = await repository.updateById(before.id, data, stamp);
    await auditRecordedAtDesk(byUserId!, before, after, Object.keys(data), false, req);
    return after;
  }

  // No row: `:id` has to be an advertiser's profile or user id, and the desk makes the row.
  if (!advertiser) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  if (!stamp) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  const { kycType, ...columns } = data;
  const created = await repository.createAtDesk(keyFor(advertiser, null), { kycType: kycType ?? advertiser.type, ...columns }, stamp);
  await auditRecordedAtDesk(byUserId!, { advertiserId: advertiser.userId, advertiserProfileId: advertiser.id }, created, Object.keys(data), true, req);
  await mirrorStatus(created);
  return created;
}

async function auditRecordedAtDesk(
  byUserId: string,
  before: { advertiserId: string | null; advertiserProfileId: string | null },
  after: { id: string },
  fields: string[],
  created: boolean,
  req?: Request,
) {
  await logActivity(byUserId, 'ADVERTISER_KYC_RECORDED_AT_DESK', {
    req,
    targetType: 'AdvertiserKyc',
    targetId: after.id,
    module: 'kyc',
    diff: auditDiff(before, after, ['status', 'method', 'recordedVia', 'recordedById', 'submittedAt', 'kycType', ...fields]),
    metadata: { advertiserId: before.advertiserId, advertiserProfileId: before.advertiserProfileId, fields, created },
  });
}

/* ── Lot N: KYC requested from the desk ──────────────────────────────────── */

/**
 * `POST /advertiser-kyc/:id/request` — the desk asks the advertiser for
 * their KYC. `:id` is the KYC row id the queue lists, the Advertiser
 * profile id **or** the advertiser's user id (row, then profile, then user —
 * a request may come before any row exists). DIGIO (the default — the
 * console's one click needs no body) opens a Digio session on the
 * advertiser's behalf, the profile's contact email and mobile being the
 * customer Digio reaches — so an advertiser with no app account is asked
 * all the same; MANUAL only tells them. Either way the row is stamped (who,
 * when, which channel; the status untouched — REQUESTED is derived as
 * `requestedAt` set and `submittedAt` null), and `ADVERTISER_KYC_REQUESTED`
 * is audited. The `KYC_REQUESTED` notice (email, SMS, a push that opens
 * their KYC screen) goes to the advertiser's user; with no user it is
 * skipped with a logged reason and the answer says `notified: false`. A
 * VERIFIED record is 409.
 */
export async function requestAdvertiserKyc(id: string, input: KycRequestInput, byUserId: string, req?: Request, now = new Date()) {
  const { kyc: current, advertiser } = await resolveAdvertiserCase(id);
  if (!advertiser) throw new ApiError(404, 'NOT_FOUND', 'No advertiser behind that id');
  if (current?.status === 'VERIFIED') {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This advertiser is already verified; there is nothing to request');
  }
  const key = keyFor(advertiser, null, current);

  const digio = input.channel === 'DIGIO' ? await initiateAdvertiserDigioKyc(advertiser) : null;
  const kyc = await repository.requestKyc(key, { requestedById: byUserId, requestedChannel: input.channel, at: now });

  await logActivity(byUserId, 'ADVERTISER_KYC_REQUESTED', {
    req,
    targetType: 'AdvertiserKyc',
    targetId: kyc.id,
    module: 'kyc',
    diff: auditDiff(current ?? {}, kyc, ['requestedAt', 'requestedChannel', 'method']),
    metadata: { advertiserId: advertiser.userId, advertiserProfileId: advertiser.id, channel: input.channel, note: input.note ?? null, digioKycId: digio?.kycId ?? null },
  });

  const partyName = advertiser.companyName ?? advertiser.name;
  const userId = advertiser.userId;
  if (!userId) {
    logger.info('KYC_REQUESTED notice skipped: the advertiser has no app account yet', { advertiserId: advertiser.id, kycId: kyc.id, channel: input.channel });
  } else {
    await notify(
      'KYC_REQUESTED',
      userId,
      { partyName, channel: kycChannelLabel(input.channel), note: input.note ?? '', deepLink: KYC_DEEP_LINK },
      {
        inApp: {
          type: 'KYC',
          title: 'Please complete your verification',
          message:
            input.channel === 'DIGIO'
              ? `ADX has started a Digio identity check for you. Open the app and finish it — it takes about a minute. ${input.note ?? ''}`.trim()
              : `ADX has asked you to complete your identity verification. ${input.note ?? ''}`.trim(),
          suggestedAction: 'Verify your identity',
          // The KYC row, as every other advertiser KYC notice names it (no relatedType — the row is the subject).
          relatedId: kyc.id,
        },
      },
    );
  }

  return { kyc, digio: digio ? { kycId: digio.kycId, validTill: digio.validTill } : null, notified: Boolean(userId) };
}

/**
 * The decision. Lot D: it remembers who decided and what they said, tells
 * the advertiser either way, and — Q131 — will not verify a manual-path
 * record until the liveness video is in. The Digio path is exempt: Digio
 * did the liveness check itself. N3-B: the liveness proof is the user's —
 * a record with no user cannot be verified on the manual path until the
 * owner signs in or the desk attests presence on their account.
 */
export async function reviewAdvertiserKyc(
  id: string,
  status: KycStatus,
  rejectionReason?: string,
  reviewer?: { userId: string; note?: string | null; req?: Request },
) {
  const kycCase = await getAdvertiserKycById(id);
  const userId = kycCase.advertiserId;

  if (status === 'VERIFIED' && kycCase.method !== 'DIGIO' && !(userId && (await hasSubmittedLiveness(userId)))) {
    throw new ApiError(
      409,
      'LIVENESS_REQUIRED',
      userId
        ? 'Ask the advertiser to record the short liveness video before verifying'
        : 'This advertiser has no app account yet, so there is no liveness video to check against',
    );
  }

  const reviewed = await repository.review(
    id,
    status,
    rejectionReason ?? null,
    reviewer ? { reviewedById: reviewer.userId, reviewNote: reviewer.note ?? null } : undefined,
  );

  // The Advertiser profile the demand funnel gates on is a different row.
  // Without this, gate 3 never closes and a verified advertiser still cannot
  // book. N3-B: by the profile the record names, on every status write;
  // no-ops when there is none.
  await mirrorStatus(reviewed);

  if (reviewer) {
    await logActivity(reviewer.userId, 'ADVERTISER_KYC_REVIEWED', {
      req: reviewer.req,
      targetType: 'AdvertiserKyc',
      targetId: id,
      module: 'kyc',
      diff: auditDiff(kycCase, reviewed, ['status', 'rejectionReason', 'reviewNote']),
      metadata: { advertiserId: kycCase.advertiserId, advertiserProfileId: kycCase.advertiserProfileId, status },
    });
    if (status === 'VERIFIED' || status === 'REJECTED') {
      if (!userId) {
        logger.info('KYC_DECISION notice skipped: the advertiser has no app account yet', { kycId: id, advertiserProfileId: kycCase.advertiserProfileId, status });
        return reviewed;
      }
      // Lot E1/F: one call — the in-app row, and the email and SMS the
      // seeded `kyc-decision` template names (partyName, decision, reason),
      // each subject to the advertiser's KYC preference.
      await notify(
        'KYC_DECISION',
        userId,
        {
          partyName: await advertiserNameFor(kycCase),
          decision: status === 'VERIFIED' ? 'verified' : 'not verified',
          reason: status === 'VERIFIED' ? 'You can book once the rest of your setup is done.' : (rejectionReason ?? ''),
        },
        {
          inApp: {
            type: 'KYC',
            title: status === 'VERIFIED' ? 'Identity verified' : 'Identity check did not clear',
            message:
              status === 'VERIFIED'
                ? 'ADX has verified your identity. You can book once the rest of your setup is done.'
                : `ADX could not verify your identity. ${rejectionReason ?? ''}`.trim(),
            suggestedAction: status === 'VERIFIED' ? 'Open your account' : 'Review your documents and resubmit',
            relatedId: id,
          },
        },
      );
    }
  }

  return reviewed;
}

/** The name the decision email greets — the profile's, or a plain "there" when the profile is not yet made. */
async function advertiserNameFor(kyc: AdvertiserKyc): Promise<string> {
  try {
    const advertiser = await profileForRecord(kyc);
    return advertiser?.companyName ?? advertiser?.name ?? 'there';
  } catch {
    return 'there';
  }
}

/* ── Lot D (Q42/Q119): the per-document desk ─────────────────────────────── */

/** PATCH /advertiser-kyc/:id/documents/:field — one tile approved or flagged. */
export async function reviewAdvertiserDocument(id: string, field: string, input: DocumentDecisionInput, byUserId: string, req?: Request) {
  if (!ADVERTISER_KYC_DOCUMENT_FIELDS.includes(field)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Unknown document field: ${field}`);
  }
  const kycCase = await getAdvertiserKycById(id);
  const review = await recordDocumentReview('ADVERTISER', kycCase.id, { field, decision: input.decision, note: input.note ?? null }, byUserId);
  await logActivity(byUserId, 'ADVERTISER_KYC_DOCUMENT_REVIEWED', {
    req,
    targetType: 'AdvertiserKyc',
    targetId: id,
    module: 'kyc',
    metadata: { field, decision: input.decision, advertiserId: kycCase.advertiserId, advertiserProfileId: kycCase.advertiserProfileId },
  });
  return review;
}

/**
 * POST /advertiser-kyc/:id/request-reupload — the record goes NEEDS_INFO,
 * the files stay, the flagged fields are recorded, and the advertiser is
 * told exactly which to send again (when they have an app account). N3-B:
 * the mirror goes NEEDS_INFO with it.
 */
export async function requestAdvertiserReupload(id: string, input: ReuploadRequestInput, byUserId: string, req?: Request) {
  const unknown = input.fields.filter((field) => !ADVERTISER_KYC_DOCUMENT_FIELDS.includes(field));
  if (unknown.length) throw new ApiError(400, 'VALIDATION_ERROR', `Unknown document fields: ${unknown.join(', ')}`);
  const kycCase = await getAdvertiserKycById(id);
  if (kycCase.status === 'VERIFIED') {
    throw new ApiError(409, 'CONFLICT', 'This advertiser is already verified; nothing to re-upload');
  }
  await flagDocuments('ADVERTISER', kycCase.id, input.fields, input.note, byUserId);
  const updated = await repository.requestReupload(id, { reviewedById: byUserId, reviewNote: input.note });
  await mirrorStatus(updated);
  await logActivity(byUserId, 'ADVERTISER_KYC_REUPLOAD_REQUESTED', {
    req,
    targetType: 'AdvertiserKyc',
    targetId: id,
    module: 'kyc',
    diff: auditDiff(kycCase, updated, ['status', 'reviewNote']),
    metadata: { fields: input.fields, advertiserId: kycCase.advertiserId, advertiserProfileId: kycCase.advertiserProfileId },
  });
  if (kycCase.advertiserId) {
    await createNotification({
      userId: kycCase.advertiserId,
      type: 'KYC',
      title: 'A few documents need another look',
      message: `${input.note} Please re-upload: ${input.fields.join(', ')}.`,
      suggestedAction: 'Re-upload the flagged documents',
      relatedId: id,
    });
  } else {
    logger.info('Re-upload notice skipped: the advertiser has no app account yet', { kycId: id, advertiserProfileId: kycCase.advertiserProfileId });
  }
  return { ...updated, flagged: await flaggedDocuments('ADVERTISER', kycCase.id) };
}

/** PATCH /advertiser-kyc/:id/assign — a filter, not ownership; any admin may still decide. */
export async function assignAdvertiserCase(id: string, input: AssignCaseInput, byUserId: string, req?: Request) {
  const kycCase = await getAdvertiserKycById(id);
  const adminUserId = input.adminUserId === 'me' ? byUserId : input.adminUserId;
  await repository.assign([id], adminUserId, new Date());
  await logActivity(byUserId, 'ADVERTISER_KYC_ASSIGNED', {
    req,
    targetType: 'AdvertiserKyc',
    targetId: id,
    module: 'kyc',
    diff: auditDiff({ assignedToId: kycCase.assignedToId }, { assignedToId: adminUserId }),
  });
  return getAdvertiserKycById(id);
}

/**
 * What the party's own ladder needs to know (Lot D): the status, the method,
 * the flagged documents with the reviewer's note, and the liveness state.
 * Null before a first submission. Read by `users` for the manifest. N3-B:
 * through the caller's profile, then the legacy user key.
 */
export async function advertiserKycReviewStateFor(userId: string) {
  const { kyc: row } = await resolveSelf(userId);
  if (!row) return null;
  return {
    status: row.status,
    method: row.method,
    reviewNote: row.reviewNote,
    /** Lot F: the manifest version pinned at the first submission, for the server-side pin. */
    manifestVersion: row.manifestVersion ?? null,
    flagged: await flaggedDocuments('ADVERTISER', row.id),
  };
}

/** POST /advertiser-kyc/:id/escalate — Lot G (Q127/142): the reviewer hands the case to Compliance. */
export async function escalateAdvertiserCase(id: string, input: KycEscalateInput, byUserId: string, req?: Request) {
  await getAdvertiserKycById(id);
  await escalateKyc({ party: 'ADVERTISER', kycId: id }, { reason: input.reason, byUserId, req }, new Date());
  return getAdvertiserKycCase(id);
}

export async function deleteAdvertiserKyc(id: string) {
  await getAdvertiserKycById(id);
  await repository.remove(id);
}

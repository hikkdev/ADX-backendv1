import type { Request } from 'express';
import { ApiError } from '../../../shared/errors';
import { auditDiff, logActivity } from '../../../shared/audit';
import type { KycStatus, PublisherKyc } from '../../../shared/database';
import {
  clearDocumentReviews,
  escalateKyc,
  flagDocuments,
  flaggedDocuments,
  hasSubmittedLiveness,
  kycCaseExtras,
  listDocumentReviews,
  listDocumentReviewsWithReviewer,
  livenessStateFor,
  maskPan,
  recordDocumentReview,
  resolveManifestVersion,
  trimDigioPayload,
  type AssignCaseInput,
  type BulkAssignInput,
  type DocumentDecisionInput,
  type KycEscalateInput,
  type KycRequestInput,
  type ReuploadRequestInput,
} from '../../kyc';
import { createNotification, notify, type KycDecisionAgentPayload } from '../../notifications';
import { fileIdFromUrl, purgeStoredFile } from '../../uploads';
import { getAgentWithUser } from '../../agents';
import { logger } from '../../../shared/logging';
import { initiateDigioKyc } from './digio.service';
import { prismaPublishersRepository as repository } from '../prisma-publishers.repository';
import { PUBLISHER_KYC_DOCUMENT_FIELDS } from '../publishers.schema';
import type { KycDocuments, KycQueueRow } from '../publishers.repository';

/** Lot N: the deep link a KYC_REQUESTED push opens — the party's own KYC screen in the user app (the same value `kyc` exports as `KYC_DEEP_LINK`; held here so the desk's tests can mock `kyc` whole). */
export const KYC_DEEP_LINK = 'adx://kyc';
const channelLabel = (channel: KycRequestInput['channel']): string => (channel === 'DIGIO' ? 'Digio' : 'at the ADX desk');

/**
 * The publisher KYC desk — Lot D (Q42/Q119/Q131).
 *
 * The workbench used to have one verdict over the whole record. Now it has a
 * decision per tile, a way to ask for exactly the flagged ones again
 * (NEEDS_INFO — the files stay, the party re-uploads only those), a memory of
 * who decided and what they said, and a filter for who is working what.
 *
 * Assignment is a filter, not ownership (decision 119): any admin may decide
 * a case, whoever it is assigned to. The one thing that does gate a decision
 * is decision 131 — a manual-path record cannot be verified until the party
 * has recorded the liveness video. The Digio path is exempt because Digio
 * performed its own.
 */

async function requireCase(publisherId: string): Promise<KycQueueRow & { kyc: PublisherKyc }> {
  const row = await repository.findKycDetail(publisherId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (!row.kyc) throw new ApiError(404, 'NOT_FOUND', 'This publisher has no KYC record yet');
  return row as KycQueueRow & { kyc: PublisherKyc };
}

function assertKnownFields(fields: string[]): void {
  const unknown = fields.filter((field) => !PUBLISHER_KYC_DOCUMENT_FIELDS.includes(field));
  if (unknown.length) throw new ApiError(400, 'VALIDATION_ERROR', `Unknown document fields: ${unknown.join(', ')}`);
}

/** PATCH /publishers/kyc-queue/:id/documents/:field — one tile approved or flagged. */
export async function reviewKycDocument(publisherId: string, field: string, input: DocumentDecisionInput, byUserId: string, req?: Request) {
  assertKnownFields([field]);
  const { kyc } = await requireCase(publisherId);
  const review = await recordDocumentReview('PUBLISHER', kyc.id, { field, decision: input.decision, note: input.note ?? null }, byUserId);
  await logActivity(byUserId, 'PUBLISHER_KYC_DOCUMENT_REVIEWED', {
    req,
    targetType: 'Publisher',
    targetId: publisherId,
    module: 'publishers',
    metadata: { kycId: kyc.id, field, decision: input.decision },
  });
  return review;
}

/**
 * POST /publishers/kyc-queue/:id/request-reupload — the flagged fields are
 * recorded, the row and the publisher's mirror go NEEDS_INFO in one
 * transaction, nothing is deleted, and the publisher is told exactly what
 * to send again. A verified publisher has nothing to re-upload.
 */
export async function requestKycReupload(publisherId: string, input: ReuploadRequestInput, byUserId: string, req?: Request) {
  assertKnownFields(input.fields);
  const row = await requireCase(publisherId);
  if (row.kyc.status === 'VERIFIED') {
    throw new ApiError(409, 'CONFLICT', 'This publisher is already verified; there is nothing to re-upload');
  }
  await flagDocuments('PUBLISHER', row.kyc.id, input.fields, input.note, byUserId);
  const updated = await repository.requestKycReupload(publisherId, { reviewedById: byUserId, reviewNote: input.note });
  await logActivity(byUserId, 'PUBLISHER_KYC_REUPLOAD_REQUESTED', {
    req,
    targetType: 'Publisher',
    targetId: publisherId,
    module: 'publishers',
    diff: auditDiff(row.kyc, updated, ['status', 'reviewNote']),
    metadata: { kycId: row.kyc.id, fields: input.fields },
  });
  if (row.userId) {
    await createNotification({
      userId: row.userId,
      type: 'KYC',
      title: 'A few documents need another look',
      subtitle: row.name,
      message: `${input.note} Please re-upload: ${input.fields.join(', ')}.`,
      suggestedAction: 'Re-upload the flagged documents',
      relatedId: publisherId,
      relatedType: 'PUBLISHER',
    });
  }
  return { ...updated, flagged: await flaggedDocuments('PUBLISHER', row.kyc.id) };
}

/**
 * The decision, with who and what. Verifying a manual-path record needs the
 * liveness video (Q131); a rejection needs nothing but its reason. The
 * publisher is told either way when they have an app account.
 */
export async function reviewKyc(
  publisherId: string,
  status: KycStatus,
  rejectionReason: string | undefined,
  reviewer: { userId: string; note?: string | null; req?: Request },
) {
  const row = await requireCase(publisherId);

  if (status === 'VERIFIED' && row.kyc.method !== 'DIGIO') {
    const hasVideo = row.userId ? await hasSubmittedLiveness(row.userId) : false;
    if (!hasVideo) {
      throw new ApiError(
        409,
        'LIVENESS_REQUIRED',
        row.userId
          ? 'Ask the publisher to record the short liveness video before verifying'
          : 'This publisher has not signed in yet, so there is no liveness video to check against',
      );
    }
  }

  const reviewed = await repository.reviewKyc(publisherId, status, rejectionReason, {
    reviewedById: reviewer.userId,
    reviewNote: reviewer.note ?? null,
  });

  await logActivity(reviewer.userId, 'PUBLISHER_KYC_REVIEWED', {
    req: reviewer.req,
    targetType: 'Publisher',
    targetId: publisherId,
    module: 'publishers',
    diff: auditDiff(row.kyc, reviewed, ['status', 'rejectionReason', 'reviewNote']),
    metadata: { kycId: row.kyc.id, status, method: row.kyc.method },
  });

  if (row.userId) {
    // Lot E1/F: one call — the in-app row, and the email and SMS the seeded
    // `kyc-decision` template names (partyName, decision, reason), each
    // subject to the publisher's KYC preference.
    await notify(
      'KYC_DECISION',
      row.userId,
      {
        partyName: row.name,
        decision: status === 'VERIFIED' ? 'verified' : 'not verified',
        reason: status === 'VERIFIED' ? 'Your account is ready to earn.' : (rejectionReason ?? ''),
      },
      {
        inApp: {
          type: 'KYC',
          title: status === 'VERIFIED' ? 'Your KYC is verified' : 'Your KYC did not clear',
          subtitle: row.name,
          message:
            status === 'VERIFIED'
              ? 'ADX has verified your identity. Your account is ready to earn.'
              : `ADX could not verify your identity. ${rejectionReason ?? ''}`.trim(),
          suggestedAction: status === 'VERIFIED' ? 'Open your dashboard' : 'Review your documents and resubmit',
          relatedId: publisherId,
          relatedType: 'PUBLISHER',
        },
      },
    );
  }

  await tellAgentOfDecision(row, reviewed);

  return reviewed;
}

/**
 * Lot F (E7-1): the agent who brought the publisher in is told of the
 * decision — the frames draw it as a modal. E9: the facts the modal prints
 * — `{ publisherId, publisherName, status, decidedAt }` — ride the row's
 * `payload` beside the prose, and `relatedType: PUBLISHER` says what
 * `relatedId` opens. Only when the publisher has an agent; never a failure
 * of the review.
 */
export const KYC_DECISION_AGENT_EVENT = 'KYC_DECISION_AGENT';

export function agentKycDecisionNotice(
  row: Pick<KycQueueRow, 'id' | 'name'>,
  reviewed: Pick<PublisherKyc, 'status' | 'reviewedAt'>,
): Omit<Parameters<typeof createNotification>[0], 'userId'> & { relatedType: 'PUBLISHER'; payload: KycDecisionAgentPayload } {
  const decidedAt = reviewed.reviewedAt ?? new Date();
  const verdict = reviewed.status === 'VERIFIED' ? 'verified' : reviewed.status === 'REJECTED' ? 'rejected' : reviewed.status.toLowerCase().replace(/_/g, ' ');
  return {
    type: 'KYC',
    title: `KYC ${verdict}`,
    subtitle: row.name,
    message: `${row.name}: KYC ${verdict} on ${decidedAt.toISOString().slice(0, 10)}. (${KYC_DECISION_AGENT_EVENT})`,
    suggestedAction: 'Open the publisher',
    relatedId: row.id,
    relatedType: 'PUBLISHER',
    payload: { publisherId: row.id, publisherName: row.name, status: reviewed.status, decidedAt: decidedAt.toISOString() },
  };
}

async function tellAgentOfDecision(row: KycQueueRow, reviewed: PublisherKyc): Promise<void> {
  if (!row.agentId) return;
  try {
    const agent = await getAgentWithUser(row.agentId);
    if (!agent?.userId) return;
    await createNotification({ userId: agent.userId, ...agentKycDecisionNotice(row, reviewed) });
  } catch (err) {
    logger.warn('Could not tell the agent of the KYC decision', { publisherId: row.id, reason: err instanceof Error ? err.message : String(err) });
  }
}

/* ── Lot N: the desk's two new paths ─────────────────────────────────────── */

/**
 * `POST /publishers/kyc-queue/:publisherId/request` — the desk asks the
 * publisher for their KYC. DIGIO opens a Digio session on the publisher's
 * behalf (the same request their phone makes; the link reaches them as the
 * integration sends it, and the initiation stamps `submittedAt` as it
 * always has, so the case sits in the queue as a pending Digio case);
 * MANUAL only tells them. Either way the row is stamped — who asked, when,
 * which channel; the status untouched, REQUESTED being derived as
 * `requestedAt` set and `submittedAt` null — `KYC_REQUESTED` leaves (email,
 * SMS, a push that opens their KYC screen) when the publisher has an app
 * account, and `PUBLISHER_KYC_REQUESTED` is audited. A VERIFIED record is
 * 409 `KYC_ALREADY_VERIFIED`.
 */
export async function requestKycFromDesk(publisherId: string, input: KycRequestInput, byUserId: string, req?: Request, now = new Date()) {
  const row = await repository.findKycDetail(publisherId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (row.kyc?.status === 'VERIFIED' || row.kycStatus === 'VERIFIED') {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This publisher is already verified; there is nothing to request');
  }

  const digio = input.channel === 'DIGIO' ? await initiateDigioKyc(publisherId, row.name, row.email ?? '', row.mobile) : null;
  const kyc = await repository.requestKyc(publisherId, { requestedById: byUserId, requestedChannel: input.channel, at: now });

  await logActivity(byUserId, 'PUBLISHER_KYC_REQUESTED', {
    req,
    targetType: 'Publisher',
    targetId: publisherId,
    module: 'publishers',
    diff: auditDiff(row.kyc ?? {}, kyc, ['requestedAt', 'requestedChannel', 'method']),
    metadata: { kycId: kyc.id, channel: input.channel, note: input.note ?? null, digioKycId: digio?.kycId ?? null },
  });

  if (row.userId) {
    await notify(
      'KYC_REQUESTED',
      row.userId,
      { partyName: row.name, channel: channelLabel(input.channel), note: input.note ?? '', deepLink: KYC_DEEP_LINK },
      {
        inApp: {
          type: 'KYC',
          title: 'Please complete your verification',
          subtitle: row.name,
          message:
            input.channel === 'DIGIO'
              ? `ADX has started a Digio identity check for you. Open the app and finish it — it takes about a minute. ${input.note ?? ''}`.trim()
              : `ADX has asked you to complete your identity verification. ${input.note ?? ''}`.trim(),
          suggestedAction: 'Verify your identity',
          relatedId: publisherId,
          relatedType: 'PUBLISHER',
        },
      },
    );
  }

  return { kyc, digio: digio ? { kycId: digio.kycId, validTill: digio.validTill } : null, notified: Boolean(row.userId) };
}

/**
 * `PUT /publishers/kyc-queue/:publisherId` — recorded at the desk. The same
 * body the agent's on-behalf `POST /publishers/:publisherId/kyc` takes (the
 * files uploaded by the admin under purpose KYC with `ownerUserId` naming
 * the publisher), written with the admin as the recorder: `recordedVia`
 * DESK, `method` MANUAL, PENDING with a fresh `submittedAt` on the row and
 * the mirror. The manifest pin and the per-tile clearing are the same as
 * every other submission; E9's empty-resubmission rule holds while
 * NEEDS_INFO. A VERIFIED record is 409 `KYC_ALREADY_VERIFIED`. Audited
 * `PUBLISHER_KYC_RECORDED_AT_DESK` with the diff.
 */
export async function recordKycAtDesk(
  publisherId: string,
  input: KycDocuments & { manifestVersion?: number | undefined },
  byUserId: string,
  req?: Request,
) {
  const row = await repository.findKycDetail(publisherId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (row.kyc?.status === 'VERIFIED' || row.kycStatus === 'VERIFIED') {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This publisher is already verified; record nothing over it');
  }
  const { docs, manifestVersion } = splitKycSubmission(input);
  assertResubmissionCarriesDocuments(row.kyc, Object.keys(docs));
  const kyc = await repository.submitKyc(publisherId, docs, { recordedById: byUserId, recordedVia: 'DESK', method: 'MANUAL' });
  await pinKycManifest(publisherId, manifestVersion);
  await clearReviewsForResubmission(kyc, Object.keys(docs));
  await logActivity(byUserId, 'PUBLISHER_KYC_RECORDED_AT_DESK', {
    req,
    targetType: 'Publisher',
    targetId: publisherId,
    module: 'publishers',
    diff: auditDiff(row.kyc ?? {}, kyc, ['status', 'method', 'recordedVia', 'recordedById', 'submittedAt', ...Object.keys(docs)]),
    metadata: { kycId: kyc.id, fields: Object.keys(docs) },
  });
  return kyc;
}

/** PATCH /publishers/kyc-queue/:id/assign — a filter, not ownership. */
export async function assignKycCase(publisherId: string, input: AssignCaseInput, byUserId: string, req?: Request) {
  const row = await requireCase(publisherId);
  const adminUserId = input.adminUserId === 'me' ? byUserId : input.adminUserId;
  await repository.assignKyc([publisherId], adminUserId, new Date());
  await logActivity(byUserId, 'PUBLISHER_KYC_ASSIGNED', {
    req,
    targetType: 'Publisher',
    targetId: publisherId,
    module: 'publishers',
    diff: auditDiff({ assignedToId: row.kyc.assignedToId }, { assignedToId: adminUserId }),
  });
  return { publisherId, assignedToId: adminUserId };
}

/**
 * POST /publishers/kyc-queue/:id/escalate — Lot G (Q127/142): the reviewer
 * hands the case to Compliance. The body of it — who it goes to, the audit
 * row, the notice — is `kyc`'s `escalateKyc`; this is the door on the
 * publisher's queue, answering the case as the workbench draws it.
 */
export async function escalateKycCase(publisherId: string, input: KycEscalateInput, byUserId: string, req?: Request) {
  await requireCase(publisherId);
  await escalateKyc({ party: 'PUBLISHER', publisherId }, { reason: input.reason, byUserId, req }, new Date());
  return kycCaseDetail(publisherId);
}

/** POST /publishers/kyc-queue/assign — the same, over a selection. */
export async function assignKycCases(input: BulkAssignInput, byUserId: string, req?: Request) {
  const adminUserId = input.adminUserId === 'me' ? byUserId : input.adminUserId;
  const assigned = await repository.assignKyc(input.ids, adminUserId, new Date());
  await logActivity(byUserId, 'PUBLISHER_KYC_ASSIGNED_BULK', {
    req,
    targetType: 'PublisherKyc',
    module: 'publishers',
    metadata: { ids: input.ids, adminUserId, assigned },
  });
  return { assigned, adminUserId };
}

/** The case as the workbench draws it: the row, every tile's decision, the liveness video. */
export async function kycCaseDetail(publisherId: string, now = new Date()) {
  const row = await repository.findKycDetail(publisherId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  const [documentReviews, liveness, extras] = await Promise.all([
    // E10-1: each tile's decision with who made it, `reviewedBy { id, name }`.
    row.kyc ? listDocumentReviewsWithReviewer('PUBLISHER', row.kyc.id) : Promise.resolve([]),
    row.userId ? livenessStateFor(row.userId) : Promise.resolve(null),
    // E7-3: the age against the SLA (the queue's own rule), the reviewer and the assignee by name.
    kycCaseExtras(row.kyc, now),
  ]);
  return { ...row, documentReviews, liveness, ...extras };
}

/**
 * Lot F: the desk's per-document decisions on a publisher's KYC row, for
 * the reads the agent's capture screen lights its tiles from —
 * `GET /publishers/:publisherId` under a grant. The same rows
 * `publisherKycReviewStateFor` gives the manifest: `flagged` is the
 * re-upload list with the reviewer's note, `documentReviews` every decision.
 */
export async function kycReviewsFor(kyc: Pick<PublisherKyc, 'id'>): Promise<{
  flagged: { field: string; note: string | null }[];
  documentReviews: { field: string; decision: string; note: string | null }[];
}> {
  const rows = await listDocumentReviews('PUBLISHER', kyc.id);
  return {
    flagged: rows.filter((row) => row.decision === 'FLAGGED').map((row) => ({ field: row.field, note: row.note })),
    documentReviews: rows.map((row) => ({ field: row.field, decision: row.decision, note: row.note })),
  };
}

/** A re-upload of a field starts it clean — called after every submission, agent's or owner's. */
export async function clearReviewsForResubmission(kyc: PublisherKyc, fields: string[]): Promise<void> {
  if (fields.length) await clearDocumentReviews('PUBLISHER', kyc.id, fields);
}

/**
 * E9 (the E7 verifier): a NEEDS_INFO case is waiting for documents. A body
 * that names none of the document columns — a type change, a bare manifest
 * pin, nothing at all — is refused 400 `EMPTY_RESUBMISSION` rather than
 * written: it would return the row to PENDING with the same files and clear
 * nothing. Both submit routes (`/me/kyc`, `/:publisherId/kyc`) ask this
 * before they write. The advertiser twin lives in `kyc`.
 */
export function assertResubmissionCarriesDocuments(kyc: { status: KycStatus | string | null } | null | undefined, sent: readonly string[]): void {
  if (kyc?.status !== 'NEEDS_INFO') return;
  if (sent.some((field) => PUBLISHER_KYC_DOCUMENT_FIELDS.includes(field))) return;
  throw new ApiError(400, 'EMPTY_RESUBMISSION', 'Attach at least one of the flagged documents — nothing was sent back for review.', {
    documentFields: [...PUBLISHER_KYC_DOCUMENT_FIELDS],
  });
}

/**
 * Lot F: the submission body split into the columns and the manifest pin.
 * The pin is written once, at the first submission — the version the phone
 * sent, or the live one when it sent none — and never moves.
 */
export function splitKycSubmission<T extends { manifestVersion?: number | undefined }>(
  input: T,
): { docs: Omit<T, 'manifestVersion'>; manifestVersion: number | undefined } {
  const { manifestVersion, ...docs } = input;
  return { docs, manifestVersion };
}

export async function pinKycManifest(publisherId: string, sent: number | undefined): Promise<void> {
  const version = await resolveManifestVersion(sent);
  if (version !== null) await repository.pinKycManifestVersion(publisherId, version);
}

/**
 * What the publisher's own ladder needs to know (Lot D): the status, the
 * method, the flagged documents with the reviewer's note. Null before a first
 * submission. Read by `users` for the manifest's partial mode.
 */
export async function publisherKycReviewStateFor(userId: string) {
  const kyc = await repository.findKycByUserId(userId);
  if (!kyc) return null;
  return {
    status: kyc.status,
    method: kyc.method,
    reviewNote: kyc.reviewNote,
    /** Lot F: the manifest version pinned at the first submission, for the server-side pin. */
    manifestVersion: kyc.manifestVersion ?? null,
    flagged: await flaggedDocuments('PUBLISHER', kyc.id),
  };
}

const IMAGE_COLUMNS = [
  'aadhaarFrontUrl',
  'aadhaarBackUrl',
  'panFrontUrl',
  'panBackUrl',
  'gstUrl',
  'addressProofUrl',
  'bankStatement',
  'govIdFrontUrl',
  'govIdBackUrl',
  'panSignatureUrl',
  'selfieUrl',
  'businessRegCertUrl',
  'directorIdUrl',
  'businessAddressProofUrl',
  'adAuthLetterUrl',
  'ngoRegCertUrl',
  'ngoAddressProofUrl',
  'ngoTaxExemptionCertUrl',
  'ngoOperationalOverviewUrl',
] as const;

/**
 * Lot D (Q127): Digio-path publisher images, purged thirty days after
 * `digioVerifiedAt`. The manual path is never touched by this job — those
 * images stay in private storage until the account closes and its retention
 * runs. What stays: the Digio request and reference ids, the status, when,
 * a trimmed payload, the PAN's last four, and `imagesPurgedAt`.
 */
export async function purgeVerifiedPublisherImages(cutoff: Date, systemUserId: string, limit = 200): Promise<string[]> {
  const rows = await repository.findPurgeableKyc(cutoff, limit);
  const purged: string[] = [];
  for (const row of rows) {
    for (const column of IMAGE_COLUMNS) {
      const fileId = fileIdFromUrl(row[column]);
      if (fileId) await purgeStoredFile(fileId);
    }
    await repository.purgeKycImages(row.id, { panNumber: maskPan(row.panNumber), digioPayload: trimDigioPayload(row.digioPayload) });
    await logActivity(systemUserId, 'KYC_IMAGES_PURGED', {
      targetType: 'Publisher',
      targetId: row.publisherId,
      module: 'publishers',
      metadata: { kycId: row.id, method: row.method, digioVerifiedAt: row.digioVerifiedAt, columns: IMAGE_COLUMNS.length },
    });
    purged.push(row.id);
  }
  return purged;
}

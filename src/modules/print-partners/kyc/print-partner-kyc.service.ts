import type { Request } from 'express';
import { ApiError } from '../../../shared/errors';
import { auditDiff, logActivity } from '../../../shared/audit';
import type { KycStatus } from '../../../shared/database';
import { slaAge, slaCutoff } from '../../../shared/time';
import { kycStateCounts, kycSummaryOf, type KycSummary } from '../../../shared/kyc-state';
import { getPlatformSettings } from '../../app-config';
import {
  clearDocumentReviews,
  escalateKyc,
  flagDocuments,
  flaggedDocuments,
  hasSubmittedLiveness,
  kycCaseExtras,
  kycLabelFor,
  kycUserLabels,
  listDocumentReviewsWithReviewer,
  livenessStateFor,
  maskPan,
  recordDocumentReview,
  trimDigioPayload,
  type AssignCaseInput,
  type DocumentDecisionInput,
  type KycEscalateInput,
  type ReuploadRequestInput,
} from '../../kyc';
import { createNotification, notify } from '../../notifications';
import { fileIdFromUrl, findUploadedFile, purgeStoredFile } from '../../uploads';
import { prismaPrintPartnersRepository as partners } from '../prisma-print-partners.repository';
import type { PartnerRow } from '../print-partners.repository';
import { prismaPrintPartnerKycRepository as repository } from './prisma-print-partner-kyc.repository';
import type { PrintPartnerKycFilter, PrintPartnerKycRow, PrintPartnerKycSort, PrintPartnerKycWithPartner } from './print-partner-kyc.repository';
import { PRINT_PARTNER_KYC_DOCUMENT_FIELDS, type RequestPrintPartnerKycInput, type ReviewPrintPartnerKycInput, type SubmitPrintPartnerKycInput } from './print-partner-kyc.schema';
import { initiatePrintPartnerDigioKyc } from './print-partner-digio.service';

/**
 * The print partner's KYC — Lot N (owner, 14 Sep 2026: "KYC can be done not
 * just by agents or users themselves but also be triggered from the admin
 * panel, and manual KYC too").
 *
 * One record per partner (`PrintPartnerKyc`), the publisher's business
 * branch, reached on three paths:
 *
 *   SELF   the partner on their own phone — `POST /print-partners/me/kyc`
 *          with the documents, or the Digio session from
 *          `POST /print-partners/me/kyc/digio/initiate`;
 *   DESK   an admin recording the documents at the desk —
 *          `PUT /print-partner-kyc/:id` — the same body, `recordedVia: DESK`
 *          and who; the liveness gate is still the partner's own video, or
 *          the admin's presence attestation on the partner's user;
 *   the desk's ASK — `POST /print-partner-kyc/:id/request { channel }`:
 *          the request stamped on the row (made if there is none), a Digio
 *          session opened on the partner's behalf when the channel is
 *          DIGIO, and the partner told (`KYC_REQUESTED`) either way.
 *
 * The review workbench is the advertiser desk's, tile for tile:
 * `KycDocumentReview` with party type PRINT_PARTNER, NEEDS_INFO and the
 * partial resubmission with the `EMPTY_RESUBMISSION` rule, assignment as a
 * filter, escalation through `kyc`, and — decision 131 — no VERIFIED on the
 * manual path until `hasSubmittedLiveness(partner.userId)` says so. Every
 * status write mirrors `PrintPartner.kycStatus` (the repository does it in
 * the same transaction). Every ADMIN write is audited with a diff.
 */

export const PRINT_PARTNER_KYC_PURPOSE = 'PRINT_PARTNER_KYC';

/* ── resolving a case ─────────────────────────────────────────────────── */

/**
 * The desk's `:id` is the KYC record's id, or — so the console can open
 * the desk from the partner page before any record exists — the partner's
 * own id. Both are cuids; the record is tried first.
 */
export async function findCaseByEitherId(id: string): Promise<PrintPartnerKycWithPartner | null> {
  return (await repository.findById(id)) ?? (await repository.findByPartnerId(id));
}

export async function requireCase(id: string): Promise<PrintPartnerKycWithPartner> {
  const row = await findCaseByEitherId(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'KYC record not found');
  return row;
}

/** The partner behind `:id` — a record's id or the partner's — with the record when there is one. */
async function resolvePartner(id: string): Promise<{ partner: PartnerRow; kyc: PrintPartnerKycWithPartner | null }> {
  const kyc = await findCaseByEitherId(id);
  const partner = await partners.findPartner(kyc ? kyc.printPartnerId : id);
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Print partner not found');
  return { partner, kyc };
}

/* ── the rules a submission passes ────────────────────────────────────── */

/**
 * E9's rule, applied to the partner's columns: a NEEDS_INFO case is waiting
 * for documents, and a body naming none of them is refused 400
 * `EMPTY_RESUBMISSION` rather than bouncing the case to PENDING with the
 * same files.
 */
export function assertResubmissionCarriesDocuments(status: KycStatus | string | null | undefined, sent: readonly string[]): void {
  if (status !== 'NEEDS_INFO') return;
  if (sent.some((field) => PRINT_PARTNER_KYC_DOCUMENT_FIELDS.includes(field))) return;
  throw new ApiError(400, 'EMPTY_RESUBMISSION', 'Attach at least one of the flagged documents — nothing was sent back for review.', {
    documentFields: [...PRINT_PARTNER_KYC_DOCUMENT_FIELDS],
  });
}

/**
 * Every document named is a private file uploaded under
 * `PRINT_PARTNER_KYC` — the partner's own, or (at the desk) one the acting
 * admin uploaded on their behalf — named by the URL the upload returned.
 * A public URL, another purpose or somebody else's file is refused.
 */
export async function assertKycDocuments(partner: Pick<PartnerRow, 'userId'>, data: SubmitPrintPartnerKycInput, alsoOwnedBy: string | null = null): Promise<void> {
  for (const field of PRINT_PARTNER_KYC_DOCUMENT_FIELDS) {
    const url = (data as Record<string, unknown>)[field];
    if (typeof url !== 'string') continue;
    const fileId = fileIdFromUrl(url);
    const file = fileId ? await findUploadedFile(fileId) : null;
    const owner = file ? (file.ownerUserId ?? file.userId) : null;
    const allowed = file ? owner === partner.userId || (alsoOwnedBy !== null && (owner === alsoOwnedBy || file.userId === alsoOwnedBy)) : false;
    if (!file || !allowed) {
      throw new ApiError(404, 'NOT_FOUND', `${field}: file not found. Upload it under ${PRINT_PARTNER_KYC_PURPOSE} and send the URL it returned.`, { field });
    }
    if (file.purpose !== PRINT_PARTNER_KYC_PURPOSE) {
      throw new ApiError(400, 'BAD_REQUEST', `${field}: that file was uploaded for ${file.purpose}; upload it with purpose ${PRINT_PARTNER_KYC_PURPOSE}.`, { field });
    }
  }
}

const sentFields = (data: SubmitPrintPartnerKycInput) => Object.keys(data).filter((key) => (data as Record<string, unknown>)[key] !== undefined);

/**
 * N2-B: every write over a record — the desk's and the partner's own — stops
 * at VERIFIED with 409 `KYC_ALREADY_VERIFIED`, the way the publisher's and
 * the advertiser's do. NEEDS_INFO (the desk asking for tiles again) is what
 * reopens it; nothing is written or audited before this check.
 */
export function assertNotVerified(status: KycStatus | string | null | undefined): void {
  if (status !== 'VERIFIED') return;
  throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This partner is already verified; record nothing over it');
}

/* ── SELF: the partner's own ──────────────────────────────────────────── */

/** `GET /print-partners/me/kyc` — the record with the flagged tiles and the liveness state; 404 before a first submission or request. */
export async function getMyPrintPartnerKyc(partner: PartnerRow) {
  const row = await repository.findByPartnerId(partner.id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No KYC record yet');
  const [flagged, liveness, labels] = await Promise.all([flaggedDocuments('PRINT_PARTNER', row.id), livenessStateFor(partner.userId), kycUserLabels([row.requestedById])]);
  const { printPartner: _partner, ...record } = row;
  return { ...record, flagged, liveness, requestedBy: kycLabelFor(labels, row.requestedById) };
}

/**
 * `POST /print-partners/me/kyc` — the first submission and every one after:
 * the columns sent are written, the rest kept, the record goes (back) to
 * PENDING with `recordedVia: SELF`; while NEEDS_INFO the body is partial —
 * only the flagged tiles — and the decisions on the fields sent are cleared.
 * N2-B: a VERIFIED record is refused 409 `KYC_ALREADY_VERIFIED` until the
 * desk moves it to NEEDS_INFO. Audited under the partner's own user.
 */
export async function submitMyPrintPartnerKyc(partner: PartnerRow, input: SubmitPrintPartnerKycInput, req?: Request, now = new Date()) {
  const current = await repository.findByPartnerId(partner.id);
  assertNotVerified(current?.status);
  const fields = sentFields(input);
  assertResubmissionCarriesDocuments(current?.status, fields);
  await assertKycDocuments(partner, input);
  const row = await repository.submit(partner.id, input, { recordedById: partner.userId, recordedVia: 'SELF', method: 'MANUAL' }, now);
  const documents = fields.filter((field) => PRINT_PARTNER_KYC_DOCUMENT_FIELDS.includes(field));
  if (documents.length) await clearDocumentReviews('PRINT_PARTNER', row.id, documents);
  await logActivity(partner.userId, 'PRINT_PARTNER_KYC_SUBMITTED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartnerKyc',
    targetId: row.id,
    diff: auditDiff({ status: current?.status ?? null }, { status: row.status }),
    metadata: { printPartnerId: partner.id, fields, resubmission: current !== null, recordedVia: 'SELF' },
  });
  return row;
}

/* ── the roster ───────────────────────────────────────────────────────── */

/**
 * N3-B: the party read's `kyc` — the six facts every party read carries
 * (`state`, `kycId`, `submittedAt`, `requestedAt`, `requestedChannel`,
 * `method`) plus the record's `status` (null before any record); never
 * null now — a partner with no record is AWAITING_DOCUMENTS, as the queue
 * lists them.
 */
export type PartnerKycSummary = KycSummary & { status: KycStatus | null };

/**
 * The columns the partner's own read (`GET /print-partners/me`, N2-B), the
 * desk's partner read and the roster rows carry — one lookup for a page;
 * N3-B: derived the way the queue derives them, so the partner page and the
 * queue agree.
 */
export async function withKycSummary<T extends Pick<PartnerRow, 'id' | 'kycStatus'>>(rows: readonly T[]): Promise<(T & { kyc: PartnerKycSummary })[]> {
  const summaries = new Map((await repository.findSummaries(rows.map((row) => row.id))).map((row) => [row.printPartnerId, row]));
  return rows.map((row) => {
    const summary = summaries.get(row.id) ?? null;
    return { ...row, kyc: { ...kycSummaryOf(summary, row.kycStatus), status: summary?.status ?? null } };
  });
}

/* ── the desk: the queue and the case ─────────────────────────────────── */

/**
 * `GET /print-partner-kyc` — the advertiser queue's contract: every row
 * with its age against the review SLA, the people on it by name; `counts`
 * per state over the filter with the state facet removed, `breached`,
 * `escalated` and (Lot N) `requested` across the queue; late rows first
 * unless `newest` is asked for. N3-B: the queue lists PARTIES — every
 * print partner, in one of six states from the moment the account exists.
 */
export async function listPrintPartnerKycQueue(where: PrintPartnerKycFilter, page: number, pageSize: number, sort?: PrintPartnerKycSort, now = new Date()) {
  const { reviewSlaHours } = (await getPlatformSettings()).kyc;
  const [{ items, total }, breached, stateCounts, escalated, requested] = await Promise.all([
    repository.findPage(where, page, pageSize, sort),
    repository.countBreached(where, slaCutoff(reviewSlaHours, now)),
    repository.countByState({ ...where, state: undefined, status: undefined }),
    repository.countEscalated(where),
    repository.countRequested(where),
  ]);
  const labels = await kycUserLabels(items.flatMap((item) => [item.assignedToId, item.escalatedToUserId, item.escalatedById, item.requestedById, item.recordedById]));
  return {
    items: items.map((item) => ({
      ...item,
      ...slaAge(item.status === 'PENDING' ? item.submittedAt : null, reviewSlaHours, now),
      requested: item.requestedAt !== null && item.submittedAt === null,
      assignedTo: kycLabelFor(labels, item.assignedToId),
      escalatedTo: kycLabelFor(labels, item.escalatedToUserId),
      escalatedBy: kycLabelFor(labels, item.escalatedById),
      requestedBy: kycLabelFor(labels, item.requestedById),
      recordedBy: kycLabelFor(labels, item.recordedById),
    })),
    total,
    page,
    pageSize,
    counts: { ...kycStateCounts(stateCounts), escalated, requested },
    breached,
    escalated,
    requested,
    slaHours: reviewSlaHours,
  };
}

/** `GET /print-partner-kyc/:id` — the case as the workbench draws it. */
export async function getPrintPartnerKycCase(id: string, now = new Date()) {
  const row = await requireCase(id);
  const [documentReviews, liveness, extras, labels] = await Promise.all([
    listDocumentReviewsWithReviewer('PRINT_PARTNER', row.id),
    livenessStateFor(row.printPartner.userId),
    kycCaseExtras(row, now),
    kycUserLabels([row.requestedById]),
  ]);
  return {
    ...row,
    documentReviews,
    liveness,
    ...extras,
    requested: row.requestedAt !== null && row.submittedAt === null,
    requestedBy: kycLabelFor(labels, row.requestedById),
  };
}

/* ── the desk: recording and asking ───────────────────────────────────── */

/**
 * `PUT /print-partner-kyc/:id` — the desk records the documents on the
 * partner's behalf: the same body as the partner's own submission, the
 * files the partner's own or the admin's upload on their behalf, the record
 * (back) to PENDING with `recordedVia: DESK` and who. N2-B: a VERIFIED
 * record — reached by its id or the partner's — is refused 409
 * `KYC_ALREADY_VERIFIED` before anything is written. Audited
 * `PRINT_PARTNER_KYC_RECORDED_AT_DESK` with the diff.
 */
export async function recordPrintPartnerKycAtDesk(id: string, input: SubmitPrintPartnerKycInput, byUserId: string, req?: Request, now = new Date()) {
  const { partner, kyc } = await resolvePartner(id);
  assertNotVerified(kyc?.status);
  const fields = sentFields(input);
  assertResubmissionCarriesDocuments(kyc?.status, fields);
  await assertKycDocuments(partner, input, byUserId);
  const row = await repository.submit(partner.id, input, { recordedById: byUserId, recordedVia: 'DESK', method: 'MANUAL' }, now);
  const documents = fields.filter((field) => PRINT_PARTNER_KYC_DOCUMENT_FIELDS.includes(field));
  if (documents.length) await clearDocumentReviews('PRINT_PARTNER', row.id, documents);
  await logActivity(byUserId, 'PRINT_PARTNER_KYC_RECORDED_AT_DESK', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartnerKyc',
    targetId: row.id,
    diff: auditDiff(kyc ?? { status: null, recordedVia: null, submittedAt: null }, row, ['status', 'recordedVia', 'recordedById', 'submittedAt']),
    metadata: { printPartnerId: partner.id, fields, recordedVia: 'DESK' },
  });
  return getPrintPartnerKycCase(row.id, now);
}

/** The in-app deep link the request's push opens — the partner's KYC screen. */
export const PRINT_PARTNER_KYC_DEEP_LINK = 'adx://partner/kyc';

/**
 * `POST /print-partner-kyc/:id/request { channel, note? }` — the desk asks
 * the partner for their KYC. The row is made if there is none and stamped
 * `requestedAt` / `requestedById` / `requestedChannel`; for DIGIO a session
 * is opened on the partner's behalf (the link goes to the partner, not the
 * admin; `submittedAt` waits for the webhook); either way the partner is
 * told through `KYC_REQUESTED` — email, SMS, push and the in-app row — with
 * the note. Refused 409 `KYC_ALREADY_VERIFIED` on a verified record.
 * Audited `PRINT_PARTNER_KYC_REQUESTED`.
 */
export async function requestPrintPartnerKyc(id: string, input: RequestPrintPartnerKycInput, byUserId: string, req?: Request, now = new Date()) {
  const { partner, kyc } = await resolvePartner(id);
  if (kyc?.status === 'VERIFIED') {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This partner is already verified; there is nothing to request');
  }
  const stamped = await repository.markRequested(partner.id, { requestedAt: now, requestedById: byUserId, requestedChannel: input.channel });
  const session = input.channel === 'DIGIO' ? await initiatePrintPartnerDigioKyc(partner, { onBehalf: true }, now) : null;

  await logActivity(byUserId, 'PRINT_PARTNER_KYC_REQUESTED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartnerKyc',
    targetId: stamped.id,
    diff: auditDiff(
      { requestedAt: kyc?.requestedAt ?? null, requestedChannel: kyc?.requestedChannel ?? null },
      { requestedAt: stamped.requestedAt, requestedChannel: stamped.requestedChannel },
    ),
    metadata: { printPartnerId: partner.id, channel: input.channel, note: input.note ?? null, digioKycId: session?.kycId ?? null },
  });

  const channelLine = input.channel === 'DIGIO' ? 'Digio has sent you a link — finish the check there, or open the app.' : 'Open the ADX app and upload your documents.';
  await notify(
    'KYC_REQUESTED',
    partner.userId,
    {
      partyName: partner.name,
      channel: input.channel === 'DIGIO' ? 'Digio' : 'document upload',
      note: input.note ?? '',
      deepLink: PRINT_PARTNER_KYC_DEEP_LINK,
    },
    {
      inApp: {
        type: 'KYC',
        title: 'ADX has asked for your KYC',
        subtitle: partner.name,
        message: `${channelLine}${input.note ? ` ${input.note}` : ''}`.trim(),
        suggestedAction: 'Open KYC',
        relatedId: stamped.id,
      },
    },
  );

  return { ...(await getPrintPartnerKycCase(stamped.id, now)), digio: session ? { kycId: session.kycId, validTill: session.validTill } : null };
}

/* ── the desk: the decision ───────────────────────────────────────────── */

/**
 * `PATCH /print-partner-kyc/:id/review` — the decision, with who and what.
 * Verifying a manual-path record needs the liveness proof on the partner's
 * user (decision 131; the Digio path is exempt); a rejection needs its
 * reason (the schema). The escalation clears with the decision; the
 * partner is told through `KYC_DECISION`. Audited `PRINT_PARTNER_KYC_REVIEWED`.
 */
export async function reviewPrintPartnerKyc(id: string, input: ReviewPrintPartnerKycInput, reviewer: { userId: string; req?: Request }, now = new Date()) {
  const row = await requireCase(id);
  if (input.status === 'VERIFIED' && row.method !== 'DIGIO' && !(await hasSubmittedLiveness(row.printPartner.userId))) {
    throw new ApiError(409, 'LIVENESS_REQUIRED', 'Ask the partner to record the short liveness video — or attest their presence at the desk — before verifying');
  }
  const reviewed = await repository.review(row.id, input.status, input.rejectionReason ?? null, { reviewedById: reviewer.userId, reviewNote: input.reviewNote ?? null }, now);

  await logActivity(reviewer.userId, 'PRINT_PARTNER_KYC_REVIEWED', {
    req: reviewer.req,
    module: 'print-partners',
    targetType: 'PrintPartnerKyc',
    targetId: row.id,
    diff: auditDiff(row, reviewed, ['status', 'rejectionReason', 'reviewNote']),
    metadata: { printPartnerId: row.printPartnerId, status: input.status, method: row.method },
  });

  await notify(
    'KYC_DECISION',
    row.printPartner.userId,
    {
      partyName: row.printPartner.name,
      decision: input.status === 'VERIFIED' ? 'verified' : 'not verified',
      reason: input.status === 'VERIFIED' ? 'Your shop can be paid for print jobs.' : (input.rejectionReason ?? ''),
    },
    {
      inApp: {
        type: 'KYC',
        title: input.status === 'VERIFIED' ? 'Your KYC is verified' : 'Your KYC did not clear',
        subtitle: row.printPartner.name,
        message:
          input.status === 'VERIFIED'
            ? 'ADX has verified your identity. Your shop can be paid for print jobs.'
            : `ADX could not verify your identity. ${input.rejectionReason ?? ''}`.trim(),
        suggestedAction: input.status === 'VERIFIED' ? 'Open your floor' : 'Review your documents and resubmit',
        relatedId: row.id,
      },
    },
  );

  return reviewed;
}

/* ── the desk: per document, assignment, escalation ───────────────────── */

function assertKnownFields(fields: readonly string[]): void {
  const unknown = fields.filter((field) => !PRINT_PARTNER_KYC_DOCUMENT_FIELDS.includes(field));
  if (unknown.length) throw new ApiError(400, 'VALIDATION_ERROR', `Unknown document fields: ${unknown.join(', ')}`);
}

/** `PATCH /print-partner-kyc/:id/documents/:field` — one tile approved or flagged. */
export async function reviewPrintPartnerDocument(id: string, field: string, input: DocumentDecisionInput, byUserId: string, req?: Request) {
  assertKnownFields([field]);
  const row = await requireCase(id);
  const review = await recordDocumentReview('PRINT_PARTNER', row.id, { field, decision: input.decision, note: input.note ?? null }, byUserId);
  await logActivity(byUserId, 'PRINT_PARTNER_KYC_DOCUMENT_REVIEWED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartnerKyc',
    targetId: row.id,
    diff: auditDiff({ [field]: null }, { [field]: input.decision }),
    metadata: { printPartnerId: row.printPartnerId, field, decision: input.decision, note: input.note ?? null },
  });
  return review;
}

/**
 * `POST /print-partner-kyc/:id/request-reupload` — the flagged fields are
 * recorded, the record goes NEEDS_INFO (the mirror too), nothing is
 * deleted, and the partner is told exactly what to send again.
 */
export async function requestPrintPartnerReupload(id: string, input: ReuploadRequestInput, byUserId: string, req?: Request, now = new Date()) {
  assertKnownFields(input.fields);
  const row = await requireCase(id);
  if (row.status === 'VERIFIED') {
    throw new ApiError(409, 'CONFLICT', 'This partner is already verified; there is nothing to re-upload');
  }
  await flagDocuments('PRINT_PARTNER', row.id, input.fields, input.note, byUserId);
  const updated = await repository.requestReupload(row.id, { reviewedById: byUserId, reviewNote: input.note }, now);
  await logActivity(byUserId, 'PRINT_PARTNER_KYC_REUPLOAD_REQUESTED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartnerKyc',
    targetId: row.id,
    diff: auditDiff(row, updated, ['status', 'reviewNote']),
    metadata: { printPartnerId: row.printPartnerId, fields: input.fields },
  });
  await createNotification({
    userId: row.printPartner.userId,
    type: 'KYC',
    title: 'A few documents need another look',
    subtitle: row.printPartner.name,
    message: `${input.note} Please re-upload: ${input.fields.join(', ')}.`,
    suggestedAction: 'Re-upload the flagged documents',
    relatedId: row.id,
  });
  return { ...updated, flagged: await flaggedDocuments('PRINT_PARTNER', row.id) };
}

/** `PATCH /print-partner-kyc/:id/assign` — a filter, not ownership; any admin may still decide. */
export async function assignPrintPartnerCase(id: string, input: AssignCaseInput, byUserId: string, req?: Request, now = new Date()) {
  const row = await requireCase(id);
  const adminUserId = input.adminUserId === 'me' ? byUserId : input.adminUserId;
  await repository.assign(row.id, adminUserId, now);
  await logActivity(byUserId, 'PRINT_PARTNER_KYC_ASSIGNED', {
    req,
    module: 'print-partners',
    targetType: 'PrintPartnerKyc',
    targetId: row.id,
    diff: auditDiff({ assignedToId: row.assignedToId }, { assignedToId: adminUserId }),
    metadata: { printPartnerId: row.printPartnerId },
  });
  return getPrintPartnerKycCase(row.id, now);
}

/** `POST /print-partner-kyc/:id/escalate` — the reviewer hands the case to Compliance; the body of it is `kyc`'s. */
export async function escalatePrintPartnerCase(id: string, input: KycEscalateInput, byUserId: string, req?: Request, now = new Date()) {
  const row = await requireCase(id);
  await escalateKyc({ party: 'PRINT_PARTNER', kycId: row.id }, { reason: input.reason, byUserId, req }, now);
  return getPrintPartnerKycCase(row.id, now);
}

/* ── the purge (Lot D, Q127 — applied to the third party) ─────────────── */

/**
 * Digio-path partner images, purged thirty days after `digioVerifiedAt` —
 * the private files removed, the URL columns nulled, the PAN masked to its
 * last four, the payload trimmed, `imagesPurgedAt` stamped,
 * `KYC_IMAGES_PURGED` written against the record. The manual path is never
 * touched by the job. Called by `jobs/kyc-purge.job.ts`.
 */
export async function purgeVerifiedPrintPartnerImages(cutoff: Date, systemUserId: string, limit = 200): Promise<string[]> {
  const rows = await repository.findPurgeable(cutoff, limit);
  const purged: string[] = [];
  for (const row of rows) {
    for (const column of PRINT_PARTNER_KYC_DOCUMENT_FIELDS) {
      const fileId = fileIdFromUrl((row as PrintPartnerKycRow & Record<string, unknown>)[column] as string | null);
      if (fileId) await purgeStoredFile(fileId);
    }
    await repository.purgeImages(row.id, { panNumber: maskPan(row.panNumber), digioPayload: trimDigioPayload(row.digioPayload) });
    await logActivity(systemUserId, 'KYC_IMAGES_PURGED', {
      targetType: 'PrintPartnerKyc',
      targetId: row.id,
      module: 'print-partners',
      metadata: { printPartnerId: row.printPartnerId, method: row.method, digioVerifiedAt: row.digioVerifiedAt, columns: PRINT_PARTNER_KYC_DOCUMENT_FIELDS.length },
    });
    purged.push(row.id);
  }
  return purged;
}

import { logActivity } from '../../../shared/audit';
import type { AgreementKind, SigningParty, SigningStatus } from '../../../shared/database';
import { ApiError } from '../../../shared/errors';
import { env } from '../../../config/env';
import { logger } from '../../../shared/logging';
import type { Page, PageQuery } from '../../../shared/pagination';
import type { EsignPolicy, SigningDocument } from '../../../shared/esign';
import { getEffectiveEsignConfig } from '../../../shared/integrations/integration-config';
import {
  cancelEsignRequest,
  createEsignRequest,
  downloadAuditCertificate,
  downloadSignedPdf,
  fetchEsignDocument,
  parseEsignWebhook,
  remindEsignSigners,
  type EsignDocument,
  type EsignSigner,
  type EsignSignType,
} from '../../../shared/integrations/digio-esign';
import { storeGeneratedFile } from '../../uploads';
import { prismaAgreementsRepository as agreements } from '../prisma-agreements.repository';
import { KIND_META, renderInsertionOrder } from '../agreements.service';
import type { PartyType } from '../agreements.repository';
import { esignPolicy, runCompletionHooks, sendEsignMessage } from './esign.ports';
import { mergeFields, renderAgreementPdf, renderListingSchedule } from './esign.render';
import { prismaEsignRepository as repository } from './prisma-esign.repository';
import type { PartySigner, SignerState, SigningFilter, SigningRow } from './esign.repository';

/**
 * DS-1 (Digio eSign, 22 Sep 2026): e-signatures on the five documents the
 * owner named, beside the click acceptances that stand everywhere else.
 *
 * What one request is: the live template of a kind, filled in for one party
 * and rendered to a PDF ADX keeps; the party (and, DS-4, ADX after them)
 * asked to sign it through Digio; the provider's answer — a webhook, or a
 * refresh when the phone polls — recorded on the row; on completion the
 * signed PDF and the audit certificate stored privately, the acceptance row
 * written for the three parties that have one (`signatureProvider` DIGIO,
 * `signatureRef` the request), and whatever the owning module asked to
 * follow (an employee's console invitation) run through its hook.
 *
 * What a gate asks is `signingStanding(...)`: required (the policy says this
 * document is signed, and — for an insertion order — the campaign is big
 * enough), and satisfied (a COMPLETED request on the live version, or on
 * any version when re-signing is not enforced). `assertSigned` turns an
 * unsatisfied standing into 403 SIGNATURE_REQUIRED carrying the open
 * request, so the app sends the party to the signing screen.
 *
 * The policy off (the default) makes every document "not required": the
 * click acceptances are exactly what they were before this lot.
 */

/* ------------------------------------------------------------------ */
/* Kinds                                                               */
/* ------------------------------------------------------------------ */

/** Which policy switch each signable kind answers to. */
export const DOCUMENT_OF: Partial<Record<AgreementKind, SigningDocument>> = {
  AGENT_PUBLISHER_PLATFORM: 'AGENT_ENGAGEMENT',
  AGENT_ADVERTISER_PLATFORM: 'AGENT_ENGAGEMENT',
  EMPLOYEE_APPOINTMENT: 'EMPLOYEE_APPOINTMENT',
  PRINT_PARTNER_SERVICE: 'PRINT_PARTNER_SERVICE',
  PUBLISHER_LICENCE: 'PUBLISHER_LICENCE',
  INSERTION_ORDER: 'INSERTION_ORDER',
};

export const SIGNABLE_KINDS = Object.keys(DOCUMENT_OF) as AgreementKind[];

/** The party a signable kind binds, in the SigningRequest's vocabulary. */
export const SIGNING_PARTY_OF: Partial<Record<AgreementKind, SigningParty>> = {
  AGENT_PUBLISHER_PLATFORM: 'AGENT',
  AGENT_ADVERTISER_PLATFORM: 'AGENT',
  EMPLOYEE_APPOINTMENT: 'EMPLOYEE',
  PRINT_PARTNER_SERVICE: 'PRINT_PARTNER',
  PUBLISHER_LICENCE: 'PUBLISHER',
  INSERTION_ORDER: 'ADVERTISER',
};

const ACCEPTANCE_PARTY: Partial<Record<SigningParty, PartyType>> = { PUBLISHER: 'publisher', ADVERTISER: 'advertiser', AGENT: 'agent' };

const OPEN: SigningStatus[] = ['REQUESTED', 'PARTIALLY_SIGNED'];

const SIGN_TYPE: Record<EsignPolicy['signMethod'], EsignSignType> = { AADHAAR: 'aadhaar', DSC: 'dsc', ELECTRONIC: 'electronic' };

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

export type SigningView = {
  id: string;
  kind: AgreementKind;
  document: SigningDocument | null;
  label: string;
  title: string;
  templateVersion: number;
  partyType: SigningParty;
  partyId: string;
  campaignId: string | null;
  attemptId: string | null;
  status: SigningStatus;
  mock: boolean;
  signer: { name: string; identifier: string; userId: string | null };
  signers: SignerState[];
  signMethod: string;
  signingUrl: string | null;
  countersign: boolean;
  stamp: { state: string; amount: string; ref: string | null } | null;
  files: { document: string | null; signed: string | null; certificate: string | null };
  requestedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  failureReason: string | null;
  lastReminderAt: Date | null;
  providerRef: string | null;
};

export function signingView(row: SigningRow): SigningView {
  return {
    id: row.id,
    kind: row.kind,
    document: DOCUMENT_OF[row.kind] ?? null,
    label: KIND_META[row.kind].label,
    title: row.template.title,
    templateVersion: row.templateVersion,
    partyType: row.partyType,
    partyId: row.partyId,
    campaignId: row.campaignId,
    attemptId: row.attemptId,
    status: row.status,
    mock: row.mock,
    signer: { name: row.signerName, identifier: row.signerIdentifier, userId: row.signerUserId },
    signers: (row.signers as SignerState[]) ?? [],
    signMethod: row.signMethod,
    signingUrl: row.signingUrl,
    countersign: row.countersign,
    stamp: row.stampState ? { state: row.stampState, amount: row.stampAmount?.toString() ?? '0', ref: row.stampRef } : null,
    files: { document: row.documentFileId, signed: row.signedFileId, certificate: row.certificateFileId },
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    completedAt: row.completedAt,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    failureReason: row.failureReason,
    lastReminderAt: row.lastReminderAt,
    providerRef: row.providerRef,
  };
}

/* ------------------------------------------------------------------ */
/* The policy's answer                                                 */
/* ------------------------------------------------------------------ */

export type SigningContext = {
  /** INSERTION_ORDER: the campaign's total, against the threshold. */
  campaignTotal?: number | string | null | undefined;
  /** INSERTION_ORDER: the advertiser's band, against the list. */
  band?: string | null | undefined;
};

/** Whether this kind must be e-signed rather than clicked, for this party, under the policy now. */
export async function signingRequired(kind: AgreementKind, context: SigningContext = {}, policy?: EsignPolicy): Promise<boolean> {
  const document = DOCUMENT_OF[kind];
  if (!document) return false;
  const current = policy ?? (await esignPolicy());
  if (!current.enabled || !current.documents[document]) return false;
  if (kind !== 'INSERTION_ORDER') return true;
  const total = Number(context.campaignTotal ?? 0);
  if (Number.isFinite(total) && total >= current.insertionOrder.valueThreshold) return true;
  return Boolean(context.band && (current.insertionOrder.bands as string[]).includes(context.band));
}

export type SigningStanding = {
  kind: AgreementKind;
  required: boolean;
  satisfied: boolean;
  status: SigningStatus | null;
  currentVersion: number | null;
  request: SigningView | null;
};

/** Where a party stands on a signed document: what every gate reads. */
export async function signingStanding(
  partyType: SigningParty,
  partyId: string,
  kind: AgreementKind,
  anchor?: { campaignId?: string | null; attemptId?: string | null },
  context: SigningContext = {},
): Promise<SigningStanding> {
  const policy = await esignPolicy();
  // The rail off is the common case and costs no read: nothing is required, nothing is shown.
  if (!policy.enabled) return { kind, required: false, satisfied: true, status: null, currentVersion: null, request: null };
  const [required, latest, template] = await Promise.all([signingRequired(kind, context, policy), repository.latestFor(partyType, partyId, kind, anchor), agreements.activeTemplate(kind)]);
  const signedCurrent = Boolean(latest && latest.status === 'COMPLETED' && (!policy.resignOnNewVersion || !template || latest.templateId === template.id));
  return {
    kind,
    required,
    satisfied: !required || signedCurrent,
    status: latest?.status ?? null,
    currentVersion: template?.version ?? null,
    request: latest ? signingView(latest) : null,
  };
}

/** 403 SIGNATURE_REQUIRED with the open request in `details.signing`, or nothing. */
export function assertSigned(standing: SigningStanding, what = 'This step'): void {
  if (standing.satisfied) return;
  throw new ApiError(403, 'SIGNATURE_REQUIRED', `${what} needs the ${KIND_META[standing.kind].label.toLowerCase()} signed first`, { signing: standing.request, kind: standing.kind });
}

/* ------------------------------------------------------------------ */
/* Opening a request                                                   */
/* ------------------------------------------------------------------ */

export type OpenSigningInput = {
  kind: AgreementKind;
  partyType: SigningParty;
  partyId: string;
  /** Who asked — the desk's admin, or null when the platform opened it on an event (a KYC webhook). */
  requestedById?: string | null | undefined;
  anchor?: { campaignId?: string | null | undefined; attemptId?: string | null | undefined } | undefined;
  /** What the owning module wants once it is signed, handed back to its completion hook. */
  followUp?: unknown;
  /** Merge fields beyond what the party record carries. */
  fields?: Record<string, string> | undefined;
  /** Under the title on the paper. */
  subtitle?: string | null | undefined;
  context?: SigningContext | undefined;
  /** Open even when the policy would not require it — the desk's own "send for signature". */
  force?: boolean | undefined;
};

const shortKind: Record<string, string> = {
  AGENT_PUBLISHER_PLATFORM: 'AGF',
  AGENT_ADVERTISER_PLATFORM: 'AGS',
  EMPLOYEE_APPOINTMENT: 'EMP',
  PRINT_PARTNER_SERVICE: 'PRT',
  PUBLISHER_LICENCE: 'LIC',
  INSERTION_ORDER: 'IO',
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const dateIST = (at: Date) => {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
};

/** Digio takes one identifier: the email where there is one, else the ten-digit mobile. */
function identifierOf(signer: PartySigner): string {
  if (signer.email) return signer.email.trim().toLowerCase();
  if (signer.mobile) return signer.mobile.replace(/\D/g, '').slice(-10);
  throw new ApiError(400, 'VALIDATION_ERROR', `${signer.partyName} has no email or mobile to send the signing link to`);
}

function stampFor(policy: EsignPolicy, document: SigningDocument, state: string | null): EsignPolicy['stampDuty'][number] | null {
  if (!state) return null;
  const code = state.trim().toUpperCase();
  return policy.stampDuty.find((row) => row.document === document && (row.state === code || row.state === STATE_CODES[code])) ?? null;
}

/** The state names the party rows carry, to the ISO codes the stamp table uses. */
const STATE_CODES: Record<string, string> = {
  KARNATAKA: 'KA',
  MAHARASHTRA: 'MH',
  DELHI: 'DL',
  'TAMIL NADU': 'TN',
  TELANGANA: 'TG',
  'ANDHRA PRADESH': 'AP',
  KERALA: 'KL',
  GUJARAT: 'GJ',
  RAJASTHAN: 'RJ',
  'UTTAR PRADESH': 'UP',
  'WEST BENGAL': 'WB',
  'MADHYA PRADESH': 'MP',
  HARYANA: 'HR',
  PUNJAB: 'PB',
  BIHAR: 'BR',
  ODISHA: 'OR',
  GOA: 'GA',
};

/**
 * Open (or find) the signing request for a party and kind. Idempotent: an
 * open request on the live version is returned as it is; a completed one
 * on the live version (or on any version while re-signing is not enforced)
 * is returned too, `created: false`. Anything else — nothing yet, an
 * expired or voided one, a completed one on an older version that must be
 * re-signed — opens a new request.
 */
export async function openSigningRequest(input: OpenSigningInput, now = new Date()): Promise<{ request: SigningRow; created: boolean }> {
  const document = DOCUMENT_OF[input.kind];
  if (!document || SIGNING_PARTY_OF[input.kind] !== input.partyType) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${KIND_META[input.kind].label} is not e-signed by a ${input.partyType.toLowerCase().replace('_', ' ')}`);
  }
  const policy = await esignPolicy();
  if (!input.force && !(await signingRequired(input.kind, input.context, policy))) {
    throw new ApiError(409, 'SIGNING_NOT_OPEN', `${KIND_META[input.kind].label} is not e-signed under the current policy`);
  }
  const template = await agreements.activeTemplate(input.kind);
  if (!template) throw new ApiError(503, 'NO_ACTIVE_TEMPLATE', `No ${KIND_META[input.kind].label.toLowerCase()} is published yet`);

  const latest = await repository.latestFor(input.partyType, input.partyId, input.kind, input.anchor);
  if (latest && OPEN.includes(latest.status) && latest.templateId === template.id) return { request: latest, created: false };
  if (latest && latest.status === 'COMPLETED' && (latest.templateId === template.id || !policy.resignOnNewVersion)) return { request: latest, created: false };

  const signer = await repository.partySigner(input.partyType, input.partyId);
  if (!signer) throw new ApiError(404, 'NOT_FOUND', `${input.partyType.toLowerCase().replace('_', ' ')} not found`);
  const identifier = identifierOf(signer);
  const byUserId = input.requestedById ?? signer.signerUserId;
  if (!byUserId) throw new ApiError(400, 'VALIDATION_ERROR', `${signer.partyName} has no account to hold the document; open it from the desk`);

  const reference = `ADX-SIGN-${shortKind[input.kind] ?? 'DOC'}-${now.getTime().toString(36).toUpperCase()}`;
  const fields: Record<string, string> = {
    'party.name': signer.partyName,
    'party.displayId': signer.displayId ?? '',
    'party.signer': signer.signerName,
    'party.email': signer.email ?? '',
    'party.mobile': signer.mobile ?? '',
    'party.city': signer.city ?? '',
    'party.state': signer.state ?? '',
    date: dateIST(now),
    reference,
    'template.version': String(template.version),
    ...signer.fields,
    ...(input.fields ?? {}),
  };

  // The enumerations the two transaction-shaped kinds carry.
  let body = template.body;
  let subtitle = input.subtitle ?? null;
  if (input.kind === 'INSERTION_ORDER') {
    const campaignId = input.anchor?.campaignId;
    if (!campaignId) throw new ApiError(400, 'VALIDATION_ERROR', 'An insertion order is signed per campaign');
    const campaign = await agreements.campaignForInsertionOrder(campaignId);
    if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
    if (campaign.advertiserId !== input.partyId) throw new ApiError(403, 'FORBIDDEN', 'That campaign is not this advertiser’s');
    body = renderInsertionOrder(body, campaign);
    subtitle = subtitle ?? `Insertion order for campaign ${campaign.reference} — ${campaign.name}`;
  } else if (input.kind === 'PUBLISHER_LICENCE') {
    const schedule = renderListingSchedule(await repository.publisherListings(input.partyId));
    body = body.includes('{{listings}}') ? body.replace('{{listings}}', schedule) : `${body}\n\n## Schedule A\n\n${schedule}`;
  }
  const rendered = mergeFields(body, fields);

  const wire = await getEffectiveEsignConfig();
  const countersign = policy.countersign && Boolean(wire.adxSignerIdentifier);
  const signers: SignerState[] = [
    { role: 'PARTY', name: signer.signerName, identifier, status: 'requested', signedAt: null },
    ...(countersign ? [{ role: 'ADX' as const, name: wire.adxSignerName ?? 'ADX', identifier: wire.adxSignerIdentifier!, status: 'requested' as const, signedAt: null }] : []),
  ];
  const stamp = stampFor(policy, document, signer.state);

  const pdf = await renderAgreementPdf(
    { title: template.title, kindLabel: KIND_META[input.kind].label, version: template.version, reference, partyName: signer.partyName, partyDisplayId: signer.displayId, date: fields.date!, subtitle },
    rendered,
    signers,
  );
  const documentFile = await storeGeneratedFile(byUserId, {
    content: pdf,
    filename: `${reference}.pdf`,
    mimeType: 'application/pdf',
    purpose: 'SIGNED_AGREEMENT',
    ownerUserId: signer.signerUserId,
  });

  const providerSigners: EsignSigner[] = signers.map((s) => ({
    identifier: s.identifier,
    name: s.name,
    reason: s.role === 'ADX' ? `Countersigning the ${KIND_META[input.kind].label.toLowerCase()}` : `Signing the ${KIND_META[input.kind].label.toLowerCase()} with ADX`,
    signType: s.role === 'ADX' ? 'dsc' : SIGN_TYPE[policy.signMethod],
  }));
  const provider = await createEsignRequest({
    referenceId: reference,
    fileName: `${reference}.pdf`,
    pdf,
    signers: providerSigners,
    expireInDays: policy.expireInDays,
    sequential: signers.length > 1,
    notifySigners: policy.notifyThroughDigio,
    displayOnPage: 'last',
    ...(stamp ? { stamp: { state: stamp.state, amount: stamp.amount, ...(stamp.article ? { article: stamp.article } : {}), firstParty: 'ADX (Keysquare Technologies)', secondParty: signer.partyName } } : {}),
  });

  const request = await repository.create({
    kind: input.kind,
    templateId: template.id,
    templateVersion: template.version,
    partyType: input.partyType,
    partyId: input.partyId,
    signerUserId: signer.signerUserId,
    signerName: signer.signerName,
    signerIdentifier: identifier,
    signMethod: policy.signMethod,
    campaignId: input.anchor?.campaignId ?? null,
    attemptId: input.anchor?.attemptId ?? null,
    status: 'REQUESTED',
    providerRef: provider.id,
    mock: provider.mock,
    signers: mergeSignerStates(signers, provider),
    signingUrl: provider.signingUrls[identifier] ?? null,
    renderedDocument: rendered,
    documentFileId: documentFile.id,
    stampState: stamp?.state ?? null,
    stampAmount: stamp ? String(stamp.amount) : null,
    stampRef: provider.stampRef,
    countersign,
    followUp: input.followUp ?? null,
    providerPayload: provider.raw,
    requestedById: input.requestedById ?? null,
    expiresAt: new Date(now.getTime() + policy.expireInDays * 24 * 60 * 60 * 1000),
  });

  await logActivity(byUserId, 'AGREEMENT_SIGNATURE_REQUESTED', {
    targetType: 'SigningRequest',
    targetId: request.id,
    module: 'agreements',
    metadata: { kind: input.kind, partyType: input.partyType, partyId: input.partyId, providerRef: provider.id, mock: provider.mock, reference },
  });
  await sendEsignMessage({ event: 'AGREEMENT_SIGNATURE_REQUESTED', request, deepLink: `adx://sign/${request.id}` });
  return { request, created: true };
}

/** Our signer list with the provider's word on each — matched by identifier; roles are ours. */
function mergeSignerStates(ours: SignerState[], provider: EsignDocument): SignerState[] {
  return ours.map((signer) => {
    const reported = provider.signers.find((s) => s.identifier.toLowerCase() === signer.identifier.toLowerCase());
    return reported ? { ...signer, status: reported.status, signedAt: reported.signedAt ?? signer.signedAt } : signer;
  });
}

/* ------------------------------------------------------------------ */
/* What the provider says                                              */
/* ------------------------------------------------------------------ */

const DOCUMENT_TO_STATUS: Record<EsignDocument['status'], SigningStatus> = {
  requested: 'REQUESTED',
  partially_signed: 'PARTIALLY_SIGNED',
  completed: 'COMPLETED',
  expired: 'EXPIRED',
  cancelled: 'CANCELLED',
  failed: 'FAILED',
};

/**
 * Apply the provider's view of a document to its request: the signers'
 * states, the status, and — on completion — the files, the acceptance row,
 * the hooks and the message. A request already closed is left as it is.
 */
export async function applyProviderDocument(row: SigningRow, doc: EsignDocument, source: 'webhook' | 'refresh' | 'mock'): Promise<SigningRow> {
  if (!OPEN.includes(row.status)) return row;
  const signers = mergeSignerStates((row.signers as SignerState[]) ?? [], doc);
  const status = DOCUMENT_TO_STATUS[doc.status];
  if (status === 'COMPLETED') return completeSigning(row, signers, doc, source);
  const failed = status === 'FAILED' || status === 'EXPIRED' || status === 'CANCELLED';
  const next = await repository.patch(row.id, {
    signers,
    status,
    providerPayload: doc.raw,
    ...(failed ? { failureReason: `${doc.status} (${source})` } : {}),
  });
  if (status === 'EXPIRED') await sendEsignMessage({ event: 'AGREEMENT_SIGNATURE_EXPIRED', request: next });
  return next;
}

async function completeSigning(row: SigningRow, signers: SignerState[], doc: EsignDocument, source: string, now = new Date()): Promise<SigningRow> {
  const byUserId = row.requestedById ?? row.signerUserId;
  let signedFileId: string | null = row.signedFileId;
  let certificateFileId: string | null = row.certificateFileId;
  if (byUserId && row.providerRef && !row.mock) {
    const [signed, certificate] = await Promise.all([downloadSignedPdf(row.providerRef).catch(swallow('signed PDF', row.id)), downloadAuditCertificate(row.providerRef).catch(swallow('audit certificate', row.id))]);
    if (signed) {
      const file = await storeGeneratedFile(byUserId, { content: signed, filename: `${row.providerRef}-signed.pdf`, mimeType: 'application/pdf', purpose: 'SIGNED_AGREEMENT', ownerUserId: row.signerUserId });
      signedFileId = file.id;
    } else if (!signedFileId) {
      // A mock has no signed copy: the rendered document stands as what was signed.
      signedFileId = row.documentFileId;
    }
    if (certificate) {
      const file = await storeGeneratedFile(byUserId, { content: certificate, filename: `${row.providerRef}-certificate.pdf`, mimeType: 'application/pdf', purpose: 'SIGNED_AGREEMENT', ownerUserId: row.signerUserId });
      certificateFileId = file.id;
    }
  } else if (!signedFileId) {
    // A mock has no signed copy: the rendered document stands as what was signed.
    signedFileId = row.documentFileId;
  }

  const acceptanceId = await recordSignedAcceptance(row, now);
  const completed = await repository.patch(row.id, {
    signers: signers.map((s) => (s.status === 'requested' ? { ...s, status: 'signed', signedAt: s.signedAt ?? now.toISOString() } : s)),
    status: 'COMPLETED',
    completedAt: now,
    signedFileId,
    certificateFileId,
    stampRef: doc.stampRef ?? row.stampRef,
    providerPayload: doc.raw,
    acceptanceId,
  });
  if (byUserId) {
    await logActivity(byUserId, 'AGREEMENT_SIGNED', { targetType: 'SigningRequest', targetId: row.id, module: 'agreements', metadata: { kind: row.kind, partyType: row.partyType, partyId: row.partyId, source, providerRef: row.providerRef } });
  }
  await runCompletionHooks(completed).catch((cause) => logger.error('Signing completion hook failed', { requestId: row.id, kind: row.kind, err: cause }));
  await sendEsignMessage({ event: 'AGREEMENT_SIGNED', request: completed });
  return completed;
}

const swallow = (what: string, requestId: string) => (cause: unknown) => {
  logger.error(`Digio eSign: could not fetch the ${what}`, { requestId, err: cause });
  return null;
};

/** The acceptance row for the three parties that have one — DIGIO, ref this request; a click on the same version is upgraded. */
async function recordSignedAcceptance(row: SigningRow, now: Date): Promise<string | null> {
  const partyType = ACCEPTANCE_PARTY[row.partyType];
  if (!partyType) return null;
  const acceptedByUserId = row.signerUserId ?? row.requestedById;
  if (!acceptedByUserId) return null;
  const party = { [`${partyType}Id`]: row.partyId };
  const existing = row.kind === 'INSERTION_ORDER' && row.campaignId ? await agreements.findAnchoredAcceptance(row.kind, { campaignId: row.campaignId }) : await agreements.findPlatformAcceptance(row.kind, party);
  if (existing && existing.templateId === row.templateId) {
    await agreements.markAcceptanceSigned(existing.id, row.id);
    return existing.id;
  }
  const created = await agreements.createAcceptance({
    ...party,
    ...(row.kind === 'INSERTION_ORDER' ? { campaignId: row.campaignId } : {}),
    templateId: row.templateId,
    templateKind: row.kind,
    templateVersion: row.templateVersion,
    acceptedByUserId,
    renderedDocument: row.renderedDocument,
    signatureProvider: 'DIGIO',
    signatureRef: row.id,
  });
  void now;
  return created.id;
}

/** `POST /webhooks/digio/esign` — the provider's word, routed by its document id. Unknown ids are logged and answered 200. */
export async function handleEsignWebhook(body: unknown): Promise<{ matched: boolean }> {
  const parsed = parseEsignWebhook(body);
  if (!parsed) {
    logger.warn('Digio eSign webhook: payload unrecognised');
    return { matched: false };
  }
  const row = await repository.findByProviderRef(parsed.document.id);
  if (!row) {
    logger.warn('Digio eSign webhook: no request for document', { documentId: parsed.document.id, event: parsed.event });
    return { matched: false };
  }
  await applyProviderDocument(row, parsed.document, 'webhook');
  return { matched: true };
}

/** The phone's poll and the desk's sync: ask the provider now. A mock answers itself. */
export async function refreshSigningRequest(id: string): Promise<SigningRow> {
  const row = await requireRequest(id);
  if (!OPEN.includes(row.status) || !row.providerRef || row.mock) return row;
  const doc = await fetchEsignDocument(row.providerRef);
  return doc ? applyProviderDocument(row, doc, 'refresh') : row;
}

/* ------------------------------------------------------------------ */
/* The desk's acts                                                     */
/* ------------------------------------------------------------------ */

async function requireRequest(id: string): Promise<SigningRow> {
  const row = await repository.find(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Signing request not found');
  return row;
}

export async function remindSigning(id: string, byUserId: string, now = new Date()): Promise<SigningRow> {
  const row = await requireRequest(id);
  if (!OPEN.includes(row.status)) throw new ApiError(409, 'SIGNING_NOT_OPEN', `This request is ${row.status.toLowerCase().replace('_', ' ')}; there is nobody to remind`);
  if (row.providerRef) await remindEsignSigners(row.providerRef);
  const next = await repository.patch(id, { lastReminderAt: now });
  await sendEsignMessage({ event: 'AGREEMENT_SIGNATURE_REQUESTED', request: next, deepLink: `adx://sign/${next.id}` });
  await logActivity(byUserId, 'AGREEMENT_SIGNATURE_REMINDED', { targetType: 'SigningRequest', targetId: id, module: 'agreements', metadata: { kind: row.kind, partyId: row.partyId } });
  return next;
}

export async function voidSigning(id: string, reason: string, byUserId: string, now = new Date()): Promise<SigningRow> {
  const row = await requireRequest(id);
  if (!OPEN.includes(row.status)) throw new ApiError(409, 'SIGNING_NOT_OPEN', `This request is already ${row.status.toLowerCase().replace('_', ' ')}`);
  if (row.providerRef) await cancelEsignRequest(row.providerRef, reason);
  const next = await repository.patch(id, { status: 'CANCELLED', cancelledAt: now, cancelReason: reason });
  await logActivity(byUserId, 'AGREEMENT_SIGNATURE_VOIDED', { targetType: 'SigningRequest', targetId: id, module: 'agreements', metadata: { kind: row.kind, partyId: row.partyId, reason } });
  return next;
}

/**
 * The dev door: a mocked request (no Digio credentials) is signed from here
 * so the flows walk end to end. Refused in production and on a real
 * request — a real one is signed on Digio's page, nowhere else.
 */
export async function mockSign(id: string, byUserId: string): Promise<SigningRow> {
  if (env.NODE_ENV === 'production') throw new ApiError(403, 'FORBIDDEN', 'The mock signature is a development door');
  const row = await requireRequest(id);
  if (!row.mock) throw new ApiError(409, 'SIGNING_NOT_OPEN', 'This request is with Digio; it is signed on Digio’s page');
  if (!OPEN.includes(row.status)) throw new ApiError(409, 'SIGNING_NOT_OPEN', `This request is already ${row.status.toLowerCase().replace('_', ' ')}`);
  const signers = ((row.signers as SignerState[]) ?? []).map((s) => ({ ...s, status: 'signed' as const, signedAt: new Date().toISOString() }));
  const doc: EsignDocument = {
    id: row.providerRef ?? `esign_mock_${row.id}`,
    status: 'completed',
    signers: signers.map((s) => ({ identifier: s.identifier, name: s.name, status: 'signed', signedAt: s.signedAt, signType: 'mock' })),
    signingUrls: {},
    stampRef: row.stampRef,
    mock: true,
    raw: { mock: true, signedBy: byUserId },
  };
  return applyProviderDocument(row, doc, 'mock');
}

/** The sweep: open requests past their expiry are EXPIRED, the signer told. */
export async function expireSigningRequests(now = new Date()): Promise<{ expired: number }> {
  const rows = await repository.expiredOpen(now, 200);
  for (const row of rows) {
    const next = await repository.patch(row.id, { status: 'EXPIRED', failureReason: 'expired (sweep)' });
    await sendEsignMessage({ event: 'AGREEMENT_SIGNATURE_EXPIRED', request: next });
  }
  return { expired: rows.length };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listSigningRequests(filter: SigningFilter, page: PageQuery): Promise<Page<SigningView>> {
  const result = await repository.list(filter, page);
  return { rows: result.rows.map(signingView), nextCursor: result.nextCursor };
}

export async function getSigningRequest(id: string): Promise<SigningView> {
  return signingView(await requireRequest(id));
}

/** The requests a person may act on — their parties' — newest first; what the apps' signing doors read. */
export async function mySigningRequests(userId: string): Promise<SigningView[]> {
  return (await repository.listForUser(userId)).map(signingView);
}

/** Whether `userId` may read or refresh request `row`: its signer, one of its party's people, or an admin. */
export async function mayActOn(userId: string, row: SigningRow, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;
  if (row.signerUserId === userId) return true;
  const parties = await repository.partiesOfUser(userId);
  return parties.some((p) => p.partyType === row.partyType && p.partyId === row.partyId);
}

export async function findSigningRequest(id: string): Promise<SigningRow | null> {
  return repository.find(id);
}

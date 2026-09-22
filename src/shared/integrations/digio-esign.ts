import { env } from '../../config/env';
import { logger } from '../logging';
import { ApiError } from '../errors/api-error';
import { getEffectiveEsignConfig, type EsignConfig } from './integration-config';

/**
 * DS-1 (Digio eSign, 22 Sep 2026): the signing rail as one small client —
 * upload a PDF with its signers, read a document back, fetch the signed
 * copy and the audit certificate, remind, cancel. It knows nothing about
 * agreements: `modules/agreements` renders the document, decides who signs
 * and records what came back.
 *
 * Digio's DigiSign API (documentation.digio.in/digisign), as the sandbox
 * answered it on 22 Sep 2026 with the account's credentials: documents are
 * uploaded to `POST /v2/client/document/upload` as multipart form-data —
 * `file` (the PDF) and `request` (the JSON with the signer sequence) — and
 * the answer carries the document id, `agreement_status`, the
 * `signing_parties` with their `status` / `expire_on`, and an
 * `access_token` for the gateway; `GET /v2/client/document/{id}` reads it
 * back; `POST /v2/client/document/{id}/cancel` voids it (the sandbox
 * reports it `expired`); the signed PDF comes from
 * `GET /v2/client/document/download?document_id=` once it is signed. Each
 * signer opens the gateway page built from the document id, their
 * identifier and the access token; Digio calls the account's webhook when
 * the agreement is acted on. No reminder or audit-certificate route
 * answered on this account — ADX re-sends its own message, and the
 * certificate download is tolerant of a 404 until Digio names the path.
 * `ENDPOINTS` keeps them in one place for the day one moves.
 *
 * Without credentials the rail is simulated in development — the request
 * is opened as a mock the dev door can sign, so every flow walks end to end
 * before the account is enabled. In production an unconfigured rail is a
 * 503 `ESIGN_UNAVAILABLE`: a mock signature on a real contract is worse
 * than a refusal.
 */

export type EsignSignType = 'aadhaar' | 'dsc' | 'electronic';

export type EsignSigner = {
  /** The email or mobile the signing link is addressed to — Digio takes exactly one. */
  identifier: string;
  name: string;
  reason: string;
  signType: EsignSignType;
};

export type EsignStamp = {
  /** ISO 3166-2 state code the stamp paper is bought in, KA for Karnataka. */
  state: string;
  amount: number;
  article?: string;
  firstParty: string;
  secondParty: string;
};

export type EsignUploadInput = {
  /** Ours, unique per request; echoed back on the document. */
  referenceId: string;
  fileName: string;
  pdf: Buffer;
  signers: EsignSigner[];
  expireInDays: number;
  /** Signers sign in the order given (the party first, ADX last). */
  sequential: boolean;
  /** Digio emails / SMSes each signer their link itself. */
  notifySigners: boolean;
  /** Where the signature block is drawn. */
  displayOnPage: 'all' | 'first' | 'last';
  stamp?: EsignStamp | undefined;
};

export type EsignSignerStatus = 'requested' | 'signed' | 'expired' | 'declined' | 'cancelled';
export type EsignDocumentStatus = 'requested' | 'partially_signed' | 'completed' | 'expired' | 'cancelled' | 'failed';

export type EsignSignerState = {
  identifier: string;
  name: string;
  status: EsignSignerStatus;
  signedAt: string | null;
  signType: string | null;
};

export type EsignDocument = {
  id: string;
  status: EsignDocumentStatus;
  signers: EsignSignerState[];
  /** The gateway page per signer identifier, where the provider handed one out. */
  signingUrls: Record<string, string>;
  stampRef: string | null;
  mock: boolean;
  raw: unknown;
};

export const ENDPOINTS = {
  upload: '/v2/client/document/upload',
  document: (id: string) => `/v2/client/document/${encodeURIComponent(id)}`,
  download: (id: string) => `/v2/client/document/download?document_id=${encodeURIComponent(id)}`,
  certificate: (id: string) => `/v2/client/document/${encodeURIComponent(id)}/certificate/download`,
  cancel: (id: string) => `/v2/client/document/${encodeURIComponent(id)}/cancel`,
  remind: (id: string) => `/v2/client/document/${encodeURIComponent(id)}/remind`,
} as const;

export const MOCK_PREFIX = 'esign_mock_';

export type EffectiveEsignConfig = Awaited<ReturnType<typeof getEffectiveEsignConfig>>;

export function esignConfigured(cfg: EsignConfig): boolean {
  return Boolean(cfg.clientId && cfg.clientSecret);
}

function authHeader(cfg: EsignConfig): string {
  return `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
}

/**
 * The gateway page a signer opens: the document, a per-open nonce, the
 * signer's identifier and the access token the upload minted. The apps open
 * it in the phone's browser; the emailed link Digio sends is the same page.
 */
export function esignGatewayUrl(cfg: Pick<EffectiveEsignConfig, 'gatewayUrl'>, documentId: string, identifier: string, tokenId: string | null): string {
  const nonce = Math.random().toString(36).slice(2, 10);
  const base = `${cfg.gatewayUrl.replace(/\/$/, '')}/#/gateway/login/${encodeURIComponent(documentId)}/${nonce}/${encodeURIComponent(identifier)}`;
  return tokenId ? `${base}?token_id=${encodeURIComponent(tokenId)}` : base;
}

function mockAllowed(): boolean {
  return env.NODE_ENV !== 'production';
}

/** 503 ESIGN_UNAVAILABLE when the rail cannot be used at all (production, no credentials). */
export function assertEsignUsable(cfg: EsignConfig): void {
  if (esignConfigured(cfg) || mockAllowed()) return;
  throw new ApiError(503, 'ESIGN_UNAVAILABLE', 'E-signing is not configured on this server; the click acceptance stands until it is');
}

/* ------------------------------------------------------------------ */
/* Digio's shapes                                                      */
/* ------------------------------------------------------------------ */

type DigioSigningParty = {
  identifier?: string;
  name?: string;
  status?: string;
  type?: string;
  signature_type?: string;
  updated_at?: string;
  signed_at?: string;
};

type DigioDocument = {
  id: string;
  agreement_status?: string;
  signing_parties?: DigioSigningParty[];
  access_token?: { id?: string; entity_id?: string; valid_till?: string };
  estamp?: { id?: string; certificate_id?: string } | null;
  [key: string]: unknown;
};

const SIGNER_STATUS: Record<string, EsignSignerStatus> = {
  requested: 'requested',
  pending: 'requested',
  signed: 'signed',
  completed: 'signed',
  expired: 'expired',
  declined: 'declined',
  rejected: 'declined',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

const DOCUMENT_STATUS: Record<string, EsignDocumentStatus> = {
  requested: 'requested',
  pending: 'requested',
  partially_signed: 'partially_signed',
  partial: 'partially_signed',
  completed: 'completed',
  signed: 'completed',
  expired: 'expired',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  rejected: 'failed',
  declined: 'failed',
  failed: 'failed',
};

/** A Digio document, however it arrived (an upload's answer, a details read, a webhook), as our shape. */
export function normaliseDigioDocument(doc: DigioDocument, gatewayUrls: Record<string, string> = {}): EsignDocument {
  const signers: EsignSignerState[] = (doc.signing_parties ?? []).map((party) => ({
    identifier: party.identifier ?? '',
    name: party.name ?? '',
    status: SIGNER_STATUS[(party.status ?? 'requested').toLowerCase()] ?? 'requested',
    signedAt: party.signed_at ?? (party.status?.toLowerCase() === 'signed' ? (party.updated_at ?? null) : null),
    signType: party.signature_type ?? party.type ?? null,
  }));
  const reported = DOCUMENT_STATUS[(doc.agreement_status ?? 'requested').toLowerCase()];
  // Digio reports the agreement as a whole; when it says nothing useful the signers decide.
  const status: EsignDocumentStatus =
    reported ?? (signers.length > 0 && signers.every((s) => s.status === 'signed') ? 'completed' : signers.some((s) => s.status === 'signed') ? 'partially_signed' : 'requested');
  return {
    id: doc.id,
    status,
    signers,
    signingUrls: gatewayUrls,
    stampRef: doc.estamp?.certificate_id ?? doc.estamp?.id ?? null,
    mock: doc.id.startsWith(MOCK_PREFIX),
    raw: doc,
  };
}

/**
 * The webhook body, whichever envelope Digio uses — the event envelope
 * (`{ event, entities, payload: { document } }`) or the bare document.
 * Null when it is neither, which the handler answers 200 and logs.
 */
export function parseEsignWebhook(body: unknown): { event: string | null; document: EsignDocument } | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const payload = record.payload as Record<string, unknown> | undefined;
  const nested = payload?.document as DigioDocument | undefined;
  const doc = nested && typeof nested.id === 'string' ? nested : typeof record.id === 'string' && (record.agreement_status !== undefined || record.signing_parties !== undefined) ? (record as unknown as DigioDocument) : null;
  if (!doc) return null;
  return { event: typeof record.event === 'string' ? record.event : null, document: normaliseDigioDocument(doc) };
}

/* ------------------------------------------------------------------ */
/* The calls                                                           */
/* ------------------------------------------------------------------ */

async function digioFetch(cfg: EffectiveEsignConfig, path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
  const response = await fetch(`${cfg.apiUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(cfg),
      // A FormData body sets its own multipart boundary; only a JSON body names its type here.
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init.accept ? { Accept: init.accept } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    logger.error('Digio eSign call failed', { path, status: response.status, body: text.slice(0, 500) });
    throw new ApiError(502, 'ESIGN_PROVIDER_ERROR', `Digio answered ${response.status} to ${path}`, { status: response.status });
  }
  return response;
}

function mockDocument(input: EsignUploadInput, cfg: EffectiveEsignConfig): EsignDocument {
  const id = `${MOCK_PREFIX}${input.referenceId}`;
  const doc: DigioDocument = {
    id,
    agreement_status: 'requested',
    signing_parties: input.signers.map((s) => ({ identifier: s.identifier, name: s.name, status: 'requested', type: s.signType })),
    ...(input.stamp ? { estamp: { id: `${MOCK_PREFIX}stamp_${input.referenceId}` } } : {}),
  };
  const urls = Object.fromEntries(input.signers.map((s) => [s.identifier, esignGatewayUrl(cfg, id, s.identifier, 'mock_token')]));
  return normaliseDigioDocument(doc, urls);
}

/** Upload the PDF with its signers; the answer carries each signer's gateway page. */
export async function createEsignRequest(input: EsignUploadInput): Promise<EsignDocument> {
  const cfg = await getEffectiveEsignConfig();
  assertEsignUsable(cfg);
  if (!esignConfigured(cfg)) {
    logger.warn('Digio eSign not configured — opening a mock signing request (dev only)', { referenceId: input.referenceId });
    return mockDocument(input, cfg);
  }
  if (!env.BASE_URL) {
    logger.warn('BASE_URL is not set — Digio eSign webhooks will not reach this server until it is');
  }
  const request = {
    signers: input.signers.map((s) => ({ identifier: s.identifier, name: s.name, reason: s.reason, sign_type: s.signType })),
    expire_in_days: input.expireInDays,
    display_on_page: input.displayOnPage,
    notify_signers: input.notifySigners,
    send_sign_link: input.notifySigners,
    sequential: input.sequential,
    generate_access_token: true,
    file_name: input.fileName,
    reference_id: input.referenceId,
    ...(input.stamp
      ? {
          estamp: {
            state: input.stamp.state,
            amount: input.stamp.amount,
            ...(input.stamp.article ? { article: input.stamp.article } : {}),
            first_party: input.stamp.firstParty,
            second_party: input.stamp.secondParty,
          },
        }
      : {}),
  };
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(input.pdf)], { type: 'application/pdf' }), input.fileName);
  form.append('request', JSON.stringify(request));
  const response = await digioFetch(cfg, ENDPOINTS.upload, { method: 'POST', body: form });
  const doc = (await response.json()) as DigioDocument;
  const token = doc.access_token?.id ?? null;
  const urls = Object.fromEntries(input.signers.map((s) => [s.identifier, esignGatewayUrl(cfg, doc.id, s.identifier, token)]));
  return normaliseDigioDocument(doc, urls);
}

/** What the provider says about a document now — the refresh behind the poll and the desk's sync. */
export async function fetchEsignDocument(documentId: string): Promise<EsignDocument | null> {
  if (documentId.startsWith(MOCK_PREFIX)) return null;
  const cfg = await getEffectiveEsignConfig();
  if (!esignConfigured(cfg)) return null;
  const response = await digioFetch(cfg, ENDPOINTS.document(documentId), { method: 'GET' });
  return normaliseDigioDocument((await response.json()) as DigioDocument);
}

/** The signed PDF, bytes. Null for a mock (the rendered PDF stands in). */
export async function downloadSignedPdf(documentId: string): Promise<Buffer | null> {
  if (documentId.startsWith(MOCK_PREFIX)) return null;
  const cfg = await getEffectiveEsignConfig();
  if (!esignConfigured(cfg)) return null;
  const response = await digioFetch(cfg, ENDPOINTS.download(documentId), { method: 'GET', accept: 'application/pdf' });
  return Buffer.from(await response.arrayBuffer());
}

/** DS-4: the audit certificate (who signed, when, from where). Null when the provider has none for the document. */
export async function downloadAuditCertificate(documentId: string): Promise<Buffer | null> {
  if (documentId.startsWith(MOCK_PREFIX)) return null;
  const cfg = await getEffectiveEsignConfig();
  if (!esignConfigured(cfg)) return null;
  try {
    const response = await digioFetch(cfg, ENDPOINTS.certificate(documentId), { method: 'GET', accept: 'application/pdf' });
    return Buffer.from(await response.arrayBuffer());
  } catch (cause) {
    // A 404 here is a document without a certificate yet, not an outage.
    if (cause instanceof ApiError && (cause.details as { status?: number } | undefined)?.status === 404) return null;
    throw cause;
  }
}

export async function cancelEsignRequest(documentId: string, reason: string): Promise<void> {
  if (documentId.startsWith(MOCK_PREFIX)) return;
  const cfg = await getEffectiveEsignConfig();
  if (!esignConfigured(cfg)) return;
  await digioFetch(cfg, ENDPOINTS.cancel(documentId), { method: 'POST', body: JSON.stringify({ reason }) });
}

/**
 * A reminder at the provider. No reminder route answered on this account
 * (22 Sep 2026: `/{id}/remind`, `/remind/{id}`, `/notify`, `/send_reminder`,
 * `/resend` all 404), so this is best-effort — a 404 is swallowed — and the
 * message ADX sends beside it is what actually reaches the signer.
 */
export async function remindEsignSigners(documentId: string): Promise<void> {
  if (documentId.startsWith(MOCK_PREFIX)) return;
  const cfg = await getEffectiveEsignConfig();
  if (!esignConfigured(cfg)) return;
  try {
    await digioFetch(cfg, ENDPOINTS.remind(documentId), { method: 'POST', body: JSON.stringify({}) });
  } catch (cause) {
    if (cause instanceof ApiError && (cause.details as { status?: number } | undefined)?.status === 404) return;
    throw cause;
  }
}

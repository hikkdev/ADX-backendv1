import { env } from '../../config/env';
import { logger } from '../logging';
import { ApiError } from '../errors/api-error';
import { getEffectiveKycConfig, type KycConfig, type KycProviderState } from './integration-config';
import { esignGatewayUrl } from './digio-esign';
import { workflowTemplateId, type DigioKycParty, type DigioWorkflowKey } from './digio-workflows';

/**
 * The Digio KYC request, as one call — shared by every party that verifies
 * through Digio. It knows nothing about who is being verified: the caller
 * hands in a reference and the person's name and contact, and gets back the
 * session the phone opens. Which row records the request, and which row a
 * webhook lands on, is each module's own business.
 *
 * Without credentials the call is simulated, so the flows can be walked
 * end to end before the account is set up; the session says it is a mock.
 *
 * The request (30 Sep 2026, checked against Digio's sandbox): `POST
 * /client/kyc/v2/request/with_template` on the API host (sandbox
 * `ext.digio.in:444`, production `api.digio.in`) must name the workflow
 * template built in Digio's dashboard — without one Digio answers 400
 * "Either of Template Name or Template Id is mandatory" — and must ask for
 * `generate_access_token`, or the answer carries no token for the page. The
 * person verifies on Digio's gateway: `<gateway>/#/gateway/login/<KID>/
 * <nonce>/<identifier>?token_id=<token>`, the page e-signing opens too.
 *
 * Phase D (the owner, 1 Oct 2026): the workflow is named by `template_id`
 * (the field Digio recognises — `templateId` is not), picked from the
 * twenty-five the owner built by the caller's `workflowKey`
 * (`digio-workflows.ts`; the settings may override an id). The call gives
 * up after fifteen seconds. An outage — a timeout, the network, a 5xx, a
 * 429 — is 503 KYC_PROVIDER_UNAVAILABLE (`reason: PROVIDER_ERROR`), the
 * same code the switch answers, so the apps offer the upload branch; any
 * other refusal (a template Digio does not know is a 404) is 502
 * KYC_PROVIDER_REFUSED with Digio's status and code. The log carries the
 * status and Digio's error code only — never the body, which can carry the
 * person's name and contact.
 */

/** Phase D: how long a KYC request may take before it counts as an outage. */
export const DIGIO_KYC_TIMEOUT_MS = 15_000;

export type DigioKycRequest = {
  /** Who is being verified — for the log; the workflow is `workflowKey`. */
  party: DigioKycParty;
  /** The workflow to run (`workflowKeyFor`); null when none could be chosen — refused NO_TEMPLATE. */
  workflowKey: DigioWorkflowKey | null;
  /** Ours, unique per request; Digio echoes it back. */
  referenceId: string;
  customerName: string;
  customerEmail: string;
  customerMobile: string;
};

export type DigioKycSession = {
  kycId: string;
  accessToken: string;
  validTill: string;
  sdkUrl: string;
  mock: boolean;
};

type DigiInitiateResponse = {
  id: string;
  customer_identifier?: string;
  /** Only when the request asked for it with `generate_access_token`. */
  access_token?: { id: string; entity_id?: string; valid_till?: string };
};

/** The page the person verifies on — Digio's gateway, the same one a document is signed on. */
function kycGatewayUrl(cfg: KycConfig, kycId: string, identifier: string, token: string | null): string {
  return esignGatewayUrl({ gatewayUrl: cfg.gatewayUrl ?? env.DIGIO_ESIGN_GATEWAY_URL }, kycId, identifier, token);
}

/** The statuses the first request sent; a workflow may send others (`approval_pending`, …) — see `digio-callback.ts`. */
export type DigioWebhookStatus = 'approved' | 'rejected' | 'pending' | 'cancelled';

export type DigioWebhookPayload = {
  id: string;
  customer_identifier?: string | undefined;
  /** Raw, as Digio sent it — stored on `digioStatus`; `digioDecisionOf` reads it. */
  status: string;
  message?: string;
  kyc_documents?: {
    type: string;
    status: string;
    name?: string;
    dob?: string;
    id_number?: string;
  }[];
  completed_at?: string;
};

export function authHeader(cfg: KycConfig): string {
  return `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
}

export function digioConfigured(cfg: KycConfig): boolean {
  return Boolean(cfg.clientId && cfg.clientSecret);
}

/**
 * Lot D (Q129): whether Digio may be asked right now, and if not, when to
 * try again. DEGRADED is the probe's verdict and clears on its next good
 * tick, so the retry is one probe interval; MANUAL is ops' switch and stays
 * until they move it, so the retry is an hour — a hint, not a promise.
 */
export type DigioAvailability = { available: boolean; provider: KycProviderState; retryAfter: number | null };

export const DEGRADED_RETRY_SECONDS = 5 * 60;
export const MANUAL_RETRY_SECONDS = 60 * 60;

export function digioAvailabilityFrom(cfg: KycConfig): DigioAvailability {
  const provider = cfg.kycProvider ?? 'DIGIO';
  if (provider === 'DIGIO') return { available: true, provider, retryAfter: null };
  return { available: false, provider, retryAfter: provider === 'DEGRADED' ? DEGRADED_RETRY_SECONDS : MANUAL_RETRY_SECONDS };
}

export async function digioAvailability(): Promise<DigioAvailability> {
  return digioAvailabilityFrom(await getEffectiveKycConfig());
}

/** 503 KYC_PROVIDER_UNAVAILABLE with `details.retryAfter`, or nothing. */
export function assertDigioAvailable(cfg: KycConfig): void {
  const availability = digioAvailabilityFrom(cfg);
  if (availability.available) return;
  throw new ApiError(
    503,
    'KYC_PROVIDER_UNAVAILABLE',
    availability.provider === 'MANUAL'
      ? 'Digio verification is switched off; upload your documents instead'
      : 'Digio is not answering right now; try again in a few minutes or upload your documents instead',
    { provider: availability.provider, retryAfter: availability.retryAfter },
  );
}

export async function requestDigioKyc(input: DigioKycRequest): Promise<DigioKycSession> {
  const cfg = await getEffectiveKycConfig();
  // Every initiate and every restart, for every party, comes through here —
  // so this is the one place the switch is honoured.
  assertDigioAvailable(cfg);

  if (!input.workflowKey) {
    // Digio refuses a request without a workflow; saying so here beats a 400 from
    // Digio on every attempt — and the mock refuses it too, so development sees it.
    logger.error('Digio KYC has no workflow for this request', { party: input.party });
    throw new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'Online verification is not set up yet; upload your documents instead', { provider: 'MANUAL', reason: 'NO_TEMPLATE' });
  }

  if (!digioConfigured(cfg)) {
    // 28 Sep 2026 (the production env audit): the mock is for development only.
    // In production an unconfigured Digio refuses like a switched-off one — a
    // mock session there would stand in for a real identity check.
    if (env.NODE_ENV === 'production') {
      throw new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'Online verification is not set up yet; upload your documents instead', { provider: 'MANUAL' });
    }
    // Dev mode — simulate a pending KYC so the flow can be tested without real credentials
    logger.warn('Digio not configured — returning mock KYC initiation (dev only)');
    const kycId = `digio_mock_${input.referenceId}`;
    return {
      kycId,
      accessToken: 'mock_token',
      validTill: new Date(Date.now() + 3600_000).toISOString(),
      sdkUrl: kycGatewayUrl(cfg, kycId, input.customerEmail || input.customerMobile, 'mock_token'),
      mock: true,
    };
  }

  const templateId = workflowTemplateId(input.workflowKey, cfg.workflowTemplates);

  if (!env.BASE_URL) {
    logger.warn('BASE_URL is not set — Digio webhook callbacks will not work until it is configured');
  }

  const identifier = input.customerEmail || input.customerMobile;
  const body = {
    customer_identifier: identifier,
    customer_name: input.customerName,
    reference_id: input.referenceId,
    template_id: templateId,
    notify_customer: true,
    // The token the gateway page opens with; Digio mints one only when asked.
    generate_access_token: true,
    ...(env.BASE_URL ? { callback_url: `${env.BASE_URL}/api/v1/webhooks/digio` } : {}),
  };

  let response: Response;
  try {
    response = await fetch(`${cfg.baseUrl}/client/kyc/v2/request/with_template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader(cfg) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DIGIO_KYC_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    logger.error('Digio KYC request did not get an answer', { party: input.party, workflowKey: input.workflowKey, timedOut });
    throw providerError(timedOut ? 'TIMEOUT' : 'NETWORK');
  }

  if (!response.ok) {
    const code = await digioErrorCode(response);
    logger.error('Digio KYC request refused', { party: input.party, workflowKey: input.workflowKey, status: response.status, code });
    if (response.status >= 500 || response.status === 429) throw providerError(response.status === 429 ? 'RATE_LIMITED' : 'HTTP_5XX');
    throw new ApiError(502, 'KYC_PROVIDER_REFUSED', 'Digio refused the verification request; ADX has been told — upload your documents instead for now', {
      provider: 'DIGIO',
      status: response.status,
      code,
    });
  }

  const data = (await response.json()) as DigiInitiateResponse;
  const token = data.access_token?.id ?? null;
  return {
    kycId: data.id,
    accessToken: token ?? '',
    validTill: data.access_token?.valid_till ?? '',
    sdkUrl: kycGatewayUrl(cfg, data.id, data.customer_identifier ?? identifier, token),
    mock: false,
  };
}

/**
 * 503 for an outage — the switch's code, so the apps offer the upload branch as they do for a switched-off Digio.
 *
 * Cashfree Phase 1: which outage it was rides on the error's `cause` (not
 * on `details` — the answer the clients read is unchanged), so the
 * verification router can record it and count it towards Digio's breaker.
 */
export type DigioOutage = 'TIMEOUT' | 'NETWORK' | 'HTTP_5XX' | 'RATE_LIMITED';

function providerError(outage: DigioOutage): ApiError {
  const error = new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'Digio is not answering right now; try again in a few minutes or upload your documents instead', {
    provider: 'DIGIO',
    reason: 'PROVIDER_ERROR',
  });
  (error as { cause?: unknown }).cause = outage;
  return error;
}

/**
 * Digio's own error code off a refusal (`{ code, message }`), or null. Only
 * the code is read and logged — the message can echo what was sent.
 */
async function digioErrorCode(response: Response): Promise<string | null> {
  try {
    const parsed = (await response.json()) as { code?: unknown; error_code?: unknown };
    const code = parsed?.code ?? parsed?.error_code;
    return typeof code === 'string' || typeof code === 'number' ? String(code).slice(0, 80) : null;
  } catch {
    return null;
  }
}

/* ── UPI ID (VPA) verification ─────────────────────────────────── */

/**
 * Digio's VPA lookup (the owner, 2 Oct 2026 — the main UPI check):
 * `POST /v3/client/public/upi/check_vpa` on the same API host and with the
 * same Basic auth as the KYC request. It asks the UPI network whether the ID
 * is live and whose it is; no money moves.
 *
 *   body     { reference_id, unique_request_id, virtual_address, name? }
 *            — both ids 1–32 characters of `[A-Za-z0-9-_]`; `name` is the
 *            expected holder, for Digio's fuzzy score.
 *   200      { virtual_address, customer_name, status, status_description, fuzzy_match_score }
 *            with status `available` | `not_available` | `failed`.
 *   400      Digio's error envelope (`{ code, message }`), read like every other refusal.
 *
 * Unlike the KYC request this does NOT throw: it answers what happened, and
 * the verification provider (`shared/verification/providers/digio.ts`) reads
 * that into the layer's classes. A timeout, the network, a 5xx and a 429 are
 * outages; 401/403 is a key problem; 404 is a product Digio has not switched
 * on; any other refusal is Digio's answer. Nothing is logged here — the
 * router logs one line per attempt, and the body carries a person's UPI ID
 * and name.
 */

export const DIGIO_VPA_PATH = '/v3/client/public/upi/check_vpa';
export const DIGIO_VPA_TIMEOUT_MS = 15_000;
/** Digio's limit on `reference_id` and `unique_request_id`. */
export const DIGIO_VPA_ID_MAX = 32;
const DIGIO_ID_PATTERN = /[^A-Za-z0-9_-]/g;

export type DigioVpaStatus = 'available' | 'not_available' | 'failed';

export type DigioVpaAnswer = {
  virtualAddress: string | null;
  customerName: string | null;
  status: DigioVpaStatus | string;
  statusDescription: string | null;
  fuzzyMatchScore: number | null;
};

export type DigioVpaRequest = {
  /** An ADX id — the case the check is about. Cut to Digio's alphabet and 32 characters. */
  referenceId: string;
  /** Unique per request — the attempt's id. Cut to Digio's alphabet and 32 characters. */
  uniqueRequestId: string;
  vpa: string;
  /** The holder ADX expects, for the fuzzy score. */
  name?: string | null | undefined;
};

export type DigioVpaOutcome =
  | { ok: true; httpStatus: number; answer: DigioVpaAnswer }
  | { ok: false; outage: DigioOutage | 'NOT_CONFIGURED' | 'SWITCHED_OFF'; httpStatus: number | null; code: string | null }
  | { ok: false; outage: null; httpStatus: number; code: string | null };

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** An id Digio accepts: its alphabet only, at most 32 characters, never empty. */
export function digioRequestId(value: string, fallback = 'adx'): string {
  const clean = value.replace(DIGIO_ID_PATTERN, '');
  return (clean || fallback).slice(0, DIGIO_VPA_ID_MAX);
}

/** Whether Digio has keys to be asked with — the VPA lookup has no mock. */
export async function digioVpaReady(): Promise<boolean> {
  return digioConfigured(await getEffectiveKycConfig());
}

const numberOrNull = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

export async function checkDigioVpa(
  input: DigioVpaRequest,
  options: { fetchImpl?: FetchFn | undefined; timeoutMs?: number | undefined; config?: KycConfig | undefined } = {},
): Promise<DigioVpaOutcome> {
  const cfg = options.config ?? (await getEffectiveKycConfig());
  // The VPA lookup has no mock: without keys it is not asked at all.
  if (!digioConfigured(cfg)) return { ok: false, outage: 'NOT_CONFIGURED', httpStatus: null, code: null };
  // The switch ops throw for Digio (or the probe's DEGRADED) covers this call too.
  if (!digioAvailabilityFrom(cfg).available) return { ok: false, outage: 'SWITCHED_OFF', httpStatus: null, code: cfg.kycProvider ?? null };

  const body: Record<string, unknown> = {
    reference_id: digioRequestId(input.referenceId),
    unique_request_id: digioRequestId(input.uniqueRequestId),
    virtual_address: input.vpa.trim(),
  };
  if (input.name?.trim()) body['name'] = input.name.trim();

  const fetchImpl: FetchFn = options.fetchImpl ?? ((url, init) => fetch(url, init));
  let response: Response;
  try {
    response = await fetchImpl(`${cfg.baseUrl ?? env.DIGIO_BASE_URL}${DIGIO_VPA_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader(cfg) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DIGIO_VPA_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, outage: timedOut ? 'TIMEOUT' : 'NETWORK', httpStatus: null, code: null };
  }

  if (!response.ok) {
    const code = await digioErrorCode(response);
    if (response.status >= 500) return { ok: false, outage: 'HTTP_5XX', httpStatus: response.status, code };
    if (response.status === 429) return { ok: false, outage: 'RATE_LIMITED', httpStatus: response.status, code };
    return { ok: false, outage: null, httpStatus: response.status, code };
  }

  let data: Record<string, unknown>;
  try {
    data = ((await response.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return { ok: false, outage: 'HTTP_5XX', httpStatus: response.status, code: 'UNREADABLE_ANSWER' };
  }
  return {
    ok: true,
    httpStatus: response.status,
    answer: {
      virtualAddress: stringOrNull(data['virtual_address']),
      customerName: stringOrNull(data['customer_name']),
      status: (stringOrNull(data['status']) ?? '').toLowerCase(),
      statusDescription: stringOrNull(data['status_description']),
      fuzzyMatchScore: numberOrNull(data['fuzzy_match_score']),
    },
  };
}

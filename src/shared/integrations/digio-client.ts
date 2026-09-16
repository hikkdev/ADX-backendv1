import { env } from '../../config/env';
import { logger } from '../logging';
import { ApiError } from '../errors/api-error';
import { getEffectiveKycConfig, type KycConfig, type KycProviderState } from './integration-config';

/**
 * The Digio KYC request, as one call — shared by every party that verifies
 * through Digio. It knows nothing about who is being verified: the caller
 * hands in a reference and the person's name and contact, and gets back the
 * session the phone opens. Which row records the request, and which row a
 * webhook lands on, is each module's own business.
 *
 * Without credentials the call is simulated, so the flows can be walked
 * end to end before the account is set up; the session says it is a mock.
 */

export type DigioKycRequest = {
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
  customer_identifier: string;
  access_token: { id: string; entity_id: string; valid_till: string };
};

export type DigioWebhookStatus = 'approved' | 'rejected' | 'pending' | 'cancelled';

export type DigioWebhookPayload = {
  id: string;
  customer_identifier: string;
  status: DigioWebhookStatus;
  message?: string;
  kyc_documents?: {
    type: string;
    status: DigioWebhookStatus;
    name?: string;
    dob?: string;
    id_number?: string;
  }[];
  completed_at?: string;
};

function authHeader(cfg: KycConfig): string {
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

  if (!digioConfigured(cfg)) {
    // Dev mode — simulate a pending KYC so the flow can be tested without real credentials
    logger.warn('Digio not configured — returning mock KYC initiation (dev only)');
    const kycId = `digio_mock_${input.referenceId}`;
    return {
      kycId,
      accessToken: 'mock_token',
      validTill: new Date(Date.now() + 3600_000).toISOString(),
      sdkUrl: `${cfg.baseUrl}/#${kycId}?token=mock_token`,
      mock: true,
    };
  }

  if (!env.BASE_URL) {
    logger.warn('BASE_URL is not set — Digio webhook callbacks will not work until it is configured');
  }

  const body = {
    customer_identifier: input.customerEmail || input.customerMobile,
    customer_name: input.customerName,
    reference_id: input.referenceId,
    notify_customer: true,
    ...(env.BASE_URL ? { callback_url: `${env.BASE_URL}/api/v1/webhooks/digio` } : {}),
    purpose: 'KYC',
  };

  const response = await fetch(`${cfg.baseUrl}/client/kyc/v2/request/with_template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(cfg) },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error('Digio initiate failed', { status: response.status, body: err });
    throw new Error(`Digio KYC initiation failed: ${response.status}`);
  }

  const data = (await response.json()) as DigiInitiateResponse;
  return {
    kycId: data.id,
    accessToken: data.access_token.id,
    validTill: data.access_token.valid_till,
    sdkUrl: `${cfg.baseUrl}/#${data.id}?token=${data.access_token.id}`,
    mock: false,
  };
}

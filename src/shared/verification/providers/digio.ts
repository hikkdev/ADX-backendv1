import { createHash } from 'crypto';
import { ApiError } from '../../errors/api-error';
import { DIGIO_VPA_ID_MAX, checkDigioVpa, digioRequestId, digioVpaReady, requestDigioKyc, type DigioKycRequest, type DigioKycSession, type DigioVpaOutcome } from '../../integrations/digio-client';
import { maskVpa, type CheckInputs, type CheckResult, type CheckType, type ErrorClass } from '../checks';
import type { CheckContext, VerificationProvider } from '../provider';
import type { VerificationSettings } from '../settings';

/**
 * Digio as a verification provider — Cashfree Phase 1.
 *
 * A wrapper, not a rewrite: the hosted KYC journey is still the one request
 * `shared/integrations/digio-client.ts` makes (Phase D — the twenty-five
 * workflows, the fifteen-second timeout, the typed 503/502). This file only
 * reads what that call did into the layer's vocabulary, so the router can
 * tell a Digio that could not be asked from a Digio that said no:
 *
 *   503 KYC_PROVIDER_UNAVAILABLE, reason PROVIDER_ERROR  →  TIMEOUT / NETWORK / HTTP_5XX / RATE_LIMITED
 *                                                           (the client says which on the error's `cause`)
 *   503 …, provider MANUAL or DEGRADED with retryAfter   →  PROVIDER_SWITCHED_OFF
 *   503 …, provider MANUAL, no retryAfter                →  MOCK_IN_PRODUCTION  (no keys on a production server)
 *   503 …, reason NO_TEMPLATE                            →  AUTH_CONFIG         (no workflow to name)
 *   502 KYC_PROVIDER_REFUSED, status 401 / 403           →  AUTH_CONFIG
 *   502 …, status 404                                    →  NOT_ENABLED         (a template Digio does not know)
 *   502 …, any other status                              →  BUSINESS            (Digio answered; final)
 *
 * The error the client threw rides along in `transient`, so a caller that
 * has no backup to hand out answers exactly the 503/502 it answered before
 * this layer existed.
 *
 * `configured()` is always true: an unconfigured Digio outside production
 * answers a mock session (the flows are walked end to end in development),
 * and in production the client itself refuses — MOCK_IN_PRODUCTION above.
 *
 * UPI_VPA (2 Oct 2026 — the owner's main UPI check, `upiCheck: 'VPA_LOOKUP'`):
 * Digio's `check_vpa` lookup. It has NO mock — without keys the router skips
 * Digio for it (`usable` → NOT_CONFIGURED) — and it reads Digio's answer so:
 *
 *   available        →  VERIFIED, the name on the UPI ID as `matchedName` and,
 *                        when a name was sent, Digio's fuzzy score; a score
 *                        under `nameMatchMin` is FAILED / BUSINESS NAME_MISMATCH
 *   not_available    →  FAILED / BUSINESS VPA_NOT_FOUND
 *   failed           →  HTTP_5XX (the UPI network did not answer; fail over)
 *   timeout, network, 5xx, 429  →  their technical classes
 *   401 / 403        →  AUTH_CONFIG;  404 → NOT_ENABLED (the product is not switched on)
 *   any other refusal (400)     →  BUSINESS, Digio's status and code
 *
 * What is kept (`raw`): the UPI ID masked to its handle and the last four
 * before the `@`, the name Digio gave, the status and the score. The name
 * ADX sent is not kept — only that one was sent.
 */

const NAME = 'DIGIO' as const;

export type DigioHostedTransient = { session: DigioKycSession } | { error: unknown };

const TRANSPORT_CAUSES: readonly ErrorClass[] = ['TIMEOUT', 'NETWORK', 'HTTP_5XX', 'RATE_LIMITED'];

/** The class of an error the Digio client threw. Anything it did not throw itself is NETWORK: the call did not complete. */
export function classifyDigioError(err: unknown): { errorClass: ErrorClass; code: string } {
  if (!(err instanceof ApiError)) return { errorClass: 'NETWORK', code: 'UNEXPECTED' };
  const details = (err.details ?? {}) as { provider?: string; reason?: string; retryAfter?: number | null; status?: number; code?: string | null };
  if (err.code === 'KYC_PROVIDER_UNAVAILABLE') {
    if (details.reason === 'PROVIDER_ERROR') {
      const cause = (err as { cause?: unknown }).cause;
      const errorClass = typeof cause === 'string' && (TRANSPORT_CAUSES as readonly string[]).includes(cause) ? (cause as ErrorClass) : 'HTTP_5XX';
      return { errorClass, code: 'PROVIDER_ERROR' };
    }
    if (details.reason === 'NO_TEMPLATE') return { errorClass: 'AUTH_CONFIG', code: 'NO_TEMPLATE' };
    if (details.retryAfter != null) return { errorClass: 'PROVIDER_SWITCHED_OFF', code: details.provider ?? 'MANUAL' };
    return { errorClass: 'MOCK_IN_PRODUCTION', code: 'NOT_CONFIGURED' };
  }
  if (err.code === 'KYC_PROVIDER_REFUSED') {
    const code = `HTTP_${details.status ?? 'XXX'}${details.code ? `:${details.code}` : ''}`;
    if (details.status === 401 || details.status === 403) return { errorClass: 'AUTH_CONFIG', code };
    if (details.status === 404) return { errorClass: 'NOT_ENABLED', code };
    return { errorClass: 'BUSINESS', code };
  }
  return { errorClass: 'NETWORK', code: err.code };
}

/**
 * `unique_request_id`: the attempt's id when Digio would take it as it is
 * (the attempt store mints 32 letters and digits); otherwise a 32-character
 * digest of it — still one per attempt, inside Digio's alphabet.
 */
export function digioUniqueRequestId(verificationId: string): string {
  const clean = verificationId.replace(/[^A-Za-z0-9_-]/g, '');
  if (clean && clean === verificationId && clean.length <= DIGIO_VPA_ID_MAX) return clean;
  return createHash('sha256').update(verificationId).digest('hex').slice(0, DIGIO_VPA_ID_MAX);
}

const NOT_FOUND_REASON = 'This UPI ID is not active, or does not exist';
const NAME_MISMATCH_REASON = 'The name on this UPI ID does not match the account holder';

/** Digio's answer to a VPA lookup, in the layer's vocabulary. */
export function vpaResult(
  outcome: DigioVpaOutcome,
  request: { vpa: string; nameSent: boolean; uniqueRequestId: string },
  ctx: { verificationId: string; settings: VerificationSettings },
): CheckResult {
  const base = { provider: NAME, providerRef: request.uniqueRequestId, verificationId: ctx.verificationId } as const;
  const masked = maskVpa(request.vpa);
  if (!outcome.ok) {
    const kept = { mode: 'VPA_LOOKUP', vpa: masked, httpStatus: outcome.httpStatus, code: outcome.code };
    if (outcome.outage === null) {
      const code = `HTTP_${outcome.httpStatus}${outcome.code ? `:${outcome.code}` : ''}`;
      const errorClass: ErrorClass = outcome.httpStatus === 401 || outcome.httpStatus === 403 ? 'AUTH_CONFIG' : outcome.httpStatus === 404 ? 'NOT_ENABLED' : 'BUSINESS';
      return { status: 'FAILED', ...base, errorClass, failureCode: code, failureReason: errorClass === 'BUSINESS' ? 'Digio refused to look this UPI ID up' : 'Digio could not be asked', raw: kept };
    }
    if (outcome.outage === 'NOT_CONFIGURED') {
      // `usable` keeps an unconfigured Digio from being asked; a key removed mid-flight lands here. Not the provider's health — not counted.
      return { status: 'FAILED', ...base, errorClass: 'MOCK_IN_PRODUCTION', failureCode: 'NOT_CONFIGURED', failureReason: 'Digio has no keys on file', raw: kept };
    }
    if (outcome.outage === 'SWITCHED_OFF') {
      return { status: 'FAILED', ...base, errorClass: 'PROVIDER_SWITCHED_OFF', failureCode: outcome.code ?? 'MANUAL', failureReason: 'Digio is switched off', raw: kept };
    }
    return { status: 'FAILED', ...base, errorClass: outcome.outage, failureCode: outcome.outage, failureReason: 'Digio could not be asked', raw: kept };
  }

  const answer = outcome.answer;
  const score = request.nameSent && answer.fuzzyMatchScore !== null ? Math.max(0, Math.min(100, answer.fuzzyMatchScore)) : undefined;
  const vpa = request.vpa.trim();
  const description = answer.statusDescription ? (vpa ? answer.statusDescription.split(vpa).join(masked ?? '') : answer.statusDescription).slice(0, 200) : null;
  const raw: Record<string, unknown> = {
    mode: 'VPA_LOOKUP',
    vpa: masked,
    status: answer.status || null,
    statusDescription: description,
    customerName: answer.customerName,
    nameSent: request.nameSent,
    fuzzyMatchScore: score ?? null,
  };
  const matched = { matchedName: answer.customerName ?? undefined, nameMatchScore: score };

  if (answer.status === 'available') {
    if (score !== undefined && score < ctx.settings.nameMatchMin) {
      return { status: 'FAILED', ...base, ...matched, errorClass: 'BUSINESS', failureCode: 'NAME_MISMATCH', failureReason: NAME_MISMATCH_REASON, raw };
    }
    return { status: 'VERIFIED', ...base, ...matched, raw };
  }
  if (answer.status === 'not_available') {
    return { status: 'FAILED', ...base, ...matched, errorClass: 'BUSINESS', failureCode: 'VPA_NOT_FOUND', failureReason: NOT_FOUND_REASON, raw };
  }
  // `failed` — the lookup itself did not go through — or a status Digio has not documented: nobody answered the question.
  const code = answer.status === 'failed' ? 'VPA_LOOKUP_FAILED' : `VPA_STATUS_${(answer.status || 'NONE').toUpperCase().slice(0, 40)}`;
  return { status: 'FAILED', ...base, errorClass: 'HTTP_5XX', failureCode: code, failureReason: 'Digio could not look this UPI ID up just now', raw };
}

async function lookUpVpa(input: CheckInputs['UPI_VPA'], ctx: CheckContext): Promise<CheckResult> {
  const name = input.name?.trim() || null;
  const uniqueRequestId = digioUniqueRequestId(ctx.verificationId);
  const outcome = await checkDigioVpa({ referenceId: digioRequestId(ctx.caseId, uniqueRequestId), uniqueRequestId, vpa: input.vpa, name }, { fetchImpl: ctx.fetchImpl });
  return vpaResult(outcome, { vpa: input.vpa, nameSent: Boolean(name), uniqueRequestId }, ctx);
}

export const digioProvider: VerificationProvider = {
  name: NAME,
  capabilities(settings): CheckType[] {
    // The VPA lookup is Digio's only while it is the UPI check the owner chose; the penny drops are Cashfree's.
    return settings.upiCheck === 'VPA_LOOKUP' ? ['HOSTED_KYC', 'UPI_VPA'] : ['HOSTED_KYC'];
  },
  async configured() {
    return true;
  },
  async usable(check) {
    // The hosted journey has a development mock; the VPA lookup does not, so it waits for keys.
    if (check === 'UPI_VPA' && !(await digioVpaReady())) return 'NOT_CONFIGURED';
    return null;
  },
  async run(check, input, ctx: CheckContext): Promise<CheckResult> {
    if (check === 'UPI_VPA') return lookUpVpa(input as CheckInputs['UPI_VPA'], ctx);
    if (check !== 'HOSTED_KYC') {
      return { status: 'FAILED', provider: NAME, providerRef: null, verificationId: ctx.verificationId, errorClass: 'NOT_ENABLED', failureCode: 'UNSUPPORTED_CHECK', failureReason: 'Digio answers the hosted KYC journey and the UPI ID lookup only', raw: {} };
    }
    const request = (input as CheckInputs['HOSTED_KYC']).digio as DigioKycRequest;
    try {
      const session = await requestDigioKyc(request);
      return {
        // The person finishes on Digio's page; Digio's webhook brings the decision.
        status: 'NEEDS_USER_ACTION',
        provider: NAME,
        providerRef: session.kycId,
        verificationId: ctx.verificationId,
        raw: { workflowKey: request.workflowKey, party: request.party, mock: session.mock },
        userAction: { kind: 'REDIRECT', url: session.sdkUrl, expiresAt: session.validTill || null },
        transient: { session } satisfies DigioHostedTransient,
      };
    } catch (err) {
      const { errorClass, code } = classifyDigioError(err);
      return {
        status: 'FAILED',
        provider: NAME,
        providerRef: null,
        verificationId: ctx.verificationId,
        errorClass,
        failureCode: code,
        failureReason: errorClass === 'BUSINESS' ? 'Digio refused the request' : 'Digio could not be asked',
        raw: { workflowKey: request.workflowKey, party: request.party },
        transient: { error: err } satisfies DigioHostedTransient,
      };
    }
  },
};

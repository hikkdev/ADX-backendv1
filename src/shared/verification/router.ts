import { logger } from '../logging';
import {
  BREAKER_COUNTED_CLASSES,
  isTechnical,
  type CheckInputs,
  type CheckResult,
  type CheckType,
  type TechnicalErrorClass,
  type VerificationCaseType,
  type VerificationProviderName,
} from './checks';
import type { CheckContext, FetchLike } from './provider';
import { verificationRuntime } from './runtime';
import type { VerificationSettings } from './settings';
import type { AttemptRecord } from './stores';

/**
 * The one door a verification check leaves by — Cashfree Phase 1 (the
 * owner, 1 Oct 2026), modelled on `shared/sms/sms.ts`.
 *
 * A caller names a CHECK and a case, never a provider. The settings name a
 * primary and up to two fallbacks for the check
 * (`verificationRouting.checks[check]`); the router walks them in order and
 *
 *   - SKIPS a provider that cannot answer the check, has no keys on file,
 *     or whose breaker is open — nothing is recorded for a skip;
 *   - ASKS the next one, recording the attempt (the attempt's id is the
 *     `verification_id` the provider is sent);
 *   - FAILS OVER only when the provider could not answer — a technical
 *     class. A BUSINESS answer ("this PAN is invalid", "the names do not
 *     match") is FINAL: no one is asked for a second opinion.
 *
 * What the SMS router lacks is here: a technical failure counts towards the
 * provider's breaker (`breaker.ts`), so a dead primary is not tried first
 * every time.
 *
 * Nothing here throws for something a provider did. A provider that throws
 * anyway (a bug) is recorded as a NETWORK failure and failed over.
 */

export type RouteOptions = {
  caseType: VerificationCaseType;
  caseId: string;
  sessionId?: string | null | undefined;
  /** Ask only this provider — the desk's "Resend on backup", which must not go back to the primary. */
  only?: VerificationProviderName | undefined;
  fetchImpl?: FetchLike | undefined;
  now?: (() => Date) | undefined;
};

/**
 * Why a provider was not asked. NEEDS_CONSENT: the provider could answer the
 * check, but not this request — Cashfree's UPI penny drop without the
 * holder's consent from the last five minutes. Skipped, not failed.
 */
export type SkipReason = 'NO_CAPABILITY' | 'NOT_CONFIGURED' | 'NEEDS_CONSENT' | 'CIRCUIT_OPEN';
export type SkippedProvider = { provider: VerificationProviderName; reason: SkipReason };

export type RoutedCheck = {
  /** The last answer given — null when no provider could be asked at all (see `skipped`). */
  result: CheckResult | null;
  /** The attempt that carries `result`. */
  attemptId: string | null;
  /** Every provider asked, in order — two rows is a failover. */
  attempts: AttemptRecord[];
  /** The answers behind `attempts`, in the same order — in memory only (they carry what is never stored). */
  results: CheckResult[];
  skipped: SkippedProvider[];
  failedOver: boolean;
};

/** The providers to walk for a check, primary first, each once. */
export function providerOrderFor(check: CheckType, settings: VerificationSettings, only?: VerificationProviderName): VerificationProviderName[] {
  if (only) return [only];
  const route = settings.checks[check];
  const order: VerificationProviderName[] = [];
  for (const name of [route.primary, ...route.fallbacks]) if (!order.includes(name)) order.push(name);
  return order;
}

/**
 * Can this provider be asked for this check right now? The reason when it
 * cannot. With the request in hand, the provider's own word on it too
 * (`usable`) — a check asked without one (the hosted backup's "is Cashfree
 * there at all?") reads the first two questions only.
 */
export async function providerUsable<C extends CheckType>(
  name: VerificationProviderName,
  check: C,
  settings: VerificationSettings,
  request?: { input: CheckInputs[C]; now: Date },
): Promise<SkipReason | null> {
  const runtime = verificationRuntime();
  const provider = runtime.providers[name];
  if (!provider.capabilities(settings).includes(check)) return 'NO_CAPABILITY';
  if (!(await provider.configured())) return 'NOT_CONFIGURED';
  if (request && provider.usable) return provider.usable(check, request.input, settings, request.now);
  return null;
}

const countsTowardsBreaker = (result: CheckResult): boolean =>
  result.status === 'FAILED' && isTechnical(result.errorClass) && BREAKER_COUNTED_CLASSES.includes(result.errorClass as TechnicalErrorClass);

export async function runCheck<C extends CheckType>(check: C, input: CheckInputs[C], options: RouteOptions): Promise<RoutedCheck> {
  const runtime = verificationRuntime();
  const settings = await runtime.settings();
  const routed: RoutedCheck = { result: null, attemptId: null, attempts: [], results: [], skipped: [], failedOver: false };
  let previous: AttemptRecord | null = null;

  for (const name of providerOrderFor(check, settings, options.only)) {
    const unusable = await providerUsable(name, check, settings, { input, now: options.now ? options.now() : new Date() });
    if (unusable) {
      routed.skipped.push({ provider: name, reason: unusable });
      continue;
    }
    const pass = await runtime.breaker.pass(name, settings.breaker);
    if (pass === 'OPEN') {
      routed.skipped.push({ provider: name, reason: 'CIRCUIT_OPEN' });
      continue;
    }

    const provider = runtime.providers[name];
    const attempt = await runtime.attempts.open({ caseType: options.caseType, caseId: options.caseId, sessionId: options.sessionId ?? null, checkType: check, provider: name });
    if (previous) {
      await runtime.attempts.markFailedOver(previous.id, name);
      routed.failedOver = true;
    }
    const ctx: CheckContext = { verificationId: attempt.verificationId, attemptNo: attempt.attemptNo, caseType: options.caseType, caseId: options.caseId, settings, fetchImpl: options.fetchImpl, now: options.now };

    const started = Date.now();
    let result: CheckResult;
    try {
      result = await provider.run(check, input, ctx);
    } catch (err) {
      logger.error('A verification provider threw; recorded as a network failure', { provider: name, check, reason: err instanceof Error ? err.name : 'unknown' });
      result = { status: 'FAILED', provider: name, providerRef: null, verificationId: attempt.verificationId, errorClass: 'NETWORK', failureCode: 'PROVIDER_THREW', failureReason: 'The provider could not be asked', raw: {} };
    }
    const latencyMs = Date.now() - started;

    const closed = await runtime.attempts.close(attempt.id, {
      status: result.status,
      errorClass: result.status === 'FAILED' ? (result.errorClass ?? 'BUSINESS') : null,
      failureCode: result.failureCode ?? null,
      latencyMs,
      providerRef: result.providerRef,
      nameMatchScore: result.nameMatchScore ?? null,
      // `transient` and `userAction` are never written: the first is in-memory only, the second is a ten-minute link.
      result: result.raw,
    });
    routed.attempts.push(closed);
    routed.results.push(result);
    routed.result = result;
    routed.attemptId = closed.id;
    previous = closed;

    const technical = result.status === 'FAILED' && isTechnical(result.errorClass);
    if (countsTowardsBreaker(result)) await runtime.breaker.failure(name, settings.breaker);
    else if (pass === 'PROBE') await runtime.breaker.success(name);

    // One line per attempt, no personal data: who was asked what, and how it went.
    logger.info('Verification check', {
      check,
      provider: name,
      status: result.status,
      errorClass: result.status === 'FAILED' ? (result.errorClass ?? 'BUSINESS') : null,
      failureCode: result.failureCode ?? null,
      latencyMs,
      attemptId: closed.id,
      attemptNo: closed.attemptNo,
      caseType: options.caseType,
      probe: pass === 'PROBE',
    });

    // A definite answer — or a check that is under way — ends the walk.
    if (!technical) return routed;
  }

  if (routed.attempts.length === 0) {
    logger.warn('Verification check not asked: no provider is usable', { check, caseType: options.caseType, skipped: routed.skipped });
  }
  return routed;
}

/**
 * Reads back an attempt that is waiting on the person (DigiLocker) or on
 * the provider (an async bank check) and records where it has got to. An
 * attempt belongs to the provider that took it, so there is no failover
 * here: a read that could not be made leaves the attempt as it was, to be
 * read again by the sweep.
 */
export async function refreshAttempt(attemptId: string, options: Pick<RouteOptions, 'fetchImpl' | 'now'> = {}): Promise<{ attempt: AttemptRecord; result: CheckResult | null } | null> {
  const runtime = verificationRuntime();
  const attempt = await runtime.attempts.find(attemptId);
  if (!attempt) return null;
  if (attempt.status !== 'PENDING' && attempt.status !== 'NEEDS_USER_ACTION') return { attempt, result: null };
  const provider = runtime.providers[attempt.provider];
  if (!provider.refresh) return { attempt, result: null };
  const settings = await runtime.settings();
  const ctx: CheckContext = { verificationId: attempt.verificationId, attemptNo: attempt.attemptNo, caseType: attempt.caseType, caseId: attempt.caseId, settings, fetchImpl: options.fetchImpl, now: options.now };
  let result: CheckResult;
  try {
    result = await provider.refresh({ checkType: attempt.checkType, verificationId: attempt.verificationId, providerRef: attempt.providerRef, result: attempt.result }, ctx);
  } catch (err) {
    logger.error('A verification provider threw on a status read; the attempt is left as it was', { provider: attempt.provider, check: attempt.checkType, reason: err instanceof Error ? err.name : 'unknown' });
    return { attempt, result: null };
  }
  return { attempt: await recordAttemptResult(attempt, result), result };
}

/** Writes an answer onto an attempt that was already open — a status read's, or a webhook's. */
export async function recordAttemptResult(attempt: AttemptRecord, result: CheckResult): Promise<AttemptRecord> {
  const runtime = verificationRuntime();
  const closed = await runtime.attempts.close(attempt.id, {
    status: result.status,
    errorClass: result.status === 'FAILED' ? (result.errorClass ?? 'BUSINESS') : null,
    failureCode: result.failureCode ?? null,
    providerRef: result.providerRef ?? attempt.providerRef,
    nameMatchScore: result.nameMatchScore ?? attempt.nameMatchScore,
    result: result.raw,
  });
  logger.info('Verification attempt read back', { check: attempt.checkType, provider: attempt.provider, status: result.status, failureCode: result.failureCode ?? null, attemptId: attempt.id });
  return closed;
}

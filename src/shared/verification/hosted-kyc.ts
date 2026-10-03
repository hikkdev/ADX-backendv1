import { ApiError } from '../errors/api-error';
import type { DigioKycRequest, DigioKycSession } from '../integrations/digio-client';
import { logger } from '../logging';
import { isTechnical, type VerificationCaseType } from './checks';
import { MAX_STEP_TRIES, SESSION_TTL_HOURS, openingSteps, sessionStatusOf, type SessionStep } from './composites';
import type { DigioHostedTransient } from './providers/digio';
import { providerUsable, runCheck } from './router';
import { verificationRuntime } from './runtime';
import { compositeFor, type VerificationSettings } from './settings';
import type { SessionRecord, SessionSubject } from './stores';

/**
 * The hosted KYC start, through the router — Cashfree Phase 1.
 *
 * Every Digio KYC start of every party comes through here instead of
 * calling the Digio client itself. Digio is asked first, as before; what is
 * new is what happens when Digio could not be asked (a TECHNICAL failure —
 * a business refusal is final and is answered as it always was):
 *
 *   - the attempt is recorded either way;
 *   - a Cashfree session is handed out in Digio's place ONLY when all of
 *     these hold (E-bis, 2 Oct 2026):
 *       · the setting `verificationRouting.hostedKycBackup` is ON (default OFF),
 *       · the caller said it can draw the Cashfree steps (`supports: ['CASHFREE']`),
 *       · it is the person's own start, not the desk's (the desk has no screens to hand a session to),
 *       · no Digio request is already out for the case — the MID-FLOW RULE:
 *         a person half-way through Digio is never switched silently;
 *   - otherwise the caller gets exactly the 503/502 it got before this
 *     layer existed. With the setting ON, a desk start or a mid-flow start
 *     that failed technically is flagged (`providerFailed`), so the caller
 *     marks the case PROVIDER_FAILED and ops are offered "Resend on backup".
 *
 * With the setting OFF nothing changes for anybody, except that the
 * attempt is on record.
 */

export type HostedKycStartInput = {
  caseType: VerificationCaseType;
  /** The party's id — what the session, the attempts and "Resend on backup" are keyed by. */
  caseId: string;
  digio: DigioKycRequest;
  /** The body's `supports` — what the calling client can draw besides Digio's page. */
  supports?: readonly string[] | undefined;
  origin: 'SELF' | 'DESK';
  /** The record already holds a Digio request that is still pending. */
  digioRequestOpen: boolean;
  /** The login that will act on a Cashfree session — the party's own. */
  ownerUserId: string | null;
  subject: SessionSubject;
};

export type HostedKycStart = { provider: 'DIGIO'; session: DigioKycSession } | { provider: 'CASHFREE'; session: SessionRecord };

/**
 * The Digio failure, as the client threw it, with one thing added for the
 * caller: `providerFailed` — mark the case PROVIDER_FAILED. The HTTP answer
 * is the one Digio's failure always had; `details.backup` is added only
 * when the backup can actually be sent, so the console knows to offer it.
 */
export class HostedKycProviderFailed extends ApiError {
  readonly providerFailed = true;
  constructor(original: ApiError, backup: { caseType: VerificationCaseType; caseId: string }) {
    super(original.statusCode, original.code, original.message, { ...((original.details ?? {}) as Record<string, unknown>), backup: { available: true, ...backup } });
  }
}

export const isProviderFailed = (err: unknown): err is HostedKycProviderFailed => err instanceof HostedKycProviderFailed;

/** The outage answer, in the Digio client's own words — for a Digio the breaker did not let through. */
function digioNotAnswering(): ApiError {
  return new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'Digio is not answering right now; try again in a few minutes or upload your documents instead', { provider: 'DIGIO', reason: 'PROVIDER_ERROR' });
}

/** Can a Cashfree session be opened for this workflow right now: the provider has keys, its breaker is not open, and the workflow has steps. */
export async function cashfreeBackupUsable(workflowKey: string | null, settings: VerificationSettings): Promise<boolean> {
  if (compositeFor(workflowKey, settings).length === 0) return false;
  if ((await providerUsable('CASHFREE_SECURE_ID', 'HOSTED_KYC', settings)) !== null) return false;
  const view = await verificationRuntime().breaker.view('CASHFREE_SECURE_ID', settings.breaker);
  return view.state !== 'OPEN';
}

/**
 * Cashfree Phase 2: may a person's own start hand out a backup session at
 * all right now — the switch is ON, Secure ID has keys and its breaker is
 * not open. What the clients read beside Digio's availability, so a person
 * is still offered the identity check while Digio is switched off (the
 * start then fails over). The workflow's own steps are checked at the start.
 */
export async function hostedKycBackupReady(): Promise<boolean> {
  const runtime = verificationRuntime();
  const settings = await runtime.settings();
  if (settings.hostedKycBackup !== 'ON') return false;
  if ((await providerUsable('CASHFREE_SECURE_ID', 'HOSTED_KYC', settings)) !== null) return false;
  const view = await runtime.breaker.view('CASHFREE_SECURE_ID', settings.breaker);
  return view.state !== 'OPEN';
}

/** Digio's availability with the backup beside it. A failure to read the backup reads as no backup — never a failed page. */
export async function kycAvailabilityWithBackup<T extends object>(digio: T): Promise<T & { backup: boolean }> {
  const backup = await hostedKycBackupReady().catch((err: unknown) => {
    logger.warn('Could not read whether the KYC backup is ready', { reason: err instanceof Error ? err.name : 'unknown' });
    return false;
  });
  return { ...digio, backup };
}

/**
 * A Cashfree session for a case: the open one when the case already has
 * one, else a new one with the workflow's steps. The caller writes the
 * party's own record (`method: 'CASHFREE'`).
 */
export async function openCashfreeSession(input: Pick<HostedKycStartInput, 'caseType' | 'caseId' | 'ownerUserId' | 'subject'> & { workflowKey: string | null }, now: Date = new Date()): Promise<SessionRecord> {
  const runtime = verificationRuntime();
  const existing = await runtime.sessions.findOpenForCase(input.caseType, input.caseId);
  if (existing && existing.expiresAt > now) return existing;
  const settings = await runtime.settings();
  const steps = openingSteps(compositeFor(input.workflowKey, settings));
  return runtime.sessions.create({
    caseType: input.caseType,
    caseId: input.caseId,
    workflowKey: input.workflowKey,
    provider: 'CASHFREE_SECURE_ID',
    ownerUserId: input.ownerUserId,
    subject: input.subject,
    steps,
    status: sessionStatusOf(steps),
    expiresAt: new Date(now.getTime() + SESSION_TTL_HOURS * 60 * 60 * 1000),
  });
}

export async function startHostedKyc(input: HostedKycStartInput, now: Date = new Date()): Promise<HostedKycStart> {
  const runtime = verificationRuntime();
  const settings = await runtime.settings();
  const backupOn = settings.hostedKycBackup === 'ON';
  const clientDrawsCashfree = (input.supports ?? []).includes('CASHFREE');
  // A workflow Cashfree has no steps for (an unknown key) is never handed a session.
  const mayHandOut = backupOn && input.origin === 'SELF' && clientDrawsCashfree && !input.digioRequestOpen && compositeFor(input.digio.workflowKey, settings).length > 0;

  // With no session to hand out, only Digio is asked — the router must not walk on to a provider nobody can use.
  const routed = await runCheck('HOSTED_KYC', { digio: input.digio }, { caseType: input.caseType, caseId: input.caseId, ...(mayHandOut ? {} : { only: 'DIGIO' as const }), now: () => now });
  const result = routed.result;

  if (result?.provider === 'DIGIO' && result.status !== 'FAILED') {
    return { provider: 'DIGIO', session: (result.transient as Extract<DigioHostedTransient, { session: unknown }>).session };
  }
  if (result?.provider === 'CASHFREE_SECURE_ID' && result.status !== 'FAILED' && mayHandOut) {
    const session = await openCashfreeSession({ caseType: input.caseType, caseId: input.caseId, workflowKey: input.digio.workflowKey, ownerUserId: input.ownerUserId, subject: input.subject }, now);
    logger.info('Hosted KYC failed over to a Cashfree session at initiate', { caseType: input.caseType, sessionId: session.id, workflowKey: input.digio.workflowKey });
    return { provider: 'CASHFREE', session };
  }

  // No session of either kind. Digio's own error when it was asked; the
  // outage answer when its breaker kept it from being asked at all.
  const digio = routed.results.find((answer) => answer.provider === 'DIGIO');
  const thrown = digio ? (digio.transient as Extract<DigioHostedTransient, { error: unknown }> | undefined)?.error : undefined;
  // Something the Digio client did not throw itself (a bug, not an answer): passed on as it is, as it always was.
  if (thrown !== undefined && !(thrown instanceof ApiError)) throw thrown;
  const error = thrown ?? digioNotAnswering();

  const technical = digio ? isTechnical(digio.errorClass) : true;
  // Flagged for "Resend on backup" only where a backup could really be sent.
  if (backupOn && technical && (input.origin === 'DESK' || input.digioRequestOpen) && (await cashfreeBackupUsable(input.digio.workflowKey, settings))) {
    throw new HostedKycProviderFailed(error, { caseType: input.caseType, caseId: input.caseId });
  }
  throw error;
}

/* ── what the clients are shown ────────────────────────────────── */

export type SessionStepView = { check: SessionStep['check']; required: boolean; status: SessionStep['status']; at: string | null; failureCode: string | null; triesLeft: number };
export type SessionView = {
  id: string;
  provider: 'CASHFREE';
  caseType: VerificationCaseType;
  caseId: string;
  workflowKey: string | null;
  status: SessionRecord['status'];
  steps: SessionStepView[];
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export const sessionStepView = (step: SessionStep): SessionStepView => ({
  check: step.check,
  required: step.required,
  status: step.status,
  at: step.at,
  failureCode: step.failureCode,
  triesLeft: Math.max(0, MAX_STEP_TRIES - step.tries),
});

/** The session as a client sees it: the steps and where each stands. Never the subject's names or an attempt's result. */
export function sessionView(session: SessionRecord): SessionView {
  return {
    id: session.id,
    provider: 'CASHFREE',
    caseType: session.caseType,
    caseId: session.caseId,
    workflowKey: session.workflowKey,
    status: session.status,
    steps: session.steps.map(sessionStepView),
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

/** What a KYC start answers when it hands out a Cashfree session instead of Digio's. */
export type CashfreeKycStart = { provider: 'CASHFREE'; sessionId: string; steps: SessionStepView[]; expiresAt: string };

export function cashfreeKycStart(session: SessionRecord): CashfreeKycStart {
  return { provider: 'CASHFREE', sessionId: session.id, steps: session.steps.map(sessionStepView), expiresAt: session.expiresAt.toISOString() };
}

/* ── the party modules' side of a start ────────────────────────── */

/**
 * A Cashfree session has no request id of Digio's; the party's record
 * carries this one in the same column, so the decision reaches the record
 * down the one road every hosted decision takes (the callback chain that
 * starts in `publishers`). The prefix says which provider it was.
 */
export const CASHFREE_REQUEST_PREFIX = 'cf_';
export const cashfreeRequestId = (sessionId: string): string => `${CASHFREE_REQUEST_PREFIX}${sessionId}`;

/** Which provider a hosted request id is from — what the record writes in `method` and `recordedVia`. */
export const hostedProviderOf = (requestId: string | null | undefined): 'DIGIO' | 'CASHFREE' => (requestId?.startsWith(CASHFREE_REQUEST_PREFIX) ? 'CASHFREE' : 'DIGIO');

/** Who a notice says did the checking: Digio by name; ADX itself for its own Cashfree-backed steps. */
export const hostedProviderName = (provider: 'DIGIO' | 'CASHFREE'): string => (provider === 'CASHFREE' ? 'ADX' : 'Digio');

/** What a record says while the desk waits for "Resend on backup". Kept on the raw provider-status column. */
export const PROVIDER_FAILED_STATUS = 'PROVIDER_FAILED';

/** The mid-flow rule's test: a Digio request already went out for this record and nothing has decided it. */
export function isDigioRequestOpen(record: { method?: string | null; digioRequestId?: string | null; status?: string | null } | null | undefined): boolean {
  return Boolean(record?.digioRequestId && record.status === 'PENDING' && record.method === 'DIGIO' && hostedProviderOf(record.digioRequestId) === 'DIGIO');
}

/** What a Digio start has always answered. */
export type DigioKycAnswer = { kycId: string; accessToken: string; validTill: string; sdkUrl: string };
/**
 * What a party's own KYC start answers. A client that sent no `supports`
 * gets the Digio answer exactly as before (E-bis: the existing shapes do
 * not change); one that sent it gets `provider` on either answer, so it can
 * tell which screens to draw.
 */
export type PartyKycAnswer = (DigioKycAnswer & { provider?: 'DIGIO' }) | CashfreeKycStart;

export type PartyKycStarted = HostedKycStart & {
  /** What the record keeps as its request id — Digio's, or `cf_<sessionId>`. */
  requestId: string;
};

/**
 * `startHostedKyc`, plus the one thing every party does when it fails in a
 * way the desk can act on: the record is marked PROVIDER_FAILED before the
 * error goes back out. A failure to mark never hides the real error.
 */
export async function startPartyKyc(input: HostedKycStartInput & { markProviderFailed: () => Promise<unknown> }, now: Date = new Date()): Promise<PartyKycStarted> {
  const { markProviderFailed, ...start } = input;
  try {
    const started = await startHostedKyc(start, now);
    return { ...started, requestId: started.provider === 'CASHFREE' ? cashfreeRequestId(started.session.id) : started.session.kycId };
  } catch (err) {
    if (isProviderFailed(err)) {
      await markProviderFailed().catch((reason: unknown) => {
        logger.error('A KYC record could not be marked PROVIDER_FAILED', { caseType: input.caseType, reason: reason instanceof Error ? reason.name : 'unknown' });
      });
    }
    throw err;
  }
}

export function partyKycAnswer(started: PartyKycStarted, supports: readonly string[] | undefined): PartyKycAnswer {
  if (started.provider === 'CASHFREE') return cashfreeKycStart(started.session);
  const { kycId, accessToken, validTill, sdkUrl } = started.session;
  return { ...(supports ? { provider: 'DIGIO' as const } : {}), kycId, accessToken, validTill, sdkUrl };
}

/** For a caller that asked for Digio and nothing else (the desk, an agent, a restart): the Digio answer, as before. */
export function digioAnswerOf(answer: PartyKycAnswer): DigioKycAnswer {
  if ('sessionId' in answer) throw new Error('A Cashfree session was handed to a caller that cannot use one');
  const { kycId, accessToken, validTill, sdkUrl } = answer;
  return { kycId, accessToken, validTill, sdkUrl };
}

/**
 * Has Cashfree proved this party is a live person matching their identity
 * document? True when the case's newest session has both face steps passed.
 * The desk's manual review asks for a liveness video unless the provider
 * already proved it (Digio's own check, or this).
 */
export async function cashfreeIdentityProven(caseType: VerificationCaseType, caseId: string): Promise<boolean> {
  const [latest] = await verificationRuntime().sessions.listForCase(caseType, caseId);
  if (!latest) return false;
  const passed = (check: SessionStep['check']) => latest.steps.some((step) => step.check === check && step.status === 'VERIFIED');
  return passed('FACE_LIVENESS') && passed('FACE_MATCH');
}

/* ── the desk's "Resend on backup" ─────────────────────────────── */

/**
 * What "Resend on backup" needs of a party's KYC case. Each party's module
 * supplies one of these for its own table (`load` reads the party and its
 * record, `stamp` puts the record on the Cashfree path); bootstrap hands
 * them to the verification service, which may import none of the modules.
 */
export type BackupCase = {
  /** The party's own login — who will act on the session. Null when they have none yet. */
  ownerUserId: string | null;
  subject: SessionSubject;
  /** The Digio workflow the case would have run; null when the legal form is not known yet. */
  workflowKey: string | null;
  verified: boolean;
};
export type BackupStamp = { method: 'CASHFREE'; digioRequestId: string; digioReferenceId: string; digioStatus: 'pending'; at: Date };
export interface BackupCasePort {
  load(caseId: string): Promise<BackupCase | null>;
  stamp(caseId: string, fields: BackupStamp): Promise<unknown>;
}

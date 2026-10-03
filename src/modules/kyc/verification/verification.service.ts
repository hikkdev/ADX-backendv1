import type { Request } from 'express';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { logActivity } from '../../../shared/audit';
import {
  DIGILOCKER_CONSENT_GONE,
  VERIFICATION_PROVIDER_LABELS,
  VERIFICATION_PROVIDER_NAMES,
  answerStep,
  bankResultOf,
  cashfreeBackupUsable,
  cashfreeRequestId,
  digilockerDocument,
  digilockerResultFromEvent,
  isSessionOpen,
  isTechnical,
  openCashfreeSession,
  recordAttemptResult,
  refreshAttempt,
  reopenStep,
  runCheck,
  sessionStatusOf,
  sessionView,
  stepOf,
  verificationRuntime,
  type AttemptRecord,
  type BackupCasePort,
  type CheckInputs,
  type CheckResult,
  type CheckType,
  type CompositeStepKind,
  type ImageInput,
  type RoutedCheck,
  type SecureIdEvent,
  type SessionRecord,
  type SessionStatus,
  type SessionStep,
  type SessionSubject,
  type SessionView,
  type VerificationCaseType,
  type VerificationProviderName,
} from '../../../shared/verification';
import { createNotification } from '../../notifications';

/**
 * The Cashfree session — Digio's backup, walked on ADX's own screens
 * (Cashfree Phase 1; the owner, 1 Oct 2026).
 *
 * Digio runs a KYC journey from one template. Cashfree's equivalent is a
 * SESSION of single checks (`shared/verification/composites.ts` says which,
 * per workflow), and this is the service behind the screens that take them:
 * DigiLocker, the selfie, the bank account, the business numbers, and for
 * an agent the licence and the vehicle. Every check goes through the
 * verification router, so each is an attempt on record.
 *
 * Three rules the whole file keeps:
 *
 *   - A session is the PERSON'S OWN. Only the login it was opened for may
 *     read or act on it; anyone else is told it does not exist.
 *   - Aadhaar is never stored (the standing owner rule; E-bis, 2 Oct 2026).
 *     DigiLocker's answer is cut down by the provider before it is kept —
 *     the name, the year of birth, the last four, the status. The Aadhaar
 *     photograph is fetched again at selfie time, compared IN MEMORY and
 *     dropped; when the hour of consent has run out, DigiLocker is asked
 *     again. The selfie is never stored either: it arrives through the
 *     upload door, is read into memory and deleted — only the scores stay.
 *   - Nothing is REJECTED here. An individual whose every step passes is
 *     verified automatically; a case with business papers goes to the desk
 *     with the results attached; a session that cannot pass is FAILED and a
 *     person decides.
 *
 * The decision reaches the party's own record down the road every hosted
 * decision takes — the callback chain that starts in `publishers` —
 * registered here by bootstrap, because `kyc` may not import `publishers`.
 */

/* ── ports, filled by bootstrap ────────────────────────────────── */

/** The hosted-decision road: `{ id, status }` to whichever party's record carries the request id. */
export type HostedOutcomeHandler = (payload: { id: string; status: string; completed_at?: string; message?: string }) => Promise<boolean>;

let hostedOutcome: HostedOutcomeHandler | null = null;
export function registerHostedOutcomeHandler(handler: HostedOutcomeHandler | null): void {
  hostedOutcome = handler;
}

/** The five parties' cases, each supplied by its own module (`BackupCasePort`). */
const backupCases = new Map<VerificationCaseType, BackupCasePort>();
export function registerBackupCase(caseType: VerificationCaseType, port: BackupCasePort): void {
  backupCases.set(caseType, port);
}
/** For tests. */
export function resetVerificationPorts(): void {
  backupCases.clear();
  hostedOutcome = null;
}

/* ── the session ───────────────────────────────────────────────── */

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Verification session not found');

async function ownSession(sessionId: string, userId: string): Promise<SessionRecord> {
  const session = await verificationRuntime().sessions.find(sessionId);
  // Somebody else's session is not there at all — its existence is not theirs to learn.
  if (!session || !session.ownerUserId || session.ownerUserId !== userId) throw notFound();
  return session;
}

/** The decision, sent down the hosted-decision road to the party's record. Never fails the request that caused it. */
async function publishOutcome(session: SessionRecord, status: SessionStatus, now: Date): Promise<void> {
  const word = status === 'VERIFIED' ? 'approved' : status === 'IN_REVIEW' ? 'in_review' : status === 'EXPIRED' ? 'expired' : 'failed';
  if (!hostedOutcome) {
    logger.warn('Verification session decided with no outcome handler registered', { sessionId: session.id, status });
    return;
  }
  try {
    const claimed = await hostedOutcome({ id: cashfreeRequestId(session.id), status: word, ...(status === 'VERIFIED' ? { completed_at: now.toISOString() } : {}) });
    if (!claimed) logger.warn('Verification session outcome matched no KYC record', { sessionId: session.id, caseType: session.caseType, status });
  } catch (err) {
    logger.error('Verification session outcome could not be applied to the KYC record', { sessionId: session.id, caseType: session.caseType, status, reason: err instanceof Error ? err.name : 'unknown' });
  }
}

/** The steps as they now stand, written; the party's record told when the session has reached a decision. */
async function settle(session: SessionRecord, steps: SessionStep[], subject: SessionSubject | null, now: Date): Promise<SessionRecord> {
  const status = sessionStatusOf(steps);
  const saved = await verificationRuntime().sessions.update(session.id, { steps, status, subject });
  if (status !== session.status && (status === 'VERIFIED' || status === 'IN_REVIEW' || status === 'FAILED')) await publishOutcome(saved, status, now);
  return saved;
}

/** A session that may still be acted on — closed on the spot when its time has run out. */
async function actionable(session: SessionRecord, now: Date): Promise<SessionRecord> {
  if (isSessionOpen(session.status) && session.expiresAt <= now) {
    const expired = await verificationRuntime().sessions.update(session.id, { status: 'EXPIRED' });
    await publishOutcome(expired, 'EXPIRED', now);
    throw new ApiError(409, 'VERIFICATION_SESSION_CLOSED', 'This verification session has expired. Start the identity check again.', { status: 'EXPIRED' });
  }
  if (!isSessionOpen(session.status)) {
    throw new ApiError(409, 'VERIFICATION_SESSION_CLOSED', 'This verification session is closed; there is nothing more to do on it.', { status: session.status });
  }
  return session;
}

/** The step of this kind, when the session has one that is still to be passed. */
function openStep(session: SessionRecord, check: CompositeStepKind): SessionStep {
  const step = stepOf(session.steps, check);
  if (!step) throw new ApiError(409, 'VERIFICATION_STEP_NOT_OPEN', 'This step is not part of this verification session.', { check });
  if (step.status === 'VERIFIED') throw new ApiError(409, 'VERIFICATION_STEP_NOT_OPEN', 'This step has already passed.', { check, status: step.status });
  return step;
}

const needs = (check: CompositeStepKind, first: CompositeStepKind, sentence: string) => new ApiError(409, 'VERIFICATION_STEP_NOT_OPEN', sentence, { check, needs: first });

/** One check for a session, through the router. A provider that could not answer is a 503 — nothing is held against the person. */
async function ask<C extends CheckType>(session: SessionRecord, check: C, input: CheckInputs[C]): Promise<{ routed: RoutedCheck; result: CheckResult }> {
  const routed = await runCheck(check, input, { caseType: session.caseType, caseId: session.caseId, sessionId: session.id });
  const result = routed.result;
  if (!result) {
    throw new ApiError(503, 'VERIFICATION_UNAVAILABLE', 'This check cannot be made right now. Try again in a few minutes.', { check, reason: routed.skipped[0]?.reason ?? 'NO_PROVIDER' });
  }
  if (result.status === 'FAILED' && isTechnical(result.errorClass)) {
    throw new ApiError(503, 'VERIFICATION_UNAVAILABLE', 'This check cannot be made right now. Try again in a few minutes.', { check, errorClass: result.errorClass });
  }
  return { routed, result };
}

const answerOf = (result: CheckResult, attemptId: string | null, at: Date) => ({
  status: result.status === 'VERIFIED' ? ('VERIFIED' as const) : result.status === 'FAILED' ? ('FAILED' as const) : ('PENDING' as const),
  attemptId,
  at,
  failureCode: result.failureCode ?? null,
});

/** What a step's answer looks like to the person: the verdict, the code when it is a "no", a score where there is one. */
type StepOutcome = { status: 'VERIFIED' | 'FAILED' | 'PENDING'; failureCode: string | null; score?: number | null };
const outcomeOf = (result: CheckResult, score?: number | null): StepOutcome => ({
  status: result.status === 'VERIFIED' ? 'VERIFIED' : result.status === 'FAILED' ? 'FAILED' : 'PENDING',
  failureCode: result.status === 'FAILED' ? (result.failureCode ?? null) : null,
  ...(score !== undefined ? { score } : {}),
});

export async function getSession(sessionId: string, userId: string, now = new Date()): Promise<SessionView> {
  const session = await ownSession(sessionId, userId);
  // A read never throws for an expired session; it says so.
  if (isSessionOpen(session.status) && session.expiresAt <= now) {
    const expired = await verificationRuntime().sessions.update(session.id, { status: 'EXPIRED' });
    await publishOutcome(expired, 'EXPIRED', now);
    return sessionView(expired);
  }
  return sessionView(session);
}

/**
 * `GET /verification/sessions/mine` — the caller's sessions still to be
 * finished, newest first. A person who left half-way (or was sent one by
 * "Resend on backup") finds it here; one whose time ran out is closed on
 * the way and left out.
 */
export async function listMySessions(userId: string, now = new Date()): Promise<{ sessions: SessionView[] }> {
  const open = await verificationRuntime().sessions.listOpenForOwner(userId);
  const sessions: SessionView[] = [];
  for (const session of open) {
    if (session.expiresAt <= now) {
      const expired = await verificationRuntime().sessions.update(session.id, { status: 'EXPIRED' });
      await publishOutcome(expired, 'EXPIRED', now);
      continue;
    }
    sessions.push(sessionView(session));
  }
  return { sessions };
}

/* ── DigiLocker ────────────────────────────────────────────────── */

export async function startDigilocker(sessionId: string, userId: string, input: { redirectUrl: string }, now = new Date()): Promise<{ url: string; expiresAt: string | null; session: SessionView }> {
  const session = await actionable(await ownSession(sessionId, userId), now);
  openStep(session, 'DIGILOCKER');
  const { routed, result } = await ask(session, 'DIGILOCKER', { documents: ['AADHAAR', 'PAN'], redirectUrl: input.redirectUrl });
  if (result.status === 'FAILED' || !result.userAction) {
    // Cashfree would not open the page for this request (a redirect address it will not take). Not a try against the person.
    throw new ApiError(400, 'VALIDATION_ERROR', 'DigiLocker could not be opened with this request.', { check: 'DIGILOCKER', code: result.failureCode ?? null });
  }
  const steps = answerStep(session.steps, 'DIGILOCKER', { status: 'PENDING', attemptId: routed.attemptId, at: now });
  const saved = await settle(session, steps, session.subject, now);
  return { url: result.userAction.url, expiresAt: result.userAction.expiresAt, session: sessionView(saved) };
}

/** What the person is shown of what DigiLocker shared: each document's status and last four, and the name. Never a number. */
function digilockerSummary(attempt: AttemptRecord): { name: string | null; documents: Record<string, { status: string | null; last4: string | null }> } {
  const result = attempt.result ?? {};
  const stored = (result['documents'] ?? {}) as Record<string, { status?: string; last4?: string | null }>;
  const documents: Record<string, { status: string | null; last4: string | null }> = {};
  for (const [name, row] of Object.entries(stored)) documents[name] = { status: row?.status ?? null, last4: row?.last4 ?? null };
  return { name: typeof result['name'] === 'string' ? (result['name'] as string) : null, documents };
}

/** A DigiLocker attempt's answer laid on its session's step. */
async function applyDigilockerAttempt(session: SessionRecord, attempt: AttemptRecord, now: Date): Promise<SessionRecord> {
  const step = stepOf(session.steps, 'DIGILOCKER');
  // An older attempt's late answer never moves a step a newer attempt owns.
  if (!step || step.attemptId !== attempt.id || !isSessionOpen(session.status)) return session;
  if (attempt.status === 'VERIFIED') {
    const name = digilockerSummary(attempt).name;
    const subject = session.subject ? { ...session.subject, identityName: name ?? session.subject.identityName ?? null } : session.subject;
    return settle(session, answerStep(session.steps, 'DIGILOCKER', { status: 'VERIFIED', attemptId: attempt.id, at: now }), subject, now);
  }
  if (attempt.status === 'FAILED') {
    return settle(session, answerStep(session.steps, 'DIGILOCKER', { status: 'FAILED', attemptId: attempt.id, at: now, failureCode: attempt.failureCode }), session.subject, now);
  }
  return session;
}

export async function refreshDigilocker(sessionId: string, userId: string, now = new Date()) {
  const session = await actionable(await ownSession(sessionId, userId), now);
  const step = stepOf(session.steps, 'DIGILOCKER');
  if (!step) throw new ApiError(409, 'VERIFICATION_STEP_NOT_OPEN', 'This step is not part of this verification session.', { check: 'DIGILOCKER' });
  if (!step.attemptId) throw new ApiError(409, 'VERIFICATION_STEP_NOT_OPEN', 'Open DigiLocker first.', { check: 'DIGILOCKER', needs: 'DIGILOCKER' });
  const read = step.status === 'PENDING' ? await refreshAttempt(step.attemptId) : null;
  const attempt = read?.attempt ?? (await verificationRuntime().attempts.find(step.attemptId));
  if (!attempt) throw notFound();
  const saved = await applyDigilockerAttempt(session, attempt, now);
  const current = stepOf(saved.steps, 'DIGILOCKER')!;
  return { status: current.status, failureCode: current.failureCode, ...digilockerSummary(attempt), session: sessionView(saved) };
}

/* ── the selfie ────────────────────────────────────────────────── */

export async function submitSelfie(sessionId: string, userId: string, image: ImageInput, now = new Date()) {
  let session = await actionable(await ownSession(sessionId, userId), now);
  const hasMatch = Boolean(stepOf(session.steps, 'FACE_MATCH'));
  const digilocker = stepOf(session.steps, 'DIGILOCKER');
  if (!stepOf(session.steps, 'FACE_LIVENESS')) throw new ApiError(409, 'VERIFICATION_STEP_NOT_OPEN', 'This step is not part of this verification session.', { check: 'FACE_LIVENESS' });
  if (stepOf(session.steps, 'FACE_LIVENESS')!.status === 'VERIFIED' && (!hasMatch || stepOf(session.steps, 'FACE_MATCH')!.status === 'VERIFIED')) {
    throw new ApiError(409, 'VERIFICATION_STEP_NOT_OPEN', 'This step has already passed.', { check: 'FACE_LIVENESS' });
  }
  // The face is matched to the DigiLocker photograph, so DigiLocker comes first.
  if (hasMatch && (!digilocker || digilocker.status !== 'VERIFIED' || !digilocker.attemptId)) {
    throw needs('FACE_MATCH', 'DIGILOCKER', 'Finish DigiLocker before the selfie: the selfie is matched to your DigiLocker photograph.');
  }

  const liveness = await ask(session, 'FACE_LIVENESS', { image });
  session = await settle(session, answerStep(session.steps, 'FACE_LIVENESS', answerOf(liveness.result, liveness.routed.attemptId, now)), session.subject, now);
  const livenessOutcome = outcomeOf(liveness.result, typeof liveness.result.raw['livenessScore'] === 'number' ? (liveness.result.raw['livenessScore'] as number) : null);
  if (liveness.result.status !== 'VERIFIED' || !hasMatch || !isSessionOpen(session.status)) {
    return { liveness: livenessOutcome, faceMatch: null, session: sessionView(session) };
  }

  // E-bis: the Aadhaar photograph is not kept. It is fetched again now — the
  // consent lasts about an hour — compared in memory and dropped.
  const digilockerAttempt = await verificationRuntime().attempts.find(digilocker!.attemptId!);
  const document = await digilockerDocument(digilockerAttempt?.verificationId ?? digilocker!.attemptId!, 'AADHAAR');
  if (!document.ok || !document.photo) {
    const consentGone = !document.ok ? Boolean(document.code && DIGILOCKER_CONSENT_GONE.has(document.code)) : true;
    if (consentGone) {
      session = await settle(session, reopenStep(session.steps, 'DIGILOCKER'), session.subject, now);
      throw new ApiError(409, 'DIGILOCKER_CONSENT_REQUIRED', 'Your DigiLocker consent has run out. Open DigiLocker again, then retake the selfie.', { check: 'FACE_MATCH', needs: 'DIGILOCKER' });
    }
    throw new ApiError(503, 'VERIFICATION_UNAVAILABLE', 'This check cannot be made right now. Try again in a few minutes.', { check: 'FACE_MATCH', errorClass: document.ok ? 'HTTP_5XX' : document.errorClass });
  }

  const match = await ask(session, 'FACE_MATCH', { first: image, second: { bytes: document.photo, mime: 'image/jpeg', filename: 'reference.jpg' } });
  session = await settle(session, answerStep(session.steps, 'FACE_MATCH', answerOf(match.result, match.routed.attemptId, now)), session.subject, now);
  return {
    liveness: livenessOutcome,
    faceMatch: outcomeOf(match.result, typeof match.result.raw['score'] === 'number' ? (match.result.raw['score'] as number) : null),
    session: sessionView(session),
  };
}

/* ── the bank account ──────────────────────────────────────────── */

export async function submitBank(sessionId: string, userId: string, input: { accountNumber: string; ifsc: string }, now = new Date()) {
  let session = await actionable(await ownSession(sessionId, userId), now);
  openStep(session, 'NAME_MATCH');
  if (!stepOf(session.steps, 'BANK_ACCOUNT')) throw new ApiError(409, 'VERIFICATION_STEP_NOT_OPEN', 'This step is not part of this verification session.', { check: 'BANK_ACCOUNT' });

  // The holder's name is matched to the name the identity gave — the entity's, for a business.
  const subject = session.subject;
  const business = subject?.business === true;
  const reference = business ? subject?.entityName : subject?.identityName;
  if (!reference) {
    throw business
      ? needs('NAME_MATCH', 'PAN', 'Verify the business PAN first: the account holder is matched to the registered name.')
      : needs('NAME_MATCH', 'DIGILOCKER', 'Finish DigiLocker first: the account holder is matched to the name on your identity.');
  }

  const bank = await ask(session, 'BANK_ACCOUNT', { accountNumber: input.accountNumber, ifsc: input.ifsc, mode: 'SYNC' });
  session = await settle(session, answerStep(session.steps, 'BANK_ACCOUNT', answerOf(bank.result, bank.routed.attemptId, now)), session.subject, now);
  const bankOutcome = { ...outcomeOf(bank.result), bankName: typeof bank.result.raw['bankName'] === 'string' ? (bank.result.raw['bankName'] as string) : null };
  if (bank.result.status !== 'VERIFIED' || !isSessionOpen(session.status)) return { bank: bankOutcome, nameMatch: null, session: sessionView(session) };

  const nameAtBank = bank.result.matchedName;
  if (!nameAtBank) {
    // The bank confirmed the account and gave no holder name: there is nothing to match, and a person decides.
    session = await settle(session, answerStep(session.steps, 'NAME_MATCH', { status: 'FAILED', attemptId: null, at: now, failureCode: 'NO_NAME_AT_BANK' }), session.subject, now);
    return { bank: bankOutcome, nameMatch: { status: 'FAILED' as const, failureCode: 'NO_NAME_AT_BANK', score: null }, session: sessionView(session) };
  }
  const match = await ask(session, 'NAME_MATCH', { name1: nameAtBank, name2: reference });
  session = await settle(session, answerStep(session.steps, 'NAME_MATCH', answerOf(match.result, match.routed.attemptId, now)), session.subject, now);
  return { bank: bankOutcome, nameMatch: outcomeOf(match.result, match.result.nameMatchScore ?? null), session: sessionView(session) };
}

/* ── the business: PAN and GSTIN ───────────────────────────────── */

export async function submitBusiness(sessionId: string, userId: string, input: { pan: string; gstin?: string | undefined }, now = new Date()) {
  let session = await actionable(await ownSession(sessionId, userId), now);
  if (!stepOf(session.steps, 'PAN')) throw new ApiError(409, 'VERIFICATION_STEP_NOT_OPEN', 'This step is not part of this verification session.', { check: 'PAN' });
  const gstinStep = stepOf(session.steps, 'GSTIN');
  if (gstinStep?.required && gstinStep.status !== 'VERIFIED' && !input.gstin) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A GSTIN is needed for this account.', { fieldErrors: { gstin: ['Required'] }, formErrors: [] });
  }

  const pan = await ask(session, 'PAN', { pan: input.pan, name: session.subject?.name });
  const entityName = pan.result.status === 'VERIFIED' ? (pan.result.matchedName ?? null) : null;
  let subject = session.subject && entityName ? { ...session.subject, entityName } : session.subject;
  session = await settle(session, answerStep(session.steps, 'PAN', answerOf(pan.result, pan.routed.attemptId, now)), subject, now);
  const panOutcome = { ...outcomeOf(pan.result, pan.result.nameMatchScore ?? null), registeredName: pan.result.matchedName ?? null };

  if (!gstinStep || !input.gstin || !isSessionOpen(session.status)) return { pan: panOutcome, gstin: null, session: sessionView(session) };

  const gstin = await ask(session, 'GSTIN', { gstin: input.gstin, businessName: session.subject?.name });
  // The GST registry's legal name stands in when the PAN gave none.
  subject = session.subject && !session.subject.entityName && gstin.result.status === 'VERIFIED' && gstin.result.matchedName ? { ...session.subject, entityName: gstin.result.matchedName } : session.subject;
  session = await settle(session, answerStep(session.steps, 'GSTIN', answerOf(gstin.result, gstin.routed.attemptId, now)), subject, now);
  return { pan: panOutcome, gstin: { ...outcomeOf(gstin.result), legalName: gstin.result.matchedName ?? null }, session: sessionView(session) };
}

/* ── an agent: the licence and the vehicle ─────────────────────── */

export async function submitDrivingLicence(sessionId: string, userId: string, input: { dlNumber: string; dob: string }, now = new Date()) {
  const session = await actionable(await ownSession(sessionId, userId), now);
  openStep(session, 'DRIVING_LICENCE');
  const { routed, result } = await ask(session, 'DRIVING_LICENCE', { dlNumber: input.dlNumber, dob: input.dob });
  const saved = await settle(session, answerStep(session.steps, 'DRIVING_LICENCE', answerOf(result, routed.attemptId, now)), session.subject, now);
  return { drivingLicence: outcomeOf(result), session: sessionView(saved) };
}

export async function submitVehicle(sessionId: string, userId: string, input: { vehicleNumber: string }, now = new Date()) {
  const session = await actionable(await ownSession(sessionId, userId), now);
  openStep(session, 'VEHICLE_RC');
  const { routed, result } = await ask(session, 'VEHICLE_RC', { vehicleNumber: input.vehicleNumber });
  const saved = await settle(session, answerStep(session.steps, 'VEHICLE_RC', answerOf(result, routed.attemptId, now)), session.subject, now);
  return { vehicle: outcomeOf(result), session: sessionView(saved) };
}

/* ── the desk ──────────────────────────────────────────────────── */

export type AttemptView = Omit<AttemptRecord, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string; providerLabel: string };
const attemptView = (attempt: AttemptRecord): AttemptView => ({
  ...attempt,
  providerLabel: VERIFICATION_PROVIDER_LABELS[attempt.provider],
  createdAt: attempt.createdAt.toISOString(),
  updatedAt: attempt.updatedAt.toISOString(),
});

/** `GET /verification/attempts` — every provider call made for a case, newest first, its sessions, and whether the backup can be sent. */
export async function listCaseAttempts(caseType: VerificationCaseType, caseId: string) {
  const runtime = verificationRuntime();
  const [attempts, sessions, settings] = await Promise.all([runtime.attempts.listForCase(caseType, caseId), runtime.sessions.listForCase(caseType, caseId), runtime.settings()]);
  const port = backupCases.get(caseType);
  const kycCase = port ? await port.load(caseId) : null;
  const usable = Boolean(kycCase && !kycCase.verified && settings.hostedKycBackup === 'ON' && (await cashfreeBackupUsable(kycCase.workflowKey, settings)));
  return {
    attempts: attempts.map(attemptView),
    sessions: sessions.map(sessionView),
    backup: { setting: settings.hostedKycBackup, available: usable },
  };
}

const backupRefused = (reason: 'SWITCHED_OFF' | 'NOT_CONFIGURED' | 'ENTITY_TYPE_UNKNOWN' | 'NOT_A_KYC_CASE', sentence: string) =>
  new ApiError(409, 'BACKUP_NOT_AVAILABLE', sentence, { reason });

/**
 * `POST /verification/cases/:caseType/:caseId/resend-on-backup` — the desk
 * sends a case to Cashfree after Digio could not be asked. A session is
 * opened for the party, their record goes onto the Cashfree path, and they
 * are told to open the app; the session is theirs to finish. Audited.
 */
export async function resendOnBackup(caseType: VerificationCaseType, caseId: string, byUserId: string, req?: Request, now = new Date()) {
  const port = backupCases.get(caseType);
  if (!port) throw backupRefused('NOT_A_KYC_CASE', 'Only a party’s KYC case can be sent to the backup provider.');
  const runtime = verificationRuntime();
  const settings = await runtime.settings();
  if (settings.hostedKycBackup !== 'ON') throw backupRefused('SWITCHED_OFF', 'The backup provider is switched off. Turn it on under Settings › Integrations › Verification routing.');
  const kycCase = await port.load(caseId);
  if (!kycCase) throw new ApiError(404, 'NOT_FOUND', 'No such account');
  if (kycCase.verified) throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This account is already verified; there is nothing to send');
  if (!kycCase.workflowKey) throw backupRefused('ENTITY_TYPE_UNKNOWN', 'Say what kind of account this is first; the checks depend on it.');
  if (!(await cashfreeBackupUsable(kycCase.workflowKey, settings))) throw backupRefused('NOT_CONFIGURED', 'Cashfree Secure ID is not set up or is not answering; the backup cannot be sent yet.');

  // On record as the backup's own attempt, beside Digio's failed one.
  await runCheck(
    'HOSTED_KYC',
    { digio: { party: kycCase.subject.party, workflowKey: kycCase.workflowKey, referenceId: `backup-${caseId}-${now.getTime()}`, customerName: '', customerEmail: '', customerMobile: '' } },
    { caseType, caseId, only: 'CASHFREE_SECURE_ID', now: () => now },
  );
  const session = await openCashfreeSession({ caseType, caseId, workflowKey: kycCase.workflowKey, ownerUserId: kycCase.ownerUserId, subject: kycCase.subject }, now);
  await port.stamp(caseId, { method: 'CASHFREE', digioRequestId: cashfreeRequestId(session.id), digioReferenceId: `backup-${session.id}`, digioStatus: 'pending', at: now });

  await logActivity(byUserId, 'KYC_RESENT_ON_BACKUP', {
    req,
    targetType: caseType,
    targetId: caseId,
    module: 'kyc',
    metadata: { sessionId: session.id, workflowKey: kycCase.workflowKey, provider: 'CASHFREE_SECURE_ID' },
  });

  let notified = false;
  if (kycCase.ownerUserId) {
    await createNotification({
      userId: kycCase.ownerUserId,
      type: 'KYC',
      title: 'Finish your identity check',
      message: 'ADX has opened a fresh identity check for you. Finish it in the ADX app or on the website — it takes a few minutes.',
      relatedId: session.id,
      relatedType: 'VERIFICATION_SESSION',
    });
    notified = true;
  } else {
    logger.info('Backup session notice skipped: the party has no app account yet', { caseType, sessionId: session.id });
  }
  return { session: sessionView(session), notified };
}

/** The 95th percentile of a list of latencies; null for none. */
function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

/** `GET /verification/health` — per provider: the breaker, the last day's success rate and p95 latency, and today's failovers. */
export async function verificationHealth(now = new Date()) {
  const runtime = verificationRuntime();
  const settings = await runtime.settings();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const attempts = await runtime.attempts.listSince(since, 5_000);

  const providers = await Promise.all(
    VERIFICATION_PROVIDER_NAMES.map(async (name: VerificationProviderName) => {
      const provider = runtime.providers[name];
      const mine = attempts.filter((attempt) => attempt.provider === name);
      // "Success" is "the provider answered" — a definite no is an answer. Only a technical failure counts against it.
      const failed = mine.filter((attempt) => attempt.status === 'FAILED' && isTechnical(attempt.errorClass));
      const latencies = mine.map((attempt) => attempt.latencyMs).filter((value): value is number => typeof value === 'number');
      return {
        name,
        label: VERIFICATION_PROVIDER_LABELS[name],
        configured: await provider.configured(),
        capabilities: provider.capabilities(settings),
        breaker: await runtime.breaker.view(name, settings.breaker),
        last24h: {
          attempts: mine.length,
          technicalFailures: failed.length,
          successRate: mine.length === 0 ? null : Math.round(((mine.length - failed.length) / mine.length) * 1000) / 10,
          p95LatencyMs: p95(latencies),
        },
        failoversToday: mine.filter((attempt) => attempt.createdAt >= startOfToday && typeof attempt.result?.['failedOverTo'] === 'string').length,
      };
    }),
  );
  return { at: now.toISOString(), hostedKycBackup: settings.hostedKycBackup, breakerSettings: settings.breaker, providers };
}

/* ── the webhook and the sweep ─────────────────────────────────── */

const FINAL = (attempt: AttemptRecord) => attempt.status === 'VERIFIED' || attempt.status === 'FAILED';

/** A generic attempt's answer laid on its session's step (the async bank check). */
async function applyAttemptToSession(attempt: AttemptRecord, now: Date): Promise<void> {
  if (!attempt.sessionId) return;
  const session = await verificationRuntime().sessions.find(attempt.sessionId);
  if (!session) return;
  if (attempt.checkType === 'DIGILOCKER') {
    await applyDigilockerAttempt(session, attempt, now);
    return;
  }
  const check = attempt.checkType as CompositeStepKind;
  const step = stepOf(session.steps, check);
  if (!step || step.attemptId !== attempt.id || !isSessionOpen(session.status) || !FINAL(attempt)) return;
  await settle(session, answerStep(session.steps, check, { status: attempt.status === 'VERIFIED' ? 'VERIFIED' : 'FAILED', attemptId: attempt.id, at: now, failureCode: attempt.failureCode }), session.subject, now);
}

/**
 * One Cashfree Secure ID event, already verified and claimed. DigiLocker
 * events and the async bank check's are the two the layer acts on; every
 * other is recorded and left. Returns what was done, for the event's row.
 */
export async function processSecureIdEvent(event: SecureIdEvent, now = new Date()): Promise<string> {
  const runtime = verificationRuntime();
  const idOf = (key: string): string | null => {
    const value = event.data[key];
    return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;
  };

  if (event.eventType.startsWith('DIGILOCKER_')) {
    const verificationId = idOf('verification_id');
    const attempt = verificationId ? await runtime.attempts.find(verificationId) : null;
    if (!attempt || attempt.checkType !== 'DIGILOCKER') return 'NO_ATTEMPT';
    if (FINAL(attempt)) return 'ALREADY_FINAL';
    const settings = await runtime.settings();
    const result = await digilockerResultFromEvent(
      { checkType: 'DIGILOCKER', verificationId: attempt.verificationId, providerRef: attempt.providerRef, result: attempt.result },
      { verificationId: attempt.verificationId, attemptNo: attempt.attemptNo, caseType: attempt.caseType, caseId: attempt.caseId, settings },
      event.data,
    );
    const saved = await recordAttemptResult(attempt, result);
    await applyAttemptToSession(saved, now);
    return `APPLIED:${saved.status}`;
  }

  if (event.eventType.startsWith('BANK_ACCOUNT_VERIFICATION_')) {
    const userId = idOf('user_id');
    const reference = idOf('reference_id');
    const attempt = (userId ? await runtime.attempts.find(userId) : null) ?? (reference ? await runtime.attempts.findByProviderRef('CASHFREE_SECURE_ID', 'BANK_ACCOUNT', reference) : null);
    if (!attempt || attempt.checkType !== 'BANK_ACCOUNT') return 'NO_ATTEMPT';
    if (FINAL(attempt)) return 'ALREADY_FINAL';
    const result = bankResultOf({ verificationId: attempt.verificationId }, event.data, { accountNumber: null, ifsc: null });
    // The attempt already holds the masked account; the event does not echo the number.
    const saved = await recordAttemptResult(attempt, { ...result, raw: { ...result.raw, account: attempt.result?.['account'] ?? null, ifscCode: attempt.result?.['ifscCode'] ?? null } });
    await applyAttemptToSession(saved, now);
    return `APPLIED:${saved.status}`;
  }

  return 'IGNORED';
}

/** How long an attempt may wait on a person or a provider before the sweep gives up on it. */
const ATTEMPT_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const SWEPT_CHECKS: readonly CheckType[] = ['DIGILOCKER', 'BANK_ACCOUNT', 'UPI_VPA'];

export type SweepReport = { read: number; settled: number; givenUp: number; sessionsExpired: number };

/**
 * The sweep: every attempt still waiting on the person or the provider is
 * read back (the webhook is the fast road; this is the one that always
 * arrives), one that has waited a day is closed, and every open session
 * past its time is EXPIRED.
 */
export async function sweepVerification(now = new Date(), limit = 100): Promise<SweepReport> {
  const runtime = verificationRuntime();
  const report: SweepReport = { read: 0, settled: 0, givenUp: 0, sessionsExpired: 0 };

  for (const attempt of await runtime.attempts.listUnfinished(SWEPT_CHECKS, limit)) {
    report.read += 1;
    const read = await refreshAttempt(attempt.id);
    let current = read?.attempt ?? attempt;
    if (!FINAL(current) && now.getTime() - current.createdAt.getTime() > ATTEMPT_GIVE_UP_MS) {
      current = await runtime.attempts.close(current.id, { status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'UNANSWERED', result: { ...(current.result ?? {}), gaveUpAt: now.toISOString() } });
      report.givenUp += 1;
    }
    if (FINAL(current)) {
      report.settled += 1;
      await applyAttemptToSession(current, now);
    }
  }

  for (const session of await runtime.sessions.listOverdue(now, limit)) {
    const expired = await runtime.sessions.update(session.id, { status: 'EXPIRED' });
    await publishOutcome(expired, 'EXPIRED', now);
    report.sessionsExpired += 1;
  }
  return report;
}

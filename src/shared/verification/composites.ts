import type { DigioWorkflowKey } from '../integrations/digio-workflows';

/**
 * Cashfree Phase 1 — Cashfree's equivalent of each Digio workflow.
 *
 * Digio runs a whole KYC journey from one template. Cashfree Secure ID has
 * no such thing: its journey is a SESSION of single checks, taken in order
 * on ADX's own screens. This file says which checks stand in for which of
 * the twenty-five Phase D workflow keys (the defaults — configuration, not
 * code: `verificationRouting.composites[key]` overrides any of them), how a
 * session's steps move, and what the steps add up to.
 *
 * The outcome rule (the owner, 1 Oct 2026): an individual whose every step
 * passes — the name match at or over the threshold, the face live, the
 * face matched — is VERIFIED automatically. Anything with business papers
 * goes to the existing desk review with the check results attached; nothing
 * is ever REJECTED automatically — a session that cannot pass is FAILED and
 * a person decides.
 *
 * Pure: no clock, no database, no provider.
 */

/** A step of a session. PAPERS is ADX's own document upload, reviewed at the desk — not a Cashfree check. */
export const COMPOSITE_STEP_KINDS = ['DIGILOCKER', 'FACE_LIVENESS', 'FACE_MATCH', 'DRIVING_LICENCE', 'VEHICLE_RC', 'PAN', 'GSTIN', 'PAPERS', 'BANK_ACCOUNT', 'NAME_MATCH'] as const;
export type CompositeStepKind = (typeof COMPOSITE_STEP_KINDS)[number];
export type CompositeStep = { step: CompositeStepKind; required: boolean };

export const isCompositeStepKind = (value: unknown): value is CompositeStepKind =>
  typeof value === 'string' && (COMPOSITE_STEP_KINDS as readonly string[]).includes(value);

const must = (step: CompositeStepKind): CompositeStep => ({ step, required: true });
const may = (step: CompositeStepKind): CompositeStep => ({ step, required: false });

/** A person: DigiLocker (Aadhaar + PAN), a live selfie, the selfie matched to the DigiLocker photo. */
const IDENTITY: CompositeStep[] = [must('DIGILOCKER'), must('FACE_LIVENESS'), must('FACE_MATCH')];
/** The account, then its holder's name against the name the identity (or the entity) gave. */
const BANK: CompositeStep[] = [must('BANK_ACCOUNT'), must('NAME_MATCH')];

/**
 * The default steps for a workflow key.
 *
 *   - An individual party (publisher, print partner, employee, agent):
 *     identity, then the bank account — an employee's is the salary or
 *     stipend account. An agent adds the driving licence and the vehicle RC.
 *   - An individual ADVERTISER: identity only. Advertisers get no bank
 *     check — refunds go back to the source (the owner).
 *   - A business: the authorised signatory's identity, the entity PAN, the
 *     GSTIN (required for a print partner, optional otherwise), the business
 *     papers through ADX's own KYC uploads (PAPERS), then the bank account
 *     against the entity or trade name — publishers and print partners
 *     only, never advertisers.
 *   - A transit spot: the vehicle RC (the number must be the listing's
 *     registration). Outdoor and media spots: papers only.
 */
export function defaultComposite(key: DigioWorkflowKey): CompositeStep[] {
  if (key === 'AGENT') return [...IDENTITY, must('DRIVING_LICENCE'), must('VEHICLE_RC'), ...BANK];
  if (key === 'SPOT.TRANSIT') return [must('VEHICLE_RC')];
  if (key === 'SPOT.OUTDOOR' || key === 'SPOT.MEDIA') return [must('PAPERS')];
  if (key.startsWith('EMPLOYEE.')) return [...IDENTITY, ...BANK];
  const [party, entity] = key.split('.') as [string, string];
  if (entity === 'INDIVIDUAL') return party === 'ADVERTISER' ? [...IDENTITY] : [...IDENTITY, ...BANK];
  const business: CompositeStep[] = [...IDENTITY, must('PAN'), party === 'PRINT_PARTNER' ? must('GSTIN') : may('GSTIN'), must('PAPERS')];
  return party === 'ADVERTISER' ? business : [...business, ...BANK];
}

/* ── a session's steps ─────────────────────────────────────────── */

export const SESSION_STATUSES = ['OPEN', 'NEEDS_USER_ACTION', 'IN_REVIEW', 'VERIFIED', 'FAILED', 'EXPIRED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * OPEN      not answered yet (or answered badly and open to another try)
 * PENDING   asked; waiting on the person (DigiLocker) or on the provider
 * VERIFIED  passed
 * FAILED    a definite "no" — tried again while tries remain
 * REVIEW    PAPERS: for the desk
 */
export type SessionStepStatus = 'OPEN' | 'PENDING' | 'VERIFIED' | 'FAILED' | 'REVIEW';

export type SessionStep = {
  check: CompositeStepKind;
  required: boolean;
  status: SessionStepStatus;
  /** The attempt that last answered the step. */
  attemptId: string | null;
  at: string | null;
  /** How many definite "no"s the step has had. */
  tries: number;
  failureCode: string | null;
};

/** A blurred selfie or a mistyped account number deserves another go; a third "no" sends the case to a person. */
export const MAX_STEP_TRIES = 3;
/** How long a session stays open. DigiLocker's own consent lasts about an hour; the rest may be finished later in the day. */
export const SESSION_TTL_HOURS = 24;

export function openingSteps(composite: readonly CompositeStep[]): SessionStep[] {
  return composite.map(({ step, required }) => ({
    check: step,
    required,
    // The papers are uploaded through ADX's own KYC screens and read at the desk; the session never waits on them.
    status: step === 'PAPERS' ? 'REVIEW' : 'OPEN',
    attemptId: null,
    at: null,
    tries: 0,
    failureCode: null,
  }));
}

export type StepAnswer = { status: 'VERIFIED' | 'FAILED' | 'PENDING'; attemptId: string | null; at: Date; failureCode?: string | null | undefined };

/** The steps with one of them answered. A step the session does not have is left out — the caller refused it already. */
export function answerStep(steps: readonly SessionStep[], check: CompositeStepKind, answer: StepAnswer): SessionStep[] {
  return steps.map((step) =>
    step.check !== check
      ? step
      : {
          ...step,
          status: answer.status,
          attemptId: answer.attemptId ?? step.attemptId,
          at: answer.at.toISOString(),
          tries: answer.status === 'FAILED' ? step.tries + 1 : step.tries,
          failureCode: answer.status === 'FAILED' ? (answer.failureCode ?? null) : null,
        },
  );
}

/** A step back to OPEN — the DigiLocker step when its consent ran out before the selfie arrived. */
export function reopenStep(steps: readonly SessionStep[], check: CompositeStepKind): SessionStep[] {
  return steps.map((step) => (step.check === check ? { ...step, status: 'OPEN' as const, failureCode: null } : step));
}

export const stepOf = (steps: readonly SessionStep[], check: CompositeStepKind): SessionStep | undefined => steps.find((step) => step.check === check);

/**
 * What the steps add up to.
 *
 *   FAILED             a required step has had its last try and still says no
 *   VERIFIED           every required step passed and there are no papers — an individual, automatically
 *   IN_REVIEW          every required check passed and the case has papers — the desk decides
 *   NEEDS_USER_ACTION  something is waiting on the person (the DigiLocker page)
 *   OPEN               otherwise
 *
 * An optional step (the GSTIN of a business that may not have one) never
 * holds the session back; its answer is attached for the desk either way.
 */
export function sessionStatusOf(steps: readonly SessionStep[]): Exclude<SessionStatus, 'EXPIRED'> {
  const required = steps.filter((step) => step.required);
  if (required.some((step) => step.status === 'FAILED' && step.tries >= MAX_STEP_TRIES)) return 'FAILED';
  const checks = required.filter((step) => step.check !== 'PAPERS');
  const hasPapers = steps.some((step) => step.check === 'PAPERS');
  if (checks.every((step) => step.status === 'VERIFIED')) return hasPapers ? 'IN_REVIEW' : 'VERIFIED';
  if (steps.some((step) => step.status === 'PENDING')) return 'NEEDS_USER_ACTION';
  return 'OPEN';
}

/** May this session still be acted on? */
export const isSessionOpen = (status: SessionStatus): boolean => status === 'OPEN' || status === 'NEEDS_USER_ACTION';

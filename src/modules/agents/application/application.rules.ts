import { createHash } from 'node:crypto';
import type { AgentDocumentKind, AgentDocumentStatus, AgentEducationLevel, AgentGrade, AgentStage, AgentVehicleType } from '../../../shared/database';

/**
 * AG-1 (the owner, 20 Sep 2026): the agent application, as rules.
 *
 * Two kinds of agent apply through one ladder. A publisher agent is a
 * delivery-partner profile (Zomato / Rapido intake: identity, vehicle papers,
 * bank, a short desk check, no interview). An advertiser agent is a sales-
 * executive profile (Justdial / IndiaMART intake: education, résumé, work
 * history, references, an assessment and an interview). What each must file
 * and what "complete" means live here, pure, so the service, the app and the
 * desk agree without reading each other.
 */

export type AgentSide = 'PUBLISHER' | 'ADVERTISER';

/** The ladder in order; the terminal and side states follow. */
export const APPLICATION_STAGES = ['APPLIED', 'PROFILE', 'DOCUMENTS', 'BANK', 'AGREEMENT', 'SCREENING', 'TRAINING', 'UNDER_REVIEW'] as const;
export const TERMINAL_STAGES = ['ACTIVE', 'ON_HOLD', 'REJECTED', 'WITHDRAWN', 'EXITED'] as const;

/** The steps an applicant completes themselves; SCREENING and TRAINING are the desk's and Lot 4's. */
export const APPLICANT_STEPS = ['PROFILE', 'DOCUMENTS', 'BANK', 'AGREEMENT'] as const;
export type ApplicantStep = (typeof APPLICANT_STEPS)[number];

export const GRADE_META: Record<AgentGrade, { label: string; handles: string }> = {
  G1: { label: 'Field', handles: 'Everyday spots and small businesses' },
  G2: { label: 'Senior field', handles: 'Established publishers and repeat advertisers' },
  G3: { label: 'Key accounts', handles: 'Media owners with large inventories, mid-size advertisers' },
  G4: { label: 'Enterprise', handles: 'Brands, agencies and airport or mall estates' },
};

export const MOTOR_VEHICLES: readonly AgentVehicleType[] = ['SCOOTER', 'MOTORBIKE', 'EV', 'CAR'];

/** The identity set — the same papers the desk's KYC record holds. */
export const IDENTITY_KINDS: readonly AgentDocumentKind[] = ['AADHAAR_FRONT', 'AADHAAR_BACK', 'PAN', 'SELFIE', 'ADDRESS_PROOF', 'BANK_PROOF'];

/**
 * What an applicant must file, by side and by whether they ride. The optional
 * kinds are offered, never demanded — the desk may ask for one by flagging.
 */
export function requiredDocuments(side: AgentSide, vehicleType: AgentVehicleType | null | undefined): AgentDocumentKind[] {
  const base: AgentDocumentKind[] = [...IDENTITY_KINDS];
  if (side === 'PUBLISHER') {
    if (vehicleType && MOTOR_VEHICLES.includes(vehicleType)) {
      base.push('DRIVING_LICENCE_FRONT', 'DRIVING_LICENCE_BACK', 'VEHICLE_RC', 'VEHICLE_INSURANCE');
    }
    return base;
  }
  base.push('EDUCATION_CERTIFICATE', 'RESUME');
  return base;
}

export function optionalDocuments(side: AgentSide): AgentDocumentKind[] {
  return side === 'PUBLISHER'
    ? ['POLICE_VERIFICATION', 'PHOTO']
    : ['EMPLOYER_PROOF', 'DRIVING_LICENCE_FRONT', 'DRIVING_LICENCE_BACK', 'POLICE_VERIFICATION', 'PHOTO'];
}

/** The papers that carry an expiry the sweep will watch (Lot 4). */
export const EXPIRING_KINDS: readonly AgentDocumentKind[] = ['DRIVING_LICENCE_FRONT', 'VEHICLE_INSURANCE', 'VEHICLE_RC', 'POLICE_VERIFICATION', 'PASSPORT'];

/** The papers that carry a number worth masking and matching. */
export const NUMBERED_KINDS: readonly AgentDocumentKind[] = ['AADHAAR_FRONT', 'PAN', 'DRIVING_LICENCE_FRONT', 'VEHICLE_RC', 'PASSPORT'];

const EDUCATION_RANK: Record<AgentEducationLevel, number> = {
  BELOW_10TH: 0,
  CLASS_10: 1,
  CLASS_12: 2,
  DIPLOMA: 3,
  GRADUATE: 4,
  POST_GRADUATE: 5,
};

/** Decision 6: an advertiser agent is 12th pass at least. */
export const ADVERTISER_MIN_EDUCATION: AgentEducationLevel = 'CLASS_12';

export function meetsEducationFloor(level: AgentEducationLevel | null | undefined): boolean {
  return level !== null && level !== undefined && EDUCATION_RANK[level] >= EDUCATION_RANK[ADVERTISER_MIN_EDUCATION];
}

/** 18 for a publisher agent, 21 for an advertiser agent (decisions 3 and 6). */
export function minimumAge(side: AgentSide): number {
  return side === 'PUBLISHER' ? 18 : 21;
}

export function ageOn(dateOfBirth: Date, now: Date): number {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const m = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) age -= 1;
  return age;
}

/* ── Numbers on papers ───────────────────────────────────────────────────── */

/** The number as the screen shows it: Aadhaar and licences keep their last four, a PAN its first five and last one. */
export function maskDocumentNumber(kind: AgentDocumentKind, number: string): string {
  const clean = number.replace(/\s+/g, '').toUpperCase();
  if (kind === 'PAN') return clean.length === 10 ? `${clean.slice(0, 5)}****${clean.slice(9)}` : '*'.repeat(Math.max(clean.length - 1, 0)) + clean.slice(-1);
  if (clean.length <= 4) return '*'.repeat(clean.length);
  return `${'*'.repeat(clean.length - 4)}${clean.slice(-4)}`;
}

/** A one-way hash for "is this paper already on another account" — never the number itself. */
export function hashDocumentNumber(kind: AgentDocumentKind, number: string): string {
  return createHash('sha256').update(`${kind}:${number.replace(/\s+/g, '').toUpperCase()}`).digest('hex');
}

/* ── Completeness ────────────────────────────────────────────────────────── */

export type ProfileFacts = {
  name: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  city: string | null;
  languages: string[];
  vehicleType: AgentVehicleType | null;
  currentAddress: string | null;
  permanentAddress: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  highestEducation: AgentEducationLevel | null;
  salesExperienceYears: number | null;
  referenceCount: number;
};

/** What the profile step still lacks, in the words the app prints. Empty means complete. */
export function profileGaps(side: AgentSide, facts: ProfileFacts, now: Date): string[] {
  const gaps: string[] = [];
  if (!facts.name?.trim()) gaps.push('Your full name');
  if (!facts.dateOfBirth) gaps.push('Your date of birth');
  else if (ageOn(facts.dateOfBirth, now) < minimumAge(side)) gaps.push(`You must be ${minimumAge(side)} or older`);
  if (!facts.gender) gaps.push('Your gender');
  if (!facts.city?.trim()) gaps.push('The city you will work in');
  if (facts.languages.length === 0) gaps.push('At least one language you speak');
  if (!facts.currentAddress?.trim()) gaps.push('Your current address');
  if (!facts.permanentAddress?.trim()) gaps.push('Your permanent address');
  if (!facts.emergencyContactName?.trim() || !facts.emergencyContactPhone?.trim()) gaps.push('An emergency contact');
  if (side === 'PUBLISHER') {
    if (!facts.vehicleType) gaps.push('How you will travel (vehicle)');
  } else {
    if (!facts.highestEducation) gaps.push('Your highest education');
    else if (!meetsEducationFloor(facts.highestEducation)) gaps.push('Advertiser agents need 12th pass or above');
    if (facts.salesExperienceYears === null) gaps.push('Years of sales experience (0 is fine)');
    if (facts.referenceCount < 1) gaps.push('At least one reference');
  }
  return gaps;
}

export type DocumentFact = { kind: AgentDocumentKind; status: AgentDocumentStatus };

export type DocumentsView = {
  required: AgentDocumentKind[];
  optional: AgentDocumentKind[];
  missing: AgentDocumentKind[];
  /** Flagged or asked again by the desk — the applicant has to act. */
  actionNeeded: AgentDocumentKind[];
  complete: boolean;
};

export function documentsView(side: AgentSide, vehicleType: AgentVehicleType | null | undefined, filed: readonly DocumentFact[]): DocumentsView {
  const required = requiredDocuments(side, vehicleType);
  const byKind = new Map(filed.map((d) => [d.kind, d.status]));
  const missing = required.filter((kind) => !byKind.has(kind));
  // AG-4: an expired paper is the applicant's to renew, the same as one the desk asked for again.
  const actionNeeded = filed.filter((d) => d.status === 'FLAGGED' || d.status === 'REUPLOAD_REQUESTED' || d.status === 'EXPIRED').map((d) => d.kind);
  return { required, optional: optionalDocuments(side), missing, actionNeeded, complete: missing.length === 0 && actionNeeded.length === 0 };
}

/* ── AG-4: screening ─────────────────────────────────────────────────────── */

export type InterviewFact = { round: number; outcome: 'SCHEDULED' | 'PASSED' | 'FAILED' | 'NO_SHOW' | 'CANCELLED'; scheduledAt: Date; marks: number | null };
export type AssessmentFact = { required: boolean; passed: boolean; bestPercent: number | null; passPercent: number | null };

export type ScreeningInput = {
  side: AgentSide;
  /** The desk's tick — the paper screen judged, or the assessment and interview judged by hand. */
  screenedAt: Date | null;
  identityVerified: boolean;
  /** Every required paper filed and approved. */
  papersApproved: boolean;
  assessment: AssessmentFact;
  interviews: readonly InterviewFact[];
};

export type ScreeningView = {
  done: boolean;
  /** Who owes the next move: the applicant (the assessment), the desk (the paper check, the interview), or nobody. */
  owedBy: 'APPLICANT' | 'DESK' | null;
  missing: string[];
  assessment: AssessmentFact;
  /** Round one passed — the sales agent's interview. */
  interviewPassed: boolean;
  /** Round two passed — asked before a G3 / G4 activation. */
  secondRoundPassed: boolean;
  nextInterview: InterviewFact | null;
};

/**
 * What "screened" means, by side. A field agent is screened on paper: the
 * identity verified and every required paper approved, or the desk's tick.
 * A sales agent sits the assessment (when one is published) and an
 * interview; the desk's tick stands in for both when it judged by hand.
 */
export function screeningOf(input: ScreeningInput): ScreeningView {
  const passedRound = (round: number) => input.interviews.some((i) => i.round === round && i.outcome === 'PASSED');
  const interviewPassed = passedRound(1);
  const secondRoundPassed = passedRound(2);
  const nextInterview = [...input.interviews].filter((i) => i.outcome === 'SCHEDULED').sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())[0] ?? null;
  const base = { assessment: input.assessment, interviewPassed, secondRoundPassed, nextInterview };
  if (input.screenedAt) return { ...base, done: true, owedBy: null, missing: [] };
  if (input.side === 'PUBLISHER') {
    const done = input.identityVerified && input.papersApproved;
    return { ...base, done, owedBy: done ? null : 'DESK', missing: done ? [] : ["The desk's paper check"] };
  }
  const missing: string[] = [];
  let owedBy: ScreeningView['owedBy'] = null;
  if (input.assessment.required && !input.assessment.passed) {
    const best = input.assessment.bestPercent;
    missing.push(best === null ? `The sales assessment (${input.assessment.passPercent ?? 60}% to pass)` : `The sales assessment — best ${best}%, ${input.assessment.passPercent ?? 60}% to pass`);
    owedBy = 'APPLICANT';
  }
  if (!interviewPassed) {
    missing.push(nextInterview ? `The interview on ${nextInterview.scheduledAt.toISOString().slice(0, 10)}` : 'An interview with ADX — the desk schedules it');
    owedBy = owedBy ?? 'DESK';
  }
  return { ...base, done: missing.length === 0, owedBy, missing };
}

/* ── The ladder ──────────────────────────────────────────────────────────── */

export type StepState = 'DONE' | 'PENDING' | 'ACTION_NEEDED' | 'WAITING';

export type LadderInput = {
  stage: AgentStage;
  side: AgentSide;
  profileGaps: string[];
  documents: DocumentsView;
  bankReady: boolean;
  agreementAccepted: boolean;
  /** AG-4: the screening as `screeningOf` judged it. */
  screening: ScreeningView;
  /** AG-4: the certificate for the side's curriculum; a gate at activation unless the desk waives it. */
  trainingCertified: boolean;
  /** No lesson is published for the side yet — the training step cannot be done, and says so. */
  trainingAvailable: boolean;
};

export type LadderStep = { key: 'PROFILE' | 'DOCUMENTS' | 'BANK' | 'AGREEMENT' | 'SCREENING' | 'TRAINING' | 'REVIEW'; state: StepState; missing: string[] };

export type Ladder = {
  stage: AgentStage;
  steps: LadderStep[];
  /** The applicant may press Submit: every step of theirs is done and nothing is flagged. */
  canSubmit: boolean;
  /** The first of their steps that is not done — where the app opens. */
  nextStep: ApplicantStep | null;
};

const submitted = (stage: AgentStage) => stage === 'UNDER_REVIEW' || stage === 'SCREENING' || stage === 'TRAINING';
const settled = (stage: AgentStage) => stage === 'ACTIVE' || stage === 'REJECTED' || stage === 'WITHDRAWN' || stage === 'EXITED';

export function ladderOf(input: LadderInput): Ladder {
  const docs = input.documents;
  const profile: LadderStep = { key: 'PROFILE', state: input.profileGaps.length === 0 ? 'DONE' : 'PENDING', missing: input.profileGaps };
  const documents: LadderStep = {
    key: 'DOCUMENTS',
    state: docs.complete ? 'DONE' : docs.actionNeeded.length > 0 ? 'ACTION_NEEDED' : 'PENDING',
    missing: [...docs.actionNeeded.map((k) => `${label(k)} — the desk asked for it again`), ...docs.missing.map(label)],
  };
  const bank: LadderStep = { key: 'BANK', state: input.bankReady ? 'DONE' : 'PENDING', missing: input.bankReady ? [] : ['A bank account or UPI ID for payouts'] };
  const agreement: LadderStep = {
    key: 'AGREEMENT',
    state: input.agreementAccepted ? 'DONE' : 'PENDING',
    missing: input.agreementAccepted ? [] : [input.side === 'PUBLISHER' ? 'The ADX field agent terms' : 'The ADX sales agent engagement terms'],
  };
  // AG-4: screening is judged by side; the applicant's part of it (the assessment) shows as theirs to do.
  const screening: LadderStep = {
    key: 'SCREENING',
    state: input.stage === 'ACTIVE' || input.screening.done ? 'DONE' : input.screening.owedBy === 'APPLICANT' ? 'ACTION_NEEDED' : submitted(input.stage) ? 'WAITING' : 'PENDING',
    missing: input.stage === 'ACTIVE' ? [] : input.screening.missing,
  };
  const training: LadderStep = {
    key: 'TRAINING',
    state: input.trainingCertified ? 'DONE' : input.trainingAvailable ? (submitted(input.stage) ? 'ACTION_NEEDED' : 'PENDING') : 'WAITING',
    missing: input.trainingCertified ? [] : input.trainingAvailable ? ['The ADX training and its quiz'] : ['The ADX training — not published for your side yet'],
  };
  const review: LadderStep = { key: 'REVIEW', state: input.stage === 'ACTIVE' ? 'DONE' : submitted(input.stage) ? 'WAITING' : 'PENDING', missing: [] };

  const mine = [profile, documents, bank, agreement];
  const nextStep = (mine.find((s) => s.state !== 'DONE')?.key as ApplicantStep | undefined) ?? null;
  const canSubmit = !settled(input.stage) && !submitted(input.stage) && nextStep === null;
  return { stage: input.stage, steps: [profile, documents, bank, agreement, screening, training, review], canSubmit, nextStep };
}

/** The stage the ladder says an unsubmitted application stands at. */
export function stageForUnsubmitted(ladder: Ladder): AgentStage {
  return ladder.nextStep ?? 'AGREEMENT';
}

/**
 * AG-4: the stage a submitted application stands at — SCREENING while the
 * screen is open, TRAINING while the certificate is, UNDER_REVIEW once both
 * are done and the desk's decision is all that is left.
 */
export function stageForSubmitted(ladder: Ladder): AgentStage {
  const state = (key: LadderStep['key']) => ladder.steps.find((s) => s.key === key)?.state;
  if (state('SCREENING') !== 'DONE') return 'SCREENING';
  // A curriculum not yet published for the side (WAITING) does not hold the application at TRAINING.
  if (state('TRAINING') === 'PENDING' || state('TRAINING') === 'ACTION_NEEDED') return 'TRAINING';
  return 'UNDER_REVIEW';
}

/** AG-4: what ACTIVATE still needs beyond the papers and the identity, unless the desk waives it. */
export function activationGaps(input: { screening: ScreeningView; trainingCertified: boolean; trainingAvailable: boolean; side: AgentSide; grade: AgentGrade; waiveScreening: boolean; waiveTraining: boolean }): { code: 'SCREENING_INCOMPLETE' | 'TRAINING_INCOMPLETE'; message: string }[] {
  const gaps: { code: 'SCREENING_INCOMPLETE' | 'TRAINING_INCOMPLETE'; message: string }[] = [];
  if (!input.waiveScreening) {
    if (!input.screening.done) gaps.push({ code: 'SCREENING_INCOMPLETE', message: `Screening is not done: ${input.screening.missing.join('; ') || 'the desk has not ticked it'}` });
    else if (input.side === 'ADVERTISER' && (input.grade === 'G3' || input.grade === 'G4') && !input.screening.secondRoundPassed) {
      gaps.push({ code: 'SCREENING_INCOMPLETE', message: `A ${input.grade} activation needs a passed second-round interview` });
    }
  }
  if (!input.waiveTraining && input.trainingAvailable && !input.trainingCertified) {
    gaps.push({ code: 'TRAINING_INCOMPLETE', message: 'The ADX training is not certified yet' });
  }
  return gaps;
}

/* ── Decisions ───────────────────────────────────────────────────────────── */

export type Decision = 'ACTIVATE' | 'REJECT' | 'HOLD' | 'RESUME';

/** What the desk may do from each stage; anything else is a 409. */
export function decisionAllowed(stage: AgentStage, decision: Decision): boolean {
  switch (decision) {
    case 'ACTIVATE':
      return stage === 'UNDER_REVIEW' || stage === 'SCREENING' || stage === 'TRAINING' || stage === 'ON_HOLD';
    case 'REJECT':
      return !settled(stage);
    case 'HOLD':
      return stage !== 'ON_HOLD' && stage !== 'REJECTED' && stage !== 'WITHDRAWN' && stage !== 'EXITED';
    case 'RESUME':
      return stage === 'ON_HOLD';
  }
}

/** The applicant may withdraw until the desk has activated them. */
export function withdrawalAllowed(stage: AgentStage): boolean {
  return !settled(stage);
}

/** An engagement ends from ACTIVE or ON_HOLD. */
export function exitAllowed(stage: AgentStage): boolean {
  return stage === 'ACTIVE' || stage === 'ON_HOLD';
}

/** The one question every dispatch point asks: only an ACTIVE agent is offered work. */
export function agentMayWork(stage: AgentStage): boolean {
  return stage === 'ACTIVE';
}

export const DOCUMENT_LABEL: Record<AgentDocumentKind, string> = {
  AADHAAR_FRONT: 'Aadhaar (front)',
  AADHAAR_BACK: 'Aadhaar (back)',
  PASSPORT: 'Passport',
  PAN: 'PAN card',
  SELFIE: 'Live selfie',
  DRIVING_LICENCE_FRONT: 'Driving licence (front)',
  DRIVING_LICENCE_BACK: 'Driving licence (back)',
  VEHICLE_RC: 'Vehicle registration',
  VEHICLE_INSURANCE: 'Vehicle insurance',
  ADDRESS_PROOF: 'Address proof',
  BANK_PROOF: 'Bank proof',
  POLICE_VERIFICATION: 'Police verification certificate',
  EDUCATION_CERTIFICATE: 'Education certificate',
  RESUME: 'Résumé',
  EMPLOYER_PROOF: 'Last employer proof',
  PHOTO: 'Photograph',
  OTHER: 'Other document',
};

const label = (kind: AgentDocumentKind) => DOCUMENT_LABEL[kind];

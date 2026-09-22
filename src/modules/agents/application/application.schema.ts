import { z } from 'zod';
import { dateOfBirthSchema, genderSchema } from '../../../shared/validation';

/**
 * AG-1: what the applicant and the desk may send. The rules
 * (`application.rules.ts`) decide what is required; the schemas only decide
 * what is well-formed.
 */

export const AGENT_SIDES = ['PUBLISHER', 'ADVERTISER'] as const;
export const AGENT_STAGES = ['APPLIED', 'PROFILE', 'DOCUMENTS', 'BANK', 'AGREEMENT', 'SCREENING', 'TRAINING', 'UNDER_REVIEW', 'ACTIVE', 'ON_HOLD', 'REJECTED', 'WITHDRAWN', 'EXITED'] as const;
export const AGENT_GRADES = ['G1', 'G2', 'G3', 'G4'] as const;
export const AGENT_ENGAGEMENT_TYPES = ['GIG', 'CONTRACT'] as const;
export const AGENT_VEHICLE_TYPES = ['NONE', 'BICYCLE', 'SCOOTER', 'MOTORBIKE', 'EV', 'CAR'] as const;
export const AGENT_EDUCATION_LEVELS = ['BELOW_10TH', 'CLASS_10', 'CLASS_12', 'DIPLOMA', 'GRADUATE', 'POST_GRADUATE'] as const;
export const AGENT_SOURCE_KINDS = ['SELF', 'FLEET', 'REFERRAL', 'WALK_IN', 'JOB_PORTAL', 'DESK', 'IMPORT'] as const;
export const AGENT_EXIT_REASONS = ['RESIGNED', 'CONTRACT_ENDED', 'NON_PERFORMANCE', 'MISCONDUCT', 'FRAUD', 'OTHER'] as const;
export const AGENT_DOCUMENT_KINDS = [
  'AADHAAR_FRONT', 'AADHAAR_BACK', 'PASSPORT', 'PAN', 'SELFIE', 'DRIVING_LICENCE_FRONT', 'DRIVING_LICENCE_BACK', 'VEHICLE_RC', 'VEHICLE_INSURANCE',
  'ADDRESS_PROOF', 'BANK_PROOF', 'POLICE_VERIFICATION', 'EDUCATION_CERTIFICATE', 'RESUME', 'EMPLOYER_PROOF', 'PHOTO', 'OTHER',
] as const;
export const AGENT_DOCUMENT_DECISIONS = ['APPROVED', 'FLAGGED', 'REUPLOAD_REQUESTED'] as const;
export const AGENT_PLATFORMS = ['ZOMATO', 'SWIGGY', 'RAPIDO', 'UBER', 'OLA', 'DUNZO', 'AMAZON_FLEX', 'DELHIVERY', 'PORTER', 'OTHER'] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const phone = z.string().trim().min(10).max(16);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const month = z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM');

/** `POST /agents/apply` — the one choice that shapes the form. */
export const applySchema = z.object({
  side: z.enum(AGENT_SIDES),
  source: z.enum(['SELF', 'FLEET', 'REFERRAL', 'JOB_PORTAL']).optional(),
  sourceNote: z.string().trim().max(200).optional(),
  referralCode: z.string().trim().max(40).optional(),
});
export type ApplyInput = z.infer<typeof applySchema>;

/** `PATCH /agents/me/application/profile` — everything the applicant tells us about themselves; a key left out is left alone. */
export const applicationProfileSchema = z.object({
  city: text(80).optional(),
  state: text(80).optional(),
  languages: z.array(text(40)).max(10).optional(),
  vehicleType: z.enum(AGENT_VEHICLE_TYPES).nullable().optional(),
  vehicleNumber: z.string().trim().max(20).nullable().optional(),
  currentAddress: text(300).nullable().optional(),
  currentLatitude: z.number().min(-90).max(90).nullable().optional(),
  currentLongitude: z.number().min(-180).max(180).nullable().optional(),
  permanentAddress: text(300).nullable().optional(),
  emergencyContactName: text(120).nullable().optional(),
  emergencyContactRelation: text(60).nullable().optional(),
  emergencyContactPhone: phone.nullable().optional(),
  // Advertiser side
  highestEducation: z.enum(AGENT_EDUCATION_LEVELS).nullable().optional(),
  salesExperienceYears: z.coerce.number().int().min(0).max(50).nullable().optional(),
  industries: z.array(text(60)).max(12).optional(),
  noticePeriodDays: z.coerce.number().int().min(0).max(180).nullable().optional(),
  // Rows of their own — sent whole, replacing what was there.
  educations: z
    .array(z.object({ level: z.enum(AGENT_EDUCATION_LEVELS), degree: text(120).optional(), institution: text(160).optional(), year: z.coerce.number().int().min(1950).max(2100).optional() }))
    .max(8)
    .optional(),
  employments: z
    .array(
      z.object({
        employer: text(160),
        role: text(120).optional(),
        industry: text(80).optional(),
        fromMonth: month.optional(),
        toMonth: month.optional(),
        current: z.boolean().optional(),
        reasonForLeaving: text(200).optional(),
      }),
    )
    .max(10)
    .optional(),
  references: z.array(z.object({ name: text(120), relation: text(60).optional(), phone })).max(4).optional(),
  // Publisher side
  platformExperiences: z
    .array(z.object({ platform: z.enum(AGENT_PLATFORMS), partnerId: text(60).optional(), years: z.coerce.number().min(0).max(40).optional(), active: z.boolean().optional(), ratingNote: text(120).optional() }))
    .max(6)
    .optional(),
});
export type ApplicationProfileInput = z.infer<typeof applicationProfileSchema>;

/**
 * AG-3: `PATCH /agents/:id/application/profile` — the desk's copy also
 * carries the person's own three fields (the app writes those through
 * `PATCH /users/me`; the admin's user update does not take them).
 */
export const deskProfileSchema = applicationProfileSchema.extend({
  name: z.string().trim().min(2).max(120).optional(),
  dateOfBirth: dateOfBirthSchema.optional(),
  gender: genderSchema.optional(),
});
export type DeskProfileInput = z.infer<typeof deskProfileSchema>;

export const documentKindParamSchema = z.enum(AGENT_DOCUMENT_KINDS);

/** `PUT /agents/me/application/documents/:kind` — one paper, uploaded already (the URL is the upload module's). */
export const fileDocumentSchema = z.object({
  url: z.string().url(),
  number: z.string().trim().min(4).max(30).optional(),
  expiresAt: isoDay.optional(),
});
export type FileDocumentInput = z.infer<typeof fileDocumentSchema>;

/** `POST /agents/me/application/withdraw` */
export const withdrawSchema = z.object({ reason: z.string().trim().max(300).optional() });

/* ── The desk ────────────────────────────────────────────────────────────── */

/** AG-3: the queue's chips — a group of stages named at once. */
export const APPLICATION_STAGE_GROUPS = {
  IN_PROGRESS: ['APPLIED', 'PROFILE', 'DOCUMENTS', 'BANK', 'AGREEMENT'],
  WITH_DESK: ['UNDER_REVIEW', 'SCREENING', 'TRAINING'],
  CLOSED: ['REJECTED', 'WITHDRAWN', 'EXITED'],
} as const satisfies Record<string, readonly (typeof AGENT_STAGES)[number][]>;

export const applicationsQuerySchema = z.object({
  stage: z.enum(AGENT_STAGES).optional(),
  /** A named group of stages (`IN_PROGRESS` | `WITH_DESK` | `CLOSED`); ignored when `stage` is given. */
  group: z.enum(['IN_PROGRESS', 'WITH_DESK', 'CLOSED']).optional(),
  side: z.enum(AGENT_SIDES).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ApplicationsQuery = z.infer<typeof applicationsQuerySchema>;

/** `PATCH /agents/:id/application/documents/:kind/review` */
export const reviewDocumentSchema = z
  .object({
    decision: z.enum(AGENT_DOCUMENT_DECISIONS),
    note: z.string().trim().max(400).optional(),
  })
  .refine((v) => v.decision === 'APPROVED' || Boolean(v.note?.trim()), { message: 'Say what is wrong with the paper', path: ['note'] });
export type ReviewDocumentInput = z.infer<typeof reviewDocumentSchema>;

/** `POST /agents/:id/application/decision` */
export const decisionSchema = z
  .object({
    decision: z.enum(['ACTIVATE', 'REJECT', 'HOLD', 'RESUME']),
    note: z.string().trim().max(600).optional(),
    grade: z.enum(AGENT_GRADES).optional(),
    gradeNote: z.string().trim().max(300).optional(),
    engagementType: z.enum(AGENT_ENGAGEMENT_TYPES).optional(),
    engagementStartAt: isoDay.optional(),
    engagementEndAt: isoDay.optional(),
    probationEndsAt: isoDay.optional(),
    reportingManagerId: z.string().trim().min(1).optional(),
    weeklyHours: z.coerce.number().int().min(1).max(84).optional(),
    territory: text(120).optional(),
    homeZone: text(80).optional(),
    /** ACTIVATE only: the desk vouches for the identity papers without a separate KYC decision (they saw the originals). */
    identityCheckedInPerson: z.boolean().optional(),
    /** AG-4, ACTIVATE only: activate without the screen done / the training certified — say why in the note. */
    waiveScreening: z.boolean().optional(),
    waiveTraining: z.boolean().optional(),
  })
  .refine((v) => v.decision !== 'REJECT' || Boolean(v.note?.trim()), { message: 'Say why the application is rejected', path: ['note'] })
  .refine((v) => v.decision !== 'HOLD' || Boolean(v.note?.trim()), { message: 'Say what the hold is waiting for', path: ['note'] })
  .refine((v) => v.decision !== 'ACTIVATE' || Boolean(v.grade), { message: 'Set the grade on activation', path: ['grade'] });
export type DecisionInput = z.infer<typeof decisionSchema>;

/** `POST /agents/:id/exit` */
export const exitSchema = z.object({
  reason: z.enum(AGENT_EXIT_REASONS),
  note: z.string().trim().max(600).optional(),
  rehireEligible: z.boolean().default(true),
  blacklist: z.boolean().default(false),
});
export type ExitInput = z.infer<typeof exitSchema>;

/* ── AG-4: screening ─────────────────────────────────────────────────────── */

export const AGENT_INTERVIEW_MODES = ['IN_PERSON', 'PHONE', 'VIDEO'] as const;
export const AGENT_INTERVIEW_OUTCOMES = ['PASSED', 'FAILED', 'NO_SHOW', 'CANCELLED'] as const;

/** `POST /agents/:id/application/interviews` — the desk books a slot. */
export const interviewSchema = z.object({
  round: z.union([z.literal(1), z.literal(2)]).default(1),
  scheduledAt: z.string().datetime({ offset: true }),
  mode: z.enum(AGENT_INTERVIEW_MODES).default('IN_PERSON'),
  location: z.string().trim().max(200).optional(),
  interviewerId: z.string().trim().min(1).optional(),
  notes: z.string().trim().max(600).optional(),
});
export type InterviewInput = z.infer<typeof interviewSchema>;

/** `PATCH /agents/:id/application/interviews/:interviewId` — the outcome, with marks out of five when it was held. */
export const interviewOutcomeSchema = z
  .object({
    outcome: z.enum(AGENT_INTERVIEW_OUTCOMES),
    marks: z.coerce.number().int().min(1).max(5).optional(),
    notes: z.string().trim().max(600).optional(),
  })
  .refine((v) => (v.outcome !== 'PASSED' && v.outcome !== 'FAILED') || v.marks !== undefined, { message: 'Give marks out of five', path: ['marks'] });
export type InterviewOutcomeInput = z.infer<typeof interviewOutcomeSchema>;

/** `POST /agents/:id/application/screen` — the desk's tick: screened, with a note. `{ clear: true }` takes it back. */
export const screenSchema = z.object({ note: z.string().trim().max(600).optional(), clear: z.boolean().optional() });
export type ScreenInput = z.infer<typeof screenSchema>;

/** `PATCH /agents/:id/grade` — the grade may move at renewal without a new decision. */
export const gradeSchema = z.object({ grade: z.enum(AGENT_GRADES), note: z.string().trim().max(300).optional() });
export type GradeInput = z.infer<typeof gradeSchema>;

/* ── AG-5: routing settings ──────────────────────────────────────────────── */

const grade = z.enum(AGENT_GRADES);
/** `PUT /agents/routing-settings` — every band named; the defaults fill anything missing. */
export const routingSettingsSchema = z.object({
  bands: z.object({ INDIVIDUAL: grade, SMALL_AGENCY: grade, LARGE_AGENCY: grade }),
  leadBands: z.object({ STANDARD: grade, KEY: grade, ENTERPRISE: grade }),
  enforce: z.boolean(),
});
export type RoutingSettingsInput = z.infer<typeof routingSettingsSchema>;

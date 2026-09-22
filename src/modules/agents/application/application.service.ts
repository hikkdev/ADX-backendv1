import type { Request } from 'express';
import { ApiError } from '../../../shared/errors';
import { logActivity } from '../../../shared/audit';
import type { AgentDocument, AgentDocumentKind, AgentGrade, AgentStage, AgreementKind } from '../../../shared/database';
import { allocateIdentifier } from '../../identifiers';
import { assertCityAllows, withCityKey } from '../../pricing';
import { notify } from '../../notifications';
import { platformStanding, recordAcceptance } from '../../agreements';
import { engagementSigning, requestEngagementSignature } from '../engagement-signing';
import { applicationPort } from './application.port';
import { prismaApplicationRepository as repository } from './prisma-application.repository';
import type { ApplicationRecord, ApplicationRow, ProfilePatch } from './application.repository';
import { APPLICATION_STAGE_GROUPS } from './application.schema';
import type { ApplicationProfileInput, ApplicationsQuery, ApplyInput, DecisionInput, DeskProfileInput, ExitInput, FileDocumentInput, GradeInput, InterviewInput, InterviewOutcomeInput, ReviewDocumentInput, ScreenInput } from './application.schema';
import { lookupVehicleRc, nameMatchScore, normaliseVehicleNumber } from '../../../shared/integrations';
import { fleetProvenanceFor, markFleetInviteActivated, markFleetInviteApplied } from './fleet.service';
import type { ExitSettlement } from './application.port';
import { dateOfBirthToDate } from '../../../shared/validation';
import {
  DOCUMENT_LABEL,
  GRADE_META,
  IDENTITY_KINDS,
  agentMayWork,
  decisionAllowed,
  documentsView,
  exitAllowed,
  hashDocumentNumber,
  ladderOf,
  maskDocumentNumber,
  optionalDocuments,
  profileGaps,
  requiredDocuments,
  activationGaps,
  screeningOf,
  stageForSubmitted,
  stageForUnsubmitted,
  withdrawalAllowed,
  type AgentSide,
  type Ladder,
  type ScreeningView,
} from './application.rules';

/**
 * AG-1 (the owner, 20 Sep 2026): the agent application.
 *
 * A person applies in the app (or the desk applies for them on the same
 * form), fills the profile, files the papers the side asks for, gives a bank
 * account, accepts the engagement terms and submits. The desk reviews each
 * paper, decides, and on activation sets the grade, the engagement and who
 * they report to. Until ACTIVE nothing offers them work
 * (`agentAcceptsWork` reads the stage). Rules live in
 * `application.rules.ts`; this file is the doors and the writes.
 */

const AGREEMENT_KIND: Record<AgentSide, AgreementKind> = {
  PUBLISHER: 'AGENT_PUBLISHER_PLATFORM',
  ADVERTISER: 'AGENT_ADVERTISER_PLATFORM',
};

/** Publisher first when a person holds both roles — the dashboard's own tie-break. */
export function sideOf(roles: readonly string[]): AgentSide {
  return roles.includes('AGENT_PUBLISHER') || !roles.includes('AGENT_ADVERTISER') ? 'PUBLISHER' : 'ADVERTISER';
}

export type DocumentView = {
  kind: AgentDocumentKind;
  label: string;
  required: boolean;
  status: AgentDocument['status'] | 'MISSING';
  url: string | null;
  numberMasked: string | null;
  expiresAt: Date | null;
  reviewNote: string | null;
  uploadedVia: string | null;
  updatedAt: Date | null;
  /** AG-4: a check beyond the desk's eyes — Cashfree's RC lookup, the bank penny drop — with what came back. */
  verification: { via: string; at: Date | null; payload: unknown } | null;
};

export type ApplicationView = {
  agent: {
    id: string;
    /** AG-3: the desk uploads papers in the applicant's name (`POST /upload` with `ownerUserId`). */
    userId: string;
    displayId: string | null;
    stage: AgentStage;
    side: AgentSide;
    grade: AgentGrade | null;
    gradeLabel: string | null;
    sourceKind: string;
    applicationSubmittedAt: Date | null;
    activatedAt: Date | null;
    holdReason: string | null;
    rejectionReason: string | null;
    reviewNote: string | null;
    engagement: {
      type: string | null;
      startAt: Date | null;
      endAt: Date | null;
      probationEndsAt: Date | null;
      reportingManagerId: string | null;
      weeklyHours: number | null;
    };
    exit: { at: Date | null; reason: string | null; note: string | null; rehireEligible: boolean; blacklisted: boolean };
  };
  person: { name: string | null; mobile: string | null; email: string | null; dateOfBirth: Date | null; gender: string | null };
  profile: Pick<
    ApplicationRecord,
    | 'city' | 'state' | 'languages' | 'vehicleType' | 'vehicleNumber' | 'currentAddress' | 'currentLatitude' | 'currentLongitude' | 'permanentAddress'
    | 'emergencyContactName' | 'emergencyContactRelation' | 'emergencyContactPhone' | 'highestEducation' | 'salesExperienceYears' | 'industries' | 'noticePeriodDays'
    | 'territory' | 'homeZone'
  >;
  educations: ApplicationRecord['educations'];
  employments: ApplicationRecord['employments'];
  references: ApplicationRecord['references'];
  platformExperiences: ApplicationRecord['platformExperiences'];
  documents: DocumentView[];
  identity: { verified: boolean; kycStatus: string | null };
  bank: { onFile: boolean };
  agreement: { kind: AgreementKind; accepted: boolean; currentVersion: number | null };
  /**
   * DS-1: the engagement terms e-signed — asked for at activation when the
   * policy says so. `required` false means the click is the record;
   * otherwise the agent works only once `satisfied`.
   */
  signing: { required: boolean; satisfied: boolean; status: string | null; requestId: string | null; signingUrl: string | null; mock: boolean; expiresAt: Date | null };
  training: { state: 'CERTIFIED' | 'LOCKED' | 'REVOKED'; available: boolean };
  /** AG-4: the screen — the assessment (the applicant's), the interviews (the desk's), the desk's tick. */
  screening: ScreeningView & {
    screenedAt: Date | null;
    screeningNote: string | null;
    assessmentModules: { id: string; title: string; passPercent: number; timeLimitMins: number | null; best: { score: number; total: number; passed: boolean; percent: number } | null }[];
    interviews: ApplicationRecord['interviews'];
  };
  ladder: Ladder;
};

async function load(userIdOrAgentId: { userId?: string; agentId?: string }): Promise<ApplicationRecord> {
  const record = userIdOrAgentId.userId ? await repository.findByUserId(userIdOrAgentId.userId) : await repository.findById(userIdOrAgentId.agentId!);
  if (!record) throw new ApiError(404, 'NOT_FOUND', userIdOrAgentId.userId ? 'You have not applied yet' : 'Agent not found');
  return record;
}

function identityVerified(record: ApplicationRecord): boolean {
  if (record.kyc?.status === 'VERIFIED') return true;
  const filed = new Map(record.documents.map((d) => [d.kind, d.status]));
  return IDENTITY_KINDS.every((kind) => filed.get(kind) === 'APPROVED');
}

async function buildView(record: ApplicationRecord, now = new Date(), opts: { identityVouched?: boolean } = {}): Promise<ApplicationView> {
  const side = sideOf(record.roles);
  const port = applicationPort();
  const [bankOnFile, training, standing, assessment, signing] = await Promise.all([
    port.hasPayoutMethod(record.userId),
    port.certificationState(record.userId),
    platformStanding(AGREEMENT_KIND[side], { agentId: record.id }).catch(() => null),
    port.assessmentState(record.id),
    engagementSigning(record.id, side).catch(() => null),
  ]);
  const gaps = profileGaps(
    side,
    {
      name: record.user.name,
      dateOfBirth: record.user.dateOfBirth,
      gender: record.user.gender,
      city: record.city,
      languages: record.languages,
      vehicleType: record.vehicleType,
      currentAddress: record.currentAddress,
      permanentAddress: record.permanentAddress,
      emergencyContactName: record.emergencyContactName,
      emergencyContactPhone: record.emergencyContactPhone,
      highestEducation: record.highestEducation,
      salesExperienceYears: record.salesExperienceYears,
      referenceCount: record.references.length,
    },
    now,
  );
  const docs = documentsView(side, record.vehicleType, record.documents);
  const verified = identityVerified(record) || Boolean(opts.identityVouched);
  const bestPercent = assessment.modules.length ? Math.min(...assessment.modules.map((m) => m.best?.percent ?? -1)) : null;
  // The paper screen: the identity set is `verified`'s business; the rest of the required papers (a rider's licence, RC, insurance; a sales agent's certificate and résumé) must each be approved.
  const papersApproved = docs.complete && docs.required.filter((kind) => !IDENTITY_KINDS.includes(kind)).every((kind) => record.documents.find((d) => d.kind === kind)?.status === 'APPROVED');
  const screening = screeningOf({
    side,
    screenedAt: record.screenedAt,
    identityVerified: verified,
    papersApproved,
    assessment: { required: assessment.required, passed: assessment.passed, bestPercent: bestPercent === null || bestPercent < 0 ? null : bestPercent, passPercent: assessment.modules[0]?.passPercent ?? null },
    interviews: record.interviews.map((i) => ({ round: i.round, outcome: i.outcome, scheduledAt: i.scheduledAt, marks: i.marks })),
  });
  const ladder = ladderOf({
    stage: record.stage,
    side,
    profileGaps: gaps,
    documents: docs,
    bankReady: bankOnFile,
    agreementAccepted: standing?.satisfied ?? false,
    screening,
    trainingCertified: training.state === 'CERTIFIED',
    trainingAvailable: training.available,
  });
  const byKind = new Map(record.documents.map((d) => [d.kind, d]));
  const documents: DocumentView[] = [...requiredDocuments(side, record.vehicleType).map((kind) => ({ kind, required: true })), ...optionalDocuments(side).map((kind) => ({ kind, required: false }))]
    // A paper filed under a kind the side does not list (the desk's passport, say) is still shown.
    .concat(record.documents.filter((d) => !requiredDocuments(side, record.vehicleType).includes(d.kind) && !optionalDocuments(side).includes(d.kind)).map((d) => ({ kind: d.kind, required: false })))
    .map(({ kind, required }) => {
      const d = byKind.get(kind);
      return {
        kind,
        label: DOCUMENT_LABEL[kind],
        required,
        status: d?.status ?? 'MISSING',
        url: d?.url ?? null,
        numberMasked: d?.numberMasked ?? null,
        expiresAt: d?.expiresAt ?? null,
        reviewNote: d?.reviewNote ?? null,
        uploadedVia: d?.uploadedVia ?? null,
        updatedAt: d?.updatedAt ?? null,
        verification: d?.verifiedVia ? { via: d.verifiedVia, at: d.verifiedAt, payload: d.verificationPayload ?? null } : null,
      };
    });

  return {
    agent: {
      id: record.id,
      userId: record.userId,
      displayId: record.displayId,
      stage: record.stage,
      side,
      grade: record.grade,
      gradeLabel: record.grade ? GRADE_META[record.grade].label : null,
      sourceKind: record.sourceKind,
      applicationSubmittedAt: record.applicationSubmittedAt,
      activatedAt: record.activatedAt,
      holdReason: record.holdReason,
      rejectionReason: record.rejectionReason,
      reviewNote: record.reviewNote,
      engagement: {
        type: record.engagementType,
        startAt: record.engagementStartAt,
        endAt: record.engagementEndAt,
        probationEndsAt: record.probationEndsAt,
        reportingManagerId: record.reportingManagerId,
        weeklyHours: record.weeklyHours,
      },
      exit: { at: record.exitedAt, reason: record.exitReason, note: record.exitNote, rehireEligible: record.rehireEligible, blacklisted: record.blacklistedAt !== null },
    },
    person: { name: record.user.name, mobile: record.user.mobile, email: record.user.email, dateOfBirth: record.user.dateOfBirth, gender: record.user.gender },
    profile: {
      city: record.city,
      state: record.state,
      languages: record.languages,
      vehicleType: record.vehicleType,
      vehicleNumber: record.vehicleNumber,
      currentAddress: record.currentAddress,
      currentLatitude: record.currentLatitude,
      currentLongitude: record.currentLongitude,
      permanentAddress: record.permanentAddress,
      emergencyContactName: record.emergencyContactName,
      emergencyContactRelation: record.emergencyContactRelation,
      emergencyContactPhone: record.emergencyContactPhone,
      highestEducation: record.highestEducation,
      salesExperienceYears: record.salesExperienceYears,
      industries: record.industries,
      noticePeriodDays: record.noticePeriodDays,
      territory: record.territory,
      homeZone: record.homeZone,
    },
    educations: record.educations,
    employments: record.employments,
    references: record.references,
    platformExperiences: record.platformExperiences,
    documents,
    identity: { verified, kycStatus: record.kyc?.status ?? null },
    bank: { onFile: bankOnFile },
    agreement: { kind: AGREEMENT_KIND[side], accepted: standing?.satisfied ?? false, currentVersion: standing?.currentVersion ?? null },
    signing: {
      required: signing?.required ?? false,
      satisfied: signing?.satisfied ?? true,
      status: signing?.status ?? null,
      requestId: signing?.request?.id ?? null,
      signingUrl: signing?.request && ['REQUESTED', 'PARTIALLY_SIGNED'].includes(signing.request.status) ? signing.request.signingUrl : null,
      mock: signing?.request?.mock ?? false,
      expiresAt: signing?.request?.expiresAt ?? null,
    },
    training: { state: training.state, available: training.available },
    screening: { ...screening, screenedAt: record.screenedAt, screeningNote: record.screeningNote, assessmentModules: assessment.modules, interviews: record.interviews },
    ladder,
  };
}

/** An unsubmitted application's stage follows the ladder; a submitted or settled one keeps its own. */
async function settleStage(record: ApplicationRecord): Promise<ApplicationView> {
  const view = await buildView(record);
  const unsubmitted = ['APPLIED', 'PROFILE', 'DOCUMENTS', 'BANK', 'AGREEMENT'].includes(record.stage);
  // AG-4: a submitted application sits at SCREENING, TRAINING or UNDER_REVIEW as the ladder says.
  const submitted = ['UNDER_REVIEW', 'SCREENING', 'TRAINING'].includes(record.stage);
  if (unsubmitted || submitted) {
    const next = unsubmitted ? stageForUnsubmitted(view.ladder) : stageForSubmitted(view.ladder);
    if (next !== record.stage) {
      await repository.patch(record.id, { stage: next });
      view.agent.stage = next;
      view.ladder.stage = next;
    }
  }
  return view;
}

/* ── The applicant ───────────────────────────────────────────────────────── */

/**
 * `POST /agents/apply { side }` — a signed-in person becomes an applicant:
 * the role and a profile at PROFILE, in one write. Someone who already has a
 * profile gets it back (idempotent); an agent who left may not re-apply from
 * here — the desk decides that.
 */
export async function apply(userId: string, input: ApplyInput, req?: Request): Promise<ApplicationView> {
  const existing = await repository.findByUserId(userId);
  if (existing) {
    if (existing.stage === 'EXITED' || existing.stage === 'REJECTED') {
      throw new ApiError(409, 'APPLICATION_CLOSED', existing.stage === 'EXITED' ? 'This account left ADX as an agent; ask the office about coming back' : 'This application was not accepted; ask the office before applying again');
    }
    return buildView(existing);
  }
  const referredBy = input.referralCode ? await repository.findAgentByReferralCode(input.referralCode) : null;
  // AG-5: a number a fleet partner invited applies as FLEET, the partner named — the provenance the brief asked for.
  const fleet = referredBy ? null : await fleetProvenanceFor(userId);
  const displayId = await allocateIdentifier('AGENT');
  const created = await repository.createApplication(userId, {
    role: input.side === 'PUBLISHER' ? 'AGENT_PUBLISHER' : 'AGENT_ADVERTISER',
    displayId,
    sourceKind: referredBy ? 'REFERRAL' : fleet ? 'FLEET' : (input.source ?? 'SELF'),
    sourceNote: fleet ? fleet.partnerName : (input.sourceNote ?? null),
    referredByAgentId: referredBy?.id ?? null,
    fleetPartnerId: fleet?.partnerId ?? null,
  });
  if (fleet) await markFleetInviteApplied(fleet.inviteId, created.id);
  await logActivity(userId, 'AGENT_APPLIED', { req, targetType: 'AgentProfile', targetId: created.id, module: 'agents', metadata: { side: input.side, source: referredBy ? 'REFERRAL' : fleet ? 'FLEET' : (input.source ?? 'SELF'), fleetPartnerId: fleet?.partnerId ?? null } });
  return buildView(created);
}

export async function getMyApplication(userId: string): Promise<ApplicationView> {
  // Settled on read: the assessment and the training are passed in the training module, which does not touch the stage.
  return settleStage(await load({ userId }));
}

/** The profile step. City goes through the rollout gate the desk's create uses. */
export async function updateMyApplicationProfile(userId: string, input: ApplicationProfileInput): Promise<ApplicationView> {
  const record = await load({ userId });
  assertOpen(record);
  if (input.city) await assertCityAllows(input.city, 'agentOnboarding');
  const { educations, employments, references, platformExperiences, ...fields } = input;
  const patch: ProfilePatch = fields.city !== undefined ? await withCityKey(fields as ProfilePatch & { city?: string | null }) : (fields as ProfilePatch);
  await repository.patch(record.id, patch);
  await repository.replaceSideRows(record.id, { educations, employments, references, platformExperiences });
  return settleStage(await load({ userId }));
}

/**
 * `PUT /agents/me/application/documents/:kind` — one paper. The number, when
 * the kind carries one, is kept masked and hashed; the same number on
 * another account is refused. Identity papers are mirrored onto the desk's
 * KYC record so the KYC queue sees them.
 */
export async function fileMyDocument(userId: string, kind: AgentDocumentKind, input: FileDocumentInput, req?: Request): Promise<ApplicationView> {
  const record = await load({ userId });
  assertOpen(record);
  return fileDocument(record, kind, input, 'APP', userId, req);
}

async function fileDocument(record: ApplicationRecord, kind: AgentDocumentKind, input: FileDocumentInput, via: 'APP' | 'DESK', byUserId: string, req?: Request): Promise<ApplicationView> {
  const side = sideOf(record.roles);
  const allowed = [...requiredDocuments(side, record.vehicleType), ...optionalDocuments(side), 'PASSPORT' as AgentDocumentKind, 'OTHER' as AgentDocumentKind];
  if (!allowed.includes(kind)) throw new ApiError(400, 'VALIDATION_ERROR', `${DOCUMENT_LABEL[kind]} is not part of a ${side.toLowerCase()} agent's application`);
  const numberHash = input.number ? hashDocumentNumber(kind, input.number) : null;
  if (numberHash && (await repository.numberHeldElsewhere(record.id, numberHash))) {
    throw new ApiError(409, 'DOCUMENT_HELD_ELSEWHERE', `This ${DOCUMENT_LABEL[kind].toLowerCase()} is already on another ADX account`);
  }
  const doc = await repository.upsertDocument({
    agentId: record.id,
    kind,
    url: input.url,
    numberMasked: input.number ? maskDocumentNumber(kind, input.number) : null,
    numberHash,
    expiresAt: input.expiresAt ? new Date(`${input.expiresAt}T23:59:59.999+05:30`) : null,
    uploadedVia: via,
    uploadedById: byUserId,
  });
  if (IDENTITY_KINDS.includes(kind)) {
    await applicationPort().mirrorIdentityDocument(record.id, record.userId, kind, input.url, input.number ?? null).catch(() => undefined);
  }
  await logActivity(byUserId, 'AGENT_DOCUMENT_FILED', { req, targetType: 'AgentDocument', targetId: doc.id, module: 'agents', metadata: { agentId: record.id, kind, via, version: doc.version } });
  return settleStage(await load({ agentId: record.id }));
}

export async function removeMyDocument(userId: string, kind: AgentDocumentKind): Promise<ApplicationView> {
  const record = await load({ userId });
  assertOpen(record);
  await repository.removeDocument(record.id, kind);
  return settleStage(await load({ userId }));
}

/** The engagement terms of the side, accepted on the applicant's own tap. 503 until the desk publishes a version. */
export async function acceptMyAgreement(userId: string, ctx: { ipAddress?: string | null; userAgent?: string | null }): Promise<ApplicationView> {
  const record = await load({ userId });
  assertOpen(record);
  const kind = AGREEMENT_KIND[sideOf(record.roles)];
  await recordAcceptance({ kind, party: { agentId: record.id }, ctx: { acceptedByUserId: userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent } });
  return settleStage(await load({ userId }));
}

/** Submit: every step of the applicant's is done, or 409 with what is missing. */
export async function submitMyApplication(userId: string, req?: Request): Promise<ApplicationView> {
  const record = await load({ userId });
  assertOpen(record);
  const view = await buildView(record);
  if (!view.ladder.canSubmit) {
    const missing = view.ladder.steps.filter((s) => ['PROFILE', 'DOCUMENTS', 'BANK', 'AGREEMENT'].includes(s.key) && s.state !== 'DONE').flatMap((s) => s.missing);
    throw new ApiError(409, 'APPLICATION_INCOMPLETE', 'The application is not complete yet', { missing, nextStep: view.ladder.nextStep });
  }
  const now = new Date();
  // AG-4: SCREENING, TRAINING or UNDER_REVIEW as the ladder says, not UNDER_REVIEW by rote.
  await repository.patch(record.id, { stage: stageForSubmitted(view.ladder), applicationSubmittedAt: now });
  await logActivity(userId, 'AGENT_APPLICATION_SUBMITTED', { req, targetType: 'AgentProfile', targetId: record.id, module: 'agents' });
  const name = record.user.name ?? record.displayId ?? 'there';
  await notify(
    'AGENT_APPLICATION_RECEIVED',
    record.userId,
    { partyName: name, side: view.agent.side === 'PUBLISHER' ? 'field agent' : 'sales agent' },
    { inApp: { type: 'SYSTEM', title: 'Application received', message: 'ADX has your application. We check the papers and get back to you within three working days.', relatedId: record.id } },
  );
  const admins = await applicationPort().adminUserIds().catch(() => [] as string[]);
  await Promise.all(
    admins.map((adminId) =>
      notify('AGENT_APPLICATION_RECEIVED', adminId, { partyName: name, side: view.agent.side.toLowerCase() }, {
        inApp: { type: 'WORK', title: `Agent application: ${name}`, message: `A ${view.agent.side.toLowerCase()} agent application is ready for review.`, suggestedAction: 'Review the application', relatedId: record.id },
        channels: [],
      }),
    ),
  );
  return settleStage(await load({ userId }));
}

export async function withdrawMyApplication(userId: string, reason: string | undefined, req?: Request): Promise<ApplicationView> {
  const record = await load({ userId });
  if (!withdrawalAllowed(record.stage)) throw new ApiError(409, 'APPLICATION_CLOSED', 'This application can no longer be withdrawn');
  await repository.patch(record.id, { stage: 'WITHDRAWN', withdrawnAt: new Date(), reviewNote: reason ?? null });
  await logActivity(userId, 'AGENT_APPLICATION_WITHDRAWN', { req, targetType: 'AgentProfile', targetId: record.id, module: 'agents', metadata: { reason: reason ?? null } });
  return buildView(await load({ userId }));
}

function assertOpen(record: ApplicationRecord): void {
  if (record.stage === 'REJECTED' || record.stage === 'WITHDRAWN' || record.stage === 'EXITED') {
    throw new ApiError(409, 'APPLICATION_CLOSED', 'This application is closed');
  }
}

/* ── The desk ────────────────────────────────────────────────────────────── */

export async function listApplications(query: ApplicationsQuery) {
  const filter = { stage: query.stage, stages: query.stage ? undefined : query.group ? APPLICATION_STAGE_GROUPS[query.group] : undefined, side: query.side, q: query.q };
  const [{ items, total }, counts] = await Promise.all([repository.findApplications(filter, query.page, query.pageSize), repository.countByStage({ side: query.side, q: query.q })]);
  const rows = items.map((row: ApplicationRow) => ({
    ...row,
    side: sideOf(row.roles),
    documents: { filed: row.documents.length, flagged: row.documents.filter((d) => d.status === 'FLAGGED' || d.status === 'REUPLOAD_REQUESTED').length },
  }));
  return { items: rows, meta: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)), counts: Object.fromEntries(counts.map((c) => [c.stage, c.count])) } };
}

export async function getApplication(agentId: string): Promise<ApplicationView> {
  return settleStage(await load({ agentId }));
}

/**
 * AG-3: the desk runs the same ladder for someone standing in front of it —
 * the profile written for them, the terms shown on paper and recorded as
 * accepted at the desk (the acceptance names the admin who recorded it and
 * says so in the rendered copy), and the submission made for them.
 */
export async function updateProfileAtDesk(agentId: string, input: DeskProfileInput, byUserId: string, req?: Request): Promise<ApplicationView> {
  const record = await load({ agentId });
  assertOpen(record);
  if (input.city) await assertCityAllows(input.city, 'agentOnboarding');
  const { educations, employments, references, platformExperiences, name, dateOfBirth, gender, ...fields } = input;
  await repository.patchPerson(record.userId, {
    ...(name !== undefined ? { name } : {}),
    ...(dateOfBirth !== undefined ? { dateOfBirth: dateOfBirthToDate(dateOfBirth) } : {}),
    ...(gender !== undefined ? { gender } : {}),
  });
  const patch: ProfilePatch = fields.city !== undefined ? await withCityKey(fields as ProfilePatch & { city?: string | null }) : (fields as ProfilePatch);
  await repository.patch(record.id, patch);
  await repository.replaceSideRows(record.id, { educations, employments, references, platformExperiences });
  await logActivity(byUserId, 'AGENT_APPLICATION_EDITED_AT_DESK', { req, targetType: 'AgentProfile', targetId: agentId, module: 'agents', metadata: { fields: Object.keys(input) } });
  return settleStage(await load({ agentId }));
}

export async function acceptAgreementAtDesk(agentId: string, byUserId: string, ctx: { ipAddress?: string | null; userAgent?: string | null }, req?: Request): Promise<ApplicationView> {
  const record = await load({ agentId });
  assertOpen(record);
  const kind = AGREEMENT_KIND[sideOf(record.roles)];
  await recordAcceptance({
    kind,
    party: { agentId: record.id },
    ctx: { acceptedByUserId: byUserId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    renderedDocument: `Accepted at the ADX desk in person; shown on paper and recorded by the desk (user ${byUserId}).`,
  });
  await logActivity(byUserId, 'AGENT_AGREEMENT_RECORDED_AT_DESK', { req, targetType: 'AgentProfile', targetId: agentId, module: 'agents', metadata: { kind } });
  return settleStage(await load({ agentId }));
}

export async function submitAtDesk(agentId: string, byUserId: string, req?: Request): Promise<ApplicationView> {
  const record = await load({ agentId });
  assertOpen(record);
  const view = await buildView(record);
  if (!view.ladder.canSubmit) {
    const missing = view.ladder.steps.filter((s) => ['PROFILE', 'DOCUMENTS', 'BANK', 'AGREEMENT'].includes(s.key) && s.state !== 'DONE').flatMap((s) => s.missing);
    throw new ApiError(409, 'APPLICATION_INCOMPLETE', 'The application is not complete yet', { missing, nextStep: view.ladder.nextStep });
  }
  await repository.patch(record.id, { stage: stageForSubmitted(view.ladder), applicationSubmittedAt: new Date() });
  await logActivity(byUserId, 'AGENT_APPLICATION_SUBMITTED', { req, targetType: 'AgentProfile', targetId: agentId, module: 'agents', metadata: { atDesk: true } });
  return settleStage(await load({ agentId }));
}

/** The desk files a paper for someone standing in front of it — the same slot, marked DESK. */
export async function fileDocumentAtDesk(agentId: string, kind: AgentDocumentKind, input: FileDocumentInput, byUserId: string, req?: Request): Promise<ApplicationView> {
  const record = await load({ agentId });
  assertOpen(record);
  return fileDocument(record, kind, input, 'DESK', byUserId, req);
}

export async function reviewDocument(agentId: string, kind: AgentDocumentKind, input: ReviewDocumentInput, byUserId: string, req?: Request): Promise<ApplicationView> {
  const view = await reviewDocumentInner(agentId, kind, input, byUserId, req);
  if (input.decision === 'APPROVED') {
    await resumeIfRenewed(agentId, byUserId, req);
    return settleStage(await load({ agentId }));
  }
  return view;
}

async function reviewDocumentInner(agentId: string, kind: AgentDocumentKind, input: ReviewDocumentInput, byUserId: string, req?: Request): Promise<ApplicationView> {
  const record = await load({ agentId });
  const updated = await repository.reviewDocument(agentId, kind, input.decision, input.note?.trim() ?? null, byUserId);
  if (!updated) throw new ApiError(404, 'NOT_FOUND', `No ${DOCUMENT_LABEL[kind].toLowerCase()} on file`);
  await logActivity(byUserId, 'AGENT_DOCUMENT_REVIEWED', { req, targetType: 'AgentDocument', targetId: updated.id, module: 'agents', metadata: { agentId, kind, decision: input.decision } });
  if (input.decision !== 'APPROVED') {
    await notify(
      'AGENT_DOCUMENT_RETURNED',
      record.userId,
      { partyName: record.user.name ?? 'there', document: DOCUMENT_LABEL[kind], note: input.note ?? '' },
      { inApp: { type: 'KYC', title: `${DOCUMENT_LABEL[kind]}: please upload it again`, message: input.note ?? 'The desk could not accept this paper.', suggestedAction: 'Open your application', relatedId: record.id } },
    );
  }
  return buildView(await load({ agentId }));
}

/**
 * The decision. ACTIVATE needs the papers complete and the identity verified
 * (the KYC set, every identity paper approved, or the desk vouching in
 * person), sets the grade and the engagement, and lifts the gate. REJECT and
 * HOLD carry their reason to the applicant; RESUME puts a held application
 * back under review.
 */
/**
 * AG-4: an agent the expiry sweep put on hold goes back to work the moment
 * the renewed paper is approved and nothing else on their record is
 * expired, flagged or asked for again.
 */
async function resumeIfRenewed(agentId: string, byUserId: string, req?: Request): Promise<void> {
  const record = await load({ agentId });
  if (record.stage !== 'ON_HOLD' || record.heldFromStage !== 'ACTIVE') return;
  const blocking = record.documents.some((d) => d.status === 'EXPIRED' || d.status === 'FLAGGED' || d.status === 'REUPLOAD_REQUESTED');
  if (blocking) return;
  await repository.patch(agentId, { stage: 'ACTIVE', heldFromStage: null, holdReason: null });
  await logActivity(byUserId, 'AGENT_APPLICATION_DECIDED', { req, targetType: 'AgentProfile', targetId: agentId, module: 'agents', metadata: { decision: 'RESUME', reason: 'paper renewed' } });
  await notify(
    'AGENT_APPLICATION_DECISION',
    record.userId,
    { partyName: record.user.name ?? 'there', decision: 'back at work', reason: 'Your renewed paper is approved.' },
    { inApp: { type: 'SYSTEM', title: 'You are back at work', message: 'Your renewed paper is approved; work starts arriving again.', suggestedAction: 'Open the app', relatedId: agentId } },
  );
}

export async function decideApplication(agentId: string, input: DecisionInput, byUserId: string, req?: Request): Promise<ApplicationView> {
  const record = await load({ agentId });
  if (!decisionAllowed(record.stage, input.decision)) {
    throw new ApiError(409, 'DECISION_NOT_ALLOWED', `Cannot ${input.decision.toLowerCase()} an application at ${record.stage.toLowerCase().replace('_', ' ')}`);
  }
  const now = new Date();
  const side = sideOf(record.roles);
  let patch: ProfilePatch;
  let decisionWord: string;
  let signatureAsk: { side: AgentSide } | null = null;

  if (input.decision === 'ACTIVATE') {
    const view = await buildView(record, now, { identityVouched: Boolean(input.identityCheckedInPerson) });
    const docs = documentsView(side, record.vehicleType, record.documents);
    if (!docs.complete) {
      throw new ApiError(409, 'APPLICATION_INCOMPLETE', 'Papers are missing or still flagged', { missing: docs.missing, actionNeeded: docs.actionNeeded });
    }
    if (!identityVerified(record) && !input.identityCheckedInPerson) {
      throw new ApiError(409, 'IDENTITY_UNVERIFIED', 'Verify the identity papers first (the KYC record, each paper, or vouch for them in person)');
    }
    // AG-4: the screen and the certificate are gates, unless the desk waives them with a reason in the note.
    const gaps = activationGaps({
      screening: view.screening,
      trainingCertified: view.training.state === 'CERTIFIED',
      trainingAvailable: view.training.available,
      side,
      grade: input.grade!,
      waiveScreening: Boolean(input.waiveScreening),
      waiveTraining: Boolean(input.waiveTraining),
    });
    if (gaps.length > 0) throw new ApiError(409, gaps[0]!.code, gaps.map((g) => g.message).join('; '), { gaps });
    if (input.reportingManagerId && !(await repository.employeeExists(input.reportingManagerId))) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'The reporting manager must be a staff record');
    }
    const engagementType = input.engagementType ?? (side === 'PUBLISHER' ? 'GIG' : 'CONTRACT');
    const startAt = input.engagementStartAt ? new Date(`${input.engagementStartAt}T00:00:00+05:30`) : now;
    const endAt = input.engagementEndAt ? new Date(`${input.engagementEndAt}T23:59:59.999+05:30`) : engagementType === 'CONTRACT' ? addMonths(startAt, 6) : null;
    const probationEndsAt = input.probationEndsAt ? new Date(`${input.probationEndsAt}T23:59:59.999+05:30`) : engagementType === 'CONTRACT' ? addMonths(startAt, 3) : null;
    patch = {
      stage: 'ACTIVE',
      status: 'ACTIVE',
      activatedAt: now,
      activatedById: byUserId,
      holdReason: null,
      rejectionReason: null,
      reviewNote: input.note ?? null,
      grade: input.grade!,
      gradeSetAt: now,
      gradeSetById: byUserId,
      gradeNote: input.gradeNote ?? null,
      engagementType,
      engagementStartAt: startAt,
      engagementEndAt: endAt,
      probationEndsAt,
      reportingManagerId: input.reportingManagerId ?? null,
      weeklyHours: input.weeklyHours ?? null,
      ...(input.territory ? { territory: input.territory } : {}),
      ...(input.homeZone ? { homeZone: input.homeZone } : {}),
    };
    decisionWord = 'accepted';
    await markFleetInviteActivated(agentId);
    // DS-1: the engagement terms are e-signed at activation when the policy asks; a failure to open the request never undoes the activation.
    signatureAsk = { side };
    if (input.identityCheckedInPerson) {
      await Promise.all(record.documents.filter((d) => IDENTITY_KINDS.includes(d.kind) && d.status === 'SUBMITTED').map((d) => repository.reviewDocument(agentId, d.kind, 'APPROVED', 'Seen in person at the desk', byUserId)));
    }
  } else if (input.decision === 'REJECT') {
    patch = { stage: 'REJECTED', rejectedAt: now, rejectionReason: input.note ?? null, reviewNote: input.note ?? null };
    decisionWord = 'not accepted';
  } else if (input.decision === 'HOLD') {
    // AG-4: remember where the hold came from, so a resume goes back there — ACTIVE for a working agent.
    patch = { stage: 'ON_HOLD', heldFromStage: record.stage, holdReason: input.note ?? null, reviewNote: input.note ?? null };
    decisionWord = 'on hold';
  } else {
    const back: AgentStage = record.heldFromStage === 'ACTIVE' || (record.heldFromStage === null && record.activatedAt) ? 'ACTIVE' : record.applicationSubmittedAt ? 'UNDER_REVIEW' : 'PROFILE';
    patch = { stage: back, heldFromStage: null, holdReason: null, reviewNote: input.note ?? null };
    decisionWord = back === 'ACTIVE' ? 'back at work' : 'back under review';
  }

  await repository.patch(agentId, patch);
  const signature = signatureAsk ? await requestEngagementSignature(agentId, signatureAsk.side, byUserId) : null;
  await logActivity(byUserId, 'AGENT_APPLICATION_DECIDED', { req, targetType: 'AgentProfile', targetId: agentId, module: 'agents', metadata: { decision: input.decision, grade: input.grade ?? null, note: input.note ?? null, waiveScreening: input.waiveScreening ?? false, waiveTraining: input.waiveTraining ?? false, ...(signature ? { signing: signature } : {}) } });
  await notify(
    'AGENT_APPLICATION_DECISION',
    record.userId,
    { partyName: record.user.name ?? 'there', decision: decisionWord, reason: input.note ?? '' },
    {
      inApp: {
        type: 'SYSTEM',
        title: input.decision === 'ACTIVATE' ? 'Welcome to ADX' : `Your application is ${decisionWord}`,
        message:
          input.decision === 'ACTIVATE'
            ? `You are an ADX ${side === 'PUBLISHER' ? 'field' : 'sales'} agent, grade ${GRADE_META[input.grade!].label}. Work starts arriving now.`
            : (input.note ?? `Your application is ${decisionWord}.`),
        suggestedAction: input.decision === 'ACTIVATE' ? 'Open the app' : 'Open your application',
        relatedId: agentId,
      },
    },
  );
  // A resumed application settles back onto its real rung — the ladder's, not PROFILE or UNDER_REVIEW by rote.
  return input.decision === 'RESUME' ? settleStage(await load({ agentId })) : buildView(await load({ agentId }));
}

/** The grade may move at a renewal without a fresh decision. */
export async function setGrade(agentId: string, input: GradeInput, byUserId: string, req?: Request): Promise<ApplicationView> {
  await load({ agentId });
  await repository.patch(agentId, { grade: input.grade, gradeSetAt: new Date(), gradeSetById: byUserId, gradeNote: input.note ?? null });
  await logActivity(byUserId, 'AGENT_GRADE_SET', { req, targetType: 'AgentProfile', targetId: agentId, module: 'agents', metadata: { grade: input.grade, note: input.note ?? null } });
  return buildView(await load({ agentId }));
}

/** The engagement ends. Settling the wallet and revoking access grants are Lot 5; the stage alone stops all work. */
export async function exitAgent(agentId: string, input: ExitInput, byUserId: string, req?: Request): Promise<ApplicationView & { settlement: ExitSettlement }> {
  const record = await load({ agentId });
  if (!exitAllowed(record.stage)) throw new ApiError(409, 'DECISION_NOT_ALLOWED', 'Only an active or held agent can be exited');
  const now = new Date();
  await repository.patch(agentId, {
    stage: 'EXITED',
    status: 'SUSPENDED',
    exitedAt: now,
    exitedById: byUserId,
    exitReason: input.reason,
    exitNote: input.note ?? null,
    rehireEligible: input.blacklist ? false : input.rehireEligible,
    blacklistedAt: input.blacklist ? now : null,
    engagementEndAt: now,
  });
  // AG-5: the settlement — sessions, grants, the QR code, the closing payout — through the modules that own each part.
  const settlement = await applicationPort().settleExit(agentId, record.userId);
  await logActivity(byUserId, 'AGENT_EXITED', {
    req,
    targetType: 'AgentProfile',
    targetId: agentId,
    module: 'agents',
    metadata: { reason: input.reason, rehireEligible: input.rehireEligible, blacklist: input.blacklist, grantsRevoked: settlement.grantsRevoked, payout: settlement.payout, notes: settlement.notes },
  });
  await notify(
    'AGENT_APPLICATION_DECISION',
    record.userId,
    { partyName: record.user.name ?? 'there', decision: 'ended', reason: settlement.payout ? `Your balance of ₹${settlement.payout.amount} is on its way to your verified account.` : '' },
    {
      inApp: {
        type: 'SYSTEM',
        title: 'Your ADX engagement has ended',
        message: settlement.payout ? `Your balance of ₹${settlement.payout.amount} has been raised as a final payout.` : 'Thank you for your work with ADX.',
        suggestedAction: 'Open the app',
        relatedId: agentId,
      },
    },
  );
  const view = await buildView(await load({ agentId }));
  return { ...view, settlement };
}

/* ── AG-5: the purge ─────────────────────────────────────────────────────── */

/** Ninety days after an exit, the papers go (decision 10). */
export const DOCUMENT_RETENTION_DAYS_AFTER_EXIT = 90;

/**
 * The images and the numbers of an exited agent's papers are removed
 * ninety days after the exit — the files through the uploads module, the
 * rows deleted, the profile stamped so the sweep never looks twice. The
 * hashed numbers go with the rows: a blacklisted agent's papers stay
 * matchable through the KYC record, not through these.
 */
export async function purgeExitedDocuments(now = new Date()): Promise<{ agents: number; documents: number; files: number }> {
  const before = new Date(now.getTime() - DOCUMENT_RETENTION_DAYS_AFTER_EXIT * 24 * 60 * 60 * 1000);
  const due = await repository.agentsForPurge(before);
  let documents = 0;
  let files = 0;
  for (const agent of due) {
    for (const doc of agent.documents) {
      if (await applicationPort().purgeFile(doc.url).catch(() => false)) files += 1;
      documents += 1;
    }
    await repository.purgeDocuments(agent.id, now);
    await logActivity(agent.exitedById ?? 'system', 'AGENT_DOCUMENTS_PURGED', { targetType: 'AgentProfile', targetId: agent.id, module: 'agents', metadata: { documents: agent.documents.length, exitedAt: agent.exitedAt } });
  }
  return { agents: due.length, documents, files };
}

/** For the dashboard and the gates: the stage as one word, and whether it lets work through. */
/* ── AG-4: screening ─────────────────────────────────────────────────────── */

/** The desk books an interview; the applicant is told the slot. */
export async function scheduleInterview(agentId: string, input: InterviewInput, byUserId: string, req?: Request): Promise<ApplicationView> {
  const record = await load({ agentId });
  assertOpen(record);
  if (input.interviewerId && !(await repository.employeeExists(input.interviewerId))) throw new ApiError(400, 'VALIDATION_ERROR', 'The interviewer must be a staff record');
  const scheduledAt = new Date(input.scheduledAt);
  const interview = await repository.createInterview({
    agentId,
    round: input.round,
    scheduledAt,
    mode: input.mode,
    location: input.location ?? null,
    interviewerId: input.interviewerId ?? null,
    notes: input.notes ?? null,
    createdById: byUserId,
  });
  await logActivity(byUserId, 'AGENT_INTERVIEW_SCHEDULED', { req, targetType: 'AgentProfile', targetId: agentId, module: 'agents', metadata: { interviewId: interview.id, round: input.round, scheduledAt: input.scheduledAt, mode: input.mode } });
  const when = scheduledAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const where = input.mode === 'IN_PERSON' ? (input.location ?? 'the ADX office') : input.mode === 'PHONE' ? 'by phone' : 'by video call';
  await notify(
    'AGENT_INTERVIEW_SCHEDULED',
    record.userId,
    { partyName: record.user.name ?? 'there', when, where, round: String(input.round) },
    { inApp: { type: 'SYSTEM', title: `Your ADX interview${input.round === 2 ? ' (second round)' : ''}`, message: `${when}, ${where}. Bring your original papers.`, suggestedAction: 'Open your application', relatedId: agentId } },
  );
  return settleStage(await load({ agentId }));
}

/** The outcome, with marks out of five when the interview was held. */
export async function recordInterviewOutcome(agentId: string, interviewId: string, input: InterviewOutcomeInput, byUserId: string, req?: Request): Promise<ApplicationView> {
  const record = await load({ agentId });
  const interview = await repository.findInterview(agentId, interviewId);
  if (!interview) throw new ApiError(404, 'NOT_FOUND', 'Interview not found');
  await repository.updateInterview(interviewId, { outcome: input.outcome, marks: input.marks ?? null, notes: input.notes ?? interview.notes, decidedAt: new Date(), decidedById: byUserId });
  await logActivity(byUserId, 'AGENT_INTERVIEW_DECIDED', { req, targetType: 'AgentProfile', targetId: agentId, module: 'agents', metadata: { interviewId, round: interview.round, outcome: input.outcome, marks: input.marks ?? null } });
  if (input.outcome === 'PASSED' || input.outcome === 'FAILED') {
    await notify(
      'AGENT_APPLICATION_DECISION',
      record.userId,
      { partyName: record.user.name ?? 'there', decision: input.outcome === 'PASSED' ? 'through the interview' : 'not through the interview', reason: input.notes ?? '' },
      { inApp: { type: 'SYSTEM', title: input.outcome === 'PASSED' ? 'Interview cleared' : 'Interview not cleared', message: input.notes ?? (input.outcome === 'PASSED' ? 'ADX is taking your application forward.' : 'ADX will be in touch about what comes next.'), suggestedAction: 'Open your application', relatedId: agentId } },
    );
  }
  return settleStage(await load({ agentId }));
}

/** The desk's tick: screened (with a note), or the tick taken back. */
export async function screenAtDesk(agentId: string, input: ScreenInput, byUserId: string, req?: Request): Promise<ApplicationView> {
  const record = await load({ agentId });
  assertOpen(record);
  if (input.clear) {
    await repository.patch(agentId, { screenedAt: null, screenedById: null, screeningNote: null });
  } else {
    await repository.patch(agentId, { screenedAt: new Date(), screenedById: byUserId, screeningNote: input.note ?? null });
  }
  await logActivity(byUserId, 'AGENT_APPLICATION_SCREENED', { req, targetType: 'AgentProfile', targetId: agentId, module: 'agents', metadata: { cleared: Boolean(input.clear), note: input.note ?? null } });
  return settleStage(await load({ agentId }));
}

/* ── AG-4: verification seams ────────────────────────────────────────────── */

/**
 * The desk checks the vehicle's RC with Cashfree's lookup: the facts land
 * on the VEHICLE_RC paper with the owner-name match, and the desk approves
 * on what it reads. Cashfree refusing (an unwhitelisted IP, an unknown
 * number) or being unconfigured is a 409 the desk reads, not a crash.
 */
export async function verifyVehicleRcAtDesk(agentId: string, byUserId: string, req?: Request): Promise<ApplicationView & { verification: { via: string; nameMatch: number | null; facts: unknown } }> {
  const record = await load({ agentId });
  const number = record.vehicleNumber ? normaliseVehicleNumber(record.vehicleNumber) : null;
  if (!number) throw new ApiError(409, 'VERIFICATION_UNAVAILABLE', 'No vehicle registration number on the application');
  const paper = await repository.findDocument(agentId, 'VEHICLE_RC');
  if (!paper) throw new ApiError(409, 'VERIFICATION_UNAVAILABLE', 'File the vehicle RC first, then check it');
  const answer = await lookupVehicleRc(number);
  if (!answer.ok) throw new ApiError(409, 'VERIFICATION_UNAVAILABLE', answer.message, { code: answer.code });
  const nameMatch = nameMatchScore(answer.facts.ownerName, record.user.name);
  const payload = { ...answer.facts, nameMatch, checkedAt: new Date().toISOString(), raw: answer.raw } as unknown as Record<string, never>;
  await repository.stampDocument(paper.id, { verifiedVia: 'CASHFREE_VRS', verifiedAt: new Date(), verificationPayload: payload });
  await logActivity(byUserId, 'AGENT_DOCUMENT_VERIFIED', { req, targetType: 'AgentProfile', targetId: agentId, module: 'agents', metadata: { kind: 'VEHICLE_RC', via: 'CASHFREE_VRS', number, nameMatch, status: answer.facts.status } });
  const view = await buildView(await load({ agentId }));
  return { ...view, verification: { via: 'CASHFREE_VRS', nameMatch, facts: answer.facts } };
}

/* ── AG-4: the expiry sweep ──────────────────────────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Reminded thirty and seven days out, once per window. */
export const DOCUMENT_REMINDER_DAYS = [30, 7] as const;

/**
 * A driving licence, an insurance, a police certificate — papers with a
 * date. The sweep reminds the agent thirty and seven days out and, on the
 * day, marks the paper EXPIRED: an applicant's ladder shows it as theirs to
 * renew; a working agent is put ON_HOLD (held from ACTIVE) until the
 * renewed paper is approved, when `resumeIfRenewed` lets them back.
 */
export async function runDocumentExpirySweep(now = new Date()): Promise<{ considered: number; reminded: number; expired: number; held: number }> {
  const rows = await repository.documentsExpiring(new Date(now.getTime() + DOCUMENT_REMINDER_DAYS[0] * DAY_MS));
  let reminded = 0;
  let expired = 0;
  let held = 0;
  for (const row of rows) {
    const label = DOCUMENT_LABEL[row.kind];
    const until = row.expiresAt;
    if (until.getTime() <= now.getTime()) {
      await repository.stampDocument(row.id, { status: 'EXPIRED', expiredAt: now });
      expired += 1;
      const working = row.agent.stage === 'ACTIVE';
      if (working) {
        await repository.patch(row.agentId, { stage: 'ON_HOLD', heldFromStage: 'ACTIVE', holdReason: `Your ${label} expired on ${until.toISOString().slice(0, 10)}. Upload the renewed one; work resumes when ADX approves it.` });
        held += 1;
      }
      await notify(
        'AGENT_DOCUMENT_EXPIRED',
        row.agent.userId,
        { partyName: row.agent.user.name ?? 'there', document: label, date: until.toISOString().slice(0, 10) },
        {
          inApp: {
            type: 'SYSTEM',
            title: `Your ${label} has expired`,
            message: working ? `Work is paused until you upload the renewed ${label} and ADX approves it.` : `Upload the renewed ${label} to keep your application moving.`,
            suggestedAction: 'Upload the renewed paper',
            relatedId: row.agentId,
          },
        },
      );
      continue;
    }
    const daysLeft = Math.ceil((until.getTime() - now.getTime()) / DAY_MS);
    const window = DOCUMENT_REMINDER_DAYS.filter((days) => daysLeft <= days).pop();
    if (window === undefined) continue;
    // Sent once per window: a reminder for a wider window does not count for a tighter one.
    if (row.expiryReminderDays !== null && row.expiryReminderDays <= window) continue;
    await repository.stampDocument(row.id, { expiryRemindedAt: now, expiryReminderDays: window });
    reminded += 1;
    await notify(
      'AGENT_DOCUMENT_EXPIRING',
      row.agent.userId,
      { partyName: row.agent.user.name ?? 'there', document: label, days: String(daysLeft), date: until.toISOString().slice(0, 10) },
      {
        inApp: {
          type: 'SYSTEM',
          title: `Your ${label} runs out in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
          message: `It expires on ${until.toISOString().slice(0, 10)}. Upload the renewed ${label} before then and nothing stops.`,
          suggestedAction: 'Upload the renewed paper',
          relatedId: row.agentId,
        },
      },
    );
  }
  return { considered: rows.length, reminded, expired, held };
}

export function workGate(stage: AgentStage): { stage: AgentStage; mayWork: boolean } {
  return { stage, mayWork: agentMayWork(stage) };
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

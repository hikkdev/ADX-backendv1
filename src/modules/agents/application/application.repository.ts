import type {
  AgentDocument,
  AgentDocumentKind,
  AgentDocumentStatus,
  AgentEducation,
  AgentEmployment,
  AgentEngagementType,
  AgentExitReason,
  AgentGrade,
  AgentInterview,
  AgentInterviewMode,
  AgentInterviewOutcome,
  AgentPlatformExperience,
  AgentProfile,
  AgentReference,
  AgentSourceKind,
  AgentStage,
  AgentVehicleType,
  AgentEducationLevel,
  DocumentVerificationVia,
  KycStatus,
  Prisma,
} from '../../../shared/database';

/** The application as the service reads it: the profile, the person, the papers and the side rows, in one read. */
export type ApplicationRecord = AgentProfile & {
  user: { id: string; name: string | null; mobile: string | null; email: string | null; dateOfBirth: Date | null; gender: string | null; isActive: boolean };
  roles: string[];
  documents: AgentDocument[];
  educations: AgentEducation[];
  employments: AgentEmployment[];
  references: AgentReference[];
  platformExperiences: AgentPlatformExperience[];
  /** AG-4: the interviews the desk scheduled, oldest first. */
  interviews: AgentInterview[];
  /** The desk's KYC set, for "identity verified" — null before any record. */
  kyc: { status: KycStatus; reviewedAt: Date | null } | null;
};

export type ProfilePatch = Partial<{
  city: string | null;
  cityId: string | null;
  state: string | null;
  languages: string[];
  vehicleType: AgentVehicleType | null;
  vehicleNumber: string | null;
  currentAddress: string | null;
  currentLatitude: number | null;
  currentLongitude: number | null;
  permanentAddress: string | null;
  emergencyContactName: string | null;
  emergencyContactRelation: string | null;
  emergencyContactPhone: string | null;
  highestEducation: AgentEducationLevel | null;
  salesExperienceYears: number | null;
  industries: string[];
  noticePeriodDays: number | null;
  stage: AgentStage;
  applicationSubmittedAt: Date | null;
  activatedAt: Date | null;
  activatedById: string | null;
  holdReason: string | null;
  rejectionReason: string | null;
  rejectedAt: Date | null;
  withdrawnAt: Date | null;
  reviewNote: string | null;
  grade: AgentGrade | null;
  gradeSetAt: Date | null;
  gradeSetById: string | null;
  gradeNote: string | null;
  engagementType: AgentEngagementType | null;
  engagementStartAt: Date | null;
  engagementEndAt: Date | null;
  probationEndsAt: Date | null;
  reportingManagerId: string | null;
  weeklyHours: number | null;
  territory: string | null;
  homeZone: string | null;
  status: 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED';
  sourceKind: AgentSourceKind;
  sourceNote: string | null;
  referredByAgentId: string | null;
  exitedAt: Date | null;
  exitedById: string | null;
  exitReason: AgentExitReason | null;
  exitNote: string | null;
  rehireEligible: boolean;
  blacklistedAt: Date | null;
  /* AG-4 */
  screenedAt: Date | null;
  screenedById: string | null;
  screeningNote: string | null;
  heldFromStage: AgentStage | null;
}>;

/** AG-4: an interview as the desk books it. */
export type NewInterview = {
  agentId: string;
  round: number;
  scheduledAt: Date;
  mode: AgentInterviewMode;
  location: string | null;
  interviewerId: string | null;
  notes: string | null;
  createdById: string;
};

export type InterviewOutcomePatch = {
  outcome: AgentInterviewOutcome;
  marks: number | null;
  notes: string | null;
  decidedAt: Date;
  decidedById: string;
};

/** AG-4: a paper with a date, and whose it is — what the expiry sweep walks. */
export type ExpiringDocument = {
  id: string;
  agentId: string;
  kind: AgentDocumentKind;
  status: AgentDocumentStatus;
  expiresAt: Date;
  expiryRemindedAt: Date | null;
  expiryReminderDays: number | null;
  agent: { id: string; userId: string; stage: AgentStage; displayId: string | null; user: { name: string | null } };
};

export type DocumentStamp = Partial<{
  status: AgentDocumentStatus;
  expiredAt: Date | null;
  expiryRemindedAt: Date | null;
  expiryReminderDays: number | null;
  verifiedVia: DocumentVerificationVia | null;
  verifiedAt: Date | null;
  verificationPayload: Prisma.InputJsonValue;
  reviewNote: string | null;
}>;

export type SideRows = {
  educations?: { level: AgentEducationLevel; degree?: string | null; institution?: string | null; year?: number | null }[];
  employments?: { employer: string; role?: string | null; industry?: string | null; fromMonth?: string | null; toMonth?: string | null; current?: boolean; reasonForLeaving?: string | null }[];
  references?: { name: string; relation?: string | null; phone: string }[];
  platformExperiences?: { platform: string; partnerId?: string | null; years?: number | null; active?: boolean; ratingNote?: string | null }[];
};

export type NewDocument = {
  agentId: string;
  kind: AgentDocumentKind;
  url: string;
  numberMasked: string | null;
  numberHash: string | null;
  expiresAt: Date | null;
  uploadedVia: 'APP' | 'DESK';
  uploadedById: string | null;
};

export type ApplicationsFilter = { stage?: AgentStage; stages?: readonly AgentStage[]; side?: 'PUBLISHER' | 'ADVERTISER'; q?: string };

/** One row of the desk's queue. */
export type ApplicationRow = {
  id: string;
  displayId: string | null;
  stage: AgentStage;
  grade: AgentGrade | null;
  sourceKind: AgentSourceKind;
  city: string | null;
  createdAt: Date;
  applicationSubmittedAt: Date | null;
  activatedAt: Date | null;
  roles: string[];
  user: { name: string | null; mobile: string | null; email: string | null };
  documents: { kind: AgentDocumentKind; status: AgentDocumentStatus }[];
};

export type NewApplication = {
  role: 'AGENT_PUBLISHER' | 'AGENT_ADVERTISER';
  displayId: string;
  sourceKind: AgentSourceKind;
  sourceNote: string | null;
  referredByAgentId: string | null;
  /** AG-5: the fleet partner whose invite this number applied through. */
  fleetPartnerId?: string | null;
};

export interface ApplicationRepository {
  /** A signed-in person becomes an applicant: the role (if missing) and a profile at PROFILE, in one transaction. */
  createApplication(userId: string, input: NewApplication): Promise<ApplicationRecord>;
  findByUserId(userId: string): Promise<ApplicationRecord | null>;
  findById(agentId: string): Promise<ApplicationRecord | null>;
  /** The profile facts, the ladder's stage among them; a key left out is left alone. */
  patch(agentId: string, patch: ProfilePatch): Promise<void>;
  /** AG-3: the person's own fields, written by the desk beside the profile. */
  patchPerson(userId: string, patch: { name?: string; dateOfBirth?: Date; gender?: string }): Promise<void>;
  /** The side rows are sent whole: each list given replaces what was there. */
  replaceSideRows(agentId: string, rows: SideRows): Promise<void>;
  /** One paper per kind: a second upload of the same kind replaces the first and starts its review again. */
  upsertDocument(doc: NewDocument): Promise<AgentDocument>;
  removeDocument(agentId: string, kind: AgentDocumentKind): Promise<void>;
  reviewDocument(agentId: string, kind: AgentDocumentKind, status: AgentDocumentStatus, note: string | null, reviewedById: string): Promise<AgentDocument | null>;
  /** Another agent already holds a paper with this number. */
  numberHeldElsewhere(agentId: string, numberHash: string): Promise<boolean>;
  /** The agent whose referral code this is, or null. */
  findAgentByReferralCode(code: string): Promise<{ id: string } | null>;
  findApplications(filter: ApplicationsFilter, page: number, pageSize: number): Promise<{ items: ApplicationRow[]; total: number }>;
  countByStage(filter: Omit<ApplicationsFilter, 'stage'>): Promise<{ stage: AgentStage; count: number }[]>;
  /** The reporting manager must be a staff record. */
  employeeExists(employeeId: string): Promise<boolean>;

  /* AG-4 */
  createInterview(input: NewInterview): Promise<AgentInterview>;
  findInterview(agentId: string, interviewId: string): Promise<AgentInterview | null>;
  updateInterview(interviewId: string, patch: InterviewOutcomePatch | { scheduledAt?: Date; mode?: AgentInterviewMode; location?: string | null; interviewerId?: string | null; notes?: string | null }): Promise<AgentInterview>;
  /** Papers with a date on or before `before`, not yet expired, on applications and agents still in play. */
  documentsExpiring(before: Date): Promise<ExpiringDocument[]>;
  /** A fact stamped on a paper beside its review — the sweep's reminder, its lapse, a verification. */
  stampDocument(documentId: string, stamp: DocumentStamp): Promise<void>;
  findDocument(agentId: string, kind: AgentDocumentKind): Promise<AgentDocument | null>;
  /* AG-5 */
  /** Exited on or before `before`, papers still on file. */
  agentsForPurge(before: Date): Promise<{ id: string; exitedAt: Date | null; exitedById: string | null; documents: { id: string; url: string }[] }[]>;
  /** The rows go; the profile is stamped. */
  purgeDocuments(agentId: string, at: Date): Promise<void>;
}

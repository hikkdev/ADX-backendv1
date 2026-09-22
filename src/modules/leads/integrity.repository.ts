import type { LeadFlag, LeadQaSample } from '../../shared/database';

/**
 * LH10 (anti-gaming and quality): the reads and writes behind the integrity
 * scan, the QA sampling and the clawback watch.
 *
 * The scan is a set of aggregate reads — numbers shared across leads, capture
 * counts in an hour, provider keys that repeated — and the flags it opens;
 * the sampling reads completed visits and recorded calls with the evidence
 * they carry. Everything here is read for a decision a person makes: nothing
 * in this file suspends anybody or moves money.
 */

/** A lead as the scan reads it. */
export type ScanLead = {
  id: string;
  displayId: string | null;
  businessName: string;
  phoneNormalised: string | null;
  capturedByAgentId: string | null;
  capturedAt: Date | null;
  assignedAgentId: string | null;
  externalKey: string | null;
  createdAt: Date;
};

/** A lead sharing a phone number with the subject. */
export type PhoneTwin = { id: string; displayId: string | null; businessName: string; createdAt: Date };

/** LH3 (D9): the referral behind a lead, with the referrer's own number and login. */
export type ReferralFact = {
  id: string;
  referrerKind: string;
  referrerId: string;
  referrerName: string | null;
  referrerPhone: string | null;
  referrerUserId: string | null;
  creditedAt: Date | null;
};

/** A completed visit the sampler may draw, with the proof it carries. */
export type VisitSample = {
  id: string;
  displayId: string | null;
  agentId: string;
  leadId: string | null;
  businessName: string;
  completedAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  proofFileId: string | null;
  proofLatitude: number | null;
  proofLongitude: number | null;
  proofAt: Date | null;
};

/** A recorded call the sampler may draw. */
export type CallSample = {
  id: string;
  leadId: string;
  byAgentId: string | null;
  durationSec: number | null;
  consentPlayed: boolean;
  recordingFileId: string | null;
  outcome: string | null;
  at: Date;
};

export type NewFlag = {
  leadId: string;
  kind: string;
  detail: string;
  evidence: unknown;
  agentId: string | null;
};

export type NewQaSample = {
  kind: 'VISIT' | 'CALL';
  agentId: string;
  visitId?: string | null;
  messageId?: string | null;
  leadId?: string | null;
  evidence: unknown;
  autoVerdict: 'PASS' | 'FAIL';
  sampledAt: Date;
};

export type FlagWithLead = LeadFlag & { lead: { displayId: string | null; businessName: string; city: string | null; side: string; stage: string; assignedAgentId: string | null } };

/** LH10: one activated lead the clawback watch reads, with what became of its account. */
export type ClawbackCandidate = {
  id: string;
  displayId: string | null;
  businessName: string;
  assignedAgentId: string | null;
  activatedAt: Date | null;
  convertedPublisherId: string | null;
  convertedAdvertiserId: string | null;
};

export interface LeadIntegrityRepository {
  /* ── the scan ─────────────────────────────────────────────────── */
  /** Leads created since `since`, oldest first — the scan's cohort. */
  leadsCreatedSince(since: Date, take: number): Promise<ScanLead[]>;
  /**
   * Other leads holding the same number. The table already refuses a second
   * lead on a normalised number (a partial unique index since the leads
   * migration), so what this catches is the rows whose number never
   * normalised and sit under the raw string.
   */
  leadsWithPhone(phoneNormalised: string, excludeLeadId: string): Promise<PhoneTwin[]>;
  /** Accounts holding the same number — a "new lead" that is already a customer. */
  accountsWithPhone(phoneNormalised: string): Promise<{ kind: string; id: string; name: string | null }[]>;
  /** The referral that produced this lead, with the referrer's own handles. */
  referralFor(leadId: string): Promise<ReferralFact | null>;
  /** Device tokens registered to a login — the self-referral's "same device". */
  deviceTokensFor(userId: string): Promise<string[]>;
  /** The logins that registered any of these tokens. */
  userIdsWithDeviceTokens(tokens: string[], excludeUserId: string | null): Promise<string[]>;
  /** The login behind a lead's converted account, if it has one. */
  userIdForLead(leadId: string): Promise<string | null>;
  /** How many leads an agent captured in the hour around `at`, and the ids. */
  capturesInHour(agentId: string, at: Date): Promise<{ count: number; leadIds: string[] }>;
  /** How many leads carry this provider key — a replay makes it more than one. */
  leadsWithExternalKey(externalKey: string): Promise<PhoneTwin[]>;
  /** Inbound form messages carrying a provider id, and how many times each arrived, since `since`. */
  repeatedFormMessages(since: Date, take: number): Promise<{ providerId: string; leadId: string; count: number }[]>;

  /* ── the flags ────────────────────────────────────────────────── */
  findFlag(leadId: string, kind: string): Promise<LeadFlag | null>;
  createFlag(data: NewFlag): Promise<LeadFlag>;
  updateFlag(id: string, patch: { status?: string; detail?: string; evidence?: unknown; decidedByUserId?: string | null; decidedAt?: Date | null; note?: string | null }): Promise<LeadFlag>;
  findFlagById(id: string): Promise<FlagWithLead | null>;
  listFlags(filter: { status?: string | undefined; kind?: string | undefined; agentId?: string | undefined; limit: number }): Promise<FlagWithLead[]>;
  countFlags(filter: { status?: string | undefined }): Promise<{ kind: string; count: number }[]>;

  /* ── the QA sampling ──────────────────────────────────────────── */
  visitsCompletedBetween(from: Date, to: Date, take: number): Promise<VisitSample[]>;
  callsBetween(from: Date, to: Date, take: number): Promise<CallSample[]>;
  qaSampleExists(kind: 'VISIT' | 'CALL', id: string): Promise<boolean>;
  createQaSample(data: NewQaSample): Promise<LeadQaSample>;
  findQaSample(id: string): Promise<LeadQaSample | null>;
  updateQaSample(id: string, patch: { verdict?: string; reviewedByUserId?: string; reviewedAt?: Date; note?: string | null }): Promise<LeadQaSample>;
  listQaSamples(filter: { agentId?: string | undefined; kind?: string | undefined; reviewed?: boolean | undefined; limit: number }): Promise<LeadQaSample[]>;
  /** The agent's samples since `since` — the quality score's sample. */
  qaSamplesForAgent(agentId: string, since: Date): Promise<Pick<LeadQaSample, 'kind' | 'autoVerdict' | 'verdict' | 'sampledAt'>[]>;
  /** LH10: confirmed flags naming the agent since `since` — the quality score's other half. */
  confirmedFlagsForAgent(agentId: string, since: Date): Promise<number>;

  /* ── the clawback ─────────────────────────────────────────────── */
  /** Leads activated inside the watch window, oldest first. */
  activatedSince(since: Date, take: number): Promise<ClawbackCandidate[]>;
  /** Whether the account behind a lead is still live — a publisher with an ACTIVE listing, an advertiser with a live campaign — and whether its login is closed. */
  accountStanding(account: { publisherId: string | null; advertiserId: string | null }): Promise<{ live: boolean; closed: boolean; label: string | null }>;
  /** The LEAD_ACTIVATED incentive recorded on the account (the priority top-up aside), or null. */
  activationIncentiveFor(account: { publisherId: string | null; advertiserId: string | null }): Promise<{ id: string; agentId: string; status: string; amount: string } | null>;
}

import type { DispatchAsk } from '../../shared/dispatch';
import type { AgentGrade, AgentProfile, AgentProfileStatus, AgentStage, AgentTier, KycStatus, SuspensionScope, TierLevel } from '../../shared/database';
import type { Money } from '../../shared/money';

/** E7-3: what another desk needs to name an agent beside a user id. */
export type AgentLabelRow = { id: string; userId: string; displayId: string | null; name: string | null; kycStatus: KycStatus | null };

export type AgentFilter = {
  /** A slug, or a name for the console's older links. */
  city?: string;
  /** Lot X-B: the key `city` resolved to — rows match on it, or on the spelling for the rows whose key is null. */
  cityId?: string | null;
  tier?: AgentTier;
  search?: string;
};

export type AgentRole = 'AGENT_PUBLISHER' | 'AGENT_ADVERTISER';

/** Everything a new agent is written with, mobile already normalised. */
export type NewAgent = {
  mobile: string;
  name: string;
  email?: string;
  role: AgentRole;
  /** AG-1: ACTIVE for the desk's one-step create (the default), PROFILE for an application started at the desk. */
  stage?: 'ACTIVE' | 'PROFILE';
  city?: string;
  /** Lot X-B: the `City` row `city` denotes, stamped by the service through `pricing.withCityKey`; null for a typed town. */
  cityId?: string | null;
  state?: string;
  displayId: string;
};

/**
 * D5: what a profile patch may carry. `null` clears a field; a key left out is
 * left alone. Every value here is already validated by the schema.
 */
export type AgentProfilePatch = {
  city?: string | null;
  /** Lot X-B: rides with `city` — the service stamps it, a caller never sends it. */
  cityId?: string | null;
  state?: string | null;
  businessName?: string | null;
  territory?: string | null;
  homeZone?: string | null;
  radiusKm?: number | null;
  workingDays?: string[];
  hoursFrom?: string | null;
  hoursTo?: string | null;
  autoAcceptInZone?: boolean;
  orderTypes?: ('INDOOR' | 'OUTDOOR' | 'TRANSIT' | 'MEDIA')[];
  maxActiveOrders?: number | null;
  status?: 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED';
};

/** The agent's zone, as the auto-accept rule reads it. */
export type AgentZone = { autoAcceptInZone: boolean; city: string | null; homeZone: string | null };

/** The order statuses in which an agent is holding the work — what `maxActiveOrders` caps. */
export const AGENT_ACTIVE_ORDER_STATUSES = ['SLOT_PROPOSED', 'SLOT_CONFIRMED', 'IN_PROGRESS', 'PENDING_OTP'] as const;

export interface AgentsRepository {
  /** The user behind a number, and whether they are already an agent. */
  findUserByMobile(
    mobile: string,
  ): Promise<{ id: string; agentProfileId: string | null; roles: string[] } | null>;
  /** Whether an email is held by a different account. */
  emailTaken(email: string, exceptUserId: string | null): Promise<boolean>;
  /** A brand-new person: user, role and profile in one write. */
  createAgent(input: NewAgent): Promise<AgentProfile>;
  /** Somebody who already has an account — a publisher, say — becoming an agent too. */
  attachAgent(userId: string, input: NewAgent): Promise<AgentProfile>;
  findPage(
    filter: AgentFilter,
    limit: number,
    offset: number,
  ): Promise<{ items: AgentProfile[]; total: number }>;
  /** The profile with the account slice `GET /agents/:id` prints; E10-1: the closure columns ride it (Lot A, Q21). */
  findById(id: string): Promise<AgentWithUser | null>;
  exists(id: string): Promise<boolean>;
  findByUserId(userId: string): Promise<AgentProfile | null>;
  /** E7-3: the label per login — the name is the user's, the KYC state the AgentKyc row's. */
  findLabelsByUserIds(userIds: string[]): Promise<AgentLabelRow[]>;
  /** K-B1: `{ id, label, displayId }` per id in one query — the QR desk names the code's subject with it. */
  findLabelsByIds(ids: string[]): Promise<{ id: string; label: string; displayId: string | null }[]>;
  /** Agent plus the user id to notify. */
  findWithUser(agentId: string): Promise<{ id: string; userId: string } | null>;
  /**
   * First agent-publisher who is offered work — profile ACTIVE, able to sign
   * in, not in the exclusion list, and under their own `maxActiveOrders` —
   * the first of them in offer-priority order (`shared/dispatch`).
   */
  /** The sweep's pick — AG-5: for the grade the work's band asks for, and where it is. */
  findAssignable(excludeIds: string[], ask?: DispatchAsk, now?: Date): Promise<{ id: string } | null>;
  /**
   * Lot A: the profile's status and suspension scopes, for the dispatch points
   * that have to refuse a suspended agent — visits, milestones, leads.
   */
  findWorkState(id: string): Promise<{ status: string; scopes: SuspensionScope[]; stage: AgentStage; roles: string[] } | null>;
  /** D5: the profile facts ops or the agent may change. */
  update(id: string, patch: AgentProfilePatch): Promise<AgentProfile>;
  /** What "auto-accept in my zone" needs to decide: the switch and where the zone is. */
  findZone(id: string): Promise<AgentZone | null>;
  /** Lot E (Q99): ACTIVE agents by name, for `hr`'s people registry. */
  /** E10-1: `includeInactive` lists every profile, not only ACTIVE ones who can sign in. */
  findDirectory(q?: string, includeInactive?: boolean): Promise<AgentDirectoryRow[]>;

  // ── GET /agents/me — the dashboard header ──────────────────────────────

  /** The profile plus the person's name and roles, by the signed-in user. */
  findDashboardProfile(userId: string): Promise<DashboardProfile | null>;
  /**
   * Accounts this agent has brought all the way through onboarding — the
   * figure the tier ladder climbs on. Attribution alone is not enough: a
   * scan that was approved and then abandoned is not an onboarding.
   */
  countOnboarded(agentId: string): Promise<{ publishers: number; advertisers: number }>;
  /**
   * Lot B (Q100): what the agent has sold — package sales that were paid for,
   * and campaigns that launched (SCHEDULED onwards). Counters beside the
   * rating, never inside it.
   */
  countSales(agentId: string): Promise<{ packagesSold: number; campaignsLaunched: number }>;
  /** The wallet's settled balance; an agent with no wallet has zero. */
  walletBalance(agentId: string): Promise<{ balance: Money; currency: string }>;
  /**
   * Work in the window [start, end): orders the agent holds whose slot falls
   * in it or that are mid-installation, and — as `visits` — visit milestones
   * due in it or already under way plus (G12-B) the agent's SCHEDULED /
   * IN_PROGRESS field visits slotted in it or under way.
   */
  countToday(agentId: string, start: Date, end: Date): Promise<{ orders: number; visits: number }>;
}

/** Lot E (Q99): one row of the people registry — the agent half. */
/** The by-id read's account slice — id, name, contacts, whether it can sign in, and (E10-1) whether it was closed. */
export type AgentWithUser = AgentProfile & {
  user: {
    id: string;
    name: string | null;
    mobile: string | null;
    email: string | null;
    isActive: boolean;
    closedAt: Date | null;
    closeReason: string | null;
  } | null;
  /** N3-B: the KYC record's six summary columns on the by-id read, so `GET /agents/:id` derives `kyc.state` the way the queue does; null before any record. */
  kyc?: KycRecordSummary | null;
};

/** N3-B: what the party read needs of the KYC record (`shared/kyc-state`'s `KycStateRecord`). */
export type KycRecordSummary = {
  id: string;
  status: KycStatus;
  submittedAt: Date | null;
  requestedAt: Date | null;
  requestedChannel: string | null;
  method: string;
};

export type AgentDirectoryRow = {
  id: string;
  userId: string;
  tier: AgentTier;
  tierLevel: TierLevel;
  city: string | null;
  /** E10-1: with `user.isActive`, whether the agent is still one who can be assigned. */
  status: AgentProfileStatus;
  user: { name: string | null; isActive: boolean };
};

export type DashboardProfile = {
  id: string;
  displayId: string | null;
  city: string | null;
  state: string | null;
  tier: AgentTier;
  tierLevel: TierLevel;
  tierPinnedAt: Date | null;
  name: string | null;
  roles: string[];
  /** Lot A: what the app tells the agent when their own work has been stopped. */
  status: string;
  suspensionScopes: SuspensionScope[];
  suspensionReason: string | null;
  suspendedAt: Date | null;
  /** AG-1: where they stand on the application ladder, and the grade the desk gave them. */
  stage: AgentStage;
  grade: AgentGrade | null;
  activatedAt: Date | null;
};

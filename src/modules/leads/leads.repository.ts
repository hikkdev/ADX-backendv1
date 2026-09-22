import type { Lead, LeadActivity, LeadClaim, LeadFeedRun, LeadReferral, LeadSource, PriorityZone, ReferralLink, Territory } from '../../shared/database';
import type { AdminLeadsQuery, NearLeadsQuery } from './leads.schema';

/** A lead with the activity the detail screen draws under it. */
export type LeadWithActivity = Lead & { activity: LeadActivity[] };

export type LeadsPage = {
  items: Lead[];
  total: number;
  counts: Record<string, number>;
  /** LH1: rows per temperature under the same facets (the temperature facet removed). */
  temperatureCounts: Record<string, number>;
  /** LH2: rows per stage under the same facets (the stage facet removed). */
  stageCounts: Record<string, number>;
};

/** LH1: what the score reads of a lead — the row, its source, the intent-bearing thread. */
export type LeadForScoring = Lead & {
  sourceRef: LeadSource | null;
  activity: { kind: string; createdAt: Date }[];
};

/** LH1: what the nightly learner reads per source. */
export type SourceStats = { sourceId: string; created: number; converted: number };

/**
 * A bubble on the agent's map — the "5 LEADS" chips DR 01 and DR 05 draw.
 *
 * Exactly the shape `agents.LeadCluster` already declares, so the layer that
 * has been rendering an empty array since the dashboard was built needs no
 * change at all beyond being given something.
 */
export type LeadCluster = {
  latitude: number;
  longitude: number;
  count: number;
  label: string;
};

/**
 * Where to look for bubbles.
 *
 * A point when the app has told us where the agent is, which is the honest
 * answer to "near you"; their city when it has not, because a dashboard that
 * shows nothing until location permission is granted teaches people the
 * feature is broken.
 */
export type LeadClusterScope =
  | { point: { latitude: number; longitude: number; radiusKm: number }; city?: undefined; cityId?: undefined }
  | {
      point?: undefined;
      city: string;
      /**
       * Lot X-L: the key `city` resolved to (`leadClusters` stamps it). Set,
       * the bubbles cover the leads keyed to the city plus the null-keyed
       * ones typed under this spelling — one hunting map, not one per
       * spelling. Null or absent: the spelling alone.
       */
      cityId?: string | null;
    };

export type NewLead = {
  side: string;
  businessName: string;
  displayId: string | null;
  category?: string | null;
  contactName?: string | null;
  phone?: string | null;
  /** Lot D (Q93): E.164, the hard duplicate key. Null when no phone, or not a phone. */
  phoneNormalised?: string | null;
  email?: string | null;
  address?: string | null;
  locality?: string | null;
  city?: string | null;
  /** Lot X-B: the `City` row `city` denotes, stamped by the service through `pricing.withCityKey`; null for a typed town. */
  cityId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  interest?: string | null;
  source?: string | null;
  bestTimeFrom?: string | null;
  bestTimeTo?: string | null;
  estimatedCommission?: string | null;
  assignedAgentId?: string | null;
  createdByUserId?: string | null;
  /** LH1: the source door; the service resolves it from the label when the caller names none. */
  sourceId?: string | null;
  lastTouchedAt?: Date | null;
  /** LH1/LH3: written when the door already knows the temperature (inbound starts warm). */
  temperature?: 'HOT' | 'WARM' | 'COLD' | null;
  /** LH3: the provider's own id (`meta:<id>`, `google-places:<place_id>`) — a replay creates nothing twice. */
  externalKey?: string | null;
  feedRunId?: string | null;
  /** LH4: the agent who spotted it, when, and the photos kept for the listing draft. */
  capturedByAgentId?: string | null;
  capturedAt?: Date | null;
  photoFileIds?: string[];
  /** LH5 */
  claimedByAgentId?: string | null;
  claimExpiresAt?: Date | null;
  territoryId?: string | null;
};

/** LH5: a viewport's facets. */
export type MapFacets = { side?: string | undefined; temperature?: string | undefined; category?: string | undefined };
export type BBoxIn = { south: number; west: number; north: number; east: number };
export type NewTerritory = { name: string; side: string; polygon: unknown; south: number; west: number; north: number; east: number; agentId: string; city: string | null; cityId: string | null; createdById: string };
export type TerritoryPatch = { name?: string; polygon?: unknown; south?: number; west?: number; north?: number; east?: number; agentId?: string; isActive?: boolean };
export type NewZone = { name: string; side: string | null; polygon: unknown; south: number | null; west: number | null; north: number | null; east: number | null; category: string | null; topUp: number; startsAt: Date; endsAt: Date; budgetCap: number | null; createdById: string };
export type ZonePatch = { name?: string | undefined; topUp?: number | undefined; startsAt?: Date | undefined; endsAt?: Date | undefined; budgetCap?: number | null | undefined; isActive?: boolean | undefined };

/** LH3: an agent who could take a new lead — the routing's candidate. */
export type CandidateAgent = { id: string; userId: string; tier: string; cityId: string | null; openLeads: number };

export type NewFeedRun = {
  sourceId: string;
  requestedById: string | null;
  side: string;
  category: string;
  city: string | null;
  polygon: unknown;
  limit: number;
  status: 'RUNNING' | 'DONE' | 'FAILED' | 'QUOTA';
  finishedAt?: Date;
  error?: string;
};

export type FeedRunPatch = {
  status?: 'RUNNING' | 'DONE' | 'FAILED' | 'QUOTA';
  candidates?: number;
  imported?: number;
  skipped?: number;
  warnings?: number;
  report?: unknown;
  error?: string;
  finishedAt?: Date;
};

export type FeedRunWithSource = LeadFeedRun & { source: { key: string; label: string } };

export type LeadPatch = Partial<Omit<NewLead, 'displayId'>> & {
  status?: string;
  firstContactedAt?: Date | null;
  convertedPublisherId?: string | null;
  convertedAdvertiserId?: string | null;
  convertedAt?: Date | null;
  /** LH1 */
  agentFlaggedHotAt?: Date | null;
  score?: number | null;
  temperature?: 'HOT' | 'WARM' | 'COLD' | null;
  scoreReasons?: unknown;
  scoreComputedAt?: Date | null;
  estimatedValue?: string | null;
  /** LH2 */
  stage?: string;
  stageChangedAt?: Date | null;
  lostReason?: string | null;
  lostNote?: string | null;
  activatedAt?: Date | null;
  retainedAt?: Date | null;
  recycleAt?: Date | null;
  attribution?: unknown;
  /** LH9/LH11 */
  recycledAt?: Date | null;
  recycleCount?: number;
};

/** LH2: what the retention watch reads of an account the lead became. */
export type AccountActivation = { activatedAt: Date | null; label: string | null };
export type AccountRetention = { repeatCount: number; stillLive: boolean };

/** LH8: one reward the hunt recorded for a lead — the agent's LEAD_* incentives on its account, and the priority top-up keyed on it. */
export type LeadReward = { id: string; event: string; amount: string; status: string; note: string | null; at: Date };

/** LH2: the funnel's filter — every facet optional, aggregates only. */
export type FunnelFilter = {
  side?: string | undefined;
  sourceId?: string | undefined;
  agentId?: string | undefined;
  cityId?: string | null | undefined;
  city?: string | undefined;
  category?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
};

export type FunnelRows = {
  byStage: { stage: string; count: number; value: string | null; avgDaysInStage: number | null }[];
  bySource: { key: string; label: string; total: number; converted: number; activated: number }[];
  byAgent: { key: string; total: number; converted: number; activated: number }[];
  byCity: { key: string; total: number; converted: number; activated: number }[];
  byCategory: { key: string; total: number; converted: number; activated: number }[];
  byChannel: { channel: string; firstContact: number; engaged: number; converted: number }[];
  lossMix: { reason: string; count: number }[];
  /** Days from creation to conversion, averaged over the converted rows in the window. */
  avgDaysToConvert: number | null;
  totals: { leads: number; converted: number; activated: number; retained: number; lost: number; recycled: number };
};

export interface LeadsRepository {
  create(data: NewLead): Promise<Lead>;
  createMany(rows: NewLead[]): Promise<number>;
  findById(leadId: string): Promise<LeadWithActivity | null>;
  update(leadId: string, patch: LeadPatch): Promise<Lead>;

  /** The agent's list. Ranked by distance when a point is given. */
  /** AG-5: `importances` narrows the agent's list to the bands their grade may take; omitted, every band. */
  findNear(query: NearLeadsQuery, importances?: readonly string[]): Promise<LeadsPage>;
  /** The ops desk. Lot X-B: `cityId` is the key `query.city` resolved to — rows match on it, or on the spelling for the rows whose key is null. */
  findForAdmin(query: AdminLeadsQuery & { cityId?: string | null }): Promise<LeadsPage>;

  /**
   * The map layer: open leads grouped by the locality they sit in.
   *
   * Grouped in the database rather than in the service, because the point of a
   * cluster is not to send a thousand rows to a phone and count them there.
   */
  clustersNear(where: LeadClusterScope): Promise<LeadCluster[]>;

  logActivity(entry: {
    leadId: string;
    actorUserId: string | null;
    kind: string;
    note?: string | null;
  }): Promise<LeadActivity>;

  /* ── Lot D (Q93): dedup ─────────────────────────────────────────── */

  /** Leads already carrying any of these normalised numbers. */
  findByPhones(phones: string[]): Promise<{ id: string; displayId: string | null; phoneNormalised: string | null }[]>;
  /**
   * Publisher and advertiser accounts on any of these numbers. Read here
   * rather than through those modules because neither exports a lookup by
   * mobile, and a read is not a decision — the same call `disputes` makes
   * for an order's parties.
   */
  findAccountsByPhones(phones: string[]): Promise<AccountByPhone[]>;
  /** Existing leads whose business name matches any of these, case-insensitively; the service folds the city. */
  findByNameAndCity(names: string[]): Promise<{ id: string; displayId: string | null; businessName: string; city: string | null }[]>;
  /**
   * The import, written whole in one transaction: every lead with its
   * IMPORTED activity, or none of them. Ids and numbers are minted by the
   * caller before this runs.
   */
  importBatch(rows: (NewLead & { displayId: string })[]): Promise<{ id: string; displayId: string | null }[]>;

  /**
   * Lot V: every open lead (not CONVERTED, not LOST) whose city is one of
   * these spellings, case-insensitively, set LOST in one transaction with a
   * STATUS_CHANGED activity each carrying `note`. Answers the ids closed;
   * a second call finds none. Lot X-B: `cityId` first — a row keyed to the
   * city is found whatever it was typed as; the spellings catch the rows
   * whose key is null.
   */
  closeOpenLeadsInCities(city: { cityId: string | null; spellings: string[] }, actorUserId: string | null, note: string): Promise<string[]>;

  /* ── LH1: scoring ──────────────────────────────────────────────── */

  /** The lead with its source and the intent-bearing activity since `since`. */
  findForScoring(leadId: string, since: Date): Promise<LeadForScoring | null>;
  /** Open leads' ids after `cursor` (by id), a page at a time — the nightly walk. */
  openLeadIdsAfter(cursor: string | null, take: number): Promise<string[]>;
  /** Live listings within the box around a point — the locality balance the fit signal reads. */
  countLiveListingsNear(point: { latitude: number; longitude: number }, radiusM: number): Promise<number>;
  /** The median daily rate of live listings within the box, or null with none — a publisher lead's value. */
  medianLiveRateNear(point: { latitude: number; longitude: number }, radiusM: number): Promise<string | null>;
  /** The average budget of campaigns paid in the city since `since`, or null — an advertiser lead's value. */
  averageCampaignBudget(cityId: string | null, since: Date): Promise<string | null>;
  /** Per source: leads created since `since`, and how many of them converted. */
  sourceStats(since: Date): Promise<SourceStats[]>;
  /* ── LH2: stages ───────────────────────────────────────────────── */

  /** Leads at any of these stages, oldest change first — the watch's page. */
  findAtStages(stages: readonly string[], take: number, cursor: string | null): Promise<Lead[]>;
  /** LOST leads whose recycle date has passed. */
  dueForRecycle(now: Date, take: number): Promise<Lead[]>;
  /** The account's first catch: a publisher's first live listing, an advertiser's first paid campaign. */
  accountActivation(account: { publisherId: string | null; advertiserId: string | null }): Promise<AccountActivation>;
  /** The account's repeat business: a publisher's bookings and whether a spot is still live; an advertiser's paid campaigns. */
  accountRetention(account: { publisherId: string | null; advertiserId: string | null }): Promise<AccountRetention>;
  /**
   * LH8 (D2): stamps the holder onto the account the lead became, only where
   * the account names no agent yet — the tier ladder's rung counts that
   * account from then on. Answers which side it stamped, or null when the
   * account already carried an agent (or does not exist).
   */
  attributeAccountToAgent(account: { publisherId: string | null; advertiserId: string | null }, agentId: string): Promise<'PUBLISHER' | 'ADVERTISER' | null>;
  /** LH8: the rewards recorded on a lead — LEAD_* incentives keyed on its account, plus the priority top-up keyed on the lead. */
  rewardsFor(lead: { id: string; convertedPublisherId: string | null; convertedAdvertiserId: string | null }): Promise<LeadReward[]>;
  /** The funnel's aggregates under a filter. */
  funnel(filter: FunnelFilter): Promise<FunnelRows>;

  /* ── LH3: feeds, inbound, referrals ────────────────────────────── */

  /** Leads already holding any of these provider keys. */
  findByExternalKeys(keys: string[]): Promise<{ id: string; externalKey: string | null }[]>;
  /** Leads created for the source since `since` — the daily quota's count. */
  countCreatedForSourceSince(sourceId: string, since: Date): Promise<number>;
  createFeedRun(data: NewFeedRun): Promise<LeadFeedRun>;
  updateFeedRun(id: string, patch: FeedRunPatch): Promise<FeedRunWithSource>;
  listFeedRuns(sourceId: string | null, take: number): Promise<FeedRunWithSource[]>;
  findFeedRun(id: string): Promise<FeedRunWithSource | null>;
  /**
   * ACTIVE agents of the side (a role on the user), with their tier, city
   * key and how many open leads they hold. Read here rather than through
   * `agents` because it is a narrow read for routing, not a decision.
   */
  candidateAgents(side: string, cityId: string | null): Promise<CandidateAgent[]>;
  /** The listing behind a SITE QR, narrowly, for the poster's inbound form. */
  findListingPoint(listingId: string): Promise<{ id: string; title: string; locality: string | null; city: string | null; cityId: string | null; latitude: number | null; longitude: number | null; publisherId: string | null } | null>;
  /** The agent profile behind an AGENT QR, narrowly. */
  findAgentBrief(agentId: string): Promise<{ id: string; userId: string; city: string | null; cityId: string | null; sides: string[] } | null>;
  findReferralLink(referrerKind: string, referrerId: string): Promise<ReferralLink | null>;
  findReferralLinkByCode(code: string): Promise<ReferralLink | null>;
  createReferralLink(data: { referrerKind: string; referrerId: string; code: string }): Promise<ReferralLink>;
  createReferral(data: { linkId: string; referrerKind: string; referrerId: string; leadId: string }): Promise<LeadReferral>;
  findReferralForLead(leadId: string): Promise<(LeadReferral & { link: ReferralLink }) | null>;
  listReferralsBy(referrerKind: string, referrerId: string): Promise<(LeadReferral & { lead: Lead })[]>;
  listReferrals(take: number): Promise<(LeadReferral & { lead: Lead })[]>;
  markReferralCredited(id: string, data: { creditAmount: string; creditedAt: Date; walletEntryId: string | null }): Promise<LeadReferral>;
  /** The label behind a referrer, for the desk's list — a business name and the account's mobile. */
  referrerLabel(referrerKind: string, referrerId: string): Promise<{ name: string; mobile: string | null } | null>;
  /** The party behind a sign-in — publisher first, then advertiser, then agent — for the referral doors. */
  partyOfUser(userId: string): Promise<{ kind: 'PUBLISHER' | 'ADVERTISER' | 'AGENT'; id: string } | null>;
  /** LH4: open leads of the side inside the box around a point — the capture's "same wall" check. */
  findOpenNear(point: { latitude: number; longitude: number }, radiusM: number, side: string): Promise<Lead[]>;

  /* ── LH5: the map, territories, zones, claims ──────────────────── */

  /** Open leads with a point inside the viewport, under the facets, hottest first. */
  findOpenInBBox(box: BBoxIn, facets: MapFacets, take: number): Promise<Lead[]>;
  /** Live listings' points inside the viewport — the supply half of the heat. */
  liveListingPoints(box: BBoxIn, take: number): Promise<{ latitude: number; longitude: number }[]>;
  /** Where demand landed since `since` — orders on listings inside the viewport, as their listing's point. */
  demandPoints(box: BBoxIn, since: Date, take: number): Promise<{ latitude: number; longitude: number }[]>;
  createTerritory(data: NewTerritory): Promise<Territory>;
  updateTerritory(id: string, patch: TerritoryPatch): Promise<Territory>;
  findTerritory(id: string): Promise<Territory | null>;
  listTerritories(filter: { activeOnly: boolean }): Promise<(Territory & { leadCount: number })[]>;
  /** Active territories of the side whose box holds the point; the service tests the ring. */
  territoriesCovering(point: { latitude: number; longitude: number }, side: string): Promise<Territory[]>;
  createZone(data: NewZone): Promise<PriorityZone>;
  updateZone(id: string, patch: ZonePatch): Promise<PriorityZone>;
  findZone(id: string): Promise<PriorityZone | null>;
  listZones(filter?: { activeAt?: Date }): Promise<PriorityZone[]>;
  addZoneSpend(id: string, amount: string): Promise<void>;
  /** Priority top-ups recorded since `since` — the platform-wide monthly cap's count. */
  priorityTopUpsSince(since: Date): Promise<number>;
  /** Whether a top-up was already recorded for the lead, under any zone — an activation is topped up once. */
  priorityTopUpPaid(leadId: string): Promise<boolean>;
  createClaim(data: { leadId: string; agentId: string; claimedAt: Date; expiresAt: Date }): Promise<LeadClaim>;
  /** Close every open claim on the lead with the reason. */
  closeOpenClaims(leadId: string, at: Date, reason: string): Promise<number>;
  /** Open claims whose hold passed. */
  claimsExpiredBefore(at: Date, take: number): Promise<LeadClaim[]>;
  /** Open claims lapsing inside the window — the warning. */
  claimsExpiringBetween(from: Date, to: Date, take: number): Promise<LeadClaim[]>;
  /** When this agent last let a claim on this lead lapse, or null. */
  lastLapsedClaim(leadId: string, agentId: string): Promise<Date | null>;
  /** Open leads the agent holds (assigned or claimed) — the cap's count. */
  countOpenFor(agentId: string): Promise<number>;

  /* ── LH6: the outreach hub's two reads off other tables ───────── */

  /** A comms template by key — the copy a sequence step or a canned opener renders. */
  findCommsTemplate(key: string): Promise<{ key: string; subject: string | null; emailBody: string | null; smsBody: string | null; pushBody: string | null; channels: string[] } | null>;
  /** D14: how many leads' first contact / engagement / conversion fell in the window, per channel. */
  attributionCounts(from: Date, to: Date, side?: string): Promise<{ channel: string; firstContact: number; engaged: number; converted: number }[]>;

  listSources(): Promise<LeadSource[]>;
  findSourceByKey(key: string): Promise<LeadSource | null>;
  createSource(data: { key: string; kind: string; label: string; quality?: number }): Promise<LeadSource>;
  updateSource(id: string, patch: { quality?: number; label?: string; isActive?: boolean; quotaPerDay?: number | null; termsAcceptedAt?: Date | null; config?: unknown }): Promise<LeadSource>;
}

export type AccountByPhone = { phoneNormalised: string; kind: 'PUBLISHER' | 'ADVERTISER'; id: string };

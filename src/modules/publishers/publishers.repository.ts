import type { AccountState, PartyAccountState, RosterStatus } from '../../shared/party-status';
import type { KycQueueState } from '../../shared/kyc-state';
import type { Provenance } from '../../shared/onboarding';
import type { Gender, KycEntityType, PartySizeBand } from '../../shared/database';
import type {
  KycStatus,
  ListingRead as Listing,
  ListingPhoto,
  Publisher,
  PublisherKyc,
  PublisherType,
} from '../../shared/database';
import type { MyListingsQuery, PublisherRosterQuery } from './publishers.schema';

/** E7-3: what another desk needs to name a publisher beside a user id. */
export type PartyLabelRow = { id: string; userId: string; displayId: string | null; name: string; kycStatus: KycStatus };

/** One of the publisher's own spots, as their list draws it. */
export type MyListing = Listing & {
  photos: ListingPhoto[];
  /** A live order is running on it right now — the frame's OCCUPIED chip. */
  occupied: boolean;
};

/** One page of that list, with a count per chip. */
export type MyListingsPage = {
  items: MyListing[];
  total: number;
  counts: Record<string, number>;
};

/** QR-13: the person behind a desk-opened account, written to their User row. */
export type PersonFields = {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: Date;
  gender?: Gender;
};

/** QR-13: what `ensureAccount` needs to open, or adopt, the User a publisher signs in as. */
export type AccountInput = PersonFields & {
  mobile: string;
  /** Issued by `identifiers`; used only when a row has to be created. */
  displayId: string;
  name: string;
  email?: string;
};

export type NewPublisher = Partial<Provenance> & {
  /** QR-13: the account the desk opened for them — set, the sign-in lands on the publisher's home. */
  userId?: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
  /** Onboarding addresses (1 Oct 2026): the address's PIN code. */
  postalCode?: string | null;
  gstin?: string;
  contactName?: string;
  contactMobile?: string;
  contactEmail?: string;
  /** QR-13: a desk onboarding with every basic in place opens complete. */
  onboardingStatus?: 'PENDING_ONBOARDING' | 'ONBOARDING_COMPLETE';
  activatedAt?: Date;
  /**
   * Who brought this publisher in. Null when ADX opened the account itself
   * (Q29): attribution is a fact about an agent's book and an admin is not an
   * agent, so an admin-created publisher is attributed to nobody unless the
   * admin names the agent it belongs to.
   */
  agentId: string | null;
  /** Issued by `identifiers`; the service allocates it, never the caller. */
  displayId?: string;
  name: string;
  mobile: string;
  email?: string;
  type?: PublisherType;
  /** Chosen at the desk beside the account type; null until asked otherwise. */
  entityType?: KycEntityType;
  city?: string;
  /** Lot X-B: the `City` row `city` denotes, stamped by the service through `pricing.withCityKey`; null for a typed town. */
  cityId?: string | null;
  state?: string;
};

export type PublisherPatch = Partial<{
  name: string;
  email: string;
  type: PublisherType;
  address: string;
  /** QR-5: where the address is, when it came off the map or a search. */
  latitude: number | null;
  longitude: number | null;
  /** Onboarding addresses (1 Oct 2026): the address's PIN code; null clears. */
  postalCode: string | null;
  city: string;
  /** Lot X-B: rides with `city` — the service stamps it, a caller never sends it. */
  cityId: string | null;
  state: string;
  gstin: string;
  contactName: string;
  contactMobile: string;
  contactEmail: string;
  /** AG-5: the band ops sets — the withdrawal ladder and, since AG-5, the grade of agent the publisher's work is routed to. */
  sizeBand: PartySizeBand;
  /** Phase D: the legal form the KYC verifies; null clears it back to what `type` says. */
  entityType: KycEntityType | null;
}>;

export type KycDocuments = Partial<{
  aadhaarFrontUrl: string;
  aadhaarBackUrl: string;
  panFrontUrl: string;
  panBackUrl: string;
  gstUrl: string;
  addressProofUrl: string;
  bankStatement: string;
  govIdType: string;
  govIdFrontUrl: string;
  govIdBackUrl: string;
  panNumber: string;
  panSignatureUrl: string;
  addressProofType: string;
  selfieUrl: string;
  businessRegCertUrl: string;
  directorIdUrl: string;
  businessAddressProofUrl: string;
  adAuthLetterUrl: string;
  ngoRegCertUrl: string;
  ngoAddressProofUrl: string;
  ngoTaxExemptionCertUrl: string;
  ngoOperationalOverviewUrl: string;
}>;

/** P-B: the agent who brought a publisher in, by name — the party page's "Onboarded by". */
export type PublisherAgentLabel = { id: string; displayId: string | null; name: string | null };

/** The agent as the include joins it (the KYC queue's shape) → the label the reads answer. Null stays null. */
export const toAgentLabel = (agent: { id: string; displayId: string | null; user: { name: string | null } | null } | null | undefined): PublisherAgentLabel | null =>
  agent ? { id: agent.id, displayId: agent.displayId, name: agent.user?.name ?? null } : null;

/**
 * Publisher with the joins the agent-facing endpoints return. E6: each
 * listing carries `_count.orders` (non-terminal) and `user` says whether the
 * account is closed. P-B: `agent` is the onboarding agent by name, null when
 * nobody brought them (absent only on the create/update echoes, which do not
 * join it).
 */
export type PublisherWithDetail = Publisher & {
  kyc: PublisherKyc | null;
  listings: (unknown & { _count?: { orders: number } })[];
  user?: { closedAt: Date | null; closeReason: string | null; isActive?: boolean } | null;
  agent?: PublisherAgentLabel | null;
};

/**
 * 29 Sep 2026 (the party rosters, made uniform): one row of the console's
 * roster — the publisher's own columns, the six KYC columns the state is
 * derived from (never the document links), the spots counted rather than
 * joined, whether the account is closed and who brought them.
 */
export type PublisherRosterRow = Publisher & {
  kyc: { id: string; status: KycStatus; submittedAt: Date | null; requestedAt: Date | null; requestedChannel: string | null; method: string | null } | null;
  listingCount: number;
  user: { closedAt: Date | null; closeReason: string | null; displayId: string | null; isActive: boolean } | null;
  agent: PublisherAgentLabel | null;
};

/** The roster's cuts as the repository takes them — the query, with the city's key resolved beside its spelling. */
export type PublisherRosterFilter = PublisherRosterQuery & { cityId?: string | null };

/** D7: a queue row — the publisher, its KYC row, and who brought them (or nobody). */
export type KycQueueRow = Publisher & {
  kyc: PublisherKyc | null;
  /** Account lifecycle: the account behind the party, for the row's `accountState`. */
  user: { isActive: boolean; closedAt: Date | null } | null;
  agent: { id: string; displayId: string | null; user: { name: string | null } } | null;
};

export type KycQueueFilter = {
  /** The legacy facet — N3-B: an alias of `state` (each record status names the state of the same word). */
  status?: KycStatus;
  /** N3-B: the party's state (`shared/kyc-state`) — the queue lists every publisher, in one of six. */
  state?: KycQueueState;
  /** N3-B: the publisher's name, display id, mobile, email or contact mobile contains. */
  q?: string;
  /** Only the self-onboarded: nobody from ADX has met them. */
  unassigned?: boolean;
  /** Lot D (Q119): the admin working the case, or `null` for nobody. */
  assignedToId?: string | null;
  /** Lot D (Q129): the Digio facets. `stuck` needs `stuckBefore`. */
  method?: 'MANUAL' | 'DIGIO';
  digioStatus?: 'pending' | 'stuck';
  stuckBefore?: Date;
  /** Absent: breaches of the review SLA first. See listKycQueue. */
  sort?: 'oldest' | 'newest';
  /** Lot G (Q127/142): only the escalated (true) or the not (false). */
  escalated?: boolean;
  /**
   * Lot N: only the requested-and-not-yet-submitted (true) — `requestedAt`
   * set, `submittedAt` null; these are otherwise outside the queue, which
   * lists submitted rows — or none of them (false).
   */
  requested?: boolean;
  /**
   * Account lifecycle (2 Oct 2026): the queue lists working accounts only —
   * a suspended, deactivated or closed publisher is left out, and every count
   * with it — unless the desk asks for the inactive (`?include=inactive`).
   */
  includeInactive?: boolean;
};

/** Lot D (Q42): what a decision writes beside the status. */
export type KycReviewStamp = { reviewedById: string; reviewNote?: string | null };

/**
 * Lot N: who recorded the documents and how — the party (SELF), their agent
 * (AGENT), or an admin at the desk (DESK, which also fixes the method to
 * MANUAL). Digio's completion stamps DIGIO by itself.
 */
export type KycRecordStamp = { recordedById: string; recordedVia: 'SELF' | 'AGENT' | 'DESK'; method?: 'MANUAL' };

/** Lot N: the desk asked for this KYC — who, when, over which channel. */
export type KycRequestStamp = { requestedById: string; requestedChannel: 'DIGIO' | 'MANUAL'; at: Date };

/** A queue row with the SLA arithmetic Q31's `kyc.reviewSlaHours` decides, (E10-1) the assignee by name, (G11-1) the escalation's two people by name, (Lot N) who requested and who recorded, and (N3-B) the party's `state` and `kycId`. */
export type KycQueueRowWithSla = KycQueueRow & {
  /** N3-B: derived from the record and the mirror — the publisher is in exactly one of six states. */
  state: KycQueueState;
  kycId: string | null;
  /** Account lifecycle: ACTIVE, SUSPENDED, DEACTIVATED or CLOSED (`shared/party-status`). */
  accountState: AccountState;
  ageHours: number | null;
  slaBreached: boolean;
  assignedTo: { id: string; name: string | null } | null;
  escalatedTo: { id: string; name: string | null } | null;
  escalatedBy: { id: string; name: string | null } | null;
  requestedBy: { id: string; name: string | null } | null;
  recordedBy: { id: string; name: string | null } | null;
};

/** One spot on the home's map, with the one fact the gauge is computed from. */
export type DashboardListing = {
  id: string;
  title: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
  /** A booking the publisher accepted whose flight covers `now`. */
  occupied: boolean;
  /**
   * That booking, for the map's Location Card (DR 02·03 3949:4333): who,
   * for how much, when, where it stands, and the agent on it. Null when the
   * spot is free.
   */
  booking: {
    orderId: string;
    advertiserName: string | null;
    campaignName: string | null;
    amount: string | null;
    startDate: Date | null;
    endDate: Date | null;
    status: string;
    agent: { id: string; name: string | null; phone: string | null } | null;
  } | null;
};

/**
 * Orders that hold a spot: accepted by the publisher and not stopped. A
 * completed install still occupies its spot until the flight ends.
 */
export const OCCUPYING_ORDER_STATUSES = [
  'PENDING_PRINT',
  'SELF_INSTALL',
  'PENDING_AGENT',
  'AGENT_REJECTED',
  'SLOT_PROPOSED',
  'SLOT_CONFIRMED',
  'IN_PROGRESS',
  'PENDING_OTP',
  'PENDING_APPROVAL',
  'COMPLETED',
] as const;

/** 26 Sep 2026: what a visitor may know of a publisher — no contact data, no KYC detail. */
export type PublicPublisherRow = { id: string; name: string; kycStatus: string; avatarUrl: string | null; liveListings: number };

export interface PublishersRepository {
  /** 26 Sep 2026: one publisher's public card, by id or display id; null when there is none, or it is closed to new business. */
  findPublicCard(idOrDisplayId: string): Promise<PublicPublisherRow | null>;
  /** D7: the queue, oldest submission first — N3-B: every publisher not yet verified plus every publisher with a record, awaiting-documents rows by when the publisher arrived. */
  findKycQueue(filter: KycQueueFilter): Promise<KycQueueRow[]>;
  /** Lot N: the same rows, counted — the `requested` chip is read with that facet forced on. */
  countKycQueue(filter: KycQueueFilter): Promise<number>;
  /** Lot N: the desk asked for this KYC — an upsert on the row; the status is untouched (REQUESTED is derived). */
  requestKyc(publisherId: string, stamp: KycRequestStamp): Promise<PublisherKyc>;
  /** D7: one case for the workbench. */
  findKycDetail(publisherId: string): Promise<KycQueueRow | null>;

  create(data: NewPublisher): Promise<PublisherWithDetail>;
  findForAgent(agentId: string, category?: string): Promise<PublisherWithDetail[]>;
  /** Every publisher, for ADX's own roster. E10-1: `q` is name / display id / city / mobile contains. */
  /** Account lifecycle: `status` absent or ALL is everyone. */
  findAllForAdmin(category?: string, q?: string, status?: RosterStatus): Promise<PublisherWithDetail[]>;
  /**
   * E10-1: the roster on the list contract — the chips are `kycStatus`, counted with the KYC tab removed.
   * 29 Sep 2026: cut by KYC state, type and city beside the door, and the spots counted, not joined.
   */
  /** Account lifecycle: `statusCounts` — publishers per account state over the cuts, with the status facet removed. */
  findRosterPage(
    query: PublisherRosterFilter,
  ): Promise<{ items: PublisherRosterRow[]; total: number; counts: Record<string, number>; statusCounts: Record<PartyAccountState, number> }>;
  findById(publisherId: string): Promise<PublisherWithDetail | null>;
  /** Without joins — for ownership and state checks. */
  findSummaryById(publisherId: string): Promise<Publisher | null>;
  findByUserId(userId: string): Promise<Publisher | null>;
  /** BD-1: everything the availability grid draws over a window — the spots, the orders holding a slot, the live reservations, the blocks. */
  findAvailability(publisherId: string, window: { from: Date; to: Date }): Promise<AvailabilityRows>;
  /** E7-3: the label per login, for the desks that name the party behind a user. */
  findLabelsByUserIds(userIds: string[]): Promise<PartyLabelRow[]>;
  /** The publisher's own spots, paged, with the three shelf counts. */
  findMyListings(publisherId: string, query: MyListingsQuery): Promise<MyListingsPage>;
  /** QR-22: when the publisher last accepted the platform terms; null until they have. */
  findPlatformAgreementAcceptedAt(publisherId: string): Promise<Date | null>;
  findByUserIdWithKyc(
    userId: string,
  ): Promise<(Publisher & { kyc: PublisherKyc | null; user: { dateOfBirth: Date | null; gender: string | null; avatarUrl: string | null } | null }) | null>;
  /**
   * DR 01's publisher home: every spot with whether a booking occupies it at
   * `now`, and how many bookings are waiting for the publisher's answer.
   */
  findDashboard(publisherId: string, now: Date): Promise<{ listings: DashboardListing[]; awaiting: number }>;
  update(publisherId: string, data: PublisherPatch): Promise<PublisherWithDetail>;

  /** Upserts the KYC row and mirrors the status onto the publisher, atomically. Lot N: `stamp` says who recorded it and how. */
  submitKyc(publisherId: string, docs: KycDocuments, stamp?: KycRecordStamp): Promise<PublisherKyc>;
  /** Lot F: pins the manifest version once — a no-op when the row already has one. */
  pinKycManifestVersion(publisherId: string, version: number): Promise<unknown>;
  reviewKyc(
    publisherId: string,
    status: KycStatus,
    rejectionReason?: string,
    stamp?: KycReviewStamp,
  ): Promise<PublisherKyc>;
  /** Lot D (Q42): NEEDS_INFO on the row and the mirror, atomically; the files stay. */
  requestKycReupload(publisherId: string, stamp: KycReviewStamp): Promise<PublisherKyc>;
  /** Lot D (Q119): who is working the cases, or nobody. Returns how many rows moved. */
  assignKyc(publisherIds: string[], adminUserId: string | null, at: Date): Promise<number>;
  /** Lot D (Q127): Digio-verified rows still holding images, verified before `cutoff`. */
  findPurgeableKyc(cutoff: Date, limit: number): Promise<PublisherKyc[]>;
  /** Nulls the image columns, masks the PAN, trims the payload, stamps `imagesPurgedAt`. */
  purgeKycImages(kycId: string, data: { panNumber: string | null; digioPayload: unknown }): Promise<PublisherKyc>;
  /** The KYC row behind a user's publisher, for the manifest. */
  findKycByUserId(userId: string): Promise<PublisherKyc | null>;

  // ── Self-registration and onboarding ──
  /** A row by its number, whoever holds it — an agent-opened account has no user yet. */
  findByMobile(mobile: string): Promise<Publisher | null>;
  /**
   * QR-13: the User a desk-opened publisher signs in as. An account already
   * on the number (a person who is an advertiser, say) is adopted: the
   * PUBLISHER role is granted and the person's fields filled where empty;
   * otherwise one is created with the role. Answers the id and whether it
   * was made.
   */
  ensureAccount(input: AccountInput): Promise<{ id: string; created: boolean }>;
  /** QR-13: the row with the person's date of birth beside it, for the settle rule. */
  findByIdWithUser(publisherId: string): Promise<(Publisher & { user: { dateOfBirth: Date | null } | null }) | null>;
  /** QR-13: the person's fields, from the desk. */
  updateAccount(userId: string, patch: PersonFields & { name?: string; email?: string }): Promise<void>;
  /** QR-14: the names behind `onboardedById`, for the detail and the roster. */
  userLabels(userIds: readonly string[]): Promise<Map<string, string | null>>;
  /** Links an agent-opened row to the person who has now signed in with its number. */
  attachUser(publisherId: string, userId: string): Promise<Publisher>;
  createSelfRegistered(data: {
    userId: string;
    name: string;
    mobile: string;
    email?: string;
    type?: PublisherType;
    /** Issued by `identifiers`; allocated in the service, never by the caller. */
    displayId?: string;
  }): Promise<Publisher>;
  /** The person's display name (an individual's, when the account has none) and email, given at registration. */
  setUserProfile(userId: string, name: string | undefined, email?: string): Promise<unknown>;
  /** QR-5: the person's date of birth and gender, collected with the publisher's details. */
  setUserDetails(userId: string, data: { dateOfBirth?: Date; gender?: string }): Promise<unknown>;
  findUserMobile(
    userId: string,
  ): Promise<{ mobile: string; name: string | null; avatarUrl: string | null; email?: string | null } | null>;
  claim(publisherId: string, agentId: string): Promise<unknown>;
  /** Publisher state only — expiring its QR codes is the qr module's job. */
  resetOnboardingState(publisherId: string): Promise<unknown>;
  completeOnboarding(publisherId: string): Promise<unknown>;
  /** K-B1: `{ id, label, displayId }` per id in one query — the QR desk names the code's subject with it. */
  findLabelsByIds(ids: string[]): Promise<{ id: string; label: string; displayId: string | null }[]>;
}

/** BD-1: the rows behind `availability.service#shapeAvailability`. */
export type AvailabilityRows = {
  listings: { id: string; displayId: string | null; title: string; category: string; city: string | null; slotsTotal: number; status: string }[];
  orders: {
    id: string;
    listingId: string;
    status: string;
    startDate: Date | null;
    endDate: Date | null;
    campaignName: string | null;
    campaignSpot: { campaign: { name: string } } | null;
    advertiser: { name: string | null; advertiserProfile: { name: string; companyName: string | null } | null };
  }[];
  reservations: {
    listingId: string;
    startDate: Date | null;
    endDate: Date | null;
    campaign: { name: string; advertiser: { name: string; companyName: string | null } };
  }[];
  blocks: { id: string; listingId: string; from: Date; to: Date; reason: string | null }[];
};

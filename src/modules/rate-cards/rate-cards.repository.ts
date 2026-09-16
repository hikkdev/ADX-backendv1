import type {
  Prisma,
  PriceApprovalSource,
  PriceApprovalStatus,
  RateCardStatus,
  RateGrade,
} from '../../shared/database';

/**
 * What the rate-card module needs from storage.
 */

export type RateCardRow = {
  id: string;
  name: string;
  version: number;
  status: RateCardStatus;
  cityId: string | null;
  cityName?: string | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  floorPct: Prisma.Decimal;
  /** Lot E (Q97): days a listing left under a revised floor has before a rejected case unpublishes it. */
  graceDays: number;
  roundingRupees: number;
  notes: string | null;
  approvedById: string | null;
  approvedAt: Date | null;
  submittedById: string | null;
  submittedAt: Date | null;
  supersedesId: string | null;
  createdAt: Date;
  /** Filled by the detail read, absent from the list. */
  entries?: RateCardEntryRow[];
  /** Listings whose media type and grade this card prices. */
  sitesPriced?: number;
};

export type RateCardEntryRow = {
  id: string;
  mediaTypeId: string;
  mediaTypeName?: string;
  grade: RateGrade;
  ratePerDay: Prisma.Decimal | null;
};

export type NewRateCard = {
  name: string;
  cityId?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  floorPct?: Prisma.Decimal;
  graceDays?: number;
  roundingRupees?: number;
  notes?: string | null;
  version?: number;
  supersedesId?: string | null;
};

export type RateCardPatch = Partial<Omit<NewRateCard, 'version' | 'supersedesId'>>;

export type EntryInput = {
  mediaTypeId: string;
  grade: RateGrade;
  ratePerDay: Prisma.Decimal | null;
};

export type PriceApprovalRow = {
  id: string;
  listingId: string;
  listingTitle?: string;
  rateCardId: string | null;
  status: PriceApprovalStatus;
  /** Lot E (Q67/Q97): who raised it — the publisher publishing under the floor, or a revised card. */
  source: PriceApprovalSource;
  /** CARD_REVISION only: the publisher's time to raise the rate before a rejection unpublishes. */
  graceUntil: Date | null;
  requestedRatePerDay: Prisma.Decimal;
  cardRatePerDay: Prisma.Decimal | null;
  floorRatePerDay: Prisma.Decimal | null;
  reason: string | null;
  requestedById: string;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  /** E7-2 (Lot E addendum 2): a rejection a running order stopped — the column, not a note prefix. */
  heldByRunningOrder: boolean;
  createdAt: Date;
};

export type NewPriceApproval = {
  listingId: string;
  rateCardId: string | null;
  requestedRatePerDay: Prisma.Decimal;
  cardRatePerDay: Prisma.Decimal | null;
  floorRatePerDay: Prisma.Decimal | null;
  reason?: string | null;
  requestedById: string;
  /** Defaults to PUBLISH_REQUEST. */
  source?: PriceApprovalSource;
  graceUntil?: Date | null;
};

/** E10-2: the approvals desk's filters — `status` as before, `source` and `listingId` beside it. */
export type ApprovalFilter = {
  status?: PriceApprovalStatus | undefined;
  source?: PriceApprovalSource | undefined;
  listingId?: string | undefined;
};

export type ApprovalPage = {
  items: PriceApprovalRow[];
  total: number;
  counts: Record<string, number>;
};

/** Everything the gate needs about a listing, in one read. */
export type GateSubject = {
  id: string;
  status: string;
  mediaTypeId: string | null;
  cityId: string | null;
  city: string | null;
  rateGrade: RateGrade | null;
  ratePerDay: Prisma.Decimal | null;
};

/**
 * E11 verify: whose listing the gate is being asked about — the publisher and
 * the agent who onboarded them, for the access check that guards the gate read
 * and the approval request. Null publisher: scraped, claimed by nobody yet.
 */
export type ListingOwner = {
  id: string;
  publisher: { id: string; userId: string | null; agentId: string | null } | null;
};

/** Lot E (Q97): a gate subject with who to tell when a card moves under it. */
export type ImpactSubject = GateSubject & {
  title: string;
  publisherId: string | null;
  publisherUserId: string | null;
};

export interface RateCardsRepository {
  listCards(status?: RateCardStatus): Promise<RateCardRow[]>;
  findCard(id: string): Promise<RateCardRow | null>;
  createCard(data: NewRateCard): Promise<RateCardRow>;
  updateCard(id: string, patch: RateCardPatch): Promise<RateCardRow>;
  setStatus(
    id: string,
    status: RateCardStatus,
    stamps?: { submittedById?: string; approvedById?: string }
  ): Promise<RateCardRow>;
  deleteCard(id: string): Promise<void>;

  replaceEntries(rateCardId: string, entries: EntryInput[]): Promise<void>;
  highestVersion(name: string): Promise<number>;
  /** Every ACTIVE card this one replaces, to be superseded in the same breath. */
  activeCardsOverlapping(cityId: string | null): Promise<RateCardRow[]>;

  /**
   * The card in force for a media type in a city today, city-scoped beating
   * national. Returns the card and the one entry that priced it.
   */
  effectiveEntry(
    mediaTypeId: string,
    grade: RateGrade,
    cityId: string | null,
    on: Date
  ): Promise<{ card: RateCardRow; entry: RateCardEntryRow } | null>;

  findGateSubject(listingId: string): Promise<GateSubject | null>;
  /** E11 verify: the listing's publisher, for the access check on the gate read and the approval request. */
  findListingOwner(listingId: string): Promise<ListingOwner | null>;
  countSitesPriced(rateCardId: string): Promise<number>;
  /**
   * Lot E (Q97): every ACTIVE listing whose media type this card prices, in
   * the card's city — or anywhere, for a national card. The grade is left to
   * the caller, which reads the card's own grid.
   */
  activeListingsPricedBy(rateCardId: string): Promise<ImpactSubject[]>;
  /** Whether an order on this listing is still running — anything short of COMPLETED or CANCELLED. */
  hasNonTerminalOrder(listingId: string): Promise<boolean>;

  listApprovals(filter?: ApprovalFilter): Promise<PriceApprovalRow[]>;
  /** E10-2: the list contract over the same filter — a page, the total, and the status histogram with the status facet removed. */
  listApprovalsPage(filter: ApprovalFilter, page: { page: number; pageSize: number }): Promise<ApprovalPage>;
  findApproval(id: string): Promise<PriceApprovalRow | null>;
  findLiveApprovalForListing(listingId: string): Promise<PriceApprovalRow | null>;
  createApproval(data: NewPriceApproval): Promise<PriceApprovalRow>;
  decideApproval(
    id: string,
    status: PriceApprovalStatus,
    decidedById: string,
    note?: string
  ): Promise<PriceApprovalRow>;
  /** Lot E (Q97): sets `heldByRunningOrder`, writes the note and leaves the case PENDING — a rejection held by a running order. */
  holdApproval(id: string, note: string): Promise<PriceApprovalRow>;
}

import type { SlotHoldOptions, SlotWindow } from '../listings';
import type { CheckIn, ListingCategory, Order, OrderAgentAssignment, OrderRead, OrderRiskBand, OrderRiskReview, OrderStatus, Prisma } from '../../shared/database';
import type { AdminOrdersQuery, CalendarQuery, MyOrdersQuery, RiskReviewQuery } from './orders.schema';

export type NewOrder = {
  advertiserId: string;
  listingId: string;
  /** BK-1: BKG-DDMM-YYNN, minted by placement. */
  displayId?: string;
  campaignName?: string;
  designUrl?: string;
  budget?: number;
  startDate?: Date;
  endDate?: Date;
  notes?: string;
};

/**
 * Lot G (Q116/136): what placement takes — the row plus two hints that never
 * reach it: the campaign the order is raised for, whose own reservation on
 * the spot must not count against the spot's slots, and (G10) how many
 * slots the order takes — the campaign spot's `quantity`, one for an order
 * placed on its own — which the count refuses when fewer are left.
 */
export type PlacementInput = NewOrder & { forCampaignId?: string; quantity?: number };

/** G11-1: which party's open orders `countOpenExposure` counts. */
export type OpenOrderScope = { publisherId: string } | { advertiserUserId: string } | { agentId: string };

/** Order joined to its listing and that listing's publisher. */
export type OrderWithPublisher = OrderRead & {
  listing: {
    id: string;
    title: string;
    latitude: number | null;
    longitude: number | null;
    qrToken: string | null;
    agentCanInstall: boolean;
    /*
     * `address`, `city` and `state` ride along because accepting a booking
     * needs somewhere to send the agent, and that is the publisher's own
     * address rather than anything on the order.
     */
    publisher: {
      id: string;
      userId: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
    } | null;
  };
};

/**
 * Lot G (Q114): one listing of the booking calendar — the spot and the
 * orders overlapping the window on it (the slot-holding ones: nothing
 * cancelled, refused or drafted). `campaignSpot` reaches the campaign the
 * order was raised from, null for a direct booking.
 */
export type CalendarListing = {
  id: string;
  displayId: string | null;
  title: string;
  city: string | null;
  category: ListingCategory;
  slotsTotal: number;
  orders: {
    id: string;
    status: OrderStatus;
    campaignName: string | null;
    startDate: Date | null;
    endDate: Date | null;
    slotTime: Date | null;
    campaignSpot: { campaign: { id: string; reference: string; name: string } } | null;
  }[];
};

/**
 * PB-1 (2 Oct 2026): the login that placed an order, as the admin board reads
 * it — the person's names and ADX id, and the advertiser profile (the
 * business) that login holds, null when it holds none.
 */
export type OrderPlacerRow = {
  id: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  displayId: string | null;
  advertiserProfile: { id: string; name: string; displayId: string | null } | null;
};

/** One page of the DR 10 order board: the rows, the total, and the chip counts. */
export type AdminOrdersPage = { items: (OrderRead & { advertiser?: OrderPlacerRow | null })[]; total: number; counts: Record<string, number> };
/**
 * A row of a persona's own list, with the accepted offer's quote on it
 * (Lot B, Q102) — null until an agent has accepted.
 */
export type MyOrderRow = OrderRead & { quotedFee: Prisma.Decimal | null };
/** One page of a persona's own orders — same shape, three different joins. */
export type MyOrdersPage = { items: MyOrderRow[]; total: number; counts: Record<string, number> };

export type VerificationPatch = Partial<{
  wideAngleUrl: string | undefined;
  closeUpUrl: string | undefined;
  landmarkUrl: string;
  /**
   * Set when the agent scans the spot's own code at check-in.
   *
   * The submit gate reads this and nothing wrote it, so the CHECK_IN
   * requirement could never be satisfied — which meant `canSubmit` was false
   * for every order that ever existed and SUBMIT INSTALLATION always came back
   * EVIDENCE_INCOMPLETE. The check-in recorded a CheckIn row and stopped there.
   */
  qrScanned: boolean;
  /** Why an agent refused the site. Used to be thrown away with the photos. */
  notes: string;
  /** Set when the submit gate passes, which is what makes A8 reachable. */
  checklistPassed: boolean;
  verifiedAt: Date;
}>;

/**
 * Lot D (Q105): an order accepted for the publisher at placement. Both
 * accept stamps carry the same instant, the publisher timer is left unset,
 * and the meeting place is the one the accept screen would have filled.
 */
export type AutoAccept = { at: Date; meetingPlace: string };

/**
 * G10: what placement may do while it holds the listing's lock — count the
 * slots held over a window and insert the order — both on the transaction
 * that took the lock, so the count and the insert are one act.
 */
export interface PlacementLock {
  /** The slots held on the locked listing over the window, quantities summed, read inside the transaction. */
  slotsHeld(window: SlotWindow, options?: SlotHoldOptions): Promise<number>;
  /** The insert, inside the same transaction; `accepted` as `create` takes it. */
  create(data: NewOrder, accepted?: AutoAccept): Promise<OrderRead>;
}

/**
 * Order fraud screening (2 Oct 2026): the order as the screening and the
 * review desk read it — the facts the order signals need and every risk
 * and hold column. ADMIN and the screening only; never a party's answer.
 */
export type OrderRiskState = {
  id: string;
  displayId: string | null;
  status: OrderStatus;
  /** The placing login (`Order.advertiserId` is a User id). */
  advertiserId: string;
  listingId: string;
  agentId: string | null;
  budget: number | null;
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  riskScore: Prisma.Decimal | null;
  riskSignals: Prisma.JsonValue | null;
  riskBand: OrderRiskBand | null;
  riskScoredAt: Date | null;
  riskReviewStatus: OrderRiskReview | null;
  riskReviewedById: string | null;
  riskReviewedAt: Date | null;
  riskReviewNote: string | null;
  riskClearedSignalKeys: string[];
  heldAt: Date | null;
  heldById: string | null;
  holdReason: string | null;
  fraudCaseId: string | null;
  /** The campaign spot the order was raised from; null for a direct booking. */
  campaignSpot: { campaignId: string } | null;
};

/** What the screening and the desk write on an order — the risk and hold columns only. */
export type OrderRiskPatch = Partial<{
  riskScore: string | null;
  riskSignals: Prisma.InputJsonValue | null;
  riskBand: OrderRiskBand | null;
  riskScoredAt: Date | null;
  riskReviewStatus: OrderRiskReview | null;
  riskReviewedById: string | null;
  riskReviewedAt: Date | null;
  riskReviewNote: string | null;
  riskClearedSignalKeys: string[];
  heldAt: Date | null;
  heldById: string | null;
  holdReason: string | null;
  fraudCaseId: string | null;
}>;

/** One row of the fraud review queue: the console board's row (with the placing login) plus every risk column. */
export type RiskReviewRow = OrderRead & {
  advertiser?: OrderPlacerRow | null;
} & Pick<OrderRiskState, 'riskScore' | 'riskSignals' | 'riskBand' | 'riskScoredAt' | 'riskReviewStatus' | 'riskReviewedById' | 'riskReviewedAt' | 'riskReviewNote' | 'riskClearedSignalKeys' | 'heldAt' | 'heldById' | 'holdReason' | 'fraudCaseId'>;

export type RiskReviewPage = { items: RiskReviewRow[]; total: number; counts: Record<string, number> };

export interface OrdersRepository {
  /** With `accepted`, the row is born PENDING_PRINT rather than PENDING_PUBLISHER. */
  create(data: NewOrder, accepted?: AutoAccept): Promise<OrderRead>;
  /**
   * G10 (the Lot G verifier's first major on slots): runs `run` inside one
   * transaction whose first statement is a per-listing advisory lock —
   * `pg_advisory_xact_lock(hashtext(listingId))`, released with the
   * transaction — so two placements on the same listing queue at the lock
   * and the second counts the first's row. A throw inside rolls it back.
   */
  placeUnderListingLock<T>(listingId: string, run: (locked: PlacementLock) => Promise<T>): Promise<T>;
  findById(orderId: string): Promise<OrderRead | null>;
  /** Just the fields other modules need to reason about an order. */
  findSummary(
    orderId: string,
  ): Promise<{ id: string; status: string; agentId: string | null; listingId: string } | null>;
  findWithPublisher(orderId: string): Promise<OrderWithPublisher | null>;
  /** The full aggregate the order detail endpoint returns. */
  findDetail(orderId: string): Promise<unknown | null>;
  /**
   * 2 Oct 2026: the order WITH its completion code — the hash and the plain
   * code the global omit keeps off every other read. For the code check and
   * for support's read-back on the admin detail; never answered raw.
   */
  findWithCompletionCode(orderId: string): Promise<(OrderRead & Pick<Order, 'completionOtp' | 'completionOtpPlain'>) | null>;
  update(orderId: string, data: Record<string, unknown>): Promise<OrderRead>;

  /* ── Evidence ──────────────────────────────────────────────────
   *
   * Photos are a list rather than three columns because the frames name four
   * separate proofs and the old shape kept two of them. */
  addPhotos(
    orderId: string,
    kind: 'PICKUP' | 'CONDITION' | 'INSTALLATION' | 'REJECTION',
    photos: { url: string; label?: string | null; latitude?: number | null; longitude?: number | null }[],
    uploadedByUserId?: string | null
  ): Promise<number>;
  countPhotos(orderId: string): Promise<{ kind: string; count: number }[]>;
  listPhotos(orderId: string): Promise<
    {
      id: string;
      kind: string;
      label: string | null;
      url: string;
      latitude: number | null;
      longitude: number | null;
      capturedAt: Date;
    }[]
  >;

  findCompletedExpiredForListing(listingId: string): Promise<OrderRead | null>;
  /* ── Lot G (Q114): the booking calendar, listings first ─────────────
   * A page of ACTIVE listings in the filter, each with the orders that hold
   * a slot on it over the window — so a spot with nothing booked is a row. */
  findCalendar(query: CalendarQuery): Promise<{ items: CalendarListing[]; total: number }>;
  /** The chips: ACTIVE listings per category over the filter, the category facet removed by the caller. */
  countCalendarByCategory(query: CalendarQuery): Promise<Record<string, number>>;
  /**
   * Every order on these spots that has not finished or been cancelled — what
   * Lot A's STOP_OPEN_WORK has to stop. Ids and the campaign key only: the
   * caller cancels each through the ordinary cancel path.
   */
  findOpenForListings(
    listingIds: string[],
  ): Promise<{ id: string; listingId: string; advertiserId: string; status: string }[]>;
  /** Orders whose publisher-response timer lapsed inside a given window. */
  findPublisherTimerExpired(windowStart: Date, now: Date): Promise<{ id: string }[]>;
  /** Offers still PENDING_AGENT whose agent window closed in [windowStart, now). */
  findAgentTimerExpired(windowStart: Date, now: Date): Promise<{ id: string; agentId: string | null }[]>;
  /**
   * When agents are already due at this publisher's spots, in [from, to) —
   * the bands the slot sheet must not offer twice.
   */
  findConfirmedSlotsForPublisher(publisherId: string, from: Date, to: Date): Promise<Date[]>;

  findForAdvertiser(advertiserId: string, query: MyOrdersQuery): Promise<MyOrdersPage>;
  findForPublisherUser(publisherUserId: string, query: MyOrdersQuery): Promise<MyOrdersPage>;
  findForAgent(agentProfileId: string, query: MyOrdersQuery): Promise<MyOrdersPage>;
  /**
   * Just the ids of the jobs an agent is holding in the given statuses.
   *
   * Narrow on purpose: `order-milestones` asks this to decide whether a
   * milestone plan is owed, and has no business reading a whole order.
   */
  findAgentOrderIdsInStatuses(
    agentProfileId: string,
    statuses: string[],
  ): Promise<{ id: string }[]>;
  findAll(query: AdminOrdersQuery): Promise<AdminOrdersPage>;
  /** PB-1: who placed an order — the admin detail's "Placed by", read beside the aggregate so no persona read gains it. */
  findPlacer(userId: string): Promise<OrderPlacerRow | null>;
  findAgentLocation(
    orderId: string,
  ): Promise<{ agentLatitude: number | null; agentLongitude: number | null; agentLocationUpdatedAt: Date | null; listing: { latitude: number | null; longitude: number | null } } | null>;

  // ── Assignment ──
  findPendingAssignment(orderId: string, agentId: string): Promise<OrderAgentAssignment | null>;
  findAssignments(orderId: string): Promise<OrderAgentAssignment[]>;
  /** Every offer this agent has had, newest first — the console's per-agent count of coded reasons. */
  findAssignmentsForAgent(agentId: string): Promise<OrderAgentAssignment[]>;
  /** The offers this agent has not answered yet — what STOP_OPEN_WORK hands back. */
  findPendingAssignmentsForAgent(agentId: string): Promise<{ id: string; orderId: string }[]>;
  /**
   * The non-terminal orders this person placed, by User id.
   *
   * `Order.advertiserId` is a User id rather than an Advertiser id — see the
   * relation on the model. Lot A's closure review asks the demand-side half of
   * the same question `findOpenForListings` answers for supply.
   */
  findOpenForAdvertiserUser(
    userId: string,
  ): Promise<{ id: string; listingId: string; status: OrderStatus }[]>;
  /**
   * G11-1: the non-terminal orders on a party and what they are worth
   * (`budget` summed, null when none carries one) — one aggregate, for
   * `fraud`'s linked-accounts rail. A publisher is scoped by its listings,
   * an advertiser by its login (`Order.advertiserId` is a User id), an
   * agent by the jobs it holds.
   */
  countOpenExposure(scope: OpenOrderScope): Promise<{ count: number; value: number | null }>;
  /**
   * Offers the order to an agent. `quotedFee` (Lot B, Q102) is the
   * installation figure resolved at offer time and shown on the sheet; null
   * when it could not be priced, so the offer still goes out.
   */
  createAssignment(orderId: string, agentId: string, quotedFee?: Prisma.Decimal | null): Promise<unknown>;
  /** Accepts the assignment and moves the order on, atomically. */
  acceptAssignment(assignmentId: string, orderId: string, agentId: string): Promise<void>;
  /** Rejects the assignment and bumps the rejection count, atomically. */
  rejectAssignment(assignmentId: string, orderId: string, reason?: string): Promise<void>;
  /**
   * Lot D (Q51/Q90): the offer or acceptance the order's agent holds —
   * PENDING or ACCEPTED, newest first — which a reassignment closes.
   */
  findCurrentAssignment(orderId: string, agentId: string): Promise<OrderAgentAssignment | null>;
  /**
   * Ops moved the order to another agent: this assignment is closed as
   * REASSIGNED with the reason kept. The rejection count is NOT bumped — the
   * agent did not refuse, ADX chose.
   */
  reassignAssignment(assignmentId: string, reason: string): Promise<void>;

  // ── Evidence ──
  upsertVerification(orderId: string, data: VerificationPatch): Promise<unknown>;
  /**
   * An order with its evidence, for the submit gate.
   *
   * `selfInstallCheckedInAt` rides along because the gate's CHECK_IN
   * requirement is answered by the agent's scan or by the publisher's own
   * check-in, and the two live on different rows.
   */
  findWithVerification(orderId: string): Promise<{
    id: string;
    status: string;
    selfInstallCheckedInAt: Date | null;
    verification: { qrScanned: boolean } | null;
  } | null>;
  upsertCheckIn(
    orderId: string,
    data: { latitude: number; longitude: number; distanceM: number },
  ): Promise<CheckIn>;
  /** Lot D (Q90): whether the agent has checked in at the site — the gate on the collect-prints override. */
  findCheckIn(orderId: string): Promise<CheckIn | null>;
  /** K-B1: `{ id, label, displayId }` per id in one query — the QR desk names the code's subject with it. */
  findLabelsByIds(ids: string[]): Promise<{ id: string; label: string; displayId: string | null }[]>;

  /* ── Order fraud screening (2 Oct 2026) ─────────────────────────── */
  /** The order with its risk and hold columns; null when there is no such order. */
  findRiskState(orderId: string): Promise<OrderRiskState | null>;
  /** Just whether (and since when) an order is held — what every hold gate asks. Null when there is no such order. */
  findHold(orderId: string): Promise<{ heldAt: Date | null } | null>;
  /** Writes risk and hold columns; answers the state after. */
  updateRisk(orderId: string, patch: OrderRiskPatch): Promise<OrderRiskState>;
  /**
   * Holds the order only if it is not held and still open (not COMPLETED or
   * CANCELLED) — one conditional write, so two holds racing do not both
   * land. True when this call held it.
   */
  holdIfOpen(orderId: string, hold: { heldAt: Date; heldById: string | null; holdReason: string }): Promise<boolean>;
  /** Lifts a hold only if there is one. True when this call lifted it. */
  releaseIfHeld(orderId: string): Promise<boolean>;
  /** The fraud review queue, one page, with a count per review status. */
  findRiskReviewPage(query: RiskReviewQuery): Promise<RiskReviewPage>;
  /** Open orders (not COMPLETED or CANCELLED), by id after `afterId` — what the nightly re-screen walks. */
  findOpenOrderIds(afterId: string | null, limit: number): Promise<string[]>;
}

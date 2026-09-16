import type {
  PackageBillingCycle,
  Prisma,
  PublisherSubscription,
  PublisherSubscriptionOrder,
  PublisherSubscriptionOrderStatus,
  PublisherSubscriptionPlan,
  SubscriptionTierName,
} from '../../shared/database';

/**
 * Lot J (B1): the publisher plan catalogue and the self-service orders.
 *
 * Kept as its own port beside `RevenueRepository` rather than folded into it:
 * the catalogue and the order book are a second table pair with their own
 * transaction (activation), and a test of the commission ladder should not
 * have to stub twelve order methods it never calls.
 */

export type PlanRow = PublisherSubscriptionPlan;

/** An order with the publisher it names — enough for a receipt, a notice and the admin list. */
export type OrderRow = PublisherSubscriptionOrder & {
  publisher: { id: string; name: string; userId: string | null; displayId: string | null };
};

export type NewPlan = {
  tier: SubscriptionTierName;
  name: string;
  pricePerMonth: Prisma.Decimal;
  ratePct: Prisma.Decimal;
  description: string | null;
  isPopular: boolean;
  entitlements: Prisma.InputJsonValue;
  sortOrder: number;
};

export type PlanPatch = {
  name?: string;
  pricePerMonth?: Prisma.Decimal;
  ratePct?: Prisma.Decimal;
  description?: string | null;
  isPopular?: boolean;
  entitlements?: Prisma.InputJsonValue;
  isActive?: boolean;
  sortOrder?: number;
};

export type NewOrder = {
  reference: string;
  publisherId: string;
  createdByUserId: string;
  tier: SubscriptionTierName;
  planName: string;
  pricePerMonth: Prisma.Decimal;
  ratePct: Prisma.Decimal;
  cycle: PackageBillingCycle;
  months: number;
  subtotal: Prisma.Decimal;
  discountPct: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  gstPct: Prisma.Decimal;
  gstAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  /** The term the order was quoted — informational until payment recomputes it. */
  startsAt: Date;
};

/** Lot J2 (d): the console's subscription list — a state facet over `startsAt`/`endsAt` at `now`, a search, one publisher. */
export const SUBSCRIPTION_STATES = ['RUNNING', 'UPCOMING', 'ENDED'] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];
export type SubscriptionListFilter = {
  state?: SubscriptionState | undefined;
  publisherId?: string | undefined;
  q?: string | undefined;
  page: number;
  pageSize: number;
};
export type SubscriptionListRow = PublisherSubscription & {
  publisher: { id: string; name: string; displayId: string | null };
};

export type OrderListFilter = {
  status?: readonly PublisherSubscriptionOrderStatus[] | undefined;
  publisherId?: string | undefined;
  q?: string | undefined;
  page: number;
  pageSize: number;
};

/**
 * Lot K (B2): a free trial, started under a per-publisher advisory lock so
 * two taps cannot both pass the "never held anything" check. The order is
 * written PAID at once (method TRIAL) beside the subscription it links to.
 */
export type TrialStart = {
  publisherId: string;
  order: NewOrder;
  now: Date;
  startsAt: Date;
  endsAt: Date;
};

export type TrialStartResult =
  | { started: true; order: OrderRow; subscription: PublisherSubscription }
  | { started: false; order: null; subscription: null };

/** Everything the activation writes, so it commits as one thing or not at all. */
export type Activation = {
  orderId: string;
  now: Date;
  method: string;
  reference: string | null;
  startsAt: Date;
  endsAt: Date;
  /** The different-tier subscription that stops now, if any. */
  endRunningId: string | null;
  /** Lot J2: a renewal the job bought carries the flag forward; everything else starts off. */
  autoRenew?: boolean | undefined;
};

export interface PublisherPlansRepository {
  /* The catalogue. */
  listPlans(includeInactive: boolean): Promise<PlanRow[]>;
  findPlan(tier: SubscriptionTierName): Promise<PlanRow | null>;
  upsertPlan(data: NewPlan): Promise<PlanRow>;
  updatePlan(tier: SubscriptionTierName, patch: PlanPatch): Promise<PlanRow>;

  /* Orders. */
  referenceExists(reference: string): Promise<boolean>;
  createOrder(data: NewOrder): Promise<OrderRow>;
  findOrder(id: string): Promise<OrderRow | null>;
  listOrdersForPublisher(publisherId: string): Promise<OrderRow[]>;
  listOrdersPage(filter: OrderListFilter): Promise<{ items: OrderRow[]; total: number; counts: Record<string, number> }>;
  cancelOrder(id: string, at: Date): Promise<OrderRow>;
  /** Every PENDING_PAYMENT order created before `before` becomes EXPIRED; returns how many. */
  expireStaleOrders(before: Date): Promise<number>;

  /**
   * The activation, in one transaction: the order becomes PAID and linked,
   * the subscription row is created (source SELF_SERVICE), and the running
   * different-tier subscription — if `endRunningId` names one — ends now.
   * Re-read inside the transaction: an order already PAID comes back as it
   * is with `activated: false`.
   */
  activateOrder(input: Activation): Promise<{ order: OrderRow; subscription: PublisherSubscription | null; activated: boolean }>;

  /**
   * Lot J2 (auto-renew): the order the sweep queued for a renewal — same
   * publisher and tier, `startsAt` equal to the ending term's `endsAt`,
   * PENDING_PAYMENT or PAID. Its existence is what makes the job idempotent.
   */
  findOrderStartingAt(publisherId: string, tier: SubscriptionTierName, startsAt: Date): Promise<OrderRow | null>;
  /** Lot K (B2): the order that bought a subscription — what it paid, and whether it was a trial; null for an admin grant. */
  findOrderBySubscription(subscriptionId: string): Promise<OrderRow | null>;

  /**
   * Lot K (B2): the free trial, in one transaction whose first statement is
   * `pg_advisory_xact_lock(hashtext(publisherId))` — the party the history
   * is keyed on — so two concurrent starts queue at the lock, and the second
   * re-reads a history that now holds the first's row and answers
   * `started: false`. The subscription and the PAID (TRIAL) order are
   * written together or not at all.
   */
  startTrial(input: TrialStart): Promise<TrialStartResult>;

  /**
   * Lot K (B2): whether the keyed wallet debit already posted — the sweep's
   * renewal asks before the balance, so a run that debited and then failed
   * to activate completes on the next run instead of failing the renewal.
   * A read of the ledger's transaction row by its idempotency key, never a
   * write.
   */
  debitPosted(idempotencyKey: string): Promise<boolean>;

  /* Subscriptions, read for the phone's screen and the daily sweep. */
  listSubscriptionsForPublisher(publisherId: string): Promise<PublisherSubscription[]>;
  /** Lot J2 (d): the console's list on the list contract, counted per state with the facet removed. */
  listSubscriptionsPage(filter: SubscriptionListFilter, now: Date): Promise<{ items: SubscriptionListRow[]; total: number; counts: Record<string, number> }>;
  /** Lot J2 (auto-renew): the subscriber's own switch on the running row. */
  setSubscriptionAutoRenew(id: string, autoRenew: boolean): Promise<PublisherSubscription>;
  /** Subscriptions ending inside `(from, to]`, with the publisher's login and, when bought on the phone, the order's cycle and how it was paid (TRIAL never renews). */
  findEndingBetween(from: Date, to: Date): Promise<(PublisherSubscription & { publisher: { id: string; name: string; userId: string | null }; order: { id: string; cycle: PackageBillingCycle; paidMethod: string | null } | null })[]>;
  /** Whether the publisher has another subscription in force at `at` other than `excludeId`. */
  hasSuccessor(publisherId: string, at: Date, excludeId: string): Promise<boolean>;
  /**
   * The once-per-subscription marker for the sweep's notices: whether an
   * in-app notification with this title already names the subscription.
   * A read of `notifications`' rows, never a write — the row itself is
   * written through `notify()`.
   */
  noticeSent(userId: string, relatedId: string, title: string): Promise<boolean>;
}

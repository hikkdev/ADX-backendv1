import type { Decimal } from '../../shared/money';
import type { PackageShelf } from './packages.schema';
import type { Prisma } from '../../shared/database';
import type {
  AdvertiserPackage,
  PackageAddOn,
  PackageBillingCycle,
  PackagePaymentMethod,
  PackageSale,
  PackageSaleLine,
  PackageSaleStatus,
  PackageTier,
} from '../../shared/database';

/**
 * What the packages module needs from storage.
 *
 * Small on purpose. A package sale is a short record with a status ladder, and
 * the only query with any shape to it is "which sales are due to expire" — the
 * rest is read one, write one.
 */

export type PackageRow = AdvertiserPackage;
export type AddOnRow = PackageAddOn;

export type SaleRow = PackageSale & {
  lines: PackageSaleLine[];
  /** `userId` (Lot J2): the login the renewal sweep and the trial tell; null for a brand with no login yet. */
  advertiser: { id: string; name: string; companyName: string | null; email: string | null; mobile: string; userId: string | null };
  package: { id: string; name: string; tier: PackageTier };
};

/** Lot D (Q94): what the catalogue editor may change on a plan. */
export type PlanPatch = Partial<{
  name: string;
  pricePerMonth: Prisma.Decimal;
  description: string | null;
  isPopular: boolean;
  entitlements: Prisma.InputJsonValue;
  isActive: boolean;
  sortOrder: number;
}>;

export type AddOnPatch = Partial<{
  name: string;
  pricePerMonth: Prisma.Decimal;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
}>;

export type NewSale = {
  reference: string;
  advertiserId: string;
  agentId: string | null;
  /** Lot B (Q1): the visit the sale was made on, when the agent was on one. */
  visitId: string | null;
  createdByUserId: string;
  packageId: string;
  tier: PackageTier;
  packageName: string;
  pricePerMonth: Prisma.Decimal;
  cycle: PackageBillingCycle;
  months: number;
  addOnsPerMonth: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  discountPct: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  gstPct: Prisma.Decimal;
  gstAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  paymentToken: string;
  lines: {
    kind: string;
    code: string;
    label: string;
    pricePerMonth: Prisma.Decimal;
    months: number;
    amount: Prisma.Decimal;
  }[];
};

/**
 * Lot K (B2): a free trial, started under a per-advertiser advisory lock so
 * two taps cannot both pass the "never held a term" check. The sale is
 * written ACTIVE at once (`paidMethod` TRIAL) with its lines.
 */
export type TrialStart = {
  advertiserId: string;
  sale: NewSale;
  now: Date;
  startsAt: Date;
  endsAt: Date;
};

export type TrialStartResult = { started: true; sale: SaleRow } | { started: false; sale: null };

export type SalePatch = Partial<{
  status: PackageSaleStatus;
  paymentLinkSentAt: Date;
  paymentLinkSends: number;
  paidAt: Date | null;
  paidMethod: PackagePaymentMethod | null;
  paidReference: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  nextBillingAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  incentiveId: string | null;
  /** Lot J2: the advertiser's own switch; honoured only while the policy allows it. */
  autoRenew: boolean;
}>;

export interface PackagesRepository {
  listPackages(includeInactive?: boolean): Promise<PackageRow[]>;
  findPackage(id: string): Promise<PackageRow | null>;
  /** Lot I (I4-B): the plans behind a set of ids in one query — the batch entitlement read. */
  findPackagesByIds(ids: readonly string[]): Promise<PackageRow[]>;
  findPackageByTier(tier: PackageTier): Promise<PackageRow | null>;
  upsertPackage(data: {
    tier: PackageTier;
    name: string;
    pricePerMonth: Prisma.Decimal;
    description: string | null;
    isPopular: boolean;
    entitlements: Prisma.InputJsonValue;
    sortOrder: number;
  }): Promise<PackageRow>;
  /** Lot D (Q94): the editor. A sale keeps its snapshot; only new sales see the change. */
  updatePackage(tier: PackageTier, patch: PlanPatch): Promise<PackageRow>;

  listAddOns(includeInactive?: boolean): Promise<AddOnRow[]>;
  findAddOnsByCode(codes: string[]): Promise<AddOnRow[]>;
  /** Any add-on by code, active or not — the editor edits retired ones too. */
  findAddOnByCode(code: string): Promise<AddOnRow | null>;
  upsertAddOn(data: {
    code: string;
    name: string;
    pricePerMonth: Prisma.Decimal;
    description: string | null;
    sortOrder: number;
  }): Promise<AddOnRow>;
  updateAddOn(code: string, patch: AddOnPatch): Promise<AddOnRow>;

  createSale(data: NewSale): Promise<SaleRow>;
  findSale(id: string): Promise<SaleRow | null>;
  findSaleByToken(token: string): Promise<SaleRow | null>;
  findSaleByReference(reference: string): Promise<SaleRow | null>;
  referenceExists(reference: string): Promise<boolean>;
  tokenExists(token: string): Promise<boolean>;
  updateSale(id: string, patch: SalePatch): Promise<SaleRow>;
  /** The recorded PACKAGE_SOLD amounts, by incentive id — "₹2,500 comm." on the card. */
  commissionAmounts(incentiveIds: string[]): Promise<Map<string, Decimal>>;
  /** The selling agent's tier, for the rate the commission is recorded at. */
  agentTier(agentId: string): Promise<string | null>;
  listSales(filter: {
    advertiserId?: string;
    agentId?: string;
    status?: PackageSaleStatus[];
    limit: number;
  }): Promise<SaleRow[]>;
  /** One page of the agent's book, with a count per shelf chip. */
  listSalesPage(filter: {
    advertiserId?: string;
    agentId?: string;
    shelf?: PackageShelf;
    status?: PackageSaleStatus[];
    q?: string;
    sort: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: SaleRow[]; total: number; counts: Record<string, number> }>;

  /**
   * Enough of an advertiser to decide whether this agent may sell to them.
   * Read here rather than borrowed, because it is a permission check on the
   * one write that creates a sale.
   */
  advertiserContext(advertiserId: string): Promise<{ id: string; agentId: string | null } | null>;

  /** The advertiser's live package, if they have one — started, and not run out. */
  findActiveSale(advertiserId: string, now: Date): Promise<SaleRow | null>;
  /** Lot I (I4-B): every live sale across a set of advertisers, newest start first — the caller keeps the first per advertiser. */
  findActiveSales(advertiserIds: readonly string[], now: Date): Promise<SaleRow[]>;
  /** Active sales whose term has run out. */
  findExpiredSales(now: Date): Promise<SaleRow[]>;

  /* Lot J2. */
  /** Grace: the advertiser's most recently ended paid term (ACTIVE or EXPIRED) with `endsAt` in `(since, at]`. */
  findLapsedSale(advertiserId: string, since: Date, at: Date): Promise<SaleRow | null>;
  /** Grace, for a set — latest end first, so the caller keeps the first per advertiser. */
  findLapsedSales(advertiserIds: readonly string[], since: Date, at: Date): Promise<SaleRow[]>;
  /** Trials: whether the advertiser has ever held a term — a sale that reached ACTIVE, running or not. */
  hasEverHeldSale(advertiserId: string): Promise<boolean>;
  /**
   * Lot K (B2): the free trial, in one transaction whose first statement is
   * `pg_advisory_xact_lock(hashtext(advertiserId))` — the party the history
   * is keyed on — so two concurrent starts queue at the lock, and the
   * second re-reads a history that now holds the first's sale and answers
   * `started: false`. The sale is written ACTIVE (TRIAL) with its lines, or
   * not at all.
   */
  startTrial(input: TrialStart): Promise<TrialStartResult>;
  /** The sweep: every sale that reached ACTIVE (still ACTIVE, or since EXPIRED) with `endsAt` in `(from, to]`. */
  findEndingBetween(from: Date, to: Date): Promise<SaleRow[]>;
  /** Whether another of the advertiser's sales is in force at `at` — the queued renewal, the replacement. */
  hasSuccessorSale(advertiserId: string, at: Date, excludeId: string): Promise<boolean>;
  /** The renewal the sweep queued: same advertiser and tier, `startsAt` equal to the ended term's `endsAt`, not cancelled or expired. */
  findSaleStartingAt(advertiserId: string, tier: PackageTier, startsAt: Date): Promise<SaleRow | null>;
  /** The once-per-sale marker for the sweep's notices — a read of `notifications`' rows, never a write. */
  noticeSent(userId: string, relatedId: string, title: string): Promise<boolean>;
}

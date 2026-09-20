import type {
  Advertiser,
  AdvertiserType,
  Gender,
  PayoutRailName,
  RefundDestination,
  RefundReason,
  RefundRequestStatus,
  WalletRefundRequest,
  AgreementAcceptance,
  AgreementKind,
  AgreementTemplate,
  Brand,
  BrandSector,
  KycStatus,
  TopUpMethod,
  Wallet,
  WalletEntry,
  WalletHold,
  WalletTopUp,
} from '../../shared/database';
import type { ListPage, ListQuery, Page, PageQuery } from '../../shared/pagination';

/* ------------------------------------------------------------------ */
/* Money over the wire                                                 */
/* ------------------------------------------------------------------ */

import type { OnboardingSource } from '../../shared/database';
/**
 * Amounts cross this boundary as decimal strings, never as numbers.
 *
 * The columns are `Decimal(14,2)` precisely so a running balance does not
 * accumulate float error; serialising through a JS number on the way out would
 * give that back. Callers that need arithmetic parse deliberately.
 */
/** E7-3: what another desk needs to name an advertiser beside a user id. */
export type AdvertiserLabelRow = { id: string; userId: string; displayId: string | null; name: string; kycStatus: KycStatus };

export type Money = string;

/* ------------------------------------------------------------------ */
/* Funnel                                                              */
/* ------------------------------------------------------------------ */

/**
 * The five demand gates, counted — the mirror of `SupplyFunnel`.
 *
 * `stuckOnAdvertiser` and `stuckOnAdx` split the same population by who is
 * being waited on, because that is the question ops actually asks: chase the
 * advertiser, or chase our own review queue.
 */
export type AdvertiserFunnel = {
  accountsCreated: number;
  profileComplete: number;
  kycVerified: number;
  platformAgreementAccepted: number;
  funded: number;
  stuckOnAdvertiser: {
    awaitingProfile: number;
    awaitingKycSubmission: number;
    awaitingAgreement: number;
    awaitingFunds: number;
  };
  stuckOnAdx: { pendingKycReview: number };
};

/** An advertiser row with the gate states the activation funnel renders. */
export type AdvertiserFunnelRow = {
  id: string;
  displayId: string | null;
  name: string;
  companyName: string | null;
  type: AdvertiserType;
  city: string | null;
  /** Lot G (Q119). */
  industry: string | null;
  kycStatus: KycStatus;
  platformAgreementAcceptedAt: Date | null;
  activatedAt: Date | null;
  brandCount: number;
  walletBalance: Money;
  createdAt: Date;
};

/* ------------------------------------------------------------------ */
/* Wallet                                                              */
/* ------------------------------------------------------------------ */

/**
 * What the advertiser can actually spend, which is not any single column.
 *
 * `spendable` is balance + goodwill − open holds. It is computed on read rather
 * than stored so the two can never disagree; a stored copy is one failed
 * transaction away from being wrong for good.
 */
export type WalletSnapshot = {
  balance: Money;
  goodwill: Money;
  held: Money;
  spendable: Money;
  currency: string;
  /** Lot A FREEZE_WALLET: set while money may land but not leave. */
  frozenAt?: Date | null;
};

/**
 * Lot B (Q41): a bank transfer or cheque ops recorded against the wallet, with
 * what reconciliation will need to match it to a bank line.
 */
export type NewTopUp = {
  walletId: string;
  amount: Money;
  method: TopUpMethod;
  utr?: string | null;
  receivedAt: Date;
  bankAccountId?: string | null;
  proofFileId?: string | null;
  paymentId?: string | null;
  note?: string | null;
  recordedByUserId: string;
  walletEntryId?: string | null;
  ledgerTransactionId?: string | null;
  /** A GATEWAY top-up is reconciled by the gateway's own settlement; set at once. */
  reconciledAt?: Date | null;
};

/** What the dormancy sweep needs of a wallet before it expires the credit. */
export type DormantWallet = {
  id: string;
  advertiserId: string;
  balance: Money;
  goodwill: Money;
};

export type RefundRequestPatch = Partial<{
  status: RefundRequestStatus;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  rail: PayoutRailName | null;
  railReference: string | null;
  paidAt: Date | null;
  paidByUserId: string | null;
  ledgerTransactionId: string | null;
}>;

/** E6: a top-up as the finance register lists it. */
export type TopUpDeskRow = WalletTopUp & {
  advertiser: { id: string; displayId: string | null; name: string } | null;
};
export const TOP_UP_DESK_STATUSES = ['RECONCILED', 'UNRECONCILED'] as const;
export type TopUpDeskQuery = ListQuery & { from?: Date | undefined; to?: Date | undefined };

/** E6: a refund request as the desk and the party read list it. */
export type RefundRequestDeskRow = WalletRefundRequest & {
  advertiser: { id: string; displayId: string | null; name: string } | null;
};

export const REFUND_REQUEST_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
  'PAID',
  'FAILED',
] as const;

/* ------------------------------------------------------------------ */
/* Port                                                                */
/* ------------------------------------------------------------------ */

/** N3-B: what the party read needs of the KYC record (`shared/kyc-state`'s `KycStateRecord`). */
export type KycRecordSummary = {
  id: string;
  status: KycStatus;
  submittedAt: Date | null;
  requestedAt: Date | null;
  requestedChannel: string | null;
  method: string;
};

export type CreateAdvertiserInput = {
  name: string;
  mobile: string;
  email?: string | null;
  type?: AdvertiserType;
  companyName?: string | null;
  gstin?: string | null;
  billingAddress?: string | null;
  city?: string | null;
  /** Lot X-B: the `City` row `city` denotes, stamped by the service through `pricing.withCityKey`; null for a typed town. */
  cityId?: string | null;
  state?: string | null;
  /** Lot G (Q119). */
  industry?: string | null;
  userId?: string | null;
  agentId?: string | null;
  displayId: string;
  /** QR-14: the door this row came through. */
  onboardedVia?: OnboardingSource | null;
  onboardedById?: string | null;
  onboardedByRole?: string | null;
  onboardedAt?: Date | null;
};

export type UpdateAdvertiserInput = Partial<
  Pick<
    Advertiser,
    | 'name'
    | 'email'
    | 'type'
    | 'companyName'
    | 'gstin'
    | 'billingAddress'
    | 'city'
    | 'cityId'
    | 'state'
    | 'industry'
    | 'userId'
    | 'agentId'
    | 'kycStatus'
    | 'activatedAt'
  >
>;

/** QR-15: what the desk's onboarding opens (or adopts) the sign-in account with — the person's own columns. */
export type AccountInput = {
  mobile: string;
  displayId: string;
  name: string;
  email?: string | null;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: Date;
  gender?: Gender;
};

/** QR-15: the person behind an account, as the console's Edit details drawer prefills from them. */
export type PersonRow = {
  displayId: string | null;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: Date | null;
  gender: Gender | null;
  avatarUrl: string | null;
  consentAcceptedAt: Date | null;
};

/** QR-15: the roster's cuts beside `q` — the door and the person who opened it. */
export type AdvertiserRosterQuery = PageQuery & { q?: string | undefined; onboardedVia?: OnboardingSource | undefined; onboardedById?: string | undefined };

export type CreateAcceptanceInput = {
  templateId: string;
  templateKind: AgreementKind;
  templateVersion: number;
  advertiserId: string;
  campaignId?: string | null;
  acceptedByUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  renderedDocument?: string | null;
};

/**
 * Everything the advertiser domain needs from storage, with no Prisma in the
 * signature. The wallet operations are deliberately coarse: each one is a
 * single atomic unit, because splitting "check the balance" from "spend it"
 * across two calls is how a wallet goes negative under load.
 */
export interface AdvertisersRepository {
  /** QR-14: the name behind `onboardedById`. */
  findUserLabel(userId: string): Promise<string | null>;
  /* Accounts */
  createAdvertiser(input: CreateAdvertiserInput): Promise<Advertiser>;
  /** QR-15: open the sign-in account for a desk-onboarded advertiser, or adopt the one the number already has (filling only what is empty, granting ADVERTISER). */
  ensureAccount(input: AccountInput): Promise<{ id: string; created: boolean }>;
  updateAccount(userId: string, patch: { firstName?: string; lastName?: string; name?: string; email?: string; dateOfBirth?: Date; gender?: Gender }): Promise<void>;
  findUserPerson(userId: string): Promise<PersonRow | null>;
  /** QR-14/15: the names behind `onboardedById`, one query for a page of rows. */
  userLabels(userIds: readonly string[]): Promise<Map<string, string | null>>;
  /** Links an agent-opened account to the person who has now signed in with its number. */
  attachUser(advertiserId: string, userId: string): Promise<Advertiser>;
  /** Attribution, set once: who brought them in. A later agent does not rewrite it. */
  attachAgent(advertiserId: string, agentId: string): Promise<void>;
  /** The person behind a user id, for the approval card. */
  findUserSummary(userId: string): Promise<{ name: string | null; avatarUrl: string | null } | null>;
  /** E6: whether the account behind the profile is closed (Lot A, Q21). */
  findUserClosure(userId: string): Promise<{ closedAt: Date | null; closeReason: string | null } | null>;
  findAdvertiserById(id: string): Promise<Advertiser | null>;
  /**
   * N3-B: the six columns the party read derives its `kyc` summary from —
   * the record by the profile first, then (a legacy row) by the user; null
   * before any record.
   */
  findKycSummary(advertiserId: string, userId: string | null): Promise<KycRecordSummary | null>;
  findAdvertiserByMobile(mobile: string): Promise<Advertiser | null>;
  findAdvertiserByUserId(userId: string): Promise<Advertiser | null>;
  /** E7-3: the label per login, for the desks that name the party behind a user. */
  findAdvertiserLabelsByUserIds(userIds: string[]): Promise<AdvertiserLabelRow[]>;
  /** K-B1: `{ id, label, displayId }` per id in one query — the QR desk names the code's subject with it. */
  findLabelsByIds(ids: string[]): Promise<{ id: string; label: string; displayId: string | null }[]>;
  updateAdvertiser(id: string, patch: UpdateAdvertiserInput): Promise<Advertiser>;
  /** E7-3: `q` is a contains over name / email / mobile / displayId beside the cursor page. */
  listAdvertisers(query: AdvertiserRosterQuery): Promise<Page<Advertiser>>;
  /** Every account this agent opened or looks after. */
  findAdvertisersForAgent(agentId: string): Promise<Advertiser[]>;

  /* Funnel */
  funnel(): Promise<AdvertiserFunnel>;
  funnelRows(query: PageQuery): Promise<Page<AdvertiserFunnelRow>>;

  /**
   * The signed-in user's verified mobile. Registration takes the number from
   * here rather than from the request body — see `registerAdvertiser`.
   */
  findUserMobile(userId: string): Promise<string | null>;

  /** The caller's own AgentProfile.id, for attributing an on-behalf signup. */
  findAgentProfileId(userId: string): Promise<string | null>;

  /* Brands */
  createBrand(input: {
    advertiserId: string;
    name: string;
    sector?: BrandSector;
    logoUrl?: string | null;
    website?: string | null;
  }): Promise<Brand>;
  findBrandById(id: string): Promise<Brand | null>;
  listBrands(advertiserId: string): Promise<Brand[]>;
  updateBrand(
    id: string,
    patch: Partial<Pick<Brand, 'name' | 'sector' | 'logoUrl' | 'website' | 'isActive'>>
  ): Promise<Brand>;

  /* Agreements — the platform click; the per-campaign kinds are `agreements`' (Lot D). */
  activeTemplate(kind: AgreementKind): Promise<AgreementTemplate | null>;
  /** The newest platform-scope acceptance of the kind — no transaction anchor. */
  findAcceptance(advertiserId: string, kind: AgreementKind): Promise<AgreementAcceptance | null>;
  createAcceptance(input: CreateAcceptanceInput): Promise<AgreementAcceptance>;

  /* Wallet */
  ensureWallet(advertiserId: string): Promise<Wallet>;
  walletSnapshot(advertiserId: string): Promise<WalletSnapshot | null>;
  listWalletEntries(advertiserId: string, query: PageQuery): Promise<Page<WalletEntry>>;
  findHoldById(id: string): Promise<WalletHold | null>;

  /**
   * Every debit and credit now goes through `wallets.move` — the freeze
   * check and the double-entry twin are one path (Lot B, Q30/Q36). What is
   * left here is the hold itself, which is a reservation rather than a
   * movement, and the top-up record the reconciliation screen reads.
   */

  /**
   * Returns null when spendable funds are short — a business outcome rather
   * than an exception, decided inside the same transaction that would place it.
   */
  placeHold(input: {
    advertiserId: string;
    campaignId: string;
    amount: Money;
  }): Promise<WalletHold | null>;

  releaseHold(holdId: string): Promise<WalletHold | null>;

  /* Top-ups (Lot B, Q41/Q118) */
  createTopUp(input: NewTopUp): Promise<WalletTopUp>;
  /** A gateway replays its webhooks; the payment id says which top-up it was. */
  findTopUpByPayment(paymentId: string): Promise<WalletTopUp | null>;
  listTopUps(advertiserId: string, query: PageQuery): Promise<Page<WalletTopUp>>;
  /**
   * E6: the finance desk's register of every top-up, on the list contract —
   * `q` is the UTR (contains), `from`/`to` bound `receivedAt`, the status
   * vocabulary is RECONCILED / UNRECONCILED, and each row names the advertiser.
   */
  listTopUpsPage(query: TopUpDeskQuery): Promise<ListPage<TopUpDeskRow>>;
  /** Lot B (Q85): what `reconciliation` needs — one by id, one by the UTR the bank line shows, and the stamp when a line explains it. */
  findTopUp(id: string): Promise<WalletTopUp | null>;
  findTopUpByUtr(utr: string): Promise<WalletTopUp | null>;
  markTopUpReconciled(id: string, at: Date | null): Promise<WalletTopUp>;

  /* Refunds */

  /**
   * The most that could be refunded right now: settled balance less open
   * holds, capped at what was actually paid in. Goodwill is excluded entirely
   * — it is issued to keep an advertiser booking and has no cash value.
   */
  refundableAmount(advertiserId: string): Promise<Money>;

  findOpenRefundRequest(advertiserId: string): Promise<WalletRefundRequest | null>;
  /** T-B: the desk's row — the request with its `advertiser` — so mark-paid and fail answer what the desk lists. */
  findRefundRequest(id: string): Promise<RefundRequestDeskRow | null>;
  listRefundRequests(
    query: PageQuery,
    status?: RefundRequestStatus
  ): Promise<Page<WalletRefundRequest>>;
  /**
   * The desk's view, on the list contract, with the chip histogram. E6: each
   * row names the advertiser the wallet belongs to; `advertiserId` narrows the
   * list to one account for the party read.
   */
  listRefundRequestsPage(query: ListQuery & { advertiserId?: string | undefined }): Promise<ListPage<RefundRequestDeskRow>>;

  /** Raises the request and freezes the amount in one transaction. */
  createRefundRequest(input: {
    advertiserId: string;
    amount: Money;
    reason: RefundReason;
    note: string;
    ticketId?: string | null;
    raisedByUserId: string;
    destination: RefundDestination;
    consentNote?: string | null;
    payoutMethodId?: string | null;
  }): Promise<WalletRefundRequest | null>;

  /**
   * Closes a PENDING request as APPROVED or REJECTED. `hold: 'RELEASE'` frees
   * the frozen money in the same transaction — a rejection, or a WALLET_CREDIT
   * approval where the money stays spendable; `'LEAVE'` is for a BANK_TRANSFER
   * approval, whose hold `wallets.move` has already captured as the REFUND
   * debit. Null when the request was no longer PENDING.
   */
  decideRefundRequest(input: {
    requestId: string;
    status: 'APPROVED' | 'REJECTED';
    hold: 'RELEASE' | 'LEAVE';
    decidedByUserId: string;
    decisionNote?: string | null;
    ledgerTransactionId?: string | null;
  }): Promise<WalletRefundRequest | null>;

  /** Mark-paid and fail, after their legs are posted. */
  updateRefundRequest(id: string, patch: RefundRequestPatch): Promise<RefundRequestDeskRow>;

  withdrawRefundRequest(requestId: string): Promise<WalletRefundRequest | null>;

  /* Dormancy */

  /**
   * Wallets that have seen no movement since `before` and still hold credit.
   * Batched so a sweep over ten million wallets does not become one call; the
   * service expires each through `wallets.move`, one transaction per wallet.
   */
  findDormantWallets(before: Date, batchSize: number): Promise<DormantWallet[]>;
}

import type { Prisma,
  SuspensionScope,
} from '../../shared/database';
import type {
  AgentIncentive,
  BankAccount,
  IncentiveEvent,
  IncentiveRate,
  KycStatus,
  PartySizeBand,
  PayoutBatch,
  PayoutBatchStatus,
  PayoutMethod,
  PayoutMethodStatus,
  PayoutMethodType,
  PayoutRailName,
  PayoutVerificationMethod,
  TaxParty,
  TaxWithholdingRate,
  WithdrawalLimit,
  WithdrawalRequest,
  WithdrawalStatus,
} from '../../shared/database';

/** Getting money out: the method it goes to, the request, and the rules around both. */

export type MethodRow = PayoutMethod;
export type LimitRow = WithdrawalLimit;
export type TaxRateRow = TaxWithholdingRate;
export type IncentiveRateRow = IncentiveRate;
export type IncentiveRow = AgentIncentive;

export type WithdrawalRow = WithdrawalRequest & {
  payoutMethod: PayoutMethod;
  wallet: {
    id: string;
    balance: Prisma.Decimal;
    goodwill: Prisma.Decimal;
    publisherId: string | null;
    agentId: string | null;
    advertiserId: string | null;
    /** Lot B (B4b): the fourth owner — a print partner being paid for a job. */
    printPartnerId?: string | null;
    /** E6: the queue says when the wallet behind a line is frozen. */
    frozenAt?: Date | null;
    /** Lot B (Q140): who the wallet belongs to, for the queue and the batch lines. */
    publisher?: { name: string } | null;
    agent?: { user: { name: string | null } | null } | null;
    advertiser?: { name: string; companyName: string | null } | null;
    printPartner?: { name: string } | null;
  };
};

/** The parties a wallet can belong to, as the queue and the party context name them. */
export type PayoutPartyKind = 'PUBLISHER' | 'AGENT' | 'ADVERTISER' | 'PRINT_PARTNER';

/** Lot B (Q140): the party kind and display name from a withdrawal's wallet. */
export function partyOfWithdrawal(row: WithdrawalRow): { kind: PayoutPartyKind; name: string } {
  const wallet = row.wallet;
  if (wallet.publisherId) return { kind: 'PUBLISHER', name: wallet.publisher?.name ?? 'Publisher' };
  if (wallet.agentId) return { kind: 'AGENT', name: wallet.agent?.user?.name ?? 'Agent' };
  if (wallet.printPartnerId) return { kind: 'PRINT_PARTNER', name: wallet.printPartner?.name ?? 'Print partner' };
  return { kind: 'ADVERTISER', name: wallet.advertiser?.companyName ?? wallet.advertiser?.name ?? 'Advertiser' };
}

export const PAYOUT_BATCH_STATUSES = [
  'DRAFT', 'IN_REVIEW', 'APPROVED', 'RELEASING', 'RELEASED', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED',
] as const;

export type BatchRow = PayoutBatch;
export type BatchView = PayoutBatch & { lines: WithdrawalRow[]; bankAccount: BankAccount | null };
export type BankAccountRow = BankAccount;

export type NewBatch = {
  reference: string;
  rail: PayoutRailName;
  bankAccountId: string | null;
  createdByUserId: string;
  cutoffAt?: Date | null;
  scheduledFor?: Date | null;
  note?: string | null;
};

export type BatchPatch = Partial<{
  status: PayoutBatchStatus;
  submittedAt: Date | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  releasedAt: Date | null;
  completedAt: Date | null;
  lineCount: number;
  totalNet: Prisma.Decimal;
  exportFileId: string | null;
  note: string | null;
  rail: PayoutRailName;
  bankAccountId: string | null;
}>;

export type WithdrawalListFilter = {
  walletId?: string;
  status?: WithdrawalStatus[];
  /** Reference or party name, contains, case-insensitive. */
  q?: string;
  partyKind?: PayoutPartyKind;
  from?: Date;
  to?: Date;
  batchId?: string;
  /** E6: one party's lines, by the profile behind the wallet. */
  publisherId?: string;
  agentId?: string;
  /** E6: the paid-out window, on `paidAt`. */
  paidFrom?: Date;
  paidTo?: Date;
  limit: number;
};

/** P-B: one party's paid-out total — by the profile behind the wallet, inside a `paidAt` window when given. */
export type PaidWithdrawalFilter = { publisherId?: string; agentId?: string; paidFrom?: Date; paidTo?: Date };

/** E6: the queue's header figures beside the status counts. */
export type WithdrawalSummaryRow = {
  counts: Record<string, number>;
  processingOver24h: number;
  /** Gross of every REQUESTED + APPROVED line — what the wallets hold back. */
  reservedTotal: Prisma.Decimal;
  /** Net of every PROCESSING line — what the rail is carrying. */
  processingTotal: Prisma.Decimal;
  /** Net of every line PAID inside the window handed in (the IST month). */
  paidThisMonth: Prisma.Decimal;
};

export type NewMethod = {
  userId: string;
  type: PayoutMethodType;
  accountHolder?: string | null;
  bankName?: string | null;
  accountNumber?: string | null;
  ifscCode?: string | null;
  /** Lot B (Q11): what the IFSC directory said, and when. Null when it was down. */
  bankBranch?: string | null;
  ifscVerifiedAt?: Date | null;
  upiVpa?: string | null;
  isDefault: boolean;
};

export type NewWithdrawal = {
  reference: string;
  walletId: string;
  payoutMethodId: string;
  amount: Prisma.Decimal;
  taxWithheld: Prisma.Decimal;
  taxRatePct: Prisma.Decimal;
  taxSection: string | null;
  netAmount: Prisma.Decimal;
  /**
   * Lot A (Q21): the closure marks the final payout it raises here, so the
   * freeze the closure itself applied does not stop its own withdrawal at
   * approval. Otherwise null until a person decides.
   */
  decisionNote?: string | null;
};

export type WithdrawalPatch = Partial<{
  status: WithdrawalStatus;
  decidedAt: Date | null;
  decidedByUserId: string | null;
  decisionNote: string | null;
  rail: PayoutRailName | null;
  railReference: string | null;
  paidAt: Date | null;
  failureReason: string | null;
  ledgerTransactionId: string | null;
  /** Lot B (Q140): set at approval, cleared when the reservation is undone. */
  reservedAt: Date | null;
  batchId: string | null;
}>;

/**
 * Enough of the party behind a wallet to price a withdrawal: which ladder they
 * are on, how long they have been here, and whose tax section applies.
 */
export type PartyContext = {
  kind: PayoutPartyKind;
  /** The publisher, agent, advertiser or print partner id behind the wallet. */
  entityId: string;
  walletId: string;
  userId: string | null;
  name: string;
  onboardedAt: Date;
  sizeBand: PartySizeBand;
  tier: string | null;
  /** Lot B (Q140): what a batch's preflight and its bank file need. */
  kycStatus: KycStatus | null;
  /**
   * `User.isActive` — except for a print partner (Lot B, B4b), whose User row
   * is sign-in-disabled by design (owner decision 122) and whose own
   * `isActive` switch is what this reports instead.
   */
  userActive: boolean | null;
  email: string | null;
  mobile: string | null;
};

export type NewBankAccount = {
  label: string;
  bankName: string;
  accountHolder: string | null;
  /** Only ever the masked form: ADX's own number is not a thing this database stores whole. */
  accountNumberMasked: string;
  ifsc: string;
  isActive: boolean;
  isDefault: boolean;
};

export type AccruableSpot = {
  id: string;
  ratePerDay: Prisma.Decimal;
  /** Units booked on the listing. A day's gross is rate × quantity (Lot B, B1). */
  quantity: number;
  /**
   * Lot B (Q38): the fraction the quote resolved at authorisation, and which
   * instrument set it. Null on spots authorised before the stamp existed;
   * the run then resolves once and records RESOLVED_AT_ACCRUAL.
   */
  commissionPct: Prisma.Decimal | null;
  commissionSource: string | null;
  orderId: string | null;
  campaign: { id: string; startDate: Date | null; endDate: Date | null };
  /**
   * `suspensionScopes` is Lot A's STOP_ACCRUAL: a publisher's is cascaded onto
   * each listing by the suspension service, so the listing's scopes are the
   * one place the accrual has to look.
   */
  listing: { id: string; publisherId: string | null; title: string; suspensionScopes?: SuspensionScope[] };
};

export type NewAccrual = {
  publisherId: string;
  listingId: string;
  campaignSpotId: string;
  forDate: Date;
  gross: Prisma.Decimal;
  commission: Prisma.Decimal;
  taxWithheld: Prisma.Decimal;
  net: Prisma.Decimal;
  commissionRatePct: Prisma.Decimal;
  /** The spot's stamp source, or RESOLVED_AT_ACCRUAL. */
  commissionSource: string | null;
  taxRatePct: Prisma.Decimal;
  clearsAt: Date;
  walletEntryId: string | null;
  ledgerTransactionId: string | null;
};

/**
 * Lot B (B1, Q135): a spot booked at quantity > 1 with the days already
 * accrued for it, for the backfill to compare each day's posted gross
 * against rate × quantity. The publisher's user id is what the notice goes to.
 */
export type UnderAccruedSpot = {
  id: string;
  ratePerDay: Prisma.Decimal;
  quantity: number;
  campaignId: string;
  orderId: string | null;
  listing: { id: string; title: string; publisherId: string | null; publisherUserId: string | null };
  accruals: {
    id: string;
    forDate: Date;
    gross: Prisma.Decimal;
    commissionRatePct: Prisma.Decimal;
    taxRatePct: Prisma.Decimal;
  }[];
};

export type AccrualRow = {
  id: string;
  forDate: Date;
  gross: Prisma.Decimal;
  commission: Prisma.Decimal;
  taxWithheld: Prisma.Decimal;
  net: Prisma.Decimal;
  clearsAt: Date;
  listing: { id: string; title: string; city: string | null };
};

export interface PayoutsRepository {
  /** Who a wallet belongs to, and the facts the withdrawal rules need. */
  findPartyContext(walletId: string): Promise<PartyContext | null>;
  findWalletForUser(userId: string): Promise<{ id: string; kind: 'PUBLISHER' | 'AGENT' | 'PRINT_PARTNER' } | null>;
  /** Lot J2 (f): the publisher behind a login, wallet or not — so a first read can open one. */
  findPublisherIdForUser(userId: string): Promise<string | null>;

  /* ── Methods ───────────────────────────────────────────────────── */
  findMethodsForUser(userId: string): Promise<MethodRow[]>;
  findMethod(id: string): Promise<MethodRow | null>;
  countMethodsForUser(userId: string): Promise<number>;
  createMethod(data: NewMethod): Promise<MethodRow>;
  updateMethod(id: string, patch: Partial<MethodRow>): Promise<MethodRow>;
  removeMethod(id: string): Promise<void>;
  /** Clears every other default in the same transaction as setting this one. */
  setDefaultMethod(userId: string, id: string): Promise<MethodRow>;
  /** Ops queue: methods somebody has to look at. */
  listMethodsByStatus(status: PayoutMethodStatus, limit: number): Promise<MethodRow[]>;

  /* ── Limits ────────────────────────────────────────────────────── */
  listLimits(): Promise<LimitRow[]>;
  upsertLimit(data: {
    band: PartySizeBand;
    minMonths: number;
    dailyCap: Prisma.Decimal;
  }): Promise<LimitRow>;

  /* ── Tax ───────────────────────────────────────────────────────── */
  findTaxRate(appliesTo: TaxParty, on: Date): Promise<TaxRateRow | null>;
  listTaxRates(): Promise<TaxRateRow[]>;
  createTaxRate(data: {
    appliesTo: TaxParty;
    section: string;
    ratePct: Prisma.Decimal;
    effectiveFrom: Date;
    note?: string | null;
  }): Promise<TaxRateRow>;
  closeTaxRate(id: string, effectiveTo: Date): Promise<TaxRateRow>;

  /* ── Withdrawals ───────────────────────────────────────────────── */
  createWithdrawal(data: NewWithdrawal): Promise<WithdrawalRow>;
  findWithdrawal(id: string): Promise<WithdrawalRow | null>;
  updateWithdrawal(id: string, patch: WithdrawalPatch): Promise<WithdrawalRow>;
  listWithdrawals(filter: WithdrawalListFilter): Promise<WithdrawalRow[]>;
  findWithdrawals(ids: string[]): Promise<WithdrawalRow[]>;
  /** Lot B (Q140): the queue's header — rows per status, and how many have sat with the rail too long. */
  withdrawalSummary(processingSince: Date, month: { start: Date; end: Date }): Promise<WithdrawalSummaryRow>;
  /** P-B: what one party has actually been paid — PAID lines' `netAmount`, optionally inside a `paidAt` window. An aggregate, so a long history never truncates. */
  sumPaidWithdrawals(filter: PaidWithdrawalFilter): Promise<{ total: Prisma.Decimal; count: number }>;
  /** Lot B (Q140): a withdrawal the rail already knows, for reconciliation. */
  findWithdrawalByRailReference(railReference: string): Promise<WithdrawalRow | null>;
  findWithdrawalByReference(reference: string): Promise<WithdrawalRow | null>;
  referenceExists(reference: string): Promise<boolean>;
  countForYear(year: number): Promise<number>;

  /* ── Payout batches (Lot B, Q140) ───────────────────────────────── */
  createBatch(data: NewBatch): Promise<BatchRow>;
  findBatch(id: string): Promise<BatchView | null>;
  updateBatch(id: string, patch: BatchPatch): Promise<BatchRow>;
  listBatches(filter: {
    status?: PayoutBatchStatus[];
    q?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: BatchRow[]; total: number; counts: Record<string, number> }>;
  batchReferenceExists(reference: string): Promise<boolean>;
  countBatchesForYear(year: number): Promise<number>;
  /**
   * Lot G (Q124): what the weekly draft may take — APPROVED lines on a
   * VERIFIED method that sit in no open batch (unbatched, or left behind by
   * a batch that is past release or cancelled), oldest request first.
   */
  findDraftableWithdrawals(limit: number): Promise<WithdrawalRow[]>;
  /** Lot G (Q124): the newest batch whose note begins with `notePrefix` — how the schedule finds its own last draft. */
  findLatestBatchByNote(notePrefix: string): Promise<BatchRow | null>;
  /** Attaches and detaches lines in one transaction, then recounts the batch. */
  setBatchLines(batchId: string, attach: string[], detach: string[]): Promise<BatchRow>;
  /** lineCount and totalNet from the lines as they stand. */
  recountBatch(batchId: string): Promise<BatchRow>;
  /** The lines' states, for deriving the batch's own. */
  tallyBatchLines(batchId: string): Promise<{ status: WithdrawalStatus; count: number }[]>;

  /* ── ADX bank accounts (Lot B, Q85) ──────────────────────────────── */
  listBankAccounts(): Promise<BankAccountRow[]>;
  findBankAccount(id: string): Promise<BankAccountRow | null>;
  createBankAccount(data: NewBankAccount): Promise<BankAccountRow>;
  updateBankAccount(id: string, patch: Partial<NewBankAccount>): Promise<BankAccountRow>;
  /**
   * What is already spoken for: requests raised and not yet settled. Summed
   * rather than moved out of the balance, so the two can never drift apart.
   */
  sumOpen(walletId: string): Promise<Prisma.Decimal>;
  /** Gross withdrawn or requested today, for the daily cap. */
  sumForDay(walletId: string, dayStart: Date, dayEnd: Date): Promise<Prisma.Decimal>;

  /* ── Daily accrual ─────────────────────────────────────────────── */
  /** Spots on a live or finished campaign, with the flight and the listing. */
  findAccruableSpots(): Promise<AccruableSpot[]>;
  /** The days already earned for a spot, so the run can skip them. */
  findAccruedDates(campaignSpotId: string): Promise<Date[]>;
  createAccrual(data: NewAccrual): Promise<{ id: string }>;
  /** Every spot at quantity > 1 that has accrued at least one day. */
  findUnderAccruedSpots(): Promise<UnderAccruedSpot[]>;
  sumAccruals(
    publisherId: string,
    clearsAfter?: Date
  ): Promise<{
    gross: Prisma.Decimal;
    commission: Prisma.Decimal;
    taxWithheld: Prisma.Decimal;
    net: Prisma.Decimal;
    count: number;
  }>;
  listAccruals(publisherId: string, limit: number): Promise<AccrualRow[]>;
  /**
   * Lot B (Q13): the monthly payment advice. Every accrual whose `forDate`
   * falls in [from, to), oldest first — the days the advice itemises.
   */
  listAccrualsForPeriod(publisherId: string, from: Date, to: Date): Promise<AccrualRow[]>;
  /** The publishers who earned anything in [from, to) — who gets an advice. */
  publisherIdsWithAccruals(from: Date, to: Date): Promise<string[]>;

  /* ── Incentives ────────────────────────────────────────────────── */
  findIncentiveRate(event: IncentiveEvent, tier: string, on: Date, side?: 'PUBLISHER' | 'ADVERTISER'): Promise<IncentiveRateRow | null>;
  listIncentiveRates(): Promise<IncentiveRateRow[]>;
  upsertIncentiveRate(data: {
    event: IncentiveEvent;
    tier: string;
    amount: Prisma.Decimal;
    effectiveFrom: Date;
  }): Promise<IncentiveRateRow>;
  createIncentive(data: {
    agentId: string;
    event: IncentiveEvent;
    tier: string;
    rateId: string | null;
    amount: Prisma.Decimal;
    taxWithheld: Prisma.Decimal;
    taxRatePct: Prisma.Decimal;
    netAmount: Prisma.Decimal;
    orderId?: string | null;
    publisherId?: string | null;
    advertiserId?: string | null;
    note?: string | null;
  }): Promise<IncentiveRow>;
  findIncentive(id: string): Promise<IncentiveRow | null>;
  /** Lot F: the login behind an agent profile, for the incentive notice — null when the profile has none. */
  findIncentiveRecipient(agentId: string): Promise<{ userId: string } | null>;
  /**
   * Lot B: the row already recorded for this event and this order or party,
   * whatever its status — the idempotency read behind `recordIncentiveOnce`.
   * Exactly one of the keys is passed.
   */
  findIncentiveFor(
    event: IncentiveEvent,
    key: { orderId?: string; publisherId?: string; advertiserId?: string }
  ): Promise<IncentiveRow | null>;
  updateIncentive(
    id: string,
    patch: Partial<{
      status: AgentIncentive['status'];
      verifiedByUserId: string | null;
      verifiedAt: Date | null;
      rejectionReason: string | null;
      walletEntryId: string | null;
      ledgerTransactionId: string | null;
      /** LH10: the clawback's stamps. */
      reversedAt: Date | null;
      reversalReason: string | null;
      reversalLedgerTransactionId: string | null;
    }>
  ): Promise<IncentiveRow>;
  listIncentives(filter: {
    agentId?: string;
    orderId?: string;
    status?: AgentIncentive['status'][];
    events?: AgentIncentive['event'][];
    /** E6: the note, the order id or the agent's name, contains. */
    q?: string;
    cursor?: string;
    limit: number;
  }): Promise<IncentiveRow[]>;
  sumIncentives(
    agentId: string,
    status: AgentIncentive['status']
  ): Promise<{ total: Prisma.Decimal; count: number }>;
  countIncentivesByEvent(agentId: string): Promise<{ event: IncentiveEvent; count: number }[]>;
}

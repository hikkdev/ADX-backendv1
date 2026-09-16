import type {
  AccountClosureCase,
  ClosureDecision,
  ErasureRequest,
  ErasureStatus,
  ErasureVia,
  Prisma,
} from '../../shared/database';

/**
 * Closing an account and erasing a person — Lot A (Q21/Q60).
 *
 * This module owns `AccountClosureCase`, `ErasureRequest` and
 * `MobileTombstone` outright, and — like `suspension` before it — it owns a
 * few columns on tables another module keeps: `User.closedAt / closeReason /
 * closedById`, and the PII columns an erasure blanks on `User`, `Publisher`,
 * `Advertiser`, `AgentProfile` and the four KYC records.
 *
 * That is deliberate. A closure is one act with one record, and an erasure has
 * to be atomic across eight tables or it leaves a half-erased person behind —
 * which is the one outcome a DPO-signed request must never produce. Splitting
 * either across five repositories to satisfy a boundary rule would turn a
 * correct write into a data-integrity bug; `docs/backend-modules.md` says so
 * for `users.deleteUserCascade` and the same reasoning applies here.
 */

/** Who this account is, and which party rows hang off it. */
export type PartyIds = {
  userId: string;
  name: string | null;
  mobile: string;
  email: string | null;
  isActive: boolean;
  closedAt: Date | null;
  closeReason: string | null;
  publisherId: string | null;
  advertiserId: string | null;
  agentProfileId: string | null;
};

export type NewClosureCase = {
  userId: string;
  ticketId?: string | null;
  reason: string;
  requestedById?: string | null;
  walletBalance: Prisma.Decimal | null;
  withdrawalsInFlight: number;
  openOrders: number;
  openWork: number;
};

/** A case as the console reads it, with enough of the person to identify them. */
export type ClosureCaseRow = AccountClosureCase & {
  user: { id: string; name: string | null; mobile: string; closedAt: Date | null } | null;
};

export type ClosureCaseFilter = { decision?: ClosureDecision | undefined; q?: string | undefined };

export type ErasureRow = ErasureRequest & {
  user: { id: string; name: string | null; mobile: string; closedAt: Date | null } | null;
};

export type ErasureFilter = { status?: ErasureStatus | undefined; q?: string | undefined };

export type NewErasureRequest = {
  userId: string;
  requestedVia: ErasureVia;
  dueAt: Date;
  reason?: string | null;
};

export type ErasurePatch = Partial<{
  status: ErasureStatus;
  approvedById: string | null;
  approvedAt: Date | null;
  dpoName: string | null;
  completedAt: Date | null;
  retainUntil: Date | null;
  refusedReason: string | null;
}>;

/** One page of a list, in the designed-list shape without the chip counts. */
export type Slice = { skip: number; take: number };

/**
 * Every placeholder an erasure writes, computed by the service so the hashing
 * rule lives in one readable place and the transaction stays a transaction.
 */
export type ErasurePlan = {
  userId: string;
  /** `erased:<sha256 prefix>` — replaces `User.mobile`, so the unique index holds. */
  userMobile: string;
  /** The full sha256 of the real number. The tombstone's primary key. */
  mobileHash: string;
  publisher: { id: string; mobile: string } | null;
  advertiser: { id: string; mobile: string } | null;
  agentProfileId: string | null;
  /** `AdvertiserKyc` is keyed by `User.id`, not by `Advertiser.id`. */
  advertiserKycUserId: string;
};

/** What an erasure actually removed, for the audit row and the response. */
export type ErasureFootprint = {
  documentsDeleted: number;
  profilesAnonymised: string[];
  kycRecordsMasked: string[];
};

export interface AccountLifecycleRepository {
  /* ── The person ─────────────────────────────────────────────────── */
  findParties(userId: string): Promise<PartyIds | null>;
  /** The three columns Q21 added, written together or not at all (the table's CHECK). */
  closeUser(userId: string, data: { reason: string; byUserId: string; at: Date }): Promise<void>;

  /* ── Closure cases ──────────────────────────────────────────────── */
  createCase(data: NewClosureCase): Promise<AccountClosureCase>;
  findCase(id: string): Promise<AccountClosureCase | null>;
  findPendingCaseForUser(userId: string): Promise<AccountClosureCase | null>;
  setCaseTicket(id: string, ticketId: string): Promise<AccountClosureCase>;
  decideCase(
    id: string,
    patch: { decision: ClosureDecision; decidedById: string; decidedAt: Date; lossNote?: string | null },
  ): Promise<AccountClosureCase>;
  listCases(
    filter: ClosureCaseFilter,
    slice: Slice,
  ): Promise<{ items: ClosureCaseRow[]; total: number; counts: Record<string, number> }>;

  /* ── Erasure ────────────────────────────────────────────────────── */
  createErasure(data: NewErasureRequest): Promise<ErasureRequest>;
  findErasure(id: string): Promise<ErasureRequest | null>;
  findOpenErasureForUser(userId: string): Promise<ErasureRequest | null>;
  updateErasure(id: string, patch: ErasurePatch): Promise<ErasureRequest>;
  listErasures(
    filter: ErasureFilter,
    slice: Slice,
  ): Promise<{ items: ErasureRow[]; total: number; counts: Record<string, number> }>;
  /**
   * The whole anonymisation, in one transaction. Wallets, ledger legs,
   * withdrawals, agreement acceptances and activity rows are deliberately not
   * touched — they are the financial record the retention window protects.
   */
  erase(plan: ErasurePlan): Promise<ErasureFootprint>;
  /**
   * Lot E's daily retention sweep (`jobs/retention.job.ts`): the PENDING
   * requests whose thirty days have run out, and the DONE ones whose
   * `retainUntil` has passed. Reads only — the sweep tells the admins and
   * writes a report; a person destroys the financial rows, never a job.
   */
  listErasuresDue(now: Date): Promise<ErasureRequest[]>;
  listErasuresPastRetention(now: Date): Promise<ErasureRequest[]>;

  /* ── Tombstone ──────────────────────────────────────────────────── */
  isTombstoned(mobileHash: string): Promise<boolean>;
}

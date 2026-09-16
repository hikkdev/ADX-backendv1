import type { Prisma } from '../../shared/database';
import type {
  BankLineDirection,
  BankLineMatchStatus,
  BankStatementImport,
  BankStatementLine,
  BankStatementProfile,
  ReconciliationMatch,
  ReconciliationMatchKind,
} from '../../shared/database';
import type { Money } from '../../shared/money';

/**
 * Bank-statement reconciliation — Lot B (Q85). What this module stores: the
 * per-bank column profiles, each import, its lines, and the one record that
 * explains a line. The things a line is matched AGAINST — a withdrawal, a
 * top-up, a ledger transaction — belong to other modules and are read
 * through their indexes, never from here.
 */

export type ProfileRow = BankStatementProfile;
export type ImportRow = BankStatementImport;
export type MatchRow = ReconciliationMatch;
export type LineRow = BankStatementLine & { match: ReconciliationMatch | null };

export const LINE_STATUSES = ['UNMATCHED', 'MATCHED', 'DIFFERS', 'IGNORED'] as const;

export type NewProfile = {
  name: string;
  bankName: string;
  columns: Record<string, string>;
  dateFormat: string | null;
};

export type NewImport = {
  bankAccountId: string;
  profileId: string | null;
  fileId: string | null;
  fileName: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  importedByUserId: string;
};

export type NewLine = {
  valueDate: Date;
  description: string;
  utr: string | null;
  direction: BankLineDirection;
  amount: Money;
  runningBalance: Money | null;
  rawHash: string;
};

export type LineFilter = {
  status?: BankLineMatchStatus[] | undefined;
  bankAccountId?: string | undefined;
  importId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  /** Description or UTR, contains, case-insensitive. */
  q?: string | undefined;
};

export type NewMatch = {
  lineId: string;
  ledgerTransactionId: string | null;
  withdrawalId: string | null;
  topUpId: string | null;
  paymentId: string | null;
  difference: Money;
  kind: ReconciliationMatchKind;
  matchedByUserId: string | null;
  note: string | null;
};

export type StatusSummary = Record<BankLineMatchStatus, { count: number; sum: Money }>;

/**
 * Lot G (Q125): one slice of the lines for the export — the same filter as
 * the list, no count, walked by keyset under the fixed (valueDate, id)
 * order, newest first: `after` is the last row of the slice before, so a
 * line landing while the file streams can neither repeat nor drop a row.
 */
export type LineSlice = {
  take: number;
  after?: { valueDate: Date; id: string };
};

export interface ReconciliationRepository {
  /* Profiles */
  listProfiles(): Promise<ProfileRow[]>;
  findProfile(id: string): Promise<ProfileRow | null>;
  createProfile(data: NewProfile): Promise<ProfileRow>;

  /* Imports */
  createImport(data: NewImport): Promise<ImportRow>;
  findImport(id: string): Promise<ImportRow | null>;
  listImports(filter: { bankAccountId?: string | undefined; limit: number }): Promise<ImportRow[]>;
  /**
   * Writes the lines that are new for this account — `rawHash` is unique per
   * account, so a line imported twice is one line — and stamps the import
   * with how many landed and how many it already had.
   */
  addLines(importId: string, bankAccountId: string, lines: NewLine[]): Promise<{ created: number; duplicates: number }>;

  /* Lines */
  findLine(id: string): Promise<LineRow | null>;
  listLines(filter: LineFilter, page: { page: number; pageSize: number }): Promise<{ items: LineRow[]; total: number; counts: Record<string, number> }>;
  /** Lot G (Q125): the export's slice, with each line's match, newest first. */
  findLineRows(filter: LineFilter, slice: LineSlice): Promise<LineRow[]>;
  /** Everything still to explain in a window, oldest first, for the auto-matcher. */
  listUnmatched(filter: { bankAccountId?: string | undefined; from?: Date | undefined; to?: Date | undefined; limit: number }): Promise<LineRow[]>;
  setLineStatus(id: string, status: BankLineMatchStatus): Promise<LineRow>;

  /* Matches */
  createMatch(data: NewMatch): Promise<MatchRow>;
  updateMatch(id: string, patch: Partial<Pick<NewMatch, 'ledgerTransactionId' | 'note'>>): Promise<MatchRow>;
  deleteMatch(lineId: string): Promise<void>;
  /** Which of these ids a match already claims — so a record explains one line only. */
  claimedLedgerTransactionIds(ids: string[]): Promise<Set<string>>;
  claimedWithdrawalIds(ids: string[]): Promise<Set<string>>;
  claimedTopUpIds(ids: string[]): Promise<Set<string>>;

  /* Summary */
  summary(filter: { bankAccountId?: string | undefined; from?: Date | undefined; to?: Date | undefined }): Promise<StatusSummary>;
}

export type { Prisma };

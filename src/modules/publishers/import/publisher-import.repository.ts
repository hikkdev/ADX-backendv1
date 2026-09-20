import type { PublisherImport, PublisherImportOutcome, PublisherImportRow, PublisherImportStatus } from '../../../shared/database';

/** The columns a merge may fill and a create writes, as the book holds them. */
export type ImportPublisherFields = {
  name?: string;
  email?: string;
  type?: string;
  gstin?: string;
  address?: string;
  city?: string;
  state?: string;
  contactName?: string;
  contactMobile?: string;
  contactEmail?: string;
  panNumber?: string;
  /** QR-13: the person behind the account, opened with the row when a first name is given. */
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  gender?: string;
  /** QR-13: the address pin. */
  latitude?: number;
  longitude?: number;
};

/** What the planner needs to know about a publisher already on the book. */
export type MatchedPublisher = {
  id: string;
  displayId: string | null;
  mobile: string;
  name: string;
  email: string | null;
  type: string;
  gstin: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  contactName: string | null;
  contactMobile: string | null;
  contactEmail: string | null;
  kyc: { panNumber: string | null } | null;
};

export type NewImportRow = {
  rowNumber: number;
  data: unknown;
  outcome: PublisherImportOutcome;
  publisherId: string | null;
  message: string | null;
};

export type ImportCounts = {
  rowCount: number;
  createdCount: number;
  mergedCount: number;
  skippedCount: number;
  /** E6: the rows that will create WITH a warning (Lot E column) — a subset of `createdCount`, counted separately. */
  warningCount: number;
  invalidCount: number;
};

export type ImportWithRows = PublisherImport & { rows: PublisherImportRow[] };

/**
 * One row's work at commit. Lot X-B: `cityId` is the key the row's `city`
 * resolved to (null for a typed town), stamped beside the string whenever
 * the city is written — on a create, and on a merge that fills the city.
 */
export type CommitAction =
  | { rowId: string; action: 'MERGE'; publisherId: string; fill: ImportPublisherFields; cityId?: string | null }
  | {
      rowId: string;
      action: 'CREATE';
      publisher: ImportPublisherFields & { mobile: string; name: string; displayId: string };
      cityId?: string | null;
      /** QR-13: the account to open (or adopt) for the row, with its own identifier; absent when the row names no person. */
      account?: { displayId: string };
      /** QR-14: who uploaded the batch, and their role at the time. */
      onboardedBy?: { userId: string; role: string };
    };

export interface PublisherImportRepository {
  findPublishersByMobiles(mobiles: string[]): Promise<MatchedPublisher[]>;
  findPublishersByPans(pans: string[]): Promise<MatchedPublisher[]>;
  createImport(data: { fileName: string; note: string | null; uploadedById: string; rows: NewImportRow[]; counts: ImportCounts }): Promise<ImportWithRows>;
  listImports(): Promise<PublisherImport[]>;
  findImport(id: string): Promise<ImportWithRows | null>;
  /**
   * The whole commit in one transaction: every create, every merge, each
   * row stamped with its publisher, the counts, the status. A create whose
   * mobile has appeared on the book since validation is merged instead.
   */
  commitImport(id: string, actions: CommitAction[], committedAt: Date): Promise<ImportWithRows>;
  setStatus(id: string, status: PublisherImportStatus): Promise<ImportWithRows>;
}

import type { ImportParty, PartyImport, PartyImportRow, PublisherImportOutcome, PublisherImportStatus } from '../../shared/database';
import type { ListPage } from '../../shared/pagination';

/** `PartyImportRow.outcome` — the publisher's five outcomes, reused by the schema. */
export type PartyImportOutcome = PublisherImportOutcome;

/**
 * A party already on the platform, as the planner needs it: the key, a label
 * for the message, and the current value of every column a merge may fill
 * (null when empty). `userId` rides along for the parties whose row is an
 * account (agents, employees).
 */
export type MatchedParty = {
  id: string;
  displayId: string | null;
  mobile: string;
  label: string;
  /** The account behind the row, for the parties whose update service is keyed by it (employees). */
  userId?: string | null;
  fields: Record<string, string | null>;
};

/** What the planner reads before it plans: the party's rows by each key, and the mobiles it may not take. */
export type MatchSet = {
  byMobile: MatchedParty[];
  /** Holders of each PAN / GSTIN in the batch, keyed by the number. */
  byPan: Map<string, MatchedParty>;
  byGstin: Map<string, MatchedParty>;
  /** Mobiles a create would be refused for, with why — a print partner's number already on an ADX account. */
  blockedMobiles: Map<string, string>;
  /** Emails already on an account — by the mobile of the account holding each — for the parties whose create makes a User. */
  takenEmails: Map<string, string>;
};

/* ── Lot U: the publisher's spots and rate card ────────────────────────── */

/** The publisher an import is for, as the act rule and the messages need it. */
export type ImportPublisher = { id: string; displayId: string | null; name: string; agentId: string | null; userId: string | null };

/**
 * One of the publisher's listings as the planner reads it: the merge keys
 * (the display id, the title, the normalised address, the point), the rate
 * and the columns a merge may fill (null when empty).
 */
export type MatchedListing = {
  id: string;
  displayId: string | null;
  title: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  /** Two decimals, or null on an unpriced listing. */
  ratePerDay: string | null;
  slotsTotal: number;
  status: string;
  fields: Record<string, string | null>;
};

/** Another publisher's listing near a point of the batch — the "possible duplicate" warning. */
export type NearbyListing = { id: string; displayId: string | null; title: string; publisherId: string | null; latitude: number; longitude: number };

/** The controlled lists a spot is classified against, read once per validation. */
export type SpotVocabulary = {
  mediaTypes: { id: string; name: string; slug: string; category: string }[];
  sizeClasses: { id: string; name: string; slug: string }[];
  materials: { id: string; name: string; slug: string }[];
};

export type NewImportRow = {
  rowNumber: number;
  data: unknown;
  outcome: PartyImportOutcome;
  targetId: string | null;
  message: string | null;
};

export type ImportCounts = {
  rowCount: number;
  createdCount: number;
  mergedCount: number;
  skippedCount: number;
  /** The rows that will create WITH a warning — a subset of `createdCount`, counted separately. */
  warningCount: number;
  invalidCount: number;
};

export type ImportWithRows = PartyImport & { rows: PartyImportRow[] };

export type RowStamp = {
  outcome?: PartyImportOutcome;
  targetId?: string | null;
  message?: string | null;
  data?: unknown;
};

export interface PartyImportsRepository {
  createImport(data: { party: ImportParty; fileName: string; note: string | null; uploadedById: string; publisherId?: string | null; rows: NewImportRow[]; counts: ImportCounts }): Promise<ImportWithRows>;
  listImports(party: ImportParty, query: { status?: readonly string[] | undefined; publisherId?: string | undefined; page: number; pageSize: number }): Promise<ListPage<PartyImport>>;
  findImport(party: ImportParty, id: string): Promise<ImportWithRows | null>;
  /** One row's result, written as it lands — the resumable marker of a commit. */
  stampRow(rowId: string, stamp: RowStamp): Promise<void>;
  finishCommit(id: string, counts: Omit<ImportCounts, 'rowCount'>, committedAt: Date): Promise<ImportWithRows>;
  setStatus(id: string, status: PublisherImportStatus): Promise<ImportWithRows>;
  /** Lot U: the supply attempt a LISTING import's first commit opened, so a resumed commit reuses it. */
  setAttempt(id: string, attemptId: string): Promise<void>;

  /* The parties' tables, read only — every write goes through the party's own service. */
  matchAdvertisers(keys: { mobiles: string[]; pans: string[]; gstins: string[] }): Promise<MatchSet>;
  matchAgents(keys: { mobiles: string[]; emails: string[] }): Promise<MatchSet>;
  matchPrintPartners(keys: { mobiles: string[]; pans: string[]; gstins: string[]; emails: string[] }): Promise<MatchSet>;
  matchEmployees(keys: { mobiles: string[]; emails: string[] }): Promise<MatchSet>;
  /** The user behind a mobile and whether it already has an employee row — the employee create's first step. */
  findUserByMobile(mobile: string): Promise<{ id: string; employeeId: string | null } | null>;

  /* Lot U: the publisher's spots and rate card — reads only; every write goes through `listings` and `supply`. */
  findPublisher(publisherId: string): Promise<ImportPublisher | null>;
  /** Every listing the publisher has, retired ones aside. */
  listPublisherListings(publisherId: string): Promise<MatchedListing[]>;
  /** The publisher's external references, by ref → listing id, from the rows earlier LISTING imports committed. */
  findExternalRefs(publisherId: string): Promise<Map<string, string>>;
  /** Other publishers' listings within `radiusM` of any of the points. */
  findListingsNear(points: { latitude: number; longitude: number }[], excludePublisherId: string, radiusM: number): Promise<NearbyListing[]>;
  listSpotVocabulary(): Promise<SpotVocabulary>;
  /** The City row a listing's free-text city names, for the rate-card lookup; null when none. */
  findCityIdByName(name: string): Promise<string | null>;
  /** Which of the listings have an order holding a slot right now. */
  listingsWithRunningBooking(listingIds: string[], now?: Date): Promise<Set<string>>;
}

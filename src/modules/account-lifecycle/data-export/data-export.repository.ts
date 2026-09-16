import type { DataExportRequest } from '../../../shared/database';

/**
 * The data export — G6 (Q104).
 *
 * `DataExportRequest` is this module's row; `assemble` is a read across the
 * tables a person's records live in — the same arrangement the erasure makes
 * for the same reason, in reverse: what an erasure blanks is what an export
 * hands back, and both have to name every table or they lie by omission.
 * Read-only, in this module's own repository, never through Prisma from a
 * service.
 *
 * What the export does NOT carry: document images and videos (the URLs are
 * dropped from every KYC record — the person can open them in the app; a
 * zip that carries identity documents is a zip that must never leak),
 * password hashes, OTPs, refresh-token hashes, and other people's names on
 * shared rows (an order names the listing and the campaign, not the
 * counter-party's phone).
 */

export interface AssembledExport {
  profile: Record<string, unknown> | null;
  roles: string[];
  parties: {
    publisher: Record<string, unknown> | null;
    advertiser: Record<string, unknown> | null;
    agent: Record<string, unknown> | null;
  };
  kyc: {
    publisher: Record<string, unknown> | null;
    advertiser: Record<string, unknown> | null;
    agent: Record<string, unknown> | null;
    user: Record<string, unknown> | null;
    /** The per-document decisions on the person's KYC cases — the desk's tiles, without the images. */
    documentDecisions: Record<string, unknown>[];
  };
  listings: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  campaigns: Record<string, unknown>[];
  wallets: { wallet: Record<string, unknown>; entries: Record<string, unknown>[] }[];
  withdrawals: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  activity: Record<string, unknown>[];
  preferences: { notifications: Record<string, unknown>[]; account: Record<string, unknown> | null };
}

export interface DataExportRepository {
  create(userId: string, now: Date): Promise<DataExportRequest>;
  findById(id: string): Promise<DataExportRequest | null>;
  /** The newest request, any status. */
  findLatest(userId: string): Promise<DataExportRequest | null>;
  /** A PENDING request, or a READY one that has not expired — the one that refuses a second ask. */
  findOpen(userId: string, now: Date): Promise<DataExportRequest | null>;
  /** PENDING rows oldest first, for the job. */
  findPending(limit: number): Promise<DataExportRequest[]>;
  markReady(id: string, patch: { fileId: string; readyAt: Date; expiresAt: Date }): Promise<DataExportRequest>;
  markFailed(id: string, error: string): Promise<DataExportRequest>;
  /** READY rows whose `expiresAt` has passed. */
  findExpired(now: Date): Promise<DataExportRequest[]>;
  markExpired(id: string): Promise<DataExportRequest>;
  /** EXPIRED and FAILED rows older than `before` — the row itself goes. */
  deleteFinishedBefore(before: Date): Promise<number>;

  /** Everything below is the person's own; the caller has already decided they may have it. */
  assemble(userId: string): Promise<AssembledExport | null>;
}

import type { QrCode, QrScan, Role } from '../../shared/database';

export type NewQrScan = {
  qrId: string;
  scannedById: string;
  role?: Role;
  latitude?: number;
  longitude?: number;
  action: string;
  /** GRANTED, PENDING_APPROVAL, EXPIRED, ALREADY_USED, NOT_AN_AGENT, USER_DECLINED. */
  outcome: string;
  distanceM?: number;
};

/** A scan with the person who made it, and their agent id when they have one. */
export type ScanWithScanner = QrScan & {
  scannedBy: {
    id: string;
    name: string | null;
    mobile: string;
    agentProfile: { displayId: string | null } | null;
  };
};

/** A scan with the code it was made on. */
export type ScanWithCode = QrScan & { qr: { id: string; type: QrCode['type']; refId: string } };

/* ── K-B1: the desk ─────────────────────────────────────────────── */

/** One row of `GET /qr` before the ref is named: the code, its scan count and its last scan. */
export type QrDeskRow = QrCode & { scansCount: number; lastScanAt: Date | null };

export type QrDeskFilter = {
  type?: QrCode['type'] | undefined;
  active?: boolean | undefined;
  refId?: string | undefined;
  /** Contains over refId and id. */
  q?: string | undefined;
};

export type ScansByFilter = {
  scannedById: string;
  outcome?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
};

/** A scan with who made it — `GET /qr/:qrId/scans`. */
export type ScanWithScannerName = QrScan & { scannedBy: { id: string; name: string | null; mobile: string } };

export interface QrRepository {
  createPlaceholder(data: {
    type: QrCode['type'];
    refId: string;
    allowedRoles: Role[];
    metadata?: Record<string, unknown>;
    token: string;
    expiresAt?: Date;
    latitude?: number;
    longitude?: number;
  }): Promise<QrCode>;
  setToken(qrId: string, token: string): Promise<unknown>;
  findById(qrId: string): Promise<QrCode | null>;
  /** The live code issued for a given subject, if any. */
  findActiveForSubject(type: QrCode['type'], refId: string): Promise<QrCode | null>;
  deactivate(qrId: string): Promise<unknown>;
  /** Expires every live code for a subject. */
  deactivateForSubject(type: QrCode['type'], refId: string): Promise<unknown>;
  logScan(data: NewQrScan): Promise<QrScan>;
  findScans(qrId: string): Promise<QrScan[]>;
  /** Every scan of every code a subject ever had — the owner's own log. */
  findScansForSubject(type: QrCode['type'], refId: string): Promise<ScanWithScanner[]>;
  /** Every scan one person made, each with its code — ops' view of an agent. */
  findScansByScanner(userId: string): Promise<ScanWithCode[]>;
  findScanById(scanId: string): Promise<QrScan | null>;
  /* K-B1: the desk. */
  /** One page of codes, newest first, with the scan count and last scan on each. */
  findDeskPage(filter: QrDeskFilter, page: { skip: number; take: number }): Promise<{ rows: QrDeskRow[]; total: number }>;
  /** Rows per type, with the type facet removed, for the chips. */
  countDeskByType(filter: Omit<QrDeskFilter, 'type'>): Promise<{ type: QrCode['type']; count: number }[]>;
  /** One code's scans, paged, with the scanner's name; the counts are per outcome with the outcome facet removed. */
  findScansPage(
    qrId: string,
    filter: { outcome?: string | undefined },
    page: { skip: number; take: number },
  ): Promise<{ rows: ScanWithScannerName[]; total: number; counts: Record<string, number> }>;
  /** D6 + K-B1: one person's scans, narrowed by outcome and window. */
  findScansByScannerFiltered(filter: ScansByFilter): Promise<ScanWithCode[]>;
  /** The scan on this code that is waiting for its owner's decision, if any. */
  findPendingScan(qrId: string): Promise<QrScan | null>;
  updateScan(scanId: string, data: { outcome: string; decidedAt?: Date; grantId?: string }): Promise<QrScan>;
}

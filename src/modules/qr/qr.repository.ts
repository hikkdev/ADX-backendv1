import type { QrCode, QrScan, Role } from '../../shared/database';

export type NewQrScan = {
  qrId: string;
  scannedById: string;
  role?: Role;
  latitude?: number;
  longitude?: number;
  action: string;
};

export interface QrRepository {
  createPlaceholder(data: {
    type: QrCode['type'];
    refId: string;
    allowedRoles: Role[];
    metadata?: Record<string, unknown>;
    token: string;
  }): Promise<QrCode>;
  setToken(qrId: string, token: string): Promise<unknown>;
  findById(qrId: string): Promise<QrCode | null>;
  /** The live code issued for a given subject, if any. */
  findActiveForSubject(type: QrCode['type'], refId: string): Promise<QrCode | null>;
  deactivate(qrId: string): Promise<unknown>;
  /** Expires every live code for a subject. */
  deactivateForSubject(type: QrCode['type'], refId: string): Promise<unknown>;
  logScan(data: NewQrScan): Promise<unknown>;
  findScans(qrId: string): Promise<QrScan[]>;
}

import type { RefreshToken } from '../../../shared/database';

export type SessionMeta = { userAgent?: string; ipAddress?: string };

export type ActiveSession = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
};

export interface TokensRepository {
  create(data: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    meta: SessionMeta;
  }): Promise<unknown>;
  findByHash(tokenHash: string): Promise<RefreshToken | null>;
  revokeById(id: string): Promise<unknown>;
  revokeByHash(tokenHash: string): Promise<unknown>;
  revokeAllForUser(userId: string): Promise<unknown>;
  listActive(userId: string): Promise<ActiveSession[]>;
  revokeSessionForUser(sessionId: string, userId: string): Promise<number>;
}

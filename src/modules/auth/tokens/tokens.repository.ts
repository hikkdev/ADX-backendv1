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
  }): Promise<{ id: string }>;
  findByHash(tokenHash: string): Promise<RefreshToken | null>;
  revokeById(id: string): Promise<unknown>;
  revokeByHash(tokenHash: string): Promise<unknown>;
  revokeAllForUser(userId: string): Promise<unknown>;
  /** E6: every open session but the one named — "sign out my other devices". */
  revokeOthersForUser(userId: string, keepSessionId: string): Promise<number>;
  listActive(userId: string): Promise<ActiveSession[]>;
  revokeSessionForUser(sessionId: string, userId: string): Promise<number>;
}

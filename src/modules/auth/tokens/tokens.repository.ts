import type { RefreshToken } from '../../../shared/database';

export type SessionMeta = { userAgent?: string; ipAddress?: string };

/** SL-1: where the address resolved to, when it did. */
export type SessionLocation = { city: string | null; region: string | null; country: string | null };

export type ActiveSession = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  /** SL-1: null until the lookup lands, and when the address is private or the lookup is off. */
  city: string | null;
  region: string | null;
  country: string | null;
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
  /** Matches on the hash; the row comes back without it (the global omit). */
  findByHash(tokenHash: string): Promise<Omit<RefreshToken, 'tokenHash'> | null>;
  revokeById(id: string): Promise<unknown>;
  revokeByHash(tokenHash: string): Promise<unknown>;
  revokeAllForUser(userId: string): Promise<unknown>;
  /** E6: every open session but the one named — "sign out my other devices". */
  revokeOthersForUser(userId: string, keepSessionId: string): Promise<number>;
  listActive(userId: string): Promise<ActiveSession[]>;
  /** SL-1: the lookup landed after the session was opened. */
  setLocation(sessionId: string, location: SessionLocation): Promise<void>;
  revokeSessionForUser(sessionId: string, userId: string): Promise<number>;
}

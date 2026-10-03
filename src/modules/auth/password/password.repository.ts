import type { PasswordResetToken } from '../../../shared/database';

export interface PasswordRepository {
  /** Expires any previous unused reset tokens for this user. */
  expireOutstandingResetTokens(userId: string): Promise<unknown>;
  createResetToken(data: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<unknown>;
  /** Matches on the hash; the row comes back without it (the global omit). */
  findUsableResetToken(tokenHash: string): Promise<Omit<PasswordResetToken, 'tokenHash'> | null>;
  markResetTokenUsed(id: string): Promise<unknown>;
}

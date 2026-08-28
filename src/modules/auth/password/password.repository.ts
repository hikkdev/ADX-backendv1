import type { PasswordResetToken } from '../../../shared/database';

export interface PasswordRepository {
  /** Expires any previous unused reset tokens for this user. */
  expireOutstandingResetTokens(userId: string): Promise<unknown>;
  createResetToken(data: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<unknown>;
  findUsableResetToken(tokenHash: string): Promise<PasswordResetToken | null>;
  markResetTokenUsed(id: string): Promise<unknown>;
}

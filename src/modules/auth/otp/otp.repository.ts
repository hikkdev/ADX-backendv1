import type { Otp, OtpPurpose, User } from '../../../shared/database';

export interface OtpRepository {
  findUserByMobile(mobile: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<User | null>;
  /** Self-registration: creates the user so the OTP can reference it. */
  createPublisherUser(mobile: string): Promise<User>;
  /** Local-only allowlist self-provisioning. */
  createDevLoginUser(mobile: string): Promise<User>;
  /** Expires any outstanding unverified codes for this recipient + purpose. */
  expireOutstandingByMobile(mobile: string, purpose: OtpPurpose): Promise<unknown>;
  expireOutstandingByEmail(email: string): Promise<unknown>;
  createForMobile(data: {
    userId: string;
    mobile: string;
    purpose: OtpPurpose;
    codeHash: string;
    expiresAt: Date;
  }): Promise<unknown>;
  createForEmail(data: {
    userId: string;
    email: string;
    codeHash: string;
    expiresAt: Date;
  }): Promise<unknown>;
  findLatestUnverifiedByMobile(mobile: string, purpose: OtpPurpose): Promise<Otp | null>;
  findLatestUnverifiedByEmail(email: string): Promise<Otp | null>;
  incrementAttempts(otpId: string): Promise<unknown>;
  markVerified(otpId: string): Promise<unknown>;
}

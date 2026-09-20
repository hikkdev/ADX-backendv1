import type { Otp, OtpPurpose, Role, User } from '../../../shared/database';

export interface OtpRepository {
  findUserByMobile(mobile: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<User | null>;
  /** Legacy publisher-app registration: creates the user WITH the PUBLISHER role. */
  createPublisherUser(mobile: string, displayId: string): Promise<User>;
  /**
   * Local-only allowlist self-provisioning, as the role the entry named.
   * Agent roles get an agent profile; an ADMIN gets a placeholder email so
   * the console's second factor has a channel after the mobile door has
   * spent SMS (Q-B); the rest are the role alone.
   */
  createDevLoginUser(mobile: string, role: Role, displayId: string): Promise<User>;
  /**
   * Register-or-login: a User with no role and no party, created at send time
   * so the OTP row has something to reference. Stays a ghost until
   * `markMobileVerified` runs; the party comes from POST /users/me/party.
   */
  createUnregisteredUser(mobile: string, displayId: string): Promise<User>;
  /** Stamps `mobileVerifiedAt` the first time a code is verified; a no-op after. */
  markMobileVerified(userId: string): Promise<unknown>;
  /** Expires any outstanding unverified codes for this recipient + purpose. */
  expireOutstandingByMobile(mobile: string, purpose: OtpPurpose): Promise<unknown>;
  /** K-B1: `purpose` defaults to LOGIN — the email login code; a contact verification names its own. */
  expireOutstandingByEmail(email: string, purpose?: OtpPurpose): Promise<unknown>;
  /**
   * K-B1: every live code the account holds, whatever the recipient. Run
   * after the sign-in number moves, so a LOGIN code already sent to the old
   * number cannot still sign this account in through it.
   */
  expireOutstandingForUser(userId: string): Promise<unknown>;
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
    /** K-B1: LOGIN when absent. */
    purpose?: OtpPurpose;
  }): Promise<unknown>;
  findLatestUnverifiedByMobile(mobile: string, purpose: OtpPurpose): Promise<Otp | null>;
  findLatestUnverifiedByEmail(email: string, purpose?: OtpPurpose): Promise<Otp | null>;
  /** K-B1: whether this account has ever proved this address with a code — any purpose. */
  hasVerifiedEmail(userId: string, email: string): Promise<boolean>;
  incrementAttempts(otpId: string): Promise<unknown>;
  markVerified(otpId: string): Promise<unknown>;
}

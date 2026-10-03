import type { EmailSignup, Otp, OtpPurpose, Role, UserRead } from '../../../shared/database';

/** ED-1: who holds an address — an account's primary, or a contact row of any account. */
export type EmailHolder = { which: 'PRIMARY' | 'CONTACT'; userId: string };

export interface OtpRepository {
  findUserByMobile(mobile: string): Promise<UserRead | null>;
  findUserByEmail(email: string): Promise<UserRead | null>;
  /** Legacy publisher-app registration: creates the user WITH the PUBLISHER role. */
  createPublisherUser(mobile: string, displayId: string): Promise<UserRead>;
  /**
   * Local-only allowlist self-provisioning, as the role the entry named.
   * Agent roles get an agent profile; an ADMIN gets a placeholder email so
   * the console's second factor has a channel after the mobile door has
   * spent SMS (Q-B); the rest are the role alone.
   */
  createDevLoginUser(mobile: string, role: Role, displayId: string): Promise<UserRead>;
  /**
   * Register-or-login: a User with no role and no party, created at send time
   * so the OTP row has something to reference. Stays a ghost until
   * `markMobileVerified` runs; the party comes from POST /users/me/party.
   */
  createUnregisteredUser(mobile: string, displayId: string): Promise<UserRead>;
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

  /* ED-1: the email door. */
  findUserById(userId: string): Promise<UserRead | null>;
  /** The one live row for an address that asked to join before it had an account. */
  findEmailSignup(email: string): Promise<EmailSignup | null>;
  /** A fresh code replaces whatever the address held — attempts back to zero, unverified. */
  upsertEmailSignup(data: { email: string; codeHash: string; expiresAt: Date }): Promise<Omit<EmailSignup, 'codeHash'>>;
  incrementEmailSignupAttempts(id: string): Promise<unknown>;
  markEmailSignupVerified(id: string): Promise<unknown>;
  deleteEmailSignup(id: string): Promise<unknown>;
  /** Stamps `emailVerifiedAt` when this address is the account's primary and the stamp is empty; a no-op otherwise. */
  markEmailVerified(userId: string, email: string): Promise<unknown>;
  /** The proven address becomes the primary, stamped now — the attach at the end of an email sign-up. */
  setPrimaryEmailVerified(userId: string, email: string): Promise<unknown>;
  /** Null when the address is free of every account's primary and every contact row. */
  findEmailHolder(email: string): Promise<EmailHolder | null>;
}

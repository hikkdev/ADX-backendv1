import { dateOfBirthToString } from '../../shared/validation';
import type { Role, User } from '../../shared/database';

type WithRoles = User & { roles: { role: Role }[] };
type ProfileRow = WithRoles & {
  agentProfile: unknown;
  publisherProfile: unknown;
  advertiserProfile?: unknown;
};

/**
 * GET /users/me and PATCH /users/me.
 *
 * Note this reports `hasPassword`, spelled correctly — unlike the mobile-OTP
 * login payload in the auth module, which returns `hashPassword`. Both are part
 * of the API; see modules/auth/auth.mapper.ts.
 */
export function profilePayload(user: ProfileRow) {
  return {
    id: user.id,
    // QR-4: the person's own ADX-… id and their two names.
    displayId: user.displayId,
    mobile: user.mobile,
    name: user.name,
    firstName: user.firstName,
    lastName: user.lastName,
    // QR-5: the person's date of birth (YYYY-MM-DD) and gender.
    dateOfBirth: dateOfBirthToString(user.dateOfBirth),
    gender: user.gender,
    // QR-6: the terms and privacy consent — null until the first screen after
    // the OTP is answered; the app gates on it.
    consentAcceptedAt: user.consentAcceptedAt,
    consentTermsVersion: user.consentTermsVersion,
    consentPrivacyVersion: user.consentPrivacyVersion,
    email: user.email,
    avatarUrl: user.avatarUrl,
    hasPassword: !!user.passwordHash,
    language: user.language,
    // Lot A (Q21): a closed account is kept, not deleted, so every read that
    // draws a person has to be able to say the account is closed.
    closedAt: user.closedAt,
    closeReason: user.closeReason,
    // E6: the account facts the console's user page prints beside the profile.
    isActive: user.isActive,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    // E11-1: stamped by the public unsubscribe link, cleared by the person's
    // own POST /users/me/email-resubscribe; null while ADX's email still goes.
    emailUnsubscribedAt: user.emailUnsubscribedAt,
    roles: user.roles.map((r) => r.role),
    agentProfile: user.agentProfile,
    publisherProfile: user.publisherProfile,
    advertiserProfile: user.advertiserProfile ?? null,
  };
}

/**
 * E6: `GET /users/me` adds the second-factor state — when it was required and
 * how much of the email backup is left — so the app can say why a challenge
 * is coming and when the fallback comes back.
 */
export function twoFactorState(user: User) {
  return {
    twoFactorRequiredAt: user.twoFactorRequiredAt,
    emailOtpFallbackCount: user.emailOtpFallbackCount,
    emailOtpFallbackResetAt: user.emailOtpFallbackResetAt,
  };
}

/**
 * Lot K2: the second-factor summary the admin reads carry — `GET /users/:id`
 * and every `GET /users` row. `method` is the factor that will be asked for
 * at the next sign-in: the app once enrolled, else SMS for an account the
 * second factor is on for, else null.
 */
export type TwoFactorSummary = {
  required: boolean;
  method: 'AUTHENTICATOR' | 'SMS' | null;
  enrolledAt: Date | null;
  recoveryCodesLeft: number;
};

export function twoFactorSummary(
  user: Pick<User, 'twoFactorRequiredAt' | 'totpSecretEnc' | 'totpEnrolledAt'>,
  recoveryCodesLeft: number,
): TwoFactorSummary {
  const required = user.twoFactorRequiredAt !== null;
  const enrolled = Boolean(user.totpSecretEnc && user.totpEnrolledAt);
  return {
    required,
    method: enrolled ? 'AUTHENTICATOR' : required ? 'SMS' : null,
    enrolledAt: enrolled ? user.totpEnrolledAt : null,
    recoveryCodesLeft: enrolled ? recoveryCodesLeft : 0,
  };
}

/**
 * GET /users — the admin list.
 *
 * Deliberately omits `hasPassword` and `avatarUrl` and adds `isActive`,
 * `lastLoginAt`, timestamps, placed orders and onboarding submissions.
 */
export function adminListPayload(
  user: ProfileRow & {
    placedOrders: unknown;
    onboardingSubmissions: unknown;
    roleConfig?: { roleConfig: { id: string; name: string } } | null;
  },
  /** Lot K2: unspent recovery codes, from `auth.recoveryCodesLeftFor` — 0 when unknown. */
  recoveryCodesLeft = 0,
) {
  return {
    // E6: the console role, or null.
    roleConfig: user.roleConfig?.roleConfig ? { id: user.roleConfig.roleConfig.id, name: user.roleConfig.roleConfig.name } : null,
    // Lot K2: the second factor the next sign-in asks for. Added fields only.
    twoFactor: twoFactorSummary(user, recoveryCodesLeft),
    id: user.id,
    mobile: user.mobile,
    name: user.name,
    email: user.email,
    language: user.language,
    isActive: user.isActive,
    closedAt: user.closedAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    roles: user.roles.map((r) => r.role),
    agentProfile: user.agentProfile,
    publisherProfile: user.publisherProfile,
    placedOrders: user.placedOrders,
    onboardingSubmissions: user.onboardingSubmissions,
  };
}

/** PATCH /users/:id — a narrower echo than either payload above. */
export function adminUpdatePayload(user: WithRoles) {
  return {
    id: user.id,
    mobile: user.mobile,
    name: user.name,
    email: user.email,
    isActive: user.isActive,
    roles: user.roles.map((r) => r.role),
  };
}

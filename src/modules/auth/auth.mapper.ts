import type { Role } from '../../shared/database';
import type { LoginUser, PublisherLoginUser } from './auth.repository';

/**
 * Login response payloads — one function per endpoint, written out in full.
 *
 * They are deliberately NOT folded into a shared builder, because the five
 * login endpoints do not return the same shape and unifying them would change
 * the API:
 *
 *   - mobile OTP returns `hashPassword` — a long-standing typo for
 *     `hasPassword`. Clients read that key, so renaming it is an API change and
 *     is out of scope for a structure-only refactor.
 *   - email OTP returns `hasPassword`, computed the same way.
 *   - password login hardcodes `hasPassword: true`: reaching that point proves
 *     a hash exists.
 *   - publisher login returns neither field, omits `avatarUrl`, `agentProfile`
 *     and `advertiserProfile`, and prefers a just-submitted name over the
 *     stored one.
 *
 * The four full payloads carry both party profiles. A user with neither is a
 * register-or-login signup who has not chosen a type yet; the app sends them
 * to POST /users/me/party.
 *
 * Writing them out separately keeps each difference visible instead of hidden
 * behind an options argument.
 */

/** POST /auth/verify-otp. Note `hashPassword` — see above. */
export function mobileOtpLoginUser(user: LoginUser, roles: Role[]) {
  return {
    id: user.id,
    mobile: user.mobile,
    name: user.name,
    email: user.email,
    language: user.language,
    avatarUrl: user.avatarUrl,
    hashPassword: !!user.passwordHash,
    roles,
    agentProfile: user.agentProfile,
    publisherProfile: user.publisherProfile,
    advertiserProfile: user.advertiserProfile,
  };
}

/** POST /auth/verify-otp-email. */
export function emailOtpLoginUser(user: LoginUser, roles: Role[]) {
  return {
    id: user.id,
    mobile: user.mobile,
    name: user.name,
    email: user.email,
    language: user.language,
    avatarUrl: user.avatarUrl,
    hasPassword: !!user.passwordHash,
    roles,
    agentProfile: user.agentProfile,
    publisherProfile: user.publisherProfile,
    advertiserProfile: user.advertiserProfile,
  };
}

/** POST /auth/login-password. Reaching this point proves a hash exists. */
export function passwordLoginUser(user: LoginUser, roles: Role[]) {
  return {
    id: user.id,
    mobile: user.mobile,
    name: user.name,
    email: user.email,
    language: user.language,
    avatarUrl: user.avatarUrl,
    hasPassword: true,
    roles,
    agentProfile: user.agentProfile,
    publisherProfile: user.publisherProfile,
    advertiserProfile: user.advertiserProfile,
  };
}

/**
 * POST /auth/google.
 *
 * `hasPassword` is computed, not hardcoded: reaching this point proves Google
 * vouched for the address, which says nothing about whether the ADX account
 * also has a password. The admin UI uses the flag to decide whether to offer
 * "set a password", so a Google-only account must report false.
 */
export function googleLoginUser(user: LoginUser, roles: Role[]) {
  return {
    id: user.id,
    mobile: user.mobile,
    name: user.name,
    email: user.email,
    language: user.language,
    avatarUrl: user.avatarUrl,
    hasPassword: !!user.passwordHash,
    roles,
    agentProfile: user.agentProfile,
    publisherProfile: user.publisherProfile,
    advertiserProfile: user.advertiserProfile,
  };
}

/**
 * POST /auth/2fa/verify — the second half of an admin's password or Google
 * sign-in.
 *
 * `hasPassword` is computed rather than hardcoded: the challenge that led here
 * may have come from Google, and the console uses the flag to decide whether
 * to offer "set a password".
 */
export function twoFactorLoginUser(user: LoginUser, roles: Role[]) {
  return {
    id: user.id,
    mobile: user.mobile,
    name: user.name,
    email: user.email,
    language: user.language,
    avatarUrl: user.avatarUrl,
    hasPassword: !!user.passwordHash,
    roles,
    agentProfile: user.agentProfile,
    publisherProfile: user.publisherProfile,
    advertiserProfile: user.advertiserProfile,
  };
}

/** POST /auth/publisher/verify-otp. */
export function publisherLoginUser(
  user: PublisherLoginUser,
  roles: Role[],
  submittedName?: string,
) {
  return {
    id: user.id,
    mobile: user.mobile,
    name: submittedName ?? user.name,
    email: user.email,
    language: user.language,
    roles,
    publisherProfile: user.publisherProfile,
  };
}

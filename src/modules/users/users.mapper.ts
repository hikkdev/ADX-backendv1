import { dateOfBirthToString } from '../../shared/validation';
import { entityTypeFacts, type EntityTypeParty } from '../../shared/kyc-state';
import type { KycEntityType, Role, User } from '../../shared/database';

type WithRoles = User & { roles: { role: Role }[] };
type ProfileRow = WithRoles & {
  agentProfile: unknown;
  publisherProfile: unknown;
  advertiserProfile?: unknown;
};

/**
 * Phase D (1 Oct 2026): a party row leaves here with its legal form as every
 * other read answers it — `entityType` the effective value (the stored one,
 * else what the legacy `type` settles, else null) and `entityTypeStored` —
 * so `/users/me` never says null where `/publishers/me` says INDIVIDUAL.
 */
function withEntityType(party: EntityTypeParty, profile: unknown): unknown {
  if (!profile || typeof profile !== 'object') return profile ?? null;
  const row = profile as { entityType?: KycEntityType | null; type?: string | null };
  return { ...row, ...entityTypeFacts(party, row) };
}

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
    // ED-1: both stamps — every account proves its number and its email;
    // the apps and the website route to whichever step is still missing.
    mobileVerifiedAt: user.mobileVerifiedAt,
    emailVerifiedAt: user.emailVerifiedAt,
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
    publisherProfile: withEntityType('PUBLISHER', user.publisherProfile),
    advertiserProfile: withEntityType('ADVERTISER', user.advertiserProfile),
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

/** One business or profile a login holds, as the users list names it. */
export type ListPartyKind = 'PUBLISHER' | 'ADVERTISER' | 'PRINT_PARTNER' | 'AGENT' | 'EMPLOYEE';
export type ListParty = { kind: ListPartyKind; id: string; name: string; displayId: string | null };

type PartyFields = { id?: unknown; name?: unknown; businessName?: unknown; displayId?: unknown; designation?: unknown };

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * 2 Oct 2026 (the owner: "a lot of users ... as if they're not linked at all"):
 * the businesses and profiles behind a login, so the users list can say
 * "Publisher · Skyline Outdoor Media" under "Vikram Rao"; the directories
 * and the KYC queues name the business, the users list names the person.
 * Publisher, advertiser and print shop by their business name; the agent by
 * the business they trade as, else the person; the employee by their
 * designation, else the person. In that order; absent profiles are skipped.
 */
export function listPartiesOf(user: {
  name: string | null;
  publisherProfile?: unknown;
  advertiserProfile?: unknown;
  printPartner?: unknown;
  agentProfile?: unknown;
  employeeProfile?: unknown;
}): ListParty[] {
  const person = text(user.name);
  const sources: [ListPartyKind, unknown, (row: PartyFields) => string | null, string][] = [
    ['PUBLISHER', user.publisherProfile, (row) => text(row.name), 'Publisher'],
    ['ADVERTISER', user.advertiserProfile, (row) => text(row.name), 'Advertiser'],
    ['PRINT_PARTNER', user.printPartner, (row) => text(row.name), 'Print partner'],
    ['AGENT', user.agentProfile, (row) => text(row.businessName) ?? person, 'Agent'],
    ['EMPLOYEE', user.employeeProfile, (row) => text(row.designation) ?? person, 'Employee'],
  ];
  const parties: ListParty[] = [];
  for (const [kind, profile, nameOf, fallback] of sources) {
    if (!profile || typeof profile !== 'object') continue;
    const row = profile as PartyFields;
    if (typeof row.id !== 'string') continue;
    parties.push({ kind, id: row.id, name: nameOf(row) ?? fallback, displayId: text(row.displayId) });
  }
  return parties;
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
    employeeProfile?: unknown;
    printPartner?: unknown;
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
    // 28 Sep 2026: the person's own ADX-… id, on the list as on the detail.
    displayId: user.displayId,
    mobile: user.mobile,
    name: user.name,
    email: user.email,
    language: user.language,
    isActive: user.isActive,
    closedAt: user.closedAt,
    // 2 Oct 2026: an erased account is closed too; the console's Status says the stronger word.
    erasedAt: user.erasedAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    roles: user.roles.map((r) => r.role),
    // 2 Oct 2026: the businesses and profiles this login holds; an added field only.
    parties: listPartiesOf(user),
    agentProfile: user.agentProfile,
    publisherProfile: withEntityType('PUBLISHER', user.publisherProfile),
    placedOrders: user.placedOrders,
    onboardingSubmissions: user.onboardingSubmissions,
  };
}

/** PATCH /users/:id — a narrower echo than either payload above. */
export function adminUpdatePayload(user: Pick<WithRoles, 'id' | 'mobile' | 'name' | 'email' | 'isActive' | 'roles'>) {
  return {
    id: user.id,
    mobile: user.mobile,
    name: user.name,
    email: user.email,
    isActive: user.isActive,
    roles: user.roles.map((r) => r.role),
  };
}

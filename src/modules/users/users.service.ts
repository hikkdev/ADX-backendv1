import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity, type AuditDiff } from '../../shared/audit';
import { logger } from '../../shared/logging';
import { expireOutstandingOtpsForUser, normalizeMobile, requireTwoFactorFor, revokeSessions, sendPasswordResetLink } from '../auth';
import { assertNotLastSuperAdmin, assignRoleConfig, getRoleConfigForUser } from '../access-control';
import type { AdvertiserType, PublisherType, Role } from '../../shared/database';
import { registerPublisher } from '../publishers';
import { registerAdvertiser } from '../advertisers';
import { prismaUsersRepository as repository } from './prisma-users.repository';
import type { AdminListFilter, AdminUserDetail, WithRoles } from './users.repository';
import { assertIdentityFree } from './users-identity';
import type {
  AccountType,
  ChoosePartyInput,
  Party,
  UpdateProfileInput,
  UpdateUserByAdminInput,
} from './users.schema';

/**
 * DR 08's three account types, in each side's own legal-form vocabulary.
 *
 * The schema carries four vocabularies for this one question (PublisherType,
 * AdvertiserType, the KYC entity kinds, the console's). This is the one
 * mapping from the question the user is actually asked. ORGANISATION lands on
 * NGO for both sides because that is the closest either has; POLITICAL and
 * AGENCY are refinements each side's own profile step can make later.
 */
const PUBLISHER_TYPE: Record<AccountType, PublisherType> = {
  INDIVIDUAL: 'INDIVIDUAL',
  BUSINESS: 'BUSINESS',
  ORGANISATION: 'NGO',
};
const ADVERTISER_TYPE: Record<AccountType, AdvertiserType> = {
  INDIVIDUAL: 'INDIVIDUAL',
  BUSINESS: 'COMMERCIAL',
  ORGANISATION: 'NGO',
};

type PartyProfile = { id: string; displayId: string | null };

export type PartyChoice = {
  party: Party;
  accountType: AccountType;
  profileId: string;
  displayId: string | null;
  /** True when this call opened (or claimed) the party; false when it already existed. */
  created: boolean;
};

/**
 * Which side of the marketplace this account is on — the first question after
 * the first OTP, and the call that mints the PUB- or ADV- identifier.
 *
 * Idempotent per side: asking again for a side the account already has
 * returns it. An account may hold both sides; the app shows the publisher one
 * where it does. The party modules own the rows and the identifiers; this
 * only asks them and grants the role that lets the rest of the API in.
 */
export async function chooseParty(userId: string, input: ChoosePartyInput): Promise<PartyChoice> {
  const user = await repository.findProfile(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const { party, accountType } = input;
  const name = input.name ?? user.name ?? undefined;

  if (party === 'PUBLISHER') {
    const existing = user.publisherProfile as PartyProfile | null;
    if (existing) {
      return { party, accountType, profileId: existing.id, displayId: existing.displayId, created: false };
    }
    const { publisher, created } = await registerPublisher(userId, {
      name,
      type: PUBLISHER_TYPE[accountType],
    });
    await repository.grantRole(userId, 'PUBLISHER');
    return { party, accountType, profileId: publisher.id, displayId: publisher.displayId, created };
  }

  const existing = user.advertiserProfile as PartyProfile | null;
  if (existing) {
    return { party, accountType, profileId: existing.id, displayId: existing.displayId, created: false };
  }
  // Until the profile step names it, the account is known by its number.
  const advertiser = await registerAdvertiser({
    userId,
    name: name ?? user.mobile,
    type: ADVERTISER_TYPE[accountType],
  });
  await repository.grantRole(userId, 'ADVERTISER');
  return { party, accountType, profileId: advertiser.id, displayId: advertiser.displayId, created: true };
}

export async function getProfile(userId: string) {
  const user = await repository.findProfile(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  return user;
}

/**
 * The person's own profile. K-B1: the email is an identity — lower-cased,
 * and when it actually moves it runs the same one-value-one-account rule the
 * desk's editor does (409 `CONTACT_TAKEN` with `details.which`): without it a
 * person could take an address that is another account's contact row, which
 * no database constraint spans, or the same address in another case.
 */
export async function updateProfile(userId: string, data: UpdateProfileInput) {
  if (data.email === undefined) return repository.updateProfile(userId, data);
  const email = data.email.trim().toLowerCase();
  const current = await repository.findById(userId);
  if (!current) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  if (email !== current.email) await assertIdentityFree('EMAIL', email, { ownPrimaryOf: userId });
  return repository.updateProfile(userId, { ...data, email });
}

/**
 * E11-1: the person's own choice to have ADX's email again — the mirror of
 * the public unsubscribe link (`notifications`' `unsubscribe`), which stamps
 * `User.emailUnsubscribedAt`; this clears it. 409 when there was no stamp:
 * the screen offered an undo for a state the account is not in.
 */
export async function resubscribeEmail(userId: string): Promise<{ emailUnsubscribedAt: null }> {
  const cleared = await repository.clearEmailUnsubscribed(userId);
  if (!cleared) {
    throw new ApiError(409, 'NOT_UNSUBSCRIBED', 'You are already receiving email from ADX');
  }
  return { emailUnsubscribedAt: null };
}

export async function listUsersForAdmin(filter: AdminListFilter = {}) {
  return repository.findAllForAdmin(filter);
}

/** K-B1: rows per state beside the list, counted with the state facet removed so the chips stay a way out. */
export async function countUsersByState(filter: AdminListFilter = {}) {
  const { state: _state, sort: _sort, ...rest } = filter;
  return repository.countByState(rest);
}

/**
 * E6: `POST /users/:id/reset-password` — the desk sends somebody the same
 * reset link `POST /auth/forgot-password` would, without the enumeration
 * dance: 409 `NO_EMAIL` when the account has no address to send it to.
 */
export async function sendResetLinkByAdmin(userId: string): Promise<{ email: string }> {
  const user = await repository.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  if (!user.email) throw new ApiError(409, 'NO_EMAIL', 'This account has no email address to send a reset link to');
  await sendPasswordResetLink(user.id, user.email);
  return { email: user.email };
}

/** What the editor answers beside the row: the diff the audit row carries. */
export type AdminEdit = { user: WithRoles; diff: AuditDiff; movedIdentity: ('mobile' | 'email')[] };

/**
 * Admin edit of another account.
 *
 * `actingUserId` is needed for the self-deactivation guard: an admin locking
 * themselves out would need another admin to undo it.
 *
 * K-B1: `language` and `avatarUrl` beside the four; a `reason` whenever the
 * mobile OR the email actually moves; a value that collides with another
 * account's primary or with any contact row answers 409 `CONTACT_TAKEN`
 * with `details.which` (PRIMARY | CONTACT) and whose. The diff of every
 * field that changed comes back for the `USER_UPDATED_BY_ADMIN` row.
 */
export async function updateUserByAdmin(
  userId: string,
  actingUserId: string,
  data: UpdateUserByAdminInput,
): Promise<AdminEdit> {
  const target = await repository.findWithRoles(userId);
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  if (data.isActive === false && userId === actingUserId) {
    throw new ApiError(400, 'BAD_REQUEST', 'You cannot deactivate your own account');
  }
  // Lot K2: the last active super admin does not leave by this door either.
  if (data.isActive === false && target.isActive) await assertNotLastSuperAdmin(userId, 'DEACTIVATE');

  const { mobile: rawMobile, email: rawEmail, reason, roles: requestedRoles, ...rest } = data;

  // M-B: the roles patch is the whole list. Dropping ADMIN from the last
  // active super admin is refused before anything is written — the same
  // LAST_SUPER_ADMIN rule as deactivation, deletion and closure.
  const currentRoles = target.roles.map((r) => r.role);
  const nextRoles = requestedRoles ? ([...new Set(requestedRoles)] as Role[]) : null;
  const rolesAdded = nextRoles ? nextRoles.filter((role) => !currentRoles.includes(role)) : [];
  const rolesRemoved = nextRoles ? currentRoles.filter((role) => !nextRoles.includes(role)) : [];
  const rolesChange = rolesAdded.length > 0 || rolesRemoved.length > 0;
  if (rolesRemoved.includes('ADMIN')) await assertNotLastSuperAdmin(userId, 'DEMOTE');
  const mobile = rawMobile ? normalizeMobile(rawMobile) : undefined;
  const email = rawEmail ? rawEmail.trim().toLowerCase() : undefined;
  const movingNumber = mobile !== undefined && mobile !== target.mobile;
  const movingEmail = email !== undefined && email !== target.email;

  if (movingNumber) {
    // Lot A: an admin's own number moves through /auth/change-mobile, from
    // their own device, with an OTP to each end. Letting the desk move it
    // would make one compromised console account enough to take over every
    // other one — change the number, then sign in as them.
    if (target.roles.some((r) => r.role === 'ADMIN')) {
      throw new ApiError(
        409,
        'USE_SELF_SERVICE_FLOW',
        'An admin changes their own number from their own device, at /auth/change-mobile.',
      );
    }
    if (!reason) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Say why this number is being changed.');
    }
  }
  if (movingEmail && !reason) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Say why this email is being changed.');
  }

  // Uniqueness is only re-checked when the value actually changes, so saving a
  // form unchanged never trips a conflict against the user's own row. K-B1:
  // a contact row anywhere holds the value too.
  if (movingNumber && mobile) await assertIdentityFree('PHONE', mobile);
  if (movingEmail && email) await assertIdentityFree('EMAIL', email);

  const patch = { ...rest, ...(mobile ? { mobile } : {}), ...(email ? { email } : {}) };

  if (rolesChange && nextRoles) {
    // A role config is console access and only an admin holds one, so it
    // goes before the ADMIN row does — through access-control's own door,
    // which audits and revokes as it always does.
    if (rolesRemoved.includes('ADMIN') && (await getRoleConfigForUser(userId))) {
      await assignRoleConfig(userId, actingUserId, { roleConfigId: null });
    }
    await repository.replaceRoles(userId, nextRoles);
    if (rolesAdded.some((role) => role === 'AGENT_PUBLISHER' || role === 'AGENT_ADVERTISER')) {
      await repository.ensureAgentProfile(userId);
    }
    if (rolesAdded.includes('ADMIN')) await requireTwoFactorFor(userId);
  }

  const updated = await repository.updateByAdmin(userId, patch);
  const diff = auditDiff(target, updated, Object.keys(patch));
  if (rolesChange) diff['roles'] = { before: currentRoles, after: updated.roles.map((r) => r.role) };

  if (movingNumber) {
    // The number is the identity and the OTP destination; every session the
    // person holds was issued to the old one — and so was every live code:
    // login signs in by the code's userId, so a LOGIN code already sent to the
    // old number would still open the account for its whole lifetime. Best
    // effort, like completeMobileChange: nothing here can undo a swap that took.
    await revokeSessions(userId, 'MOBILE_CHANGED_BY_ADMIN');
    try {
      await expireOutstandingOtpsForUser(userId);
    } catch (err) {
      logger.warn('Outstanding OTPs were not expired after an admin mobile change', { userId, reason: err instanceof Error ? err.message : String(err) });
    }
    await logActivity(userId, 'MOBILE_CHANGED_BY_ADMIN', {
      module: 'users',
      targetType: 'User',
      targetId: userId,
      diff: auditDiff({ mobile: target.mobile }, { mobile: updated.mobile }, ['mobile']),
      metadata: { changedBy: actingUserId, reason },
    });
  }

  // A deactivated account keeps its access tokens for up to their whole
  // lifetime unless the marker is written — which is the window an admin
  // pressing "deactivate" believes they have just closed.
  if (data.isActive === false) {
    await revokeSessions(userId, 'ACCOUNT_DEACTIVATED');
  } else if (rolesChange) {
    // The roles are in the token: a change that leaves live sessions alone
    // has not taken effect for anybody already signed in.
    await revokeSessions(userId, 'ROLES_CHANGED');
  }

  return {
    user: updated,
    diff,
    movedIdentity: [...(movingNumber ? ['mobile' as const] : []), ...(movingEmail ? ['email' as const] : [])],
  };
}

/** Which activity action an admin edit records, based on what changed. */
export function adminUpdateAction(data: UpdateUserByAdminInput): string {
  if (data.isActive === false) return 'ACCOUNT_DEACTIVATED';
  if (data.isActive === true) return 'ACCOUNT_ACTIVATED';
  return 'PROFILE_UPDATED_BY_ADMIN';
}

/**
 * The five kinds of history that make an account a record rather than a row,
 * in the words the refusal uses.
 */
const HISTORY_LABELS: Record<keyof Awaited<ReturnType<typeof repository.findDeletionHistory>>, string> = {
  walletEntries: 'wallet entries',
  ledgerLegs: 'ledger entries',
  orders: 'orders',
  listings: 'listings',
  agreementAcceptances: 'accepted agreements',
  kycRecords: 'KYC records',
};

export async function deleteUser(userId: string, actingUserId: string) {
  if (userId === actingUserId) {
    throw new ApiError(400, 'BAD_REQUEST', 'You cannot delete your own account');
  }

  const user = await repository.findDeletionTarget(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const isAdmin = user.roles.some((r) => r.role === 'ADMIN');
  // Lot K2 (Lot K verifier): "the last Super Admin" is membership of the
  // system role, the same LAST_SUPER_ADMIN rule access-control applies on
  // role-config, deactivation and closure — not a count of ADMIN rows.
  if (isAdmin) await assertNotLastSuperAdmin(userId, 'DELETE');

  /*
   * Lot A: an account with money, work, inventory, a signed agreement or a KYC
   * record behind it is closed, never deleted. `deleteUserCascade` would take
   * the orders and the listings with it, and the ledger legs that balance
   * against ADX would be left describing a party that no longer exists. The
   * closure case is the path, and this refusal names it.
   */
  const history = await repository.findDeletionHistory(user);
  const found = (Object.keys(history) as (keyof typeof history)[])
    .filter((key) => history[key] > 0)
    .map((key) => ({ kind: key, label: HISTORY_LABELS[key], count: history[key] }));

  if (found.length > 0) {
    throw new ApiError(
      409,
      'USER_HAS_HISTORY',
      `This account has ${found.map((row) => `${row.count} ${row.label}`).join(', ')} behind it and cannot be deleted. Close it instead.`,
      { userId, has: found, closeWith: 'account closure' }
    );
  }

  await repository.deleteUserCascade(user);

  return { mobile: user.mobile, wasAdmin: isAdmin };
}

export async function createUser(input: {
  mobile: string;
  name?: string;
  email?: string;
  roles: Role[];
}) {
  const mobile = normalizeMobile(input.mobile);
  const email = input.email ? input.email.trim().toLowerCase() : undefined;

  // K-B1: a taken identity is any account's primary OR any contact row.
  await assertIdentityFree('PHONE', mobile);
  if (email) await assertIdentityFree('EMAIL', email);

  const user = await repository.createWithRoles({ ...input, mobile, ...(email ? { email } : {}) });

  // Lot A (Q25): the second factor is on for an admin from the moment the
  // account exists, not from the first time somebody remembers to turn it on.
  if (input.roles.includes('ADMIN')) await requireTwoFactorFor(user.id);

  return user;
}

/**
 * GET /users/:id — one account for the console, with the console role it
 * holds. `roleConfig` is null for an admin who has not been given one, which
 * the launch rule reads as "every permission"; the console says so.
 */
export async function getUserForAdmin(userId: string): Promise<{
  user: Awaited<ReturnType<typeof repository.findProfile>> & object;
  roleConfig: { id: string; name: string } | null;
  detail: AdminUserDetail;
}> {
  const user = await repository.findProfile(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  // K-B1: the counts and the party links, so the page can link across.
  const [roleConfig, detail] = await Promise.all([getRoleConfigForUser(userId), repository.findAdminDetail(userId)]);
  return { user, roleConfig, detail };
}

/**
 * Grants ADMIN only while no admin exists — the first-run escape hatch, which
 * is why the route is unauthenticated. Once any admin exists it is closed for
 * good and /users/roles takes over.
 */
export async function bootstrapAdmin(userId: string) {
  if (await repository.findAnyAdminRole()) {
    throw new ApiError(403, 'FORBIDDEN', 'Admin already exists — use /users/roles to assign roles');
  }
  await repository.grantAdmin(userId);
}

export async function assignRole(userId: string, role: Role) {
  await repository.grantRole(userId, role);

  // An agent role is meaningless without a profile to hang assignments off.
  if (role === 'AGENT_PUBLISHER' || role === 'AGENT_ADVERTISER') {
    await repository.ensureAgentProfile(userId);
  }

  // The roles are in the access token, so a grant that leaves live sessions
  // alone has not taken effect for anybody already signed in. Granting ADMIN
  // also turns the second factor on.
  if (role === 'ADMIN') await requireTwoFactorFor(userId);
  await revokeSessions(userId, 'ROLE_ASSIGNED');
}

/**
 * Narrow lookups other modules depend on, so nothing else has to query the
 * User table directly.
 *
 * `support` labels reply authors with the display name; `employees` checks a
 * user exists before creating an HR record.
 */
export async function getUserDisplayName(userId: string): Promise<string | null> {
  const user = await repository.findById(userId);
  if (!user) return null;
  return user.name ?? user.mobile ?? null;
}

/**
 * E6: `{ id, name }` for a set of actor ids, in one query — the reads that
 * join who did something (`suspension` events, `feature-flags` changes, the
 * payout batches) read it, so none of them queries `User`. An id nobody
 * matches maps to a null name rather than disappearing.
 */
export type UserLabel = { id: string; name: string | null };

export async function findUserLabels(ids: readonly string[]): Promise<Map<string, UserLabel>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const labels = new Map<string, UserLabel>(unique.map((id) => [id, { id, name: null }]));
  if (unique.length === 0) return labels;
  for (const row of await repository.findNamesByIds(unique)) {
    labels.set(row.id, { id: row.id, name: row.name ?? row.mobile ?? null });
  }
  return labels;
}

/**
 * E7-3: the person behind an id, as a desk names them — name, contacts, the
 * roles and the one **primary role** the console prints (`PRIMARY_ROLE_ORDER`:
 * the party roles first, ADMIN last, null for an account with none). One
 * query for a set of ids; an id nobody matches is absent from the map.
 * `support` (the requester on the queue and the rail) and this module's own
 * impersonation list read it.
 */
export type UserSummary = {
  id: string;
  name: string | null;
  mobile: string;
  email: string | null;
  isActive: boolean;
  createdAt: Date;
  roles: Role[];
  role: Role | null;
};

const PRIMARY_ROLE_ORDER: Role[] = ['PUBLISHER', 'ADVERTISER', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'PARTNER', 'ADMIN'];

export function primaryRoleOf(roles: readonly Role[]): Role | null {
  return PRIMARY_ROLE_ORDER.find((role) => roles.includes(role)) ?? roles[0] ?? null;
}

export async function findUserSummaries(ids: readonly string[]): Promise<Map<string, UserSummary>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const out = new Map<string, UserSummary>();
  if (unique.length === 0) return out;
  for (const row of await repository.findSummariesByIds(unique)) {
    const roles = row.roles.map((entry) => entry.role);
    out.set(row.id, {
      id: row.id,
      name: row.name,
      mobile: row.mobile,
      email: row.email,
      isActive: row.isActive,
      createdAt: row.createdAt,
      roles,
      role: primaryRoleOf(roles),
    });
  }
  return out;
}

/* ── E6: the system account ─────────────────────────────────────────── */

/**
 * `ActivityLog.userId` is a foreign key, so a job that moves something has
 * to write its row under a real account. Until E6 that was "the first
 * admin", which put a person's name on the probe's and the purge's work.
 * This is the account instead: mobile `+910000000000` (not a number anyone
 * can register), name `ADX system`, `isActive: false`, no roles — it can
 * never sign in and never holds a permission. `ensureSystemUser()` runs at
 * boot beside `ensureSystemRoles`; `systemUserId()` is what a job asks for,
 * looking the row up (and caching it) when boot did not run here.
 */
export const SYSTEM_USER_MOBILE = '+910000000000';
export const SYSTEM_USER_NAME = 'ADX system';

let systemUser: string | null = null;

export async function ensureSystemUser(): Promise<string> {
  const row = await repository.ensureSystemUser({ mobile: SYSTEM_USER_MOBILE, name: SYSTEM_USER_NAME });
  systemUser = row.id;
  return row.id;
}

/** The system account's id, or null when it does not exist and cannot be created. */
export async function systemUserId(): Promise<string | null> {
  if (systemUser) return systemUser;
  try {
    return await ensureSystemUser();
  } catch {
    return null;
  }
}

/** For tests. */
export function resetSystemUserCache(): void {
  systemUser = null;
}

/** Throws 404 rather than answering a boolean — what a route needs before it acts. */
export async function requireUser(userId: string): Promise<void> {
  if (!(await repository.findById(userId))) throw new ApiError(404, 'NOT_FOUND', 'User not found');
}

export async function userExists(userId: string): Promise<boolean> {
  return (await repository.findById(userId)) !== null;
}

/**
 * Every admin's user id — the recipients for platform-wide alerts.
 *
 * Used by `orders` and the publisher-timer job so neither queries UserRole.
 */
export async function listAdminUserIds(): Promise<string[]> {
  return (await repository.findAdminUserIds()).map((row) => row.userId);
}

/**
 * GET /users/me/onboarding-manifest moved to `onboarding-manifest.service.ts`
 * in Lot D: the ladder now reads the party's KYC review state, the liveness
 * video and the Digio switch, and those reach into `kyc` and
 * `shared/integrations` — too much for the identity service to carry.
 */

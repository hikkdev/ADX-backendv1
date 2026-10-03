import type { Request } from 'express';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { env } from '../../config/env';
import { auditDiff, logActivity } from '../../shared/audit';
import { PERMISSIONS, permissionsOfTier, unknownPermissions } from '../../shared/auth';
import type { Role } from '../../shared/database';
import { revokeSessions, type ConsoleStanding } from '../auth';
import { prismaRoleConfigRepository as repository } from './prisma-access-control.repository';
import type { RoleConfigWithCount } from './access-control.repository';
import { SYSTEM_ROLES, SUPER_ADMIN_ROLE } from './system-roles';
import type {
  AssignRoleConfigInput,
  CreateRoleConfigInput,
  UpdateRoleConfigInput,
} from './access-control.schema';

/** What the console list draws beside each role. */
export type RoleConfigView = {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/** The one view: the list's row, and (T-B) what the get, the create and the patch answer. */
export function toRoleConfigView(role: RoleConfigWithCount): RoleConfigView {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    permissions: role.permissions,
    isSystem: role.isSystem,
    memberCount: role._count.members,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

export async function listRoleConfigs(): Promise<RoleConfigView[]> {
  const roles = await repository.findAll();
  return roles.map(toRoleConfigView);
}

export async function getRoleConfig(id: string): Promise<RoleConfigView> {
  const role = await repository.findById(id);
  if (!role) throw new ApiError(404, 'NOT_FOUND', 'Role not found');
  return toRoleConfigView(role);
}

/**
 * Every id a role names must exist in the catalogue.
 *
 * A typo stored today is a permission that silently never matches — the role
 * looks configured and grants nothing. 400 naming the offending ids is the
 * only useful answer.
 */
function assertKnownPermissions(permissions: readonly string[] | undefined): void {
  if (!permissions) return;
  const unknown = unknownPermissions(permissions);
  if (unknown.length > 0) {
    throw new ApiError(400, 'UNKNOWN_PERMISSION', 'Unknown permission ids', { unknown });
  }
}

export async function createRoleConfig(data: CreateRoleConfigInput) {
  assertKnownPermissions(data.permissions);
  // Names are the identity clients use, so a duplicate is a conflict rather
  // than a silent second row.
  const existing = await repository.findByName(data.name);
  if (existing) throw new ApiError(409, 'CONFLICT', 'A role with this name already exists');
  // Deduplicated on write so a console double-click cannot store `['x','x']`.
  return toRoleConfigView(await repository.create({ ...data, permissions: [...new Set(data.permissions)] }));
}

export async function updateRoleConfig(id: string, data: UpdateRoleConfigInput) {
  assertKnownPermissions(data.permissions);
  const before = await getRoleConfig(id);

  // A system role is the floor under console access: emptying it, or renaming
  // it out of recognition, would leave the platform with nobody who can fix
  // it. Its membership is editable; its definition is not.
  if (before.isSystem) {
    if (data.permissions && data.permissions.length === 0) {
      throw new ApiError(409, 'CONFLICT', 'A system role cannot be emptied');
    }
    if (data.name && data.name !== before.name) {
      throw new ApiError(409, 'CONFLICT', 'A system role cannot be renamed');
    }
  }

  const after = toRoleConfigView(
    await repository.update(id, {
      ...data,
      ...(data.permissions ? { permissions: [...new Set(data.permissions)] } : {}),
    }),
  );

  // Everyone holding this role is re-issued a token on their next request:
  // the permissions are in the token, so a narrowed role that leaves live
  // sessions alone has not actually been narrowed.
  await revokeMembersOf(id, 'ROLE_CONFIG_PERMISSIONS_CHANGED');

  return { before, after };
}

export async function deleteRoleConfig(id: string) {
  const role = await getRoleConfig(id);
  if (role.isSystem) {
    throw new ApiError(409, 'CONFLICT', 'A system role cannot be deleted');
  }
  const members = await repository.countMembers(id);
  if (members > 0) {
    throw new ApiError(409, 'ROLE_HAS_MEMBERS', 'Move the people holding this role first', { members });
  }
  await repository.remove(id);
  return role;
}

/**
 * Ends the sessions of everyone holding a role. Best-effort per member: one
 * unreachable Redis must not leave the role half-changed.
 */
async function revokeMembersOf(roleConfigId: string, reason: string): Promise<void> {
  const members = await repository.listMemberUserIds(roleConfigId);
  await Promise.all(
    members.map((userId) =>
      revokeSessions(userId, reason).catch((cause: unknown) =>
        logger.warn('Could not revoke sessions after a role change', {
          userId,
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    ),
  );
}

/* ── membership ──────────────────────────────────────────────────── */

export type MembershipResult = {
  userId: string;
  roleConfig: { id: string; name: string } | null;
  previous: { id: string; name: string } | null;
};

/**
 * PUT /users/:id/role-config.
 *
 * Three rules. The target must hold the ADMIN Role, because a role config is
 * console access and nobody else has a console. The last member of the system
 * role cannot be moved off it, or the platform is left with no super admin.
 * And the change ends the person's sessions, because their permissions live
 * in their token.
 */
export async function assignRoleConfig(
  userId: string,
  actingUserId: string,
  input: AssignRoleConfigInput,
): Promise<MembershipResult> {
  if (!(await repository.userExists(userId))) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  if (!(await repository.isAdmin(userId))) {
    throw new ApiError(409, 'CONFLICT', 'Only an admin can hold a console role. Grant the ADMIN role first.');
  }

  const current = await repository.findMembership(userId);
  const previous = current ? { id: current.roleConfig.id, name: current.roleConfig.name } : null;

  if (input.roleConfigId === null) {
    if (!current) return { userId, roleConfig: null, previous: null };
    await assertNotLastSystemMember(current.roleConfig.id, current.roleConfig.isSystem);
    await repository.clearMembership(userId);
    await revokeSessions(userId, 'ROLE_CONFIG_ASSIGNED');
    return { userId, roleConfig: null, previous };
  }

  const target = await repository.findById(input.roleConfigId);
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'Role not found');

  // K-B1: the system role is granted only by somebody who holds it. An
  // admin with no role config holds every permission (the launch rule) and
  // counts — that is how the first super admin is ever made.
  if (target.isSystem) await assertActingIsSuperAdmin(actingUserId);

  if (current && current.roleConfigId !== target.id) {
    await assertNotLastSystemMember(current.roleConfig.id, current.roleConfig.isSystem);
  }

  const row = await repository.setMembership(userId, target.id, actingUserId);
  await revokeSessions(userId, 'ROLE_CONFIG_ASSIGNED');
  return { userId, roleConfig: { id: row.roleConfig.id, name: row.roleConfig.name }, previous };
}

async function assertNotLastSystemMember(roleConfigId: string, isSystem: boolean): Promise<void> {
  if (!isSystem) return;
  if ((await repository.countMembers(roleConfigId)) <= 1) {
    throw new ApiError(409, 'LAST_SUPER_ADMIN', 'The last member of the super-admin role cannot be moved off it');
  }
}

export type SuperAdminRemoval = 'DEACTIVATE' | 'DELETE' | 'CLOSE' | 'DEMOTE';

const REMOVAL_WORDS: Record<SuperAdminRemoval, string> = {
  DEACTIVATE: 'deactivated',
  DELETE: 'deleted',
  CLOSE: 'closed',
  DEMOTE: 'demoted',
};

/**
 * Lot K2: the same LAST_SUPER_ADMIN rule for the other ways a super
 * admin leaves — deactivation (`PATCH /users/:id { isActive: false }`),
 * deletion (`DELETE /users/:id`), closure (`account-lifecycle`) and, M-B,
 * demotion (`PATCH /users/:id { roles }` dropping ADMIN). Counted
 * on the members who can still sign in: a role whose only other member is
 * deactivated or closed is a role with nobody in it. A person outside the
 * system role is never refused here.
 */
export async function assertNotLastSuperAdmin(userId: string, action: SuperAdminRemoval): Promise<void> {
  const membership = await repository.findMembership(userId);
  if (!membership || !membership.roleConfig.isSystem) return;
  const active = await repository.listMemberUserIds(membership.roleConfigId, { activeOnly: true });
  if (active.some((id) => id !== userId)) return;
  throw new ApiError(
    409,
    'LAST_SUPER_ADMIN',
    `The last active member of the super-admin role cannot be ${REMOVAL_WORDS[action]}. Give somebody else the role first.`,
    { userId, action },
  );
}

/**
 * K-B1: a super admin is a member of the system role — and nothing else
 * (RP-1, 24 Sep 2026; an admin with no role config used to count under the
 * launch rule). One predicate, read by the grant guard below and by
 * `consoleStandingFor`.
 */
function isSuperAdminMembership(membership: { roleConfig: { isSystem: boolean } } | null): boolean {
  return !!membership && membership.roleConfig.isSystem;
}

async function assertActingIsSuperAdmin(actingUserId: string): Promise<void> {
  const acting = await repository.findMembership(actingUserId);
  if (!isSuperAdminMembership(acting)) {
    throw new ApiError(403, 'SUPER_ADMIN_ONLY', 'Only a super admin can grant the super-admin role');
  }
}

/** GET /users/:id — the console role, or null. */
export async function getRoleConfigForUser(userId: string): Promise<{ id: string; name: string } | null> {
  const row = await repository.findMembership(userId);
  return row ? { id: row.roleConfig.id, name: row.roleConfig.name } : null;
}

/**
 * M-B: what `GET /users/me` and `GET /auth/2fa/status` say about the
 * console — the role config with `isSystem`, and `isSuperAdmin` by the
 * predicate above. A non-admin has no console: null and false, with no
 * membership read. Registered on `auth`'s port at load (see index.ts).
 */
/**
 * QR-14: what to write as `onboardedByRole` — the console role's name for an
 * admin ("Super admin", "Ops manager", …; "Admin" while the membership is
 * unset), "Agent" for the two agent roles, else the platform role as it is.
 * A snapshot: roles move, the stamp on a party does not.
 */
export async function actorLabelFor(userId: string, roles: readonly Role[]): Promise<string> {
  if (roles.includes('ADMIN')) {
    const standing = await consoleStandingFor(userId, roles);
    if (standing.isSuperAdmin) return 'Super admin';
    return standing.roleConfig?.name ?? 'Admin';
  }
  if (roles.includes('AGENT_PUBLISHER') || roles.includes('AGENT_ADVERTISER')) return 'Agent';
  return roles[0] ? roles[0].charAt(0) + roles[0].slice(1).toLowerCase() : 'Unknown';
}

export async function consoleStandingFor(userId: string, roles: readonly Role[]): Promise<ConsoleStanding> {
  if (!roles.includes('ADMIN')) return { roleConfig: null, isSuperAdmin: false };
  const membership = await repository.findMembership(userId);
  return {
    roleConfig: membership
      ? { id: membership.roleConfig.id, name: membership.roleConfig.name, isSystem: membership.roleConfig.isSystem }
      : null,
    isSuperAdmin: isSuperAdminMembership(membership),
  };
}

/**
 * Lot G (Q127/142): who holds a console role, by its name — the KYC
 * escalation asks for the Compliance pool this way. An unknown role is an
 * empty list, never an error: the caller decides what to fall back to.
 * Only open accounts are answered — a deactivated or closed member cannot
 * take a case, and the ADMIN fallback already reads the same way.
 */
export async function findRoleMemberUserIds(roleName: string): Promise<string[]> {
  const role = await repository.findByName(roleName);
  if (!role) return [];
  return repository.listMemberUserIds(role.id, { activeOnly: true });
}

/* ── the enforcement seam ────────────────────────────────────────── */

/**
 * The permission ids a session gets — the resolver `auth` calls at login and
 * on refresh.
 *
 * RP-1 (owner, 24 Sep 2026): only Super admin holds every permission;
 * anyone else holds exactly their role's list, and an ADMIN with no role
 * holds none — `requireRole('ADMIN')` then refuses them by name
 * (ROLE_REQUIRED) until a super admin assigns one. The launch rule that
 * gave a role-less admin everything is gone. Everyone else — publishers,
 * advertisers, agents — holds none; their access is the `Role` enum and
 * route guards, not this.
 *
 * The one exception keeps a fresh platform operable: when the system role
 * has no member at all, the first ADMIN to sign in is seated in it (see
 * `seatSuperAdmin`). Once anyone holds the chair the exception never fires.
 */
export async function permissionsFor(userId: string, roles: Role[]): Promise<string[]> {
  if (!roles.includes('ADMIN')) return [];
  const membership = await repository.findMembership(userId);
  if (membership) return membership.roleConfig.permissions;
  if (await seatIfChairEmpty(userId)) return [...PERMISSIONS];
  return [];
}

/* ── the super admin chair ───────────────────────────────────────── */

/**
 * Seats `userId` in the system role when it has no member at all — the
 * fresh-platform case, where the first admin exists only after the dev
 * door or an invite minted them. Never when anyone already holds it. A
 * failure is logged and answered false: sign-in must not break on it.
 */
async function seatIfChairEmpty(userId: string): Promise<boolean> {
  try {
    const system = await repository.findByName(SUPER_ADMIN_ROLE);
    if (!system) return false;
    if ((await repository.countMembers(system.id)) > 0) return false;
    await seatSuperAdmin(userId, system.id, 'first admin to sign in');
    return true;
  } catch (err: unknown) {
    logger.warn('Could not seat the first super admin', { userId, cause: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

async function seatSuperAdmin(userId: string, roleConfigId: string, how: string): Promise<void> {
  await repository.setMembership(userId, roleConfigId, userId);
  await logActivity(userId, 'SUPER_ADMIN_SEATED', {
    module: 'access-control',
    targetType: 'RoleConfig',
    targetId: roleConfigId,
    metadata: { how },
  });
  logger.warn('Seated the super admin', { userId, how });
}

/**
 * Boot (after `ensureSystemRoles`): when no open account holds the system
 * role, seat one — the account `BOOTSTRAP_SUPER_ADMIN` names by mobile or
 * email, else the oldest open ADMIN. Deterministic on purpose: without it,
 * a platform whose super admin was deactivated has nobody who can assign a
 * role, and RP-1 leaves every other admin outside. Naming an account that
 * is not an open ADMIN seats nobody and says so; the setting is the
 * owner's explicit choice and is not second-guessed.
 */
export async function ensureSuperAdminHolder(named: string | null = env.BOOTSTRAP_SUPER_ADMIN ?? null): Promise<void> {
  const system = await repository.findByName(SUPER_ADMIN_ROLE);
  if (!system) return;
  const active = await repository.listMemberUserIds(system.id, { activeOnly: true });
  if (active.length > 0) return;
  const candidate = await repository.findBootstrapAdmin(named);
  if (!candidate) {
    logger.warn(
      named
        ? 'BOOTSTRAP_SUPER_ADMIN names no open ADMIN account; nobody was seated as super admin'
        : 'No open ADMIN account exists; the first admin to sign in will be seated as super admin',
      { named },
    );
    return;
  }
  await seatSuperAdmin(candidate.id, system.id, named ? 'BOOTSTRAP_SUPER_ADMIN' : 'oldest open ADMIN at boot');
}

/* ── the seeded roles ────────────────────────────────────────────── */

/**
 * Creates or refreshes the six roles the console ships with. Idempotent, and
 * called once at startup rather than from `prisma/seed.ts`, so a fresh
 * database and a long-running one end up with the same rows.
 *
 * Super admin's list is `PERMISSIONS` itself: a permission added to the
 * catalogue is held by the super admin from the next boot, with no migration.
 */
export async function ensureSystemRoles(): Promise<void> {
  for (const role of SYSTEM_ROLES) {
    await repository.upsertByName({
      name: role.name,
      description: role.description,
      permissions: role.name === SUPER_ADMIN_ROLE ? [...PERMISSIONS] : role.permissions(),
      isSystem: role.isSystem,
    });
  }
}

/** Exported for the README table and the tests — what "view on everything" means. */
export const readOnlyPermissions = (): string[] => permissionsOfTier('view');

/* ── audit helpers ───────────────────────────────────────────────── */

const AUDITED_FIELDS = ['name', 'description', 'permissions'] as const;

export async function auditRoleWrite(
  actingUserId: string,
  action: string,
  role: { id: string; name: string },
  options: { before?: object | null; after?: object | null; req?: Request } = {},
): Promise<void> {
  await logActivity(actingUserId, action, {
    req: options.req,
    module: 'access-control',
    targetType: 'RoleConfig',
    targetId: role.id,
    diff: auditDiff(options.before ?? null, options.after ?? null, AUDITED_FIELDS),
    metadata: { name: role.name },
  });
}

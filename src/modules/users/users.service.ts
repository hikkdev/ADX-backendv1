import { ApiError } from '../../shared/errors';
import { normalizeMobile } from '../auth';
import type { Role } from '../../shared/database';
import { prismaUsersRepository as repository } from './prisma-users.repository';
import type { UpdateProfileInput, UpdateUserByAdminInput } from './users.schema';

export async function getProfile(userId: string) {
  const user = await repository.findProfile(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  return user;
}

export async function updateProfile(userId: string, data: UpdateProfileInput) {
  return repository.updateProfile(userId, data);
}

export async function listUsersForAdmin() {
  return repository.findAllForAdmin();
}

/**
 * Admin edit of another account.
 *
 * `actingUserId` is needed for the self-deactivation guard: an admin locking
 * themselves out would need another admin to undo it.
 */
export async function updateUserByAdmin(
  userId: string,
  actingUserId: string,
  data: UpdateUserByAdminInput,
) {
  const target = await repository.findById(userId);
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  if (data.isActive === false && userId === actingUserId) {
    throw new ApiError(400, 'BAD_REQUEST', 'You cannot deactivate your own account');
  }

  const { mobile: rawMobile, ...rest } = data;
  const mobile = rawMobile ? normalizeMobile(rawMobile) : undefined;

  // Uniqueness is only re-checked when the value actually changes, so saving a
  // form unchanged never trips a conflict against the user's own row.
  if (mobile && mobile !== target.mobile) {
    if (await repository.findByMobile(mobile)) {
      throw new ApiError(409, 'CONFLICT', 'A user with this mobile number already exists');
    }
  }
  if (rest.email && rest.email !== target.email) {
    if (await repository.findByEmail(rest.email)) {
      throw new ApiError(409, 'CONFLICT', 'A user with this email already exists');
    }
  }

  return repository.updateByAdmin(userId, { ...rest, ...(mobile ? { mobile } : {}) });
}

/** Which activity action an admin edit records, based on what changed. */
export function adminUpdateAction(data: UpdateUserByAdminInput): string {
  if (data.isActive === false) return 'ACCOUNT_DEACTIVATED';
  if (data.isActive === true) return 'ACCOUNT_ACTIVATED';
  return 'PROFILE_UPDATED_BY_ADMIN';
}

export async function deleteUser(userId: string, actingUserId: string) {
  if (userId === actingUserId) {
    throw new ApiError(400, 'BAD_REQUEST', 'You cannot delete your own account');
  }

  const user = await repository.findDeletionTarget(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const isAdmin = user.roles.some((r) => r.role === 'ADMIN');
  if (isAdmin && (await repository.countAdmins()) <= 1) {
    throw new ApiError(400, 'BAD_REQUEST', 'Cannot delete the last remaining Super Admin');
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

  if (await repository.findByMobile(mobile)) {
    throw new ApiError(409, 'CONFLICT', 'A user with this mobile number already exists');
  }

  return repository.createWithRoles({ ...input, mobile });
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

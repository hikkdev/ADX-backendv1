import type { Role, User } from '../../shared/database';

type WithRoles = User & { roles: { role: Role }[] };
type ProfileRow = WithRoles & { agentProfile: unknown; publisherProfile: unknown };

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
    mobile: user.mobile,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    hasPassword: !!user.passwordHash,
    language: user.language,
    roles: user.roles.map((r) => r.role),
    agentProfile: user.agentProfile,
    publisherProfile: user.publisherProfile,
  };
}

/**
 * GET /users — the admin list.
 *
 * Deliberately omits `hasPassword` and `avatarUrl` and adds `isActive`,
 * `lastLoginAt`, timestamps, placed orders and onboarding submissions.
 */
export function adminListPayload(
  user: ProfileRow & { placedOrders: unknown; onboardingSubmissions: unknown },
) {
  return {
    id: user.id,
    mobile: user.mobile,
    name: user.name,
    email: user.email,
    language: user.language,
    isActive: user.isActive,
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

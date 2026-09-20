/**
 * Access control — the console's roles, what each one may do, and who holds
 * one (`RoleConfig`, `UserRoleConfig`).
 *
 * Not to be confused with the `Role` enum that `shared/auth`'s requireRole()
 * checks: that enum is fixed in the Prisma schema and is enforced per route.
 * A `RoleConfig` is a named list of permission ids from
 * `shared/auth/permissions`, resolved into the access token at session start
 * and enforced by `requirePermission()`. Granting a user a `Role` lives in the
 * `users` module; granting them a role *config* lives here.
 */
import { registerConsoleStandingResolver } from '../auth';
import { consoleStandingFor } from './access-control.service';

export { rolesConfigRouter } from './access-control.routes';

/** `users` — PUT /users/:id/role-config, and the roleConfig on GET /users/:id. */
export {
  assignRoleConfig,
  getRoleConfigForUser,
  type MembershipResult,
} from './access-control.service';
/**
 * M-B — `users` (GET /users/me) and, through auth's port, GET /auth/2fa/status:
 * `roleConfig { id, name, isSystem }` and `isSuperAdmin` by the one predicate.
 * Registered on the port here rather than in bootstrap: this module already
 * imports `auth`, and the answer must not depend on a second wiring step.
 */
export { consoleStandingFor } from './access-control.service';
/** QR-14: the actor's role at the time, for a party's `onboardedByRole` stamp. */
export { actorLabelFor } from './access-control.service';
registerConsoleStandingResolver(consoleStandingFor);
/**
 * Lot K2 — `users` (deactivate, delete) and `account-lifecycle` (close):
 * the last active super admin cannot leave by any door (409 LAST_SUPER_ADMIN).
 */
export { assertNotLastSuperAdmin, type SuperAdminRemoval } from './access-control.service';
export { assignRoleConfigSchema, type AssignRoleConfigInput } from './access-control.schema';

/** `bootstrap` — the resolver behind the token's `perms`, and the seeded roles. */
export { ensureSystemRoles, permissionsFor } from './access-control.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

/** Lot G (Q127/142): `kyc` — the members of a console role by name, for the escalation pool (Compliance, else KYC reviewer). */
export { findRoleMemberUserIds } from './access-control.service';

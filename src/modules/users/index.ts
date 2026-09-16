/**
 * Users — identity, profile, roles and account administration.
 *
 * Credentials are NOT here: password hashes, OTPs, refresh tokens and reset
 * tokens belong to `auth`. Both modules touch the `User` table, split by
 * concern rather than by table; see the README.
 */
export { userRouter } from './users.routes';

/**
 * Narrow lookups for modules that would otherwise query the User table:
 * `support` (reply author labels) and `employees` (existence check).
 */
export { getUserDisplayName, userExists } from './users.service';

/**
 * Lot S: `party-imports` makes the User an imported employee needs the way
 * `POST /users` does — identity checks, normalised mobile, lower-cased
 * email — before `employees.createEmployee` gives it the record.
 */
export { createUser } from './users.service';

/**
 * E6: `{ id, name }` per actor id in one query, for the reads that join who
 * did something. `suspension` imports it; `feature-flags` and `payouts` sit
 * underneath this module and reach it through the ports bootstrap fills.
 */
export { findUserLabels } from './users.service';
export type { UserLabel } from './users.service';

/**
 * E7-3: `{ id, name, mobile, email, roles, role }` per id in one query — the
 * desks that name a requester (`support`) read it; `role` is the primary
 * role the console prints (party roles first, ADMIN last).
 */
export { findUserSummaries, primaryRoleOf } from './users.service';
export type { UserSummary } from './users.service';

/**
 * E6: the system account the jobs write their audit rows under, instead of
 * the first admin. `ensureSystemUser` runs at boot (bootstrap/register-modules);
 * `systemUserId` is what a job asks for.
 */
export { ensureSystemUser, systemUserId, SYSTEM_USER_MOBILE, SYSTEM_USER_NAME } from './users.service';

/** Admin recipients for platform alerts — used by `orders` and jobs. */
export { listAdminUserIds } from './users.service';

/**
 * Q83: the onboarding ladder as code, in the template vocabulary — what
 * `scripts/seedConfig` writes to `flows.onboarding`, and what the manifest
 * falls back to when that key is absent.
 */
export { CODE_ONBOARDING_TEMPLATE } from './onboarding-manifest';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

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

/** Admin recipients for platform alerts — used by `orders` and jobs. */
export { listAdminUserIds } from './users.service';

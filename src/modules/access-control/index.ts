/**
 * Access control — the admin-defined catalogue of named roles and their
 * permission lists (`RoleConfig`).
 *
 * Not to be confused with the `Role` enum that `shared/auth`'s requireRole()
 * checks: that enum is fixed in the Prisma schema and is enforced per route.
 * RoleConfig is data the admin UI edits, and nothing enforces it at runtime
 * today. Granting a user a `Role` lives in the `users` module.
 */
export { rolesConfigRouter } from './access-control.routes';

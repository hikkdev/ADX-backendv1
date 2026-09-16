import { PERMISSIONS } from '../../shared/auth';
import type { Role } from '../../shared/database';

/**
 * The one thing a session start needs from another module: which permission
 * ids this person holds. The answer lives in `access-control` (RoleConfig and
 * its members), and access-control needs `revokeSessions` from here whenever
 * a role changes — so the dependency is inverted. `bootstrap/register-modules`
 * plugs access-control's resolver in; until it does, the launch rule answers:
 * an ADMIN holds every permission, nobody else holds any.
 */
export type PermissionResolver = (userId: string, roles: Role[]) => Promise<string[]>;

let resolver: PermissionResolver | null = null;

export function registerPermissionResolver(fn: PermissionResolver | null): void {
  resolver = fn;
}

/** The launch rule, also what a registered resolver falls back to for an ADMIN with no role. */
export function launchPermissions(roles: Role[]): string[] {
  return roles.includes('ADMIN') ? [...PERMISSIONS] : [];
}

export async function resolvePermissions(userId: string, roles: Role[]): Promise<string[]> {
  if (!resolver) return launchPermissions(roles);
  return resolver(userId, roles);
}

/* ------------------------------------------------------------------ */
/* Console standing — M-B                                              */
/* ------------------------------------------------------------------ */

/**
 * What `GET /users/me` and `GET /auth/2fa/status` say about the console
 * role: the config the person holds (with `isSystem`) and whether they are
 * a super admin — a member of the system role, or an ADMIN with no role
 * config at all under the launch rule. The predicate is access-control's
 * (`consoleStandingFor`) and is registered from there, so the console
 * stops reading `/roles-config` a second time to decide the same thing.
 * Unregistered, the launch rule answers.
 */
export type ConsoleStanding = {
  roleConfig: { id: string; name: string; isSystem: boolean } | null;
  isSuperAdmin: boolean;
};
export type ConsoleStandingResolver = (userId: string, roles: Role[]) => Promise<ConsoleStanding>;

let standingResolver: ConsoleStandingResolver | null = null;

export function registerConsoleStandingResolver(fn: ConsoleStandingResolver | null): void {
  standingResolver = fn;
}

/** The launch rule: an ADMIN with no role config is a super admin; nobody else has a console. */
export function launchConsoleStanding(roles: Role[]): ConsoleStanding {
  return { roleConfig: null, isSuperAdmin: roles.includes('ADMIN') };
}

export async function resolveConsoleStanding(userId: string, roles: Role[]): Promise<ConsoleStanding> {
  if (!standingResolver) return launchConsoleStanding(roles);
  return standingResolver(userId, roles);
}

/* ------------------------------------------------------------------ */
/* The erasure tombstone — Lot A (Q60)                                 */
/* ------------------------------------------------------------------ */

/**
 * Whether a number was erased on a DPO-approved request before this send.
 *
 * `account-lifecycle` owns `MobileTombstone` and needs `revokeSessions` from
 * here to close an account, so the dependency is inverted exactly as the
 * permission resolver above is: this module declares the question, that one
 * answers it, and `bootstrap/register-modules` introduces them.
 *
 * Unregistered, the answer is "no" — a tombstone that cannot be read must
 * never stop somebody registering, because the whole point of the decision
 * (Q60) is that an erased person may come back. It only decides whether an
 * activity row is written beside the new account.
 */
export type MobileTombstonePort = { wasErased(mobile: string): Promise<boolean> };

let tombstone: MobileTombstonePort | null = null;

export function registerMobileTombstonePort(port: MobileTombstonePort | null): void {
  tombstone = port;
}

export async function mobileWasErased(mobile: string): Promise<boolean> {
  if (!tombstone) return false;
  return tombstone.wasErased(mobile);
}

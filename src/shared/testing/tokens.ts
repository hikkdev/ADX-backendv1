import { signAccessToken } from '../auth';
import type { Role } from '../database';

/**
 * Fixtures shared by the global contract suite and by per-module __tests__.
 *
 * Tokens are minted through shared/auth rather than through the auth module so
 * a test never depends on the module it is not testing — and so these keep
 * working while the auth module itself is being moved.
 *
 * Deliberately free of dev-only dependencies (no supertest, no vitest) so
 * `npm run build` stays green: this compiles into dist like any other file.
 */
export const ALL_ROLES: Role[] = [
  'ADMIN',
  'AGENT_PUBLISHER',
  'AGENT_ADVERTISER',
  'PUBLISHER',
  'ADVERTISER',
];

export function tokenFor(roles: Role[], userId = 'contract-test-user'): string {
  return signAccessToken(userId, roles);
}

/** Roles guarding a route, parsed out of a `requireRole(A|B)` chain entry. */
export function guardedRoles(chain: string[]): Role[] | null {
  const entry = chain.find((c) => c.startsWith('requireRole('));
  if (!entry) return null;
  return entry.slice('requireRole('.length, -1).split('|') as Role[];
}

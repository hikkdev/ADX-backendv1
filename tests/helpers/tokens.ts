import jwt from 'jsonwebtoken';
import { env } from '../../src/config/env';
import type { Role } from '../../src/generated/prisma';

/**
 * Mints an access token directly rather than through the auth module, so the
 * contract tests keep working while that module is being moved. The payload
 * shape ({ sub, roles }) is what authenticate() reads.
 */
export function tokenFor(roles: Role[], userId = 'contract-test-user'): string {
  return jwt.sign({ sub: userId, roles }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
}

export const ALL_ROLES: Role[] = [
  'ADMIN',
  'AGENT_PUBLISHER',
  'AGENT_ADVERTISER',
  'PUBLISHER',
  'ADVERTISER',
];

/** Roles guarding a route, parsed out of a `requireRole(A|B)` chain entry. */
export function guardedRoles(chain: string[]): Role[] | null {
  const entry = chain.find((c) => c.startsWith('requireRole('));
  if (!entry) return null;
  return entry.slice('requireRole('.length, -1).split('|') as Role[];
}

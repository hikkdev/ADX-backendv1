import { z } from 'zod';
import { ApiError } from '../../../shared/errors';
import { IMPERSONATION_TOKEN_TTL_SECONDS, signImpersonationToken } from '../../../shared/auth';
import type { Role } from '../../../shared/database';
import { prismaImpersonationRepository as repository } from './prisma-impersonation.repository';
import { findUserSummaries } from '../users.service';

/**
 * Read-only impersonation — Lot A, Q27.
 *
 * An admin sometimes has to see what a publisher sees: a price that looks
 * wrong on their screen and right on ours, a document they say is missing.
 * Asking them to screen-share is what happens today, and it is worse for
 * everybody's privacy than a bounded, logged, read-only session.
 *
 * Three things make it safe enough to exist:
 *
 *  - **Read-only, enforced centrally.** The token carries `act` (who is really
 *    holding it), and `authenticate()` in shared/auth refuses every non-GET
 *    request that carries it — so no route can forget. A write "as" somebody
 *    is impossible, not merely discouraged.
 *  - **Fifteen minutes.** The token expires on its own; ending the session
 *    early is a row update, and the session row is the record.
 *  - **Never another admin.** Reading another admin's console would be a way
 *    to see the audit trail, the finance queues and everything they hold,
 *    without either of the two admins' second factors.
 *
 * A reason is required because the row is what somebody reads back in six
 * months, and "why" is the only field that cannot be reconstructed.
 */

export const impersonateSchema = z.object({
  reason: z.string().trim().min(10, 'Say why, in a sentence somebody can read back later').max(500),
});

export type ImpersonateInput = z.infer<typeof impersonateSchema>;

export type ImpersonationStart = {
  sessionId: string;
  accessToken: string;
  expiresAt: Date;
  scope: 'read';
  target: { id: string; name: string | null; mobile: string; roles: Role[] };
};

export async function startImpersonation(
  adminUserId: string,
  targetUserId: string,
  input: ImpersonateInput,
): Promise<ImpersonationStart> {
  if (adminUserId === targetUserId) {
    throw new ApiError(400, 'BAD_REQUEST', 'You are already yourself.');
  }

  const target = await repository.findTarget(targetUserId);
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const roles = target.roles.map((r) => r.role) as Role[];
  if (roles.includes('ADMIN')) {
    throw new ApiError(403, 'FORBIDDEN', 'An admin account cannot be impersonated.');
  }
  if (!target.isActive) {
    throw new ApiError(409, 'CONFLICT', 'That account is not active.');
  }

  const expiresAt = new Date(Date.now() + IMPERSONATION_TOKEN_TTL_SECONDS * 1000);
  const session = await repository.start({ adminUserId, targetUserId, reason: input.reason, expiresAt });

  // No `perms`: the target is not an admin, so there is nothing to carry, and
  // an empty list is what `requirePermission` will read.
  const accessToken = signImpersonationToken(targetUserId, roles, { sub: adminUserId, sessionId: session.id });

  return {
    sessionId: session.id,
    accessToken,
    expiresAt: session.expiresAt,
    scope: 'read',
    target: { id: target.id, name: target.name, mobile: target.mobile, roles },
  };
}

/**
 * POST /users/impersonations/:id/end.
 *
 * Only the admin who started it may end it, and ending an already-ended
 * session answers with the row rather than a conflict: the caller's intent —
 * "this must not be open" — is satisfied either way.
 */
export async function endImpersonation(adminUserId: string, sessionId: string) {
  const session = await repository.findById(sessionId);
  if (!session) throw new ApiError(404, 'NOT_FOUND', 'Impersonation session not found');
  if (session.adminUserId !== adminUserId) {
    throw new ApiError(403, 'FORBIDDEN', 'That impersonation session belongs to another admin.');
  }
  if (session.endedAt) return session;
  return repository.end(sessionId);
}

/** The admin's own open sessions — what the console banner is drawn from. */
/**
 * E7-3: every open session the admin holds, each row with the person being
 * read as `target: { id, name, role }` — null when the account is gone.
 */
export async function listOpenImpersonations(adminUserId: string) {
  const sessions = await repository.listOpenFor(adminUserId, new Date());
  const targets = await findUserSummaries(sessions.map((session) => session.targetUserId));
  return sessions.map((session) => {
    const target = targets.get(session.targetUserId);
    return { ...session, target: target ? { id: target.id, name: target.name, role: target.role } : null };
  });
}

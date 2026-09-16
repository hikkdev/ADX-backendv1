import type { Dispute } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import type { Actor } from './disputes.types';

/**
 * Who may see a case, and on what terms.
 *
 * A dispute is visible to the party who raised it, the party it is against,
 * and ADX. Nobody else — not another agent on the same publisher, not the
 * advertiser on a neighbouring order. Reading answers "not found" to a
 * stranger, so the existence of a case leaks nothing; writing answers
 * "forbidden", so a genuine party with a stale link learns what happened.
 */

export const isAdmin = (actor: Actor) => actor.roles.includes('ADMIN');

export type Standing = 'RAISER' | 'AGAINST' | 'ADMIN';

export function standingOf(dispute: Pick<Dispute, 'raisedByUserId' | 'againstUserId'>, actor: Actor): Standing | null {
  if (dispute.raisedByUserId === actor.sub) return 'RAISER';
  if (dispute.againstUserId && dispute.againstUserId === actor.sub) return 'AGAINST';
  if (isAdmin(actor)) return 'ADMIN';
  return null;
}

export const mayView = (dispute: Pick<Dispute, 'raisedByUserId' | 'againstUserId'>, actor: Actor) =>
  standingOf(dispute, actor) !== null;

/** For writes: 403 to a stranger, and the standing to everyone else. */
export function assertParty(dispute: Pick<Dispute, 'raisedByUserId' | 'againstUserId'>, actor: Actor): Standing {
  const standing = standingOf(dispute, actor);
  if (!standing) throw new ApiError(403, 'FORBIDDEN', 'This is not your case');
  return standing;
}

export function assertRaiser(dispute: Pick<Dispute, 'raisedByUserId' | 'againstUserId'>, actor: Actor): void {
  if (standingOf(dispute, actor) !== 'RAISER') {
    throw new ApiError(403, 'FORBIDDEN', 'Only the person who raised this case can do that');
  }
}

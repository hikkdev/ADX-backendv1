import type { Request } from 'express';
import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { findAgentProfile } from '../agents';
import { liveGrantFor } from '../access-grants';
import { getAdvertiser } from './advertisers.service';

/**
 * Who may act on an advertiser's account, and on what terms.
 *
 * Until this existed, `/advertisers/:id/*` checked nothing but that the id
 * named a row: any signed-in account could edit any advertiser's profile,
 * accept agreements for them, place holds on their wallet, and read their
 * statement. The publisher side has had its policy since the door-to-door
 * model settled; this is the same policy for the demand side.
 *
 * Three actors. The OWNER — the user behind the account — may do anything.
 * An ADMIN may do anything. The agent the account is attributed to may READ
 * it, and may WRITE only while the owner's approval is live: a
 * `DelegatedAccessGrant` on this advertiser, opened when they approved the
 * agent's scan and closed when onboarding ends or they withdraw it. Every
 * agent write is logged against that grant, which is what the owner's
 * access log reads back.
 */

export type Actor = { sub: string; roles?: string[] };
export type ActingAs = { as: 'OWNER' | 'ADMIN' | 'AGENT'; grantId: string | null };

export async function assertMayActFor(
  req: Request,
  advertiserId: string,
  mode: 'READ' | 'WRITE',
  action?: string,
): Promise<ActingAs> {
  const actor = req.user as Actor | undefined;
  if (!actor) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in first');
  const advertiser = await getAdvertiser(advertiserId);

  if ((actor.roles ?? []).includes('ADMIN')) return { as: 'ADMIN', grantId: null };
  if (advertiser.userId === actor.sub) return { as: 'OWNER', grantId: null };

  const agent = await findAgentProfile(actor.sub);
  if (!agent || advertiser.agentId !== agent.id) {
    throw new ApiError(403, 'FORBIDDEN', 'This is not your advertiser account');
  }
  if (mode === 'READ') return { as: 'AGENT', grantId: null };

  const grant = await liveGrantFor(agent.id, { advertiserId }, 'PROFILE');
  if (!grant) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Your access to this advertiser has ended. Ask them to approve a fresh code.',
    );
  }
  if (action) await logActivity(actor.sub, action, req, { advertiserId, grantId: grant.id });
  return { as: 'AGENT', grantId: grant.id };
}

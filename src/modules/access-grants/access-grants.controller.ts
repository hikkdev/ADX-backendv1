import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { issueGrantSchema } from './access-grants.schema';
import {
  issueGrant,
  listGrantsForAgent,
  listGrantsForPublisher,
  listOpenGrants,
  revokeGrant,
  type Actor,
  listGrantsHeldByAgent,
  partyAccessLog,
} from './access-grants.service';

function actor(req: Request): Actor {
  const userId = req.user?.sub;
  if (!userId) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
  return { userId, isAdmin: (req.user?.roles ?? []).includes('ADMIN') };
}

function param(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Missing ${key}`);
  }
  return value;
}

/**
 * Issues the code, and returns it once.
 *
 * The token is the credential. It is returned here so the publisher's app can
 * render it and is never readable again — a grant listing shows that a code
 * exists and what it covers, not what it says.
 */
export async function issueGrantHandler(req: Request, res: Response): Promise<void> {
  const parsed = issueGrantSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  const { grant, token } = await issueGrant(parsed.data, actor(req));
  res.status(201).json({
    success: true,
    data: {
      grant,
      token,
      /**
       * The sentence the publisher's app must show beside the code.
       *
       * It is server-side because it describes what the server will actually
       * honour, and a warning that drifts from that is worse than none.
       */
      warning:
        `This code lets ${grant.scope === 'PROFILE' ? 'your profile' : 'your listings'} be ` +
        `edited by the ADX agent assigned to your request, for ${grant.durationMinutes} minutes ` +
        `after they scan it. It stops on its own, and you can withdraw it at any time.`,
    },
  });
}

export async function revokeGrantHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await revokeGrant(param(req, 'grantId'), actor(req)) });
}

export async function publisherGrantsHandler(req: Request, res: Response): Promise<void> {
  const grants = await listGrantsForPublisher(param(req, 'publisherId'), actor(req));
  res.json({ success: true, data: grants });
}

/** What the scanning agent currently holds. Their own only. */
export async function myGrantsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listGrantsForAgent(actor(req).userId) });
}

export async function openGrantsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listOpenGrants() });
}

/* ── D6: ops oversight ───────────────────────────────────────────────────── */

export async function agentGrantsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listGrantsHeldByAgent(param(req, 'agentId')) });
}

export async function partyLogHandler(req: Request, res: Response): Promise<void> {
  const partyType = param(req, 'partyType') as 'publisher' | 'advertiser';
  res.json({ success: true, data: await partyAccessLog(partyType, param(req, 'partyId')) });
}

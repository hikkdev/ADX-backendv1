import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { logActivity } from '../../../shared/audit';
import { acceptInvite, acceptInviteSchema, describeInvite } from './invites.service';

/*
 * Only the anonymous half of the invitation flow is here. The console half —
 * issuing, listing, resending and revoking — is mounted under /users, where an
 * admin looks for it, and calls this module's service through its index.
 */

/* ── the anonymous half: under /auth ─────────────────────────────── */

/** GET /auth/invites/:token — never names an address for a token that is not live. */
export async function describeInviteHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await describeInvite(req.params['token'] as string) });
}

/**
 * POST /auth/accept-invite — step one sends the code, step two creates the
 * account. 201 only when an account was created.
 */
export async function acceptInviteHandler(req: Request, res: Response): Promise<void> {
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const result = await acceptInvite(parsed.data);
  if (result.stage === 'ACCEPTED') {
    await logActivity(result.user.id, 'USER_INVITE_ACCEPTED', req, { email: result.user.email });
    res.status(201).json({ success: true, data: result });
    return;
  }
  res.json({ success: true, data: result });
}

import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { logActivity } from '../../../shared/audit';
import {
  endImpersonation,
  impersonateSchema,
  listOpenImpersonations,
  startImpersonation,
} from './impersonation.service';

export async function startImpersonationHandler(req: Request, res: Response): Promise<void> {
  const parsed = impersonateSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const targetUserId = req.params['id'] as string;
  const started = await startImpersonation(req.user!.sub, targetUserId, parsed.data);

  await logActivity(req.user!.sub, 'IMPERSONATION_STARTED', {
    req,
    module: 'users',
    targetType: 'User',
    targetId: targetUserId,
    metadata: { sessionId: started.sessionId, reason: parsed.data.reason, expiresAt: started.expiresAt.toISOString() },
  });

  res.status(201).json({ success: true, data: started });
}

export async function endImpersonationHandler(req: Request, res: Response): Promise<void> {
  const sessionId = req.params['id'] as string;
  const session = await endImpersonation(req.user!.sub, sessionId);

  await logActivity(req.user!.sub, 'IMPERSONATION_ENDED', {
    req,
    module: 'users',
    targetType: 'User',
    targetId: session.targetUserId,
    metadata: { sessionId: session.id },
  });

  res.json({ success: true, data: session });
}

export async function listImpersonationsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listOpenImpersonations(req.user!.sub) });
}

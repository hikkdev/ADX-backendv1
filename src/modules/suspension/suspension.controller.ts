import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import type { PartyType } from './suspension.repository';
import {
  idParamSchema,
  partyParamsSchema,
  reinstateBodySchema,
  suspendBodySchema,
} from './suspension.schema';
import { reinstateParty, suspendParty, suspensionOf } from './suspension.service';

/**
 * Eight writes and one read, all admin-only at the router.
 *
 * The four parties share one handler pair rather than four: the difference
 * between suspending a listing and suspending an agent is which scopes are
 * admitted and what happens next, and both of those live in the service.
 */

const invalid = (error: { flatten(): unknown }) =>
  new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

const partyId = (req: Request): string => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) throw invalid(parsed.error);
  return parsed.data.id;
};

export const suspendHandlerFor =
  (partyType: PartyType) =>
  async (req: Request, res: Response): Promise<void> => {
    const body = suspendBodySchema.safeParse(req.body);
    if (!body.success) throw invalid(body.error);

    const result = await suspendParty(partyType, partyId(req), {
      scopes: body.data.scopes,
      reason: body.data.reason,
      byUserId: req.user!.sub,
    });
    res.json({ success: true, data: result });
  };

export const reinstateHandlerFor =
  (partyType: PartyType) =>
  async (req: Request, res: Response): Promise<void> => {
    const body = reinstateBodySchema.safeParse(req.body);
    if (!body.success) throw invalid(body.error);

    const result = await reinstateParty(partyType, partyId(req), {
      ...(body.data.scopes ? { scopes: body.data.scopes } : {}),
      reason: body.data.reason,
      byUserId: req.user!.sub,
    });
    res.json({ success: true, data: result });
  };

/** The current scopes and the whole history, for one party. */
export async function suspensionHandler(req: Request, res: Response): Promise<void> {
  const params = partyParamsSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error);
  res.json({ success: true, data: await suspensionOf(params.data.partyType, params.data.partyId) });
}

import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate } from '../../shared/auth';
import { entityTypeCatalogue } from '../../shared/kyc-state';

/**
 * `GET /kyc/entity-types` — Phase D (1 Oct 2026).
 *
 * The legal forms each party may verify as, labelled the way every surface
 * labels them: `{ PUBLISHER: [{ value, label }], ADVERTISER: [...],
 * PRINT_PARTNER: [...] }`, in the enum's order. The apps and the website
 * draw the picker from it when a party's `entityType` is null (or a Digio
 * start answers 409 `ENTITY_TYPE_REQUIRED`); the console's Edit-details
 * drawers and the KYC queue's request dialog draw the same list. Any
 * signed-in user — it is the question, not anyone's answer.
 */
export async function entityTypesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: entityTypeCatalogue() });
}

export const kycEntityTypeRouter = Router();
kycEntityTypeRouter.use(authenticate);
kycEntityTypeRouter.get('/entity-types', asyncHandler(entityTypesHandler));

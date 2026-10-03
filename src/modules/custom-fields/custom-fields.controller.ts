import type { NextFunction, Request, Response } from 'express';
import type { CustomFieldEntity } from '../../shared/database';
import { requirePermission } from '../../shared/auth';
import { ApiError } from '../../shared/errors';
import { createDefSchema, listDefsQuerySchema, patchDefSchema, putValuesSchema, ENTITY_GROUP } from './custom-fields.schema';
import { archiveDef, assertOwner, createDef, listDefs, ownerDefs, parseEntity, restoreDef, setValues, updateDef, valuesFor } from './custom-fields.service';

const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());
const actorOf = (req: Request) => ({ userId: req.user!.sub, req });
const entityOf = (req: Request) => parseEntity(req.params['entity']);
const entityIdOf = (req: Request) => String(req.params['entityId'] ?? '');

/**
 * The values of a record are read and written with the record's own group:
 * a publisher and its listings with `supply`, an advertiser with `demand`,
 * a lead with `marketplace`. The group is known only once `:entity` is, so
 * the guard is chosen per request; an unknown entity is a 404 before any
 * permission is asked.
 */

export function requireEntityPermission(tier: 'view' | 'edit') {
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    const entity = entityOf(req);
    requirePermission(`${ENTITY_GROUP[entity]}.${tier}`)(req, res, next);
  };
  Object.defineProperty(guard, 'name', { value: `requireEntityPermission(${tier})`, configurable: true });
  return guard;
}

/* ── The desk ─────────────────────────────────────────────────────── */

export async function listDefsHandler(req: Request, res: Response): Promise<void> {
  const parsed = listDefsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await listDefs(parsed.data) });
}

export async function createDefHandler(req: Request, res: Response): Promise<void> {
  const parsed = createDefSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.status(201).json({ success: true, data: await createDef(parsed.data, actorOf(req)) });
}

export async function updateDefHandler(req: Request, res: Response): Promise<void> {
  const parsed = patchDefSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await updateDef(String(req.params['id'] ?? ''), parsed.data, actorOf(req)) });
}

export async function archiveDefHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await archiveDef(String(req.params['id'] ?? ''), actorOf(req)) });
}

export async function restoreDefHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await restoreDef(String(req.params['id'] ?? ''), actorOf(req)) });
}

export async function deskValuesHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await valuesFor(entityOf(req), entityIdOf(req), 'DESK') });
}

export async function deskSetValuesHandler(req: Request, res: Response): Promise<void> {
  const parsed = putValuesSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await setValues(entityOf(req), entityIdOf(req), parsed.data.values, 'DESK', actorOf(req)) });
}

/* ── The owner ────────────────────────────────────────────────────── */

export async function ownerDefsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await ownerDefs(entityOf(req)) });
}

export async function ownerValuesHandler(req: Request, res: Response): Promise<void> {
  const entity = entityOf(req);
  await assertOwner(entity, entityIdOf(req), req.user!.sub);
  res.json({ success: true, data: await valuesFor(entity, entityIdOf(req), 'OWNER') });
}

export async function ownerSetValuesHandler(req: Request, res: Response): Promise<void> {
  const parsed = putValuesSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const entity = entityOf(req);
  await assertOwner(entity, entityIdOf(req), req.user!.sub);
  res.json({ success: true, data: await setValues(entity, entityIdOf(req), parsed.data.values, 'OWNER', actorOf(req)) });
}

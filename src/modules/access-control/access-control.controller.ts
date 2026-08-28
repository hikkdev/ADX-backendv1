import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { createRoleConfigSchema, updateRoleConfigSchema } from './access-control.schema';
import {
  createRoleConfig,
  deleteRoleConfig,
  getRoleConfig,
  listRoleConfigs,
  updateRoleConfig,
} from './access-control.service';

export async function createRoleConfigHandler(req: Request, res: Response): Promise<void> {
  const parsed = createRoleConfigSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const role = await createRoleConfig(parsed.data);
  res.status(201).json({ success: true, data: role });
}

export async function getAllRoleConfigsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listRoleConfigs() });
}

export async function getRoleConfigByIdHandler(req: Request, res: Response): Promise<void> {
  const role = await getRoleConfig(req.params['id'] as string);
  res.json({ success: true, data: role });
}

export async function updateRoleConfigHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateRoleConfigSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  // Validation precedes the existence check here — the reverse of banking and
  // advertisements. Preserved from the original controller: a malformed body
  // against an unknown id answers 400, not 404.
  const role = await updateRoleConfig(req.params['id'] as string, parsed.data);
  res.json({ success: true, data: role });
}

export async function deleteRoleConfigHandler(req: Request, res: Response): Promise<void> {
  await deleteRoleConfig(req.params['id'] as string);
  res.json({ success: true, data: { message: 'Role deleted' } });
}

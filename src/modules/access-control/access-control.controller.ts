import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { PERMISSIONS, PERMISSION_GROUPS } from '../../shared/auth';
import { createRoleConfigSchema, updateRoleConfigSchema } from './access-control.schema';
import {
  auditRoleWrite,
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
  await auditRoleWrite(req.user!.sub, 'ROLE_CONFIG_CREATED', role, { after: role, req });
  res.status(201).json({ success: true, data: role });
}

export async function getAllRoleConfigsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listRoleConfigs() });
}

/**
 * GET /roles-config/capabilities — the matrix the console draws.
 *
 * Ahead of `/:id` in the router, or the id parameter swallows it.
 */
export async function getCapabilitiesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: { groups: PERMISSION_GROUPS, permissions: PERMISSIONS } });
}

export async function getRoleConfigByIdHandler(req: Request, res: Response): Promise<void> {
  const role = await getRoleConfig(req.params['id'] as string);
  res.json({ success: true, data: role });
}

export async function updateRoleConfigHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateRoleConfigSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  // Validation precedes the existence check here. Preserved from the original
  // controller: a malformed body against an unknown id answers 400, not 404.
  const { before, after } = await updateRoleConfig(req.params['id'] as string, parsed.data);
  await auditRoleWrite(req.user!.sub, 'ROLE_CONFIG_UPDATED', after, { before, after, req });
  res.json({ success: true, data: after });
}

export async function deleteRoleConfigHandler(req: Request, res: Response): Promise<void> {
  const role = await deleteRoleConfig(req.params['id'] as string);
  await auditRoleWrite(req.user!.sub, 'ROLE_CONFIG_DELETED', role, { before: role, after: null, req });
  res.json({ success: true, data: { message: 'Role deleted' } });
}

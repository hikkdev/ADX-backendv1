import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../shared/errors';
import { prisma } from '../shared/database';

const createRoleConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  permissions: z.array(z.string()).default([]),
});

const updateRoleConfigSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

export async function createRoleConfigHandler(req: Request, res: Response): Promise<void> {
  const parsed = createRoleConfigSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const existing = await prisma.roleConfig.findUnique({ where: { name: parsed.data.name } });
  if (existing) throw new ApiError(409, 'CONFLICT', 'A role with this name already exists');

  const role = await prisma.roleConfig.create({ data: parsed.data });
  res.status(201).json({ success: true, data: role });
}

export async function getAllRoleConfigsHandler(_req: Request, res: Response): Promise<void> {
  const roles = await prisma.roleConfig.findMany({ orderBy: { createdAt: 'asc' } });
  res.json({ success: true, data: roles });
}

export async function getRoleConfigByIdHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const role = await prisma.roleConfig.findUnique({ where: { id } });
  if (!role) throw new ApiError(404, 'NOT_FOUND', 'Role not found');
  res.json({ success: true, data: role });
}

export async function updateRoleConfigHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const parsed = updateRoleConfigSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const existing = await prisma.roleConfig.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Role not found');

  const role = await prisma.roleConfig.update({ where: { id }, data: parsed.data });
  res.json({ success: true, data: role });
}

export async function deleteRoleConfigHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const existing = await prisma.roleConfig.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Role not found');

  await prisma.roleConfig.delete({ where: { id } });
  res.json({ success: true, data: { message: 'Role deleted' } });
}

import { ApiError } from '../../shared/errors';
import { prismaRoleConfigRepository as repository } from './prisma-access-control.repository';
import type { CreateRoleConfigInput, UpdateRoleConfigInput } from './access-control.schema';

export async function listRoleConfigs() {
  return repository.findAll();
}

export async function getRoleConfig(id: string) {
  const role = await repository.findById(id);
  if (!role) throw new ApiError(404, 'NOT_FOUND', 'Role not found');
  return role;
}

export async function createRoleConfig(data: CreateRoleConfigInput) {
  // Names are the identity clients use, so a duplicate is a conflict rather
  // than a silent second row.
  const existing = await repository.findByName(data.name);
  if (existing) throw new ApiError(409, 'CONFLICT', 'A role with this name already exists');
  return repository.create(data);
}

export async function updateRoleConfig(id: string, data: UpdateRoleConfigInput) {
  await getRoleConfig(id);
  return repository.update(id, data);
}

export async function deleteRoleConfig(id: string) {
  await getRoleConfig(id);
  await repository.remove(id);
}

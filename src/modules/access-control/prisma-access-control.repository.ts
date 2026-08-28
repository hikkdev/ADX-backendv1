import { prisma } from '../../shared/database';
import type { RoleConfigRepository } from './access-control.repository';
import type { CreateRoleConfigInput, UpdateRoleConfigInput } from './access-control.schema';

export const prismaRoleConfigRepository: RoleConfigRepository = {
  findAll() {
    return prisma.roleConfig.findMany({ orderBy: { createdAt: 'asc' } });
  },

  findById(id: string) {
    return prisma.roleConfig.findUnique({ where: { id } });
  },

  findByName(name: string) {
    return prisma.roleConfig.findUnique({ where: { name } });
  },

  create(data: CreateRoleConfigInput) {
    return prisma.roleConfig.create({ data });
  },

  update(id: string, data: UpdateRoleConfigInput) {
    return prisma.roleConfig.update({ where: { id }, data });
  },

  remove(id: string) {
    return prisma.roleConfig.delete({ where: { id } });
  },
};

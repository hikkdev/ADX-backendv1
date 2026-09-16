import { prisma } from '../../shared/database';
import type { RoleConfigRepository } from './access-control.repository';
import type { CreateRoleConfigInput, UpdateRoleConfigInput } from './access-control.schema';

const MEMBER_COUNT = { _count: { select: { members: true } } } as const;

export const prismaRoleConfigRepository: RoleConfigRepository = {
  findAll() {
    return prisma.roleConfig.findMany({ orderBy: { createdAt: 'asc' }, include: MEMBER_COUNT }) as never;
  },

  findById(id: string) {
    return prisma.roleConfig.findUnique({ where: { id }, include: MEMBER_COUNT });
  },

  findByName(name: string) {
    return prisma.roleConfig.findUnique({ where: { name } });
  },

  // T-B: the get, the create and the patch carry the member count the list
  // carries — the same include on the write, no second read.
  create(data: CreateRoleConfigInput) {
    return prisma.roleConfig.create({ data, include: MEMBER_COUNT });
  },

  update(id: string, data: UpdateRoleConfigInput) {
    return prisma.roleConfig.update({ where: { id }, data, include: MEMBER_COUNT });
  },

  remove(id: string) {
    return prisma.roleConfig.delete({ where: { id } });
  },

  upsertByName({ name, description, permissions, isSystem }) {
    // The permission list is rewritten on every boot for the seeded roles:
    // they are code, not data, and an admin who wants a different set makes
    // their own role. `description` and `isSystem` follow for the same reason.
    return prisma.roleConfig.upsert({
      where: { name },
      update: { description, permissions, isSystem },
      create: { name, description, permissions, isSystem },
    });
  },

  countMembers(roleConfigId: string) {
    return prisma.userRoleConfig.count({ where: { roleConfigId } });
  },

  async listMemberUserIds(roleConfigId: string, options: { activeOnly?: boolean } = {}) {
    const rows = await prisma.userRoleConfig.findMany({
      where: { roleConfigId, ...(options.activeOnly ? { user: { isActive: true, closedAt: null } } : {}) },
      select: { userId: true },
      orderBy: { assignedAt: 'asc' },
    });
    return rows.map((row) => row.userId);
  },

  findMembership(userId: string) {
    return prisma.userRoleConfig.findUnique({ where: { userId }, include: { roleConfig: true } });
  },

  setMembership(userId: string, roleConfigId: string, assignedById: string) {
    // One role per person: the row is keyed by userId, so assigning a second
    // role moves the membership rather than adding to it.
    return prisma.userRoleConfig.upsert({
      where: { userId },
      update: { roleConfigId, assignedById, assignedAt: new Date() },
      create: { userId, roleConfigId, assignedById },
      include: { roleConfig: true },
    });
  },

  clearMembership(userId: string) {
    return prisma.userRoleConfig.deleteMany({ where: { userId } });
  },

  async isAdmin(userId: string) {
    return (await prisma.userRole.count({ where: { userId, role: 'ADMIN' } })) > 0;
  },

  async userExists(userId: string) {
    return (await prisma.user.count({ where: { id: userId } })) > 0;
  },
};

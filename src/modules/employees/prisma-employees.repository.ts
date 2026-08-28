import { prisma } from '../../shared/database';
import type { EmployeeRepository } from './employees.repository';
import type { CreateEmployeeInput, UpdateEmployeeInput } from './employees.schema';

const userSelection = { select: { id: true, name: true, mobile: true, email: true } };

export const prismaEmployeeRepository: EmployeeRepository = {
  async findPage(page: number, pageSize: number) {
    const [items, total] = await Promise.all([
      prisma.employee.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { user: userSelection },
      }),
      prisma.employee.count(),
    ]);
    return { items, total };
  },

  findByUserId(userId: string) {
    return prisma.employee.findUnique({ where: { userId }, include: { user: userSelection } });
  },

  findSummaryByUserId(userId: string) {
    return prisma.employee.findUnique({ where: { userId } });
  },

  create(data: CreateEmployeeInput) {
    return prisma.employee.create({ data });
  },

  update(userId: string, data: UpdateEmployeeInput) {
    return prisma.employee.update({ where: { userId }, data });
  },

  remove(userId: string) {
    return prisma.employee.delete({ where: { userId } });
  },
};

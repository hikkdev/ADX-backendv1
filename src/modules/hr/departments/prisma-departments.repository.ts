import { prisma, type Prisma } from '../../../shared/database';
import { countsFrom } from '../../../shared/pagination';
import { DEPARTMENT_STATUSES } from './departments.schema';
import type { DepartmentFilter, DepartmentPatch, DepartmentSort, DepartmentsRepository, NewDepartment } from './departments.repository';

const relations = {
  parent: { select: { id: true, name: true, code: true } },
  children: { select: { id: true, name: true, code: true, isActive: true }, orderBy: { name: 'asc' as const } },
};

function where(filter: DepartmentFilter, facets: { status: boolean } = { status: true }): Prisma.DepartmentWhereInput {
  const statuses = filter.status ?? [];
  const active = statuses.includes('ACTIVE');
  const inactive = statuses.includes('INACTIVE');
  return {
    ...(filter.q
      ? {
          OR: [
            { name: { contains: filter.q, mode: 'insensitive' } },
            { code: { contains: filter.q, mode: 'insensitive' } },
            { regions: { has: filter.q } },
          ],
        }
      : {}),
    ...(facets.status && active !== inactive ? { isActive: active } : {}),
  };
}

export const prismaDepartmentsRepository: DepartmentsRepository = {
  findAll(filter, sort: DepartmentSort) {
    return prisma.department.findMany({
      where: where(filter),
      orderBy: sort === 'newest' ? { createdAt: 'desc' } : { name: 'asc' },
      include: relations,
      take: 500,
    });
  },

  async countByActive(filter) {
    const groups = await prisma.department.groupBy({ by: ['isActive'], where: where(filter, { status: false }), _count: { _all: true } });
    return countsFrom(
      groups.map((group) => ({ status: group.isActive ? 'ACTIVE' : 'INACTIVE', _count: group._count })),
      DEPARTMENT_STATUSES,
    );
  },

  findById(id: string) {
    return prisma.department.findUnique({ where: { id }, include: relations });
  },

  findByName(name: string) {
    return prisma.department.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  },

  findByCode(code: string) {
    return prisma.department.findFirst({ where: { code: { equals: code, mode: 'insensitive' } } });
  },

  create(data: NewDepartment) {
    return prisma.department.create({ data });
  },

  update(id: string, data: DepartmentPatch) {
    return prisma.department.update({ where: { id }, data });
  },

  remove(id: string) {
    return prisma.department.delete({ where: { id } });
  },
};

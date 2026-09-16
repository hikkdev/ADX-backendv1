import { prisma, type Prisma } from '../../shared/database';
import { countsFrom } from '../../shared/pagination';
import { EMPLOYEE_ACTIVITY_CHIPS, type EmployeePatch, type EmployeeRepository } from './employees.repository';
import type { EmployeeFilter, EmployeeOrder } from './employees.schema';

const userSelection = { select: { id: true, name: true, mobile: true, email: true } };
/** Lot G (Q122): the department record, joined on every read so the console prints its name. */
const departmentSelection = { select: { id: true, name: true, code: true } };
const employeeInclude = { user: userSelection, departmentRecord: departmentSelection };

/** The directory's search: the person's name, email or mobile, or the record's designation and display id. */
function searchWhere(q: string | undefined): Prisma.EmployeeWhereInput {
  if (!q) return {};
  return {
    OR: [
      { user: { name: { contains: q, mode: 'insensitive' } } },
      { user: { email: { contains: q, mode: 'insensitive' } } },
      { user: { mobile: { contains: q } } },
      { designation: { contains: q, mode: 'insensitive' } },
      { displayId: { contains: q, mode: 'insensitive' } },
    ],
  };
}

function filterWhere(filter: EmployeeFilter): Prisma.EmployeeWhereInput {
  return {
    // The free string, or (Lot G) the record's name — one release of both.
    ...(filter.department
      ? { OR: [{ department: { equals: filter.department, mode: 'insensitive' } }, { departmentRecord: { name: { equals: filter.department, mode: 'insensitive' } } }] }
      : {}),
    ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
    ...(filter.active !== undefined ? { isActive: filter.active } : {}),
    ...searchWhere(filter.q),
  };
}

export const prismaEmployeeRepository: EmployeeRepository = {
  async findPage(filter: EmployeeFilter, page: number, pageSize: number, order: EmployeeOrder) {
    const where = filterWhere(filter);
    // Lot G (Q113): the id breaks ties so a page never repeats a row across
    // two people who share a name or a title.
    const orderBy: Prisma.EmployeeOrderByWithRelationInput[] =
      order.sort === 'NAME'
        ? [{ user: { name: order.dir } }, { id: 'asc' }]
        : order.sort === 'ROLE'
          ? [{ designation: { sort: order.dir, nulls: 'last' } }, { id: 'asc' }]
          : order.sort === 'REGION'
            ? [{ region: { sort: order.dir, nulls: 'last' } }, { id: 'asc' }]
            : [{ createdAt: order.dir }, { id: 'asc' }];
    const [items, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy,
        include: employeeInclude,
      }),
      prisma.employee.count({ where }),
    ]);
    return { items, total };
  },

  async countByActive(filter: EmployeeFilter) {
    const groups = await prisma.employee.groupBy({ by: ['isActive'], where: filterWhere(filter), _count: { _all: true } });
    return countsFrom(
      groups.map((group) => ({ status: group.isActive ? 'ACTIVE' : 'INACTIVE', _count: group._count })),
      EMPLOYEE_ACTIVITY_CHIPS,
    );
  },

  findByUserId(userId: string) {
    // N3-B: the KYC record's summary rides the by-user read, for the `kyc: { state, ... }` the party read carries.
    return prisma.employee.findUnique({
      where: { userId },
      include: { ...employeeInclude, kyc: { select: { id: true, status: true, submittedAt: true, requestedAt: true, requestedChannel: true, method: true } } },
    });
  },

  findByExternalHrmsId(externalHrmsId: string) {
    return prisma.employee.findUnique({ where: { externalHrmsId }, select: { id: true, userId: true } });
  },

  findDirectory(q?: string, includeInactive = false) {
    return prisma.employee.findMany({
      where: { ...(includeInactive ? {} : { isActive: true }), ...searchWhere(q) },
      select: { id: true, userId: true, department: true, designation: true, isActive: true, user: { select: { name: true } }, departmentRecord: { select: { name: true } } },
      orderBy: { user: { name: 'asc' } },
      take: 200,
    });
  },

  findSummaryByUserId(userId: string) {
    return prisma.employee.findUnique({ where: { userId } });
  },

  findSummaryById(id: string) {
    return prisma.employee.findUnique({ where: { id } });
  },

  /* ── Lot G (Q122): the department record ─────────────────────────────── */

  departmentExists(departmentId: string) {
    return prisma.department.findUnique({ where: { id: departmentId }, select: { id: true, name: true, code: true } });
  },

  async sumOpenRoles() {
    const result = await prisma.department.aggregate({ where: { isActive: true }, _sum: { openRoles: true } });
    return result._sum.openRoles ?? 0;
  },

  async countByDepartment() {
    const groups = await prisma.employee.groupBy({ by: ['departmentId'], where: { departmentId: { not: null } }, _count: { _all: true } });
    const counts: Record<string, number> = {};
    for (const group of groups) if (group.departmentId) counts[group.departmentId] = group._count._all;
    return counts;
  },

  findByDepartment(departmentId: string) {
    return prisma.employee.findMany({
      where: { departmentId },
      select: {
        id: true,
        userId: true,
        displayId: true,
        designation: true,
        region: true,
        workMode: true,
        employmentType: true,
        isActive: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: [{ isActive: 'desc' }, { user: { name: 'asc' } }],
      take: 500,
    });
  },

  async findUnlinkedDepartmentNames() {
    const rows = await prisma.employee.findMany({
      where: { departmentId: null, department: { not: null } },
      select: { department: true },
      distinct: ['department'],
    });
    return rows.flatMap((row) => (row.department?.trim() ? [row.department.trim()] : []));
  },

  async linkDepartmentByName(name: string, departmentId: string) {
    const result = await prisma.employee.updateMany({
      where: { departmentId: null, department: { equals: name, mode: 'insensitive' } },
      data: { departmentId },
    });
    return result.count;
  },

  create(data) {
    return prisma.employee.create({ data });
  },

  update(userId: string, data: EmployeePatch) {
    return prisma.employee.update({ where: { userId }, data });
  },

  remove(userId: string) {
    return prisma.employee.delete({ where: { userId } });
  },
};

import { prisma } from '../../shared/database';
import type { ActionCountRow, OpenAssignedRow, ScheduleEntryRow, WorkloadRepository, WorkloadStaffRow } from './workload.repository';

const OPEN_KYC = ['PENDING', 'NEEDS_INFO'] as const;
const OPEN_FRAUD = ['OPEN', 'INVESTIGATING', 'ESCALATED'] as const;

export const prismaWorkloadRepository: WorkloadRepository = {
  async findStaff(): Promise<WorkloadStaffRow[]> {
    const rows = await prisma.employee.findMany({
      where: { isActive: true },
      select: { id: true, userId: true, designation: true, department: true, user: { select: { name: true } }, departmentRecord: { select: { name: true } } },
      orderBy: { user: { name: 'asc' } },
      take: 1000,
    });
    return rows.map((row) => ({
      userId: row.userId,
      employeeId: row.id,
      name: row.user.name,
      designation: row.designation,
      department: row.departmentRecord?.name ?? row.department,
    }));
  },

  async countOpenAssigned(userIds: string[]): Promise<OpenAssignedRow[]> {
    if (userIds.length === 0) return [];
    const [publisherKyc, advertiserKyc, tickets, fraud] = await Promise.all([
      prisma.publisherKyc.groupBy({ by: ['assignedToId'], where: { assignedToId: { in: userIds }, status: { in: [...OPEN_KYC] } }, _count: { _all: true } }),
      prisma.advertiserKyc.groupBy({ by: ['assignedToId'], where: { assignedToId: { in: userIds }, status: { in: [...OPEN_KYC] } }, _count: { _all: true } }),
      prisma.supportTicket.groupBy({ by: ['assignedAdminUserId'], where: { assignedAdminUserId: { in: userIds }, status: { not: 'CLOSED' } }, _count: { _all: true } }),
      prisma.fraudCase.groupBy({ by: ['assignedToUserId'], where: { assignedToUserId: { in: userIds }, status: { in: [...OPEN_FRAUD] } }, _count: { _all: true } }),
    ]);
    const by = new Map<string, OpenAssignedRow>();
    const row = (userId: string) => {
      let entry = by.get(userId);
      if (!entry) {
        entry = { userId, kyc: 0, tickets: 0, fraud: 0 };
        by.set(userId, entry);
      }
      return entry;
    };
    for (const group of publisherKyc) if (group.assignedToId) row(group.assignedToId).kyc += group._count._all;
    for (const group of advertiserKyc) if (group.assignedToId) row(group.assignedToId).kyc += group._count._all;
    for (const group of tickets) if (group.assignedAdminUserId) row(group.assignedAdminUserId).tickets += group._count._all;
    for (const group of fraud) if (group.assignedToUserId) row(group.assignedToUserId).fraud += group._count._all;
    return [...by.values()];
  },

  async findScheduleEntries(userIds: string[], from: Date, to: Date): Promise<ScheduleEntryRow[]> {
    if (userIds.length === 0) return [];
    return prisma.scheduleEntry.findMany({
      where: { assigneeUserId: { in: userIds }, date: { gte: from, lt: to } },
      select: { assigneeUserId: true, date: true },
      take: 20_000,
    });
  },

  async countActions(userIds: string[], from: Date, to: Date): Promise<ActionCountRow[]> {
    if (userIds.length === 0) return [];
    const groups = await prisma.activityLog.groupBy({
      by: ['userId', 'action'],
      where: { userId: { in: userIds }, createdAt: { gte: from, lt: to } },
      _count: { _all: true },
    });
    return groups.map((group) => ({ userId: group.userId, action: group.action, count: group._count._all }));
  },
};

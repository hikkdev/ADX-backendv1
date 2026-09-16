import { prisma } from '../../shared/database';
import type { EntryPatch, NewEntry, ScheduleRepository } from './schedule.repository';

export const prismaScheduleRepository: ScheduleRepository = {
  findInRange(from: Date, to: Date, assigneeUserId?: string) {
    return prisma.scheduleEntry.findMany({
      where: { date: { gte: from, lte: to }, ...(assigneeUserId ? { assigneeUserId } : {}) },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }],
    });
  },

  findById(id: string) {
    return prisma.scheduleEntry.findUnique({ where: { id } });
  },

  create(data: NewEntry) {
    return prisma.scheduleEntry.create({ data });
  },

  update(id: string, data: EntryPatch) {
    return prisma.scheduleEntry.update({ where: { id }, data });
  },

  remove(id: string) {
    return prisma.scheduleEntry.delete({ where: { id } });
  },
};

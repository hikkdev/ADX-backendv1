import { prisma } from '../../shared/database';
import type { HolidayPatch, HrRepository, NewHoliday } from './hr.repository';

const yearWindow = (year: number) => ({ gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) });

export const prismaHrRepository: HrRepository = {
  findHolidaysInYear(year: number) {
    return prisma.holiday.findMany({
      where: { date: yearWindow(year), hiddenAt: null },
      orderBy: [{ date: 'asc' }, { region: { sort: 'asc', nulls: 'first' } }],
    });
  },

  findHolidaysInRange(from: Date, to: Date) {
    return prisma.holiday.findMany({
      where: { date: { gte: from, lte: to }, hiddenAt: null },
      orderBy: [{ date: 'asc' }, { region: { sort: 'asc', nulls: 'first' } }],
    });
  },

  findHolidayById(id: string) {
    return prisma.holiday.findUnique({ where: { id } });
  },

  findHolidayOn(date: Date, region: string | null) {
    return prisma.holiday.findFirst({ where: { date, region } });
  },

  createHoliday(data: NewHoliday) {
    return prisma.holiday.create({ data });
  },

  updateHoliday(id: string, data: HolidayPatch) {
    return prisma.holiday.update({ where: { id }, data });
  },

  removeHoliday(id: string) {
    return prisma.holiday.delete({ where: { id } });
  },

  findAllHolidaysBetween(from: Date, to: Date) {
    return prisma.holiday.findMany({ where: { date: { gte: from, lte: to } }, orderBy: [{ date: 'asc' }] });
  },

  findHolidaysByExternalIds(externalIds: string[]) {
    if (externalIds.length === 0) return Promise.resolve([]);
    return prisma.holiday.findMany({ where: { externalId: { in: externalIds } } });
  },

  countCalendarHolidaysInYear(year: number) {
    return prisma.holiday.count({ where: { source: 'CALENDAR', date: yearWindow(year) } });
  },
};

import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { createHolidaySchema, holidaysQuerySchema, patchHolidaySchema, peopleQuerySchema } from './hr.schema';
import { createHoliday, deleteHoliday, listHolidays, patchHoliday } from './holidays.service';
import { listPeople } from './people.service';

const parse = <T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } },
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  return result.data as T;
};

const HOLIDAY_FIELDS = ['date', 'name', 'region', 'kind'] as const;
const holidayId = (req: Request) => req.params['holidayId'] as string;

export async function listHolidaysHandler(req: Request, res: Response): Promise<void> {
  const { year } = parse(holidaysQuerySchema, req.query);
  res.json({ success: true, data: await listHolidays(year) });
}

export async function createHolidayHandler(req: Request, res: Response): Promise<void> {
  const holiday = await createHoliday(parse(createHolidaySchema, req.body));
  await logActivity(req.user!.sub, 'HOLIDAY_CREATED', {
    req,
    module: 'hr',
    targetType: 'Holiday',
    targetId: holiday.id,
    metadata: { date: holiday.date, name: holiday.name, region: holiday.region, kind: holiday.kind },
  });
  res.status(201).json({ success: true, data: holiday });
}

export async function patchHolidayHandler(req: Request, res: Response): Promise<void> {
  const patch = parse(patchHolidaySchema, req.body);
  const { before, after } = await patchHoliday(holidayId(req), patch);
  await logActivity(req.user!.sub, 'HOLIDAY_UPDATED', {
    req,
    module: 'hr',
    targetType: 'Holiday',
    targetId: after.id,
    diff: auditDiff(before, after, HOLIDAY_FIELDS),
    metadata: { date: after.date, name: after.name },
  });
  res.json({ success: true, data: after });
}

export async function deleteHolidayHandler(req: Request, res: Response): Promise<void> {
  const holiday = await deleteHoliday(holidayId(req));
  await logActivity(req.user!.sub, 'HOLIDAY_DELETED', {
    req,
    module: 'hr',
    targetType: 'Holiday',
    targetId: holiday.id,
    metadata: { date: holiday.date, name: holiday.name, region: holiday.region },
  });
  res.json({ success: true, data: { message: 'Holiday deleted' } });
}

export async function listPeopleHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listPeople(parse(peopleQuerySchema, req.query)) });
}

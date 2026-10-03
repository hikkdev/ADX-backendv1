import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { createHolidaySchema, holidaySyncSchema, holidaysQuerySchema, patchHolidaySchema, peopleQuerySchema } from './hr.schema';
import { HolidayCalendarUnavailableError, HolidaySyncBusyError, getHolidayCalendarView, syncHolidayCalendar } from './holiday-calendar.service';
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

/** HC-1: a calendar row is hidden (HOLIDAY_HIDDEN) so the next sync leaves it out; a typed one is deleted. */
export async function deleteHolidayHandler(req: Request, res: Response): Promise<void> {
  const { holiday, hidden } = await deleteHoliday(holidayId(req));
  await logActivity(req.user!.sub, hidden ? 'HOLIDAY_HIDDEN' : 'HOLIDAY_DELETED', {
    req,
    module: 'hr',
    targetType: 'Holiday',
    targetId: holiday.id,
    metadata: { date: holiday.date, name: holiday.name, region: holiday.region, source: holiday.source },
  });
  res.json({ success: true, data: { message: hidden ? 'Holiday hidden' : 'Holiday deleted', hidden } });
}

/** HC-1: GET /hr/holidays/calendar — the switch, the address, the observances choice and the last run. */
export async function holidayCalendarHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getHolidayCalendarView() });
}

/**
 * HC-1: POST /hr/holidays/sync { years? } — the "Sync now" button. Refused
 * while the calendar is switched off; a feed that cannot be read is a 502
 * in plain words (nothing was written). Audited either way.
 */
export async function syncHolidaysHandler(req: Request, res: Response): Promise<void> {
  const { years } = parse(holidaySyncSchema, req.body ?? {});
  const calendar = await getHolidayCalendarView();
  if (!calendar.enabled) {
    throw new ApiError(409, 'HOLIDAY_CALENDAR_OFF', 'Calendar sync is off. Turn it on in Settings › Integrations › Holiday calendar.');
  }
  try {
    const result = await syncHolidayCalendar({ years });
    await logActivity(req.user!.sub, 'HOLIDAY_CALENDAR_SYNCED', {
      req,
      module: 'hr',
      targetType: 'Holiday',
      metadata: { ...result, url: calendar.url, includeObservances: calendar.includeObservances },
    });
    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof HolidaySyncBusyError) throw new ApiError(409, 'HOLIDAY_SYNC_RUNNING', err.message);
    if (err instanceof HolidayCalendarUnavailableError) {
      await logActivity(req.user!.sub, 'HOLIDAY_CALENDAR_SYNC_FAILED', {
        req,
        module: 'hr',
        targetType: 'Holiday',
        metadata: { error: err.message, url: calendar.url },
      });
      throw new ApiError(502, 'HOLIDAY_CALENDAR_UNAVAILABLE', err.message);
    }
    throw err;
  }
}

export async function listPeopleHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listPeople(parse(peopleQuerySchema, req.query)) });
}

import { ApiError } from '../../shared/errors';
import type { Holiday, HolidayKind, HolidaySource } from '../../shared/database';
import { prismaHrRepository as repository } from './prisma-hr.repository';
import { HOLIDAYS_2026 } from './holidays-2026';
import { dateColumn, isoDateOf, type CreateHolidayInput, type PatchHolidayInput } from './hr.schema';

/**
 * Holidays — Lot E (Q98): the one HR record kept in-house.
 *
 * Everything else about a person (leave, payroll, documents) lives in the HR
 * tool the integrations row links to. Holidays stay here because the staff
 * diary shades them, and the diary is ours.
 */
export type HolidayView = {
  id: string;
  date: string;
  name: string;
  region: string | null;
  kind: HolidayKind;
  /** HC-1: MANUAL (a person typed it, or edited a calendar row) or CALENDAR (the public calendar keeps it). */
  source: HolidaySource;
  /** HC-1: the calendar says the date may still move. */
  tentative: boolean;
};

/** Lot G (Q123): `kind` rides every read, so the diary's shading can tell a restricted day from a public one. */
export const toHolidayView = (row: Holiday): HolidayView => ({
  id: row.id,
  date: isoDateOf(row.date),
  name: row.name,
  region: row.region,
  kind: row.kind,
  source: row.source,
  tentative: row.tentative,
});

export async function listHolidays(year: number): Promise<HolidayView[]> {
  return (await repository.findHolidaysInYear(year)).map(toHolidayView);
}

/** `[from, to]` inclusive `YYYY-MM-DD`s — what `schedule` shades its grid with. */
export async function holidaysInRange(from: string, to: string): Promise<HolidayView[]> {
  return (await repository.findHolidaysInRange(dateColumn(from), dateColumn(to))).map(toHolidayView);
}

/**
 * HC-1: a day someone hid from the calendar still holds its date. A person
 * who now types a holiday onto that date gets the date: the hidden row goes,
 * and their entry — MANUAL — keeps the sync away from the day.
 */
async function clearHiddenClash(clash: Holiday | null): Promise<Holiday | null> {
  if (clash?.hiddenAt) {
    await repository.removeHoliday(clash.id);
    return null;
  }
  return clash;
}

export async function createHoliday(input: CreateHolidayInput): Promise<HolidayView> {
  const date = dateColumn(input.date);
  if (await clearHiddenClash(await repository.findHolidayOn(date, input.region))) {
    throw new ApiError(409, 'CONFLICT', 'There is already a holiday on that date for that region');
  }
  return toHolidayView(await repository.createHoliday({ date, name: input.name, region: input.region, kind: input.kind }));
}

export async function patchHoliday(id: string, patch: PatchHolidayInput): Promise<{ before: HolidayView; after: HolidayView }> {
  const existing = await requireHoliday(id);
  const date = patch.date !== undefined ? dateColumn(patch.date) : existing.date;
  const region = patch.region !== undefined ? patch.region || null : existing.region;
  // Moving a day onto one that is already there is the same collision a create meets.
  if (patch.date !== undefined || patch.region !== undefined) {
    const found = await repository.findHolidayOn(date, region);
    const clash = found && found.id !== id ? await clearHiddenClash(found) : found;
    if (clash && clash.id !== id) {
      throw new ApiError(409, 'CONFLICT', 'There is already a holiday on that date for that region');
    }
  }
  const after = await repository.updateHoliday(id, {
    ...(patch.date !== undefined ? { date } : {}),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.region !== undefined ? { region } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    // HC-1: an edited calendar row is the editor's version — MANUAL, so the
    // sync stops touching it. Its event id stays, so the sync knows the
    // event is taken and does not bring a second copy back.
    ...(existing.source === 'CALENDAR' ? { source: 'MANUAL' as const } : {}),
  });
  return { before: toHolidayView(existing), after: toHolidayView(after) };
}

/**
 * HC-1: deleting a calendar row hides it — kept, with `hiddenAt`, so the
 * next sync does not bring it back. A row a person typed is deleted.
 */
export async function deleteHoliday(id: string): Promise<{ holiday: HolidayView; hidden: boolean }> {
  const existing = await requireHoliday(id);
  if (existing.source === 'CALENDAR') {
    return { holiday: toHolidayView(await repository.updateHoliday(id, { hiddenAt: new Date() })), hidden: true };
  }
  return { holiday: toHolidayView(await repository.removeHoliday(id)), hidden: false };
}

/** A hidden row is gone as far as the page is concerned. */
async function requireHoliday(id: string): Promise<Holiday> {
  const row = await repository.findHolidayById(id);
  if (!row || row.hiddenAt) throw new ApiError(404, 'NOT_FOUND', 'Holiday not found');
  return row;
}

/**
 * The boot seed — HC-1: run only while the holiday calendar is switched off
 * (`ensureHolidayCalendar` decides); with it on, the calendar brings the
 * days and adopts the rows this seed wrote. Idempotent: a day already on the table — under whatever
 * name ops gave it — is left alone, and only the missing ones are written.
 * Returns how many were inserted, for the log line. Runs from bootstrap, not
 * awaited, like the system roles: a holiday table that cannot be written is
 * not a reason to refuse traffic.
 */
export async function ensureHolidays(seed = HOLIDAYS_2026): Promise<number> {
  let inserted = 0;
  for (const holiday of seed) {
    const date = dateColumn(holiday.date);
    if (await repository.findHolidayOn(date, null)) continue;
    await repository.createHoliday({ date, name: holiday.name, region: null, kind: holiday.kind ?? 'PUBLIC' });
    inserted += 1;
  }
  return inserted;
}

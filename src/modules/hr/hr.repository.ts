import type { Holiday, HolidayKind, HolidaySource } from '../../shared/database';

/**
 * HC-1 (1 Oct 2026): `source`, `externalId` and `tentative` ride a write only
 * when the calendar sync (or a person's edit of a calendar row) sets them;
 * a row a person types is MANUAL by the column's default.
 */
export type NewHoliday = {
  date: Date;
  name: string;
  region: string | null;
  kind: HolidayKind;
  source?: HolidaySource;
  externalId?: string | null;
  tentative?: boolean;
};
export type HolidayPatch = Partial<NewHoliday> & { hiddenAt?: Date | null };

export interface HrRepository {
  /** Every visible holiday whose date falls in the calendar year, in date order. Hidden calendar rows are left out. */
  findHolidaysInYear(year: number): Promise<Holiday[]>;
  /** `[from, to]` inclusive, both UTC-midnight dates — the diary's window. Hidden calendar rows are left out. */
  findHolidaysInRange(from: Date, to: Date): Promise<Holiday[]>;
  findHolidayById(id: string): Promise<Holiday | null>;
  /**
   * The row on a date for a region — or the national one when `region` is
   * null. Checked by hand because Postgres treats two NULL regions as
   * distinct and the unique index would let a national day in twice. A
   * hidden row is found too: it still holds its date.
   */
  findHolidayOn(date: Date, region: string | null): Promise<Holiday | null>;
  createHoliday(data: NewHoliday): Promise<Holiday>;
  updateHoliday(id: string, data: HolidayPatch): Promise<Holiday>;
  removeHoliday(id: string): Promise<Holiday>;
  /** HC-1: every row in `[from, to]` inclusive, hidden ones included — what the sync reconciles against. */
  findAllHolidaysBetween(from: Date, to: Date): Promise<Holiday[]>;
  /** HC-1: the rows carrying any of these calendar event ids, whatever their source or date. */
  findHolidaysByExternalIds(externalIds: string[]): Promise<Holiday[]>;
  /** HC-1: how many calendar rows the year holds, hidden ones included — the boot run's question. */
  countCalendarHolidaysInYear(year: number): Promise<number>;
}

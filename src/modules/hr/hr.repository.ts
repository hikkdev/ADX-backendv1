import type { Holiday, HolidayKind } from '../../shared/database';

export type NewHoliday = { date: Date; name: string; region: string | null; kind: HolidayKind };
export type HolidayPatch = Partial<NewHoliday>;

export interface HrRepository {
  /** Every holiday whose date falls in the calendar year, in date order. */
  findHolidaysInYear(year: number): Promise<Holiday[]>;
  /** `[from, to]` inclusive, both UTC-midnight dates — the diary's window. */
  findHolidaysInRange(from: Date, to: Date): Promise<Holiday[]>;
  findHolidayById(id: string): Promise<Holiday | null>;
  /**
   * The row on a date for a region — or the national one when `region` is
   * null. Checked by hand because Postgres treats two NULL regions as
   * distinct and the unique index would let a national day in twice.
   */
  findHolidayOn(date: Date, region: string | null): Promise<Holiday | null>;
  createHoliday(data: NewHoliday): Promise<Holiday>;
  updateHoliday(id: string, data: HolidayPatch): Promise<Holiday>;
  removeHoliday(id: string): Promise<Holiday>;
}

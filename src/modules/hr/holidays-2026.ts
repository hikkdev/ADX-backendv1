/**
 * The 2026 holiday list the platform boots with — Lot E (Q98).
 *
 * A SHORT LIST IN CODE, ON PURPOSE. The three national holidays are fixed by
 * law; the gazetted ones below follow the central government's 2026 list and
 * the lunar dates among them are the published ones, which a state or a
 * moon-sighting may move by a day. `ensureHolidays()` inserts only what is
 * missing and never rewrites a name, so ops corrects a date or adds a
 * regional day through `/hr/holidays` and this file never undoes it. Next
 * year's list is a new constant beside this one, not an edit to it.
 */
/** Lot G (Q123): `kind` defaults to PUBLIC; the restricted days (`OPTIONAL`) are the ones a person may choose. */
export type SeedHoliday = { date: string; name: string; kind?: 'PUBLIC' | 'OPTIONAL' };

export const HOLIDAYS_2026: readonly SeedHoliday[] = [
  { date: '2026-01-26', name: 'Republic Day' },
  { date: '2026-03-04', name: 'Holi' },
  { date: '2026-03-21', name: 'Id-ul-Fitr' },
  { date: '2026-03-26', name: 'Ram Navami' },
  { date: '2026-03-31', name: 'Mahavir Jayanti' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-05-01', name: 'Buddha Purnima' },
  { date: '2026-05-27', name: 'Id-ul-Zuha (Bakrid)' },
  { date: '2026-06-26', name: 'Muharram' },
  { date: '2026-08-15', name: 'Independence Day' },
  { date: '2026-08-26', name: 'Milad-un-Nabi' },
  { date: '2026-09-04', name: 'Janmashtami' },
  { date: '2026-10-02', name: 'Mahatma Gandhi Jayanti' },
  { date: '2026-10-20', name: 'Dussehra' },
  { date: '2026-11-08', name: 'Diwali' },
  { date: '2026-11-24', name: 'Guru Nanak Jayanti' },
  { date: '2026-12-25', name: 'Christmas Day' },
];

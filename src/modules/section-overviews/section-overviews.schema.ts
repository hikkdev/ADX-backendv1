import { z } from 'zod';
import { SECTIONS } from './section-overviews.service';

const isoDay = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'must be YYYY-MM-DD');

/** `/:section` — one of the six user sections; anything else is a 400, not a 404, because the path is a vocabulary. */
export const sectionParamSchema = z.object({ section: z.enum(SECTIONS) });

/** `?from=&to=&city=` — inclusive Indian days (the last thirty when absent) and a city the party's own column is matched on. */
export const sectionOverviewQuerySchema = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  city: z.string().trim().min(1).max(80).optional(),
});

import { closeDatabase } from '../shared/database';
import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { backfillCityKeys, CITY_KEYED_TABLES } from '../modules/pricing';

/**
 * The city key, re-resolved — Lot X-B.
 *
 *   npm run backfill:city-keys
 *
 * Every party row carries the `City` row its typed city denotes as `cityId`
 * (`targetMarketCityId` on a campaign), stamped on the way in since Lot X-B
 * and backfilled once by the migration. A key is null when the string was
 * a town the catalogue lacked at the time. This re-runs the resolver over
 * every null key in the eight tables — each distinct typed string resolved
 * once, folded in with one `updateMany` — for the day an alias or a manual
 * city arrives after the rows did (an alias taught through `PATCH
 * /pricing/cities/:slug` folds its own rows the moment it is saved; this is
 * the belt for the braces, and for a city added by hand). Reports resolved
 * / still-null per table. Idempotent: a second run resolves nothing.
 *
 * Prints the same figures `GET /geo/unresolved` draws on the Geographies
 * overview, table by table, and never touches the typed strings themselves
 * — the owner's rule that a typed town stays as typed.
 */
async function main(): Promise<void> {
  const started = Date.now();
  logger.info('Re-resolving the city key over every null key', { tables: CITY_KEYED_TABLES });
  const result = await backfillCityKeys();
  const rows = CITY_KEYED_TABLES.map((table) => `${table.padEnd(14)} resolved ${String(result[table].resolved).padStart(6)}   still null ${String(result[table].stillNull).padStart(6)}`);
  const resolved = CITY_KEYED_TABLES.reduce((n, table) => n + result[table].resolved, 0);
  const stillNull = CITY_KEYED_TABLES.reduce((n, table) => n + result[table].stillNull, 0);
  console.log([...rows, `Total: ${resolved} resolved, ${stillNull} still null (typed towns the catalogue lacks — add an alias or a manual city and run again). Done in ${((Date.now() - started) / 1000).toFixed(1)}s.`].join('\n'));
  await closeDatabase();
  // The modules imported above open the shared ioredis client at load, and
  // that socket keeps the event loop alive after the work is done — the same
  // hang createUser.ts documents.
  redis.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

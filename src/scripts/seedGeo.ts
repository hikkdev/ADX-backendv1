import { closeDatabase } from '../shared/database';
import { redis } from '../shared/cache';
import { logActivity } from '../shared/audit';
import { logger } from '../shared/logging';
import { loadGeoDataset, loadGeoOverrides, prismaGeoRepository, runGeoSeed } from '../modules/geo';
import { systemUserId } from '../modules/users';

/**
 * The all-India geography catalogue — Lot V (the owner, 15 Sep 2026).
 *
 *   npm run seed:geo
 *
 * Reads `data/geo/india-geo.json` (GeoNames, CC BY 4.0: 36 states, 763
 * districts, ~6,500 populated places of 5,000 people or more) and upserts
 * `GeoState` by code, `GeoDistrict` by (state, code) and `City` by GeoNames
 * id — in chunks, never one round trip per row. The 44 Lot A cities are
 * matched by name or alias and gain their GeoNames id, state, district,
 * point, population and kind while keeping their slug, stage and switches;
 * every other place is created PLANNED, `source` GEONAMES, `isActive` false.
 * Idempotent: a second run reports zero created, zero updated.
 *
 * W-B: `data/geo/seed-overrides.json` is read after the dataset and places,
 * by slug, the seed rows GeoNames lacks (Navi Mumbai).
 *
 * Run AFTER `seed:cities` (Lot A) so the 44 are matched rather than created
 * as PLANNED towns, and BEFORE the rollout is used. The same run is
 * `POST /geo/seed` from the console. Audited GEO_SEEDED with the counts as
 * the system user when one exists.
 */
async function main(): Promise<void> {
  const started = Date.now();
  const [dataset, overrides] = await Promise.all([loadGeoDataset(), loadGeoOverrides()]);
  logger.info('Seeding the geography catalogue', { source: dataset.source, generatedOn: dataset.generatedOn, states: dataset.states.length, districts: dataset.districts.length, cities: dataset.cities.length, overrides: overrides.cities.length });
  const result = await runGeoSeed(dataset, prismaGeoRepository, overrides);
  const actor = await systemUserId();
  if (actor) await logActivity(actor, 'GEO_SEEDED', { module: 'geo', targetType: 'City', targetId: 'catalogue', metadata: { ...result, via: 'seed:geo' } });
  console.log(
    [
      `States: ${result.states.created} created, ${result.states.updated} updated, ${result.states.total} total.`,
      `Districts: ${result.districts.created} created, ${result.districts.updated} updated, ${result.districts.total} total.`,
      `Cities: ${result.cities.created} created, ${result.cities.matched} seed rows matched, ${result.cities.updated} refreshed, ${result.cities.unchanged} unchanged, ${result.cities.total} total.`,
      result.cities.unmatchedSeed.length ? `Seed rows neither the dataset nor the overrides place (left as they are): ${result.cities.unmatchedSeed.join(', ')}.` : 'Every seed row matched.',
      result.cities.overridden.length ? `Placed by data/geo/seed-overrides.json: ${result.cities.overridden.join(', ')}.` : 'No overrides.',
      `Done in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
    ].join('\n'),
  );
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

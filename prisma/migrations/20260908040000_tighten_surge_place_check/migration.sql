-- The zod schema already refuses a city-scoped window that gives a point but no
-- radius; the column constraint still allowed it. A row that slipped in any
-- other way -- a backfill, a manual insert, a future code path -- would sit in
-- the calendar matching nothing, forever, with nothing to say why: surgeApplies
-- needs all three of latitude, longitude and radius to test containment, then
-- falls through to a city name that such a row does not have.
--
-- Dropped and recreated rather than altered: Postgres has no ALTER CONSTRAINT
-- for a CHECK expression.
ALTER TABLE "SurgeEvent" DROP CONSTRAINT IF EXISTS "SurgeEvent_city_scope_has_place";

ALTER TABLE "SurgeEvent"
  ADD CONSTRAINT "SurgeEvent_city_scope_has_place" CHECK (
    "scope" <> 'CITY'
    OR "city" IS NOT NULL
    OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "radiusMeters" IS NOT NULL)
  );

# geo

Two things under one prefix. The platform's one door to the maps vendor —
geocoding, reverse geocoding, place search and (G7, Q137) directions — and,
since Lot V (the owner, 15 Sep 2026), **the geography catalogue and the
city rollout**: every town in India, the stage each is at with ADX, and the
six switches a stage turns on and off. The maps half keeps no table; the
rollout half owns `GeoState`, `GeoDistrict`, `CityRolloutEvent` and the
rollout columns of `City`.

## The rollout (Lot V)

> "Why only 44? We plan to target entire India, the geographical section
> should be free of any restrictions. Instead there should be better control
> features so we can select what city to go into and launch ADX or what city
> to pull our business out of, what city to gather our listing from etc."

So the catalogue is the country (GeoNames' populated places of 5,000 people
or more — ~6,500 towns under 763 districts and 36 states), and control is a
stage per city plus six function switches, changed from the console without
a deploy. A name the catalogue does not know is still allowed everywhere:
free text stays free; only a catalogued city whose stage says no refuses.

### The stages

| Stage | Meaning | Default switches | `isActive` mirror |
| --- | --- | --- | --- |
| `PLANNED` | in the catalogue, nothing on (every new row) | all off | false |
| `SEEDING` | gathering supply: listings created, imported and verified, agents onboarded, leads fed; nothing published, nothing sold | supplyIntake, agentOnboarding, leadFeeds on; publishing, demand, printPartners off | true |
| `LAUNCHED` | open for business | all on | true |
| `PAUSED` | nothing new; what runs, runs (orders and campaigns already placed complete) | all off | true |
| `WITHDRAWN` | out; the hourly wind-down takes the live listings down | all off | false |

Moves (`rollout.rules.ts`, 409 otherwise): PLANNED → SEEDING or LAUNCHED;
SEEDING → LAUNCHED, PAUSED or WITHDRAWN; LAUNCHED → PAUSED or WITHDRAWN;
PAUSED → LAUNCHED or WITHDRAWN; WITHDRAWN → SEEDING or LAUNCHED (re-entry —
nothing is republished). Entering a stage starts from its default switches
and the body may override any of them; a patch naming no stage (or the
current one) keeps the switches and applies the overrides only. `launchedAt`
is stamped on entering LAUNCHED and kept across a pause; `pausedAt` and
`withdrawnAt` are stamped on entry and cleared on leaving. `City.isActive`
stays as a mirror of the stage so the thirty-odd readers of the old flag
(the resolver, the surge windows, the phone's city list) keep working —
which is why `PATCH /pricing/cities/:slug { isActive }` now answers 400
pointing here. One `CityRolloutEvent` per change (from, to, the switches
after, who, the note); every write audited.

### The switches, and who enforces what

`pricing.assertCityAllows(name, function)` is the gate — it lives in
`pricing` because every gated module already imports it and `geo` sits
above `pricing` (see "Ownership" below). 400 `CITY_NOT_OPEN
{ stage, function, city }` on a catalogued city whose switch is off; an
unresolved name passes and is noted once a day (`geo:unknown-city:*` in
Redis, an info log) so ops can add the town by hand.

| Switch | What it gates | Enforced by |
| --- | --- | --- |
| `supplyIntake` | new inventory | `listings.createListing`; the listing importer (`party-imports`, a new spot's row SKIPPED and named — a merge into an existing spot is not new inventory) |
| `publishing` | a listing going live | `listings.publishListing` (after the rate-card gate); `supply.reviewVerification` — a cleared site visit in a non-publishing city holds the listing exactly as auto-publish-off does (AWAITING_SITE_VERIFICATION, the desk told), and a re-verification leaves a SUSPENDED listing suspended and tells the desk |
| `demand` | campaigns targeting the city | `campaigns.patchDraft` (`targetMarket`, `targetMarkets`); `GET /listings/browse?city=` answers `{ items: [], total: 0, comingSoon: { city, slug, stage } }` instead of rows |
| `agentOnboarding` | signing an agent for the city | `agents.createAgent`; the party importer's agent rows (INVALID, named — a merge into an existing agent is not an onboarding) |
| `printPartners` | signing and switching on a print shop | `print-partners.createPartner` and `activatePartner` |
| `leadFeeds` | filling the lead pool | `leads.importLeads` — a row in a closed city is `CITY_NOT_OPEN` on the report, one lookup per distinct city in the sheet (the import is the only feed today) |

The 44 Lot A cities were backfilled LAUNCHED with all six on, so nothing
changed for them the day this landed; the ~6,400 rows the seed added are
PLANNED and refuse every gated function until ops move them.

### Owned routes (rollout)

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/geo/summary` | ADMIN — cities per stage, the states with any activity (any non-PLANNED city) and their counts |
| GET | `/geo/map?bbox=minLng,minLat,maxLng,maxLat&stage=` | ADMIN — city points (with `id`) with the stage, the population, the kind and `listingsLive` (Lot X-B: two grouped queries over the non-PLANNED pins — by key, then the null-keyed rows by name or slug; a PLANNED pin reads 0); the console draws pins — state polygons are out of scope |
| GET | `/geo/states` | ADMIN — the 36 states with counts per stage |
| GET | `/geo/states/:code/districts` | ADMIN — a state's districts with counts per stage |
| GET | `/geo/cities?state=&district=&stage=&q=&kind=&minPopulation=&page&pageSize&sort=population\|name` | ADMIN — the list contract (`items, total, page, pageSize, counts` per stage with the stage facet removed); `stage` and `kind` are comma lists; `q` matches the name, an alias or the slug |
| POST | `/geo/cities` | ADMIN + `settings.edit` — `{ name, stateCode, districtCode?, lat, lng, aliases?, population?, kind? }`: a place the dataset lacks, `source` MANUAL, PLANNED; slug `name` then `name-state`, 409 when both are taken; audited `CITY_ADDED` |
| GET | `/geo/cities/:slug` | ADMIN — the row, its last 50 events (W-B: each with `byUser { id, name }` — one `users.findUserLabels` lookup for the page), and its counts: publishers, listings live / total, advertisers, active agents, active print partners, open leads — Lot X-B: each one count over the party table **by the city key** (`cityId`, stamped on every write), the free-text `city` matched case-insensitively against the city's name, slug and aliases only for the rows whose key is null (`CityMatch` in `prisma-geo.repository.ts`, read-only), so the figures are exact and a typed town is still found |
| GET | `/geo/unresolved` | ADMIN — Lot X-B: `{ items: [{ city, total, tables: { publishers?, advertisers?, agents?, printPartners?, listings?, leads?, fieldVisits?, campaigns? } }], total, rows }` — the distinct typed city strings with **no key** across the eight party tables (folded case-insensitively) with their row counts, biggest first; `pricing.listUnresolvedCities`. The console draws it on the Geographies overview so ops can add an alias (`PATCH /pricing/cities/:slug` folds the rows at once) or a manual city (`POST /geo/cities`, then `POST /geo/backfill-city-keys` or `npm run backfill:city-keys`) and fold them in |
| POST | `/geo/backfill-city-keys` | ADMIN + `settings.edit` — Lot X-L: the console's button for `npm run backfill:city-keys` (`pricing.backfillCityKeys`): re-resolves every null city key across the eight party tables and answers `{ tables: [{ table, resolved, stillNull }] }` in `CITY_KEYED_TABLES` order. One run at a time — a Redis `SET NX` lock (`geo:city-keys:backfill`, 10-minute TTL, released on finish) answers the second click 409 `CONFLICT` and runs nothing; Redis down fails the run rather than running it unguarded. Audited `GEO_CITY_KEYS_BACKFILLED` with the totals and the per-table rows |
| GET | `/geo/cities/:slug/readiness` | ADMIN — `{ ready, checks: [{ key, ok, detail, soft? }] }`: `rateCard` (an ACTIVE card in force for the city, or a national one), `agents` (≥ 1 ACTIVE agent of each side), `listings` (live ≥ `settings.geo.launchMinListings`), `printPartner` (≥ 1 active partner when `settings.geo.launchNeedsPrintPartner`), `vocabulary` (any media type), and — Y-B — `audience` (**soft**: a panel backs at least one of the city's spots or sample points this month; printed with the profile's basis, never counted in `ready`, a failed read a detail). Advisory — the launch is never refused |
| GET | `/geo/cities/:slug/audience?period=YYYY-MM` | ADMIN — Y-B: the **city audience profile** (`audience-profile.service.ts`): `{ city, period, provenance: 'PANEL', provider, vendors, policy, provenanceByField, agreement { footfall }, coverage { spots, withSnapshot, ratio }, samplePoints, footfall { daily, byHour, byWeekday }, demographics { ageBands, gender, incomeBands, affinities }, basis, computedAt }` — the blend over the city's live spots' stored `AudienceSnapshot` rows (`listings.storedAudienceForListings`): **mean** daily footfall per catchment (the spots of a city overlap — a sum would count a street twice), the hour / weekday profiles and the mixes **weighted by each catchment's daily footfall** (a catchment with no figure counts as an average one), `coverage` = spots with a panel over live spots, the vendors in force and the mean of the spots' vendor agreement. `period` defaults to this month. **Calls no vendor** — it folds what the spot reads already fetched — unless `settings.audience.cityProfileSamplePoints` > 0 (default 0): then up to N points on a ⌈√N⌉ × ⌈√N⌉ grid across the bounding box of the city's placed listings (else a 3 km circle around the city point; nothing without a point) are read through `listings.audienceForSpots` under synthetic keys `city:<slug>:<n>`, so each is asked once per enabled vendor per month and kept as a snapshot, and folded in beside the spots (`samplePoints { configured, asked, withSnapshot }`). **The cost:** one billable call per point per vendor per month per city — 16 points × 2 vendors × 50 cities is 1,600 calls a month. Cached **one minute** per (city, period) in Redis (`geo:city-audience:<slug>:<period>`). `provider: 'NONE'`, `vendors: []`, `policy: null` with nothing enabled. Exported as `cityAudienceProfile(slug, period?)` for the lead score (the leads lots) to read a city's footfall for fit |
| PATCH | `/geo/cities/:slug/rollout` | ADMIN + `settings.edit` — `{ stage?, supplyIntake?, publishing?, demand?, agentOnboarding?, printPartners?, leadFeeds?, note? }` (at least one; unknown keys refused); 409 on a move the table refuses; audited `CITY_ROLLOUT_CHANGED` with the diff over stage, mirror, the six switches, the stamps and the note |
| POST | `/geo/rollout` | ADMIN + `settings.edit` — `{ citySlugs[] \| stateCode \| districtId, stage, switches?, note }` (exactly one scope): every city planned on its own, one event per city that moved, the refused ones named in `skipped` rather than the batch failed; one audit summary `CITY_ROLLOUT_BULK` |
| POST | `/geo/seed` | ADMIN + `system.roles` — the same run as `npm run seed:geo`, from the console; audited `GEO_SEEDED` with the counts |
| GET | `/app/geo/cities?stage=LAUNCHED\|SEEDING&q=&lat&lng&limit` | any signed-in user — the pickers: `items` at the stages asked (LAUNCHED by default) and, with `settings.geo.comingSoonWaitlist` on, `comingSoon` (the SEEDING cities and the PLANNED national and state capitals, for the advertiser waitlist); nearest first with a position, biggest first without |
| GET | `/app/geo/resolve?name=` | any signed-in user — `{ resolved, slug, city, state, stage, switches, comingSoon }` for a typed name; an unknown name answers `resolved: false` with every switch true |
| POST | `/app/geo/waitlist` | any signed-in user — W-B: `{ citySlug, side: ADVERTISER \| PUBLISHER, note? }`, behind `settings.geo.comingSoonWaitlist` (503 `FEATURE_OFF { key }` when off). A lead through `leads.registerWaitlistLead` (`waitlist.service.ts`): the side from the body; business, contact and phone from the caller's account — the profile on the side asked for first, the other side's next, the login's name and mobile last; city and point from the catalogue row; `source` WAITLIST (a `LeadSource`-style label until the leads lots land); interest "Notify me when <city> launches". Deduped by the phone rule — a second tap answers the lead the number already has, **200** not 201, and notes the ask on its thread. Answers `{ leadId, city, stage }`. 409 `ALREADY_LIVE { city, stage }` on a LAUNCHED city, 404 on an unknown slug. Nothing audited (the requester's own act); the lead's IMPORTED row names the source |

### The seed

`npm run seed:geo` (`src/scripts/seedGeo.ts`) and `POST /geo/seed` both run
`seed.service.ts` over `data/geo/india-geo.json`: 36 states upserted by
GeoNames admin1 code, 763 districts by (state, admin2 code), the cities by
GeoNames id — `createMany` with `skipDuplicates` in chunks of 500 and one
transaction of updates, never one round trip per row (the whole file loads
in well under a minute on Neon). The 44 Lot A rows are **matched, not
duplicated**: a row without a GeoNames id is matched by normalised name or
alias (exact name first, the seed's own state breaking a tie — India has
four Raipurs, two Jodhpurs, two Chandigarhs) and gains the id, the state
and district, the point, the population and the kind; its slug, stage,
switches and `source` (`SEED`) stay as they are. Navi Mumbai is not in the
dataset and is reported, not guessed. Every other place is created PLANNED,
`source` GEONAMES, `isActive` false, its aliases from the dataset; the slug
is the name, then `name-state`, then `name-state-district`, then
`name-<geonameId>`, the biggest place taking the bare slug. State and
district names lose GeoNames' "State of" / "Union Territory of" prefixes and
their diacritics ("State of Mahārāshtra" → "Maharashtra"). A second run
changes nothing; a refreshed dataset updates only the rows whose columns
moved, and an alias ops added by hand survives. Run it after `seed:cities`.

**The overrides (W-B).** `data/geo/seed-overrides.json` —
`{ cities: [{ slug, name, stateCode, districtCode?, lat, lng, population?, kind?, aliases? }] }`
— is read after the dataset (`loadGeoOverrides`; an absent file is no
overrides) and gives a row the dataset lacks its state, district, point,
population, kind and aliases, **matched by slug**: Navi Mumbai (GeoNames
files it under Mumbai) is `stateCode` 16, district 517 (Thane), 19.033 /
73.0297, 1,120,547 people. The row's slug, stage, switches and `source`
are never touched; a slug the table lacks is created PLANNED, `source`
SEED; a state or district code the dataset lacks fails the run rather than
guessing. Idempotent like the rest (a row whose columns already agree is
not written); the summary reports the slugs placed as `overridden`, and
`unmatchedSeed` no longer names them. Both `npm run seed:geo` and
`POST /geo/seed` apply it.

**The city key backfill (Lot X-B).** `npm run backfill:city-keys`
(`src/scripts/backfillCityKeys.ts`, `pricing.backfillCityKeys`) re-runs the
resolver over every party row whose `cityId` is null — each distinct typed
string per table resolved once, folded in with one `updateMany` — and
reports resolved / still-null per table. The migration backfilled every
existing row once; run this after `seed:geo` adds places, or after a manual
city, so the strings `GET /geo/unresolved` lists fold in. An alias taught
through `PATCH /pricing/cities/:slug` folds its own rows the moment it is
saved and needs no run. Idempotent. Lot X-L: the same run from the console
is `POST /geo/backfill-city-keys` (above), under a lock so two clicks do
not race.

**Data: [GeoNames](https://www.geonames.org), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** — the IN dump,
places with population ≥ 5,000, generated 2026-09-15. The file is vendored
at `data/geo/india-geo.json` so a build never fetches it.

### The wind-down

Lot X-B: the listings taken down, the leads closed and the agents told are
found **by the city key** (`matchOf(city)` → `{ cityId, spellings }`), the
city's spellings catching only the rows whose key is null — so a row keyed
to the city is found whatever it was typed as, and a typed-only row (an old
spelling taught as an alias later) is still found by its spelling.

A stage change to WITHDRAWN shuts the gates at once; `jobs/city-winddown.job.ts`
(hourly, Redis lock `lock:city-winddown-tick`, heartbeat `city-winddown`, as
the system user) does the rest within the hour through `winddown.service.ts`:

1. every ACTIVE listing in the city off the market through
   `listings.unpublishListing` (INACTIVE, audited LISTING_UNPUBLISHED, cause
   CITY_WITHDRAWN), each publisher told once — event `CITY_WITHDRAWN`,
   template `city-withdrawn`, email + push + in-app;
2. running campaigns left to complete (nothing here touches an order;
   `demand` off is what stops new bookings);
3. every open lead in the city LOST through `leads.closeOpenLeadsInCity`,
   "city withdrawn" on the activity thread (`Lead` has no loss-reason column;
   the thread is where a loss has always been explained);
4. every ACTIVE agent in the city told, once.

Idempotent by a marker: a CityRolloutEvent WITHDRAWN → WITHDRAWN noted
`WIND_DOWN_DONE` with the counts; a city whose marker is newer than its
`withdrawnAt` is not walked again, so a re-withdrawal after re-entry is.
Audited `CITY_WOUND_DOWN`. **Re-entry republishes nothing**: the listings
stay INACTIVE and each publisher relists what they still have. PAUSED has
no wind-down.

### Ownership — geo sits above pricing

`City` stays `pricing`'s table: the free-text resolver (`resolveCity`,
`buildCityResolver`, `listCities` — active rows only, so the 6,400 PLANNED
towns never resolve a spelling) and the gate (`citySupport`,
`assertCityAllows`) live there, and `listings`, `supply`, `campaigns`,
`agents`, `print-partners`, `leads` and the importers import them from
there. This module imports `pricing` (the slug helper, the stage list, the
name lookup behind `/app/geo/resolve`) and never the other way round, so
there is no cycle; it reads and writes the rollout columns of the same table
through its own `prisma-geo.repository.ts`, which also holds the read-only
counts over the party tables. `pricing` therefore does not re-export the
rollout service — the alternative (geo below pricing, pricing re-exporting)
would have put the wind-down's imports of `listings` and `leads` under
`pricing`, which both of those import. `citySupport` asks one query per
name (by slug, alias or display name) rather than loading the table, since
the table is the country now.

### Settings

`settings.geo` on the platform row (`app-config`): `launchMinListings` (10),
`launchNeedsPrintPartner` (false), `comingSoonWaitlist` (true). Y-B:
`settings.audience.cityProfileSamplePoints` (0, max 64) — the city audience
profile's sample grid; off, the profile never calls a vendor.

### Tests

`__tests__/rollout.rules.test.ts` (every move, the refused ones, the
defaults, the mirror, the stamps), `seed.test.ts` (a fixture cut and the
real file: the 44-row match, the slugs, idempotence, the round-trip budget,
W-B: the overrides placing Navi Mumbai, idempotently, and the refusals),
`rollout.service.test.ts` (the stages on a city, the bulk by state and
district, a town by hand, readiness, the map, the pickers),
`rollout.routes.test.ts` (guards, the audit rows, the seed route, the app
reads, W-B: `byUser` on the city page's events and the waitlist — the
caller's profile, the fallbacks, the 200 on a second tap, ALREADY_LIVE,
FEATURE_OFF; Y-B: the city audience route), `winddown.test.ts` (the four
duties, idempotence, re-entry), `city-winddown.job.test.ts` and
`audience-profile.test.ts` (Y-B: the fold's weighting and coverage, the
minute cache, nothing enabled, the sample grid off by default and on — the
box, the circle, the synthetic keys, a vendor failure no failure — and the
soft readiness check), all over `in-memory-geo.repository.ts`. The
gates are pinned where they are enforced: `pricing/__tests__/cities.test.ts`
(each function on a launched, a seeding, a planned and an unknown city),
`listings/__tests__/city-gate-and-publish.test.ts` and `browse.test.ts`,
`supply/__tests__/auto-publish.test.ts`, `agents/__tests__/agents.create.test.ts`,
`print-partners/__tests__/print-partners.service.test.ts`,
`leads/__tests__/leads-dedup.test.ts`, and the two importers' tests.

## The maps door

No table, no repository: every answer comes from the vendor, and the only
thing kept is a fifteen-minute Redis entry per route.

## Why it exists

`supply.schema.ts` has said since the beginning that geocoding fills a listing's
coordinates in, and nothing did. The booking wizard's POI step and every address
field wanted place search. The agent app's job screens (Q101) want the route
line. And the two phone apps each have their own Maps key for tiles, restricted
by package and bundle id, which is the wrong key to spend on lookups: a server
key, restricted by IP, is what these calls should use.

## The seam (G7 — Q101/132/137)

The vendor is **not** this module's. `shared/maps` is the `MapsProvider` port
— `geocode`, `reverse`, `autocomplete`, `placeDetails`, `directions` — with
three adapters, `google.ts` (Geocoding, Places Autocomplete + Details, the
Routes API for directions; moved there from this module's `google.client.ts`),
`mapbox.ts` (Geocoding v6, Search Box v1 for the session-billed search,
Directions v5) and, Z-B, `osm.ts` (OpenStreetMap: Nominatim `/search`,
`/reverse`, `/lookup`; Photon `/api` for search-as-you-type; OSRM
`/route/v1` — every base URL configurable, no key, the public Nominatim
metered at one request a second through a Redis bucket, every call timing
out at 8 s). `getEffectiveMapsConfig().provider` on the integrations row
picks one at call time — Google unless ops chose Mapbox or OSM — so switching
vendor is a form change on `/settings/integrations { section: 'maps' }`, not
a deploy. This module calls the seam's provider-agnostic lookups and never a
vendor by name; the listing importer (`party-imports`) geocodes through the
same door, unchanged.

The client half is `GET /app/maps` (`app-config`): the vendor and its browser
key / public token — or, on OSM, the raster tile line — nothing else. AC-B1
(16 Sep 2026): on OSM the tile line travels with the Mapbox PUBLIC token and
`engineReady`, because the phones draw OSM tiles through the Mapbox SDK, which
needs the public token to initialise; the console and the backend never do.

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/geo/geocode?address=` | any signed-in user |
| GET | `/geo/reverse?latitude=&longitude=` | any signed-in user |
| GET | `/geo/autocomplete?input=&session=&latitude=&longitude=&radiusM=` | any signed-in user |
| GET | `/geo/places/:placeId?session=` | any signed-in user |
| GET | `/geo/directions?from=lat,lng&to=lat,lng&mode=driving\|two_wheeler` | any signed-in user — Q137: `{ polyline (encoded, precision 5 on every vendor — the OSM adapter encodes OSRM's GeoJSON itself), distanceM, durationS, steps: [{ instruction, distanceM, durationS, polyline }], mode, modeUsed, provider }`; `mode` defaults to `driving`; 404 when the vendor finds no route. Cached in Redis **15 minutes per rounded pair** (four decimals, about 11 m) per mode — one vendor call per opened job, never per refresh (`directions.service.ts`); Redis down means the vendor is asked. Mapbox has no motorcycle profile and answers `two_wheeler` with driving — `modeUsed` says so; so does OSRM (the demo router serves the car profile alone) |

Authenticated because every call spends the platform's quota; open to every
role because every persona has an address to type somewhere.

## The key

`getEffectiveMapsConfig()` in `shared/integrations` — the integrations row's
`maps` section first (`googleServerKey` / `mapboxSecretToken`), the pre-G7
`googleMaps.apiKey` row next, the environment last — so ops can rotate it from
`/settings/integrations` without a deploy. **No key is a 503
`INTEGRATION_NOT_CONFIGURED`, not a crash**, and so is a key the vendor refuses:
to a screen those are the same problem. Quota is 429. The vendor being down is
502. Nothing there is 404 except "no route" and "no such place". OSM (Z-B) has
no key: a 403 / 429 from Nominatim is the public usage policy, answered 429
with the policy sentence, and so is the seam's own one-request-a-second bucket
on the public host — never a 503.

## Sessions

Autocomplete predictions carry no coordinates, on purpose — both vendors bill
those separately. A screen mints a session token per search box, sends it on
every keystroke, then calls `/places/:placeId` with the chosen id and the same
token. The whole search bills as one session instead of one request per letter
(Google's `sessiontoken`; Mapbox Search Box's `session_token`; Photon has no
session and bills nothing — the token is accepted and ignored).

## Shapes

No vendor's shapes leave `shared/maps`. Everything above sees
`formattedAddress`, `latitude`, `longitude`, `placeId`, `city`, `state`,
`postalCode`. City is Google's `locality` / Mapbox's `place` / Nominatim's
`city` → `town` → `village`, falling back to the district where an Indian
address is filed that way. An OSM placeId is the object itself —
`N<id>` / `W<id>` / `R<id>` — which is what Nominatim's `/lookup` takes.

## Tests (maps)

`src/shared/maps/__tests__/` — the Google adapter (moved from here), the Mapbox
adapter, the OSM adapter (`osm.test.ts`: the four lookups against recorded
fixtures, every error mapping, the public-host bucket, the 8 s timeout, the
polyline encoder against Google's worked example), and the seam's choice of
vendor and client config (the OSM client half and the public-safe tile hosts).
`party-imports/__tests__/listing-imports.osm.test.ts` — the listing importer
geocoding through Nominatim with OSM selected, and the bucket holding the
second row of a batch.
`__tests__/directions.test.ts` — the directions route, its query shape and the
once-per-pair cache.

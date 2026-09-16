# feature-flags

The feature registry and its switches — Lot A (Q31), rebuilt around the
registry in Lot G (answers 144-146, 13-14 September 2026).

Not to be confused with `app-config`, which is the other half of Q31: that
holds the platform's *numbers* (SLAs, floors, retention windows), this holds
the platform's *switches*. A number ops tune is a setting; a feature ADX is
rolling out, piloting, killing or rolling back is a flag.

## The owner's requirement (13 Sep)

Settings -> Feature flags lists **every** feature across the apps, the console
and the future website; is the on/off kill switch for a buggy feature; offers
rollback; lets an update to an existing feature be pushed or pulled back
without a full release; and lists a new feature automatically the moment it is
added anywhere in the codebase. The registry is how each of those is true.

## The registry

A feature is declared where it is built.

- **Backend**: every module carries a `features.ts` beside its routes that
  calls `feature(key, { surfaces, owner, kind, launch, description, variants?,
  aliases?, routes?, jobs? })` once per user-facing capability — one key per
  thing a person can use (`marketplace.instant-booking`,
  `campaigns.landing-pages`, `kyc.digio`), not one per route. `index.ts`
  imports it (`import './features'`) so the declaration loads with the
  module. The bootstrap's own routes (health) are declared in
  `src/bootstrap/features.ts`. The registry itself is `src/shared/features`
  (a process-wide Map, no I/O); `registry.ts` here is the module's door to it.
  It sits in `shared/` so a test that mocks this module cannot erase a
  declaration.
- **Console and apps**: `features.manifest.json` at each package root
  (`adx-adminUI-sai`, `mobile/user-app`, `mobile/agent-app`) maps route groups
  or feature folders to keys. A key the backend declares only needs its
  `paths` — the surface is added to the backend's declaration; a key only that
  package knows carries owner, kind, launch and description too. Each package
  runs `scripts/check-features.mjs` (`npm run check:features`, chained into
  `npm run lint`): every `src/app/(admin)/**/page.tsx`, every
  `src/features/*` folder, maps to a key, and no declared path is stale.
- **The document**: `npm run features:sync` folds the backend declarations and
  the three manifests into `docs/feature-registry.json` (committed, sorted,
  no timestamp). `npm run features:check` says whether it is behind.
- **Boot**: `ensureFeatureRegistry()` (from `bootstrap/register-modules`, not
  awaited, skipped under `NODE_ENV=test`) folds the three Lot A rows under
  their registry keys, then upserts every feature — the declarations widened
  by the document's surfaces, plus the document's manifest-only features — into
  `FeatureFlag`: a new row is created `enabled` unless `launch: 'dark'`, with
  `source: REGISTERED`, `registeredAt`, `surfaces`, `kind`, `owner`,
  `variants`; an existing REGISTERED row has its metadata refreshed and keeps
  its `enabled`, `rolloutPercent`, `variant` and `rollout`; a MANUAL row is
  never touched. Until it lands, a declared key with no row answers from its
  launch default, so nothing waits on the boot window. G12-B: `variants` on
  the row is the **union** of the declaration's and the committed document's
  (`registrations()`), so a variant declared server-side — `listings/features`
  `marketplace.instant-booking` `['default', 'recommended']`, `campaigns/features`
  `campaigns.multi-market` `['default', 'unwarned']` — is accepted by
  `PATCH /flags/:key { variant }` on the next boot without a manifest sync.
- **The check** (G11-2): `registry-check.ts` is the one checker. It folds the
  declarations and the manifests on disk (`MANIFEST_FILES`, resolved from
  the package root) into a fresh document and compares it with the
  committed one **per surface**, on the fields that surface contributes —
  BACKEND: kind, owner, launch, description, aliases, routes, jobs (and the
  merged surfaces and variants when every manifest is present); a manifest
  surface: whether it names the key, its paths, and for a manifest-only
  feature its metadata. Each surface answers `{ behind, reasons[] }` with
  one line per key ("`x.y` is in the code but not in the document",
  "… is in the document but no longer in the code", "… differs (routes,
  description)"). A manifest not on disk leaves its surface "not compared"
  (`behind: false`, the reason says so), the way the architecture test
  treats it; a manifest that does not parse or cannot be folded is behind.
  `npm run features:check` prints it and exits 1 when any surface is
  behind; `GET /flags/registry` carries it as `check`. `scripts/
  collect-features.ts` re-exports the manifest reader from here so the
  script, the gate and the read measure the same files.
- **The gate**: `tests/architecture/feature-registry.test.ts` fails when a
  mounted route is covered by no feature (neither `requireFeature(key)` on its
  chain nor a declared route prefix — the longest declared prefix wins, so a
  module's root prefix is the safety net under its finer keys), when a job
  under `src/jobs` is mapped to no feature, when a module has no `features.ts`
  or its `index.ts` does not import it, when a declared prefix or job matches
  nothing, and when `docs/feature-registry.json` is behind.

Keys are `<area>.<capability>`, lower-case, hyphens allowed. The three Lot A
keys live on as aliases: `isFeatureEnabled('instant-booking')` resolves to
`marketplace.instant-booking`, `multi-market-campaigns` to
`campaigns.multi-market`, `publisher-spot-insights` to
`publisher.spot-insights`, and `GET /app/flags` still answers the flat boolean
under each for one release.

## Owned routes

| Method | Path | Guard | What |
| --- | --- | --- | --- |
| GET | `/api/v1/flags` | ADMIN | every flag: `surfaces`, `kind`, `source`, `owner`, `variant`, `variants`, `rollout`, `lastGoodState`, `registeredAt`, `aliases`, and `lastChange` (with `byUser`). L-B: optional `?surface=&kind=&source=&state=ON\|OFF\|DARK_LAUNCH&owner=&q=` — the console's own filters, evaluated server-side so a bulk selection can name "every key the filter leaves" (`owner` exact, case-insensitive; `q` a substring over key, description, owner and aliases; a value outside the vocabulary is a 400). Two shapes: without `page`/`pageSize` the **bare array** the console reads today (filtered or not); with either of them the **list contract** `{ items, total, page, pageSize, counts: { surface, kind, state } }` (`page` defaults to 1, `pageSize` to 50, max 500), each count facet tallied with its own facet removed from the filter so a chip row stays a way back out |
| GET | `/api/v1/flags/registry` | ADMIN | `docs/feature-registry.json` (every surface, the manifests' paths, where each feature is declared) merged with the rows as `flag`; a row the document does not know is listed from the row alone. G11-2: also `check: { current, surfaces: [{ surface, behind, reasons[] }] }` — is the committed document behind the code, per surface, the same verdict `npm run features:check` prints (see below) |
| GET | `/api/v1/flags/me` | ADMIN | G11-2: `{ key: { enabled, variant } }` for the caller across **every** surface — the console's own evaluation moves server-side, through the evaluator `/app/flags` uses (same bucket, same rules, the city through the port); no legacy booleans. `Cache-Control: no-store` |
| PATCH | `/api/v1/flags/:key` | ADMIN | `{ enabled?, rolloutPercent?, variant?, rollout?, note? }` — a patch; `variant` must be one of the row's `variants` (or null); `rollout` is `{ roles?, cities?, userIds? }` or null; writes a `FeatureFlagChange` (with `variant`, `rollout`), stores the position before as `lastGoodState`, fires the flag change port; audited `FEATURE_FLAG_CHANGED` with the diff over enabled / rolloutPercent / variant / rollout |
| PUT | `/api/v1/flags/:key` | ADMIN | the same handler — the console that ships today PUTs; one release |
| POST | `/api/v1/flags/:key/rollback` | ADMIN + `system.flags` | `{ note? }` — restores `lastGoodState`, keeps the current position as the new `lastGoodState` (so a rollback can be rolled back), writes a change with `rollbackOfId` = the change it undid, fires the port; 409 when the flag has never moved; audited `FEATURE_FLAG_ROLLED_BACK` with what was restored |
| POST | `/api/v1/flags/bulk` | ADMIN | L-B: `{ keys: string[] (1-200, distinct; aliases accepted), patch: { enabled?, rolloutPercent?, variant?, rollout? } (the same patch `PATCH /:key` takes, at least one field), note (required, 4-500 chars — a bulk move without a reason is the thing an incident review cannot reconstruct) }`. Applies the patch to every key in **one transaction** through the same path a single write takes, so `lastGoodState`, the `FeatureFlagChange` row (carrying the note) and the silent FLAGS_CHANGED push happen per key exactly as `PATCH /:key` does. The whole batch is refused with nothing written on a 404 naming the unknown keys (`{ keys }`) or a 400 naming the keys whose `variants` do not include the asked variant (`{ variant, keys: [{ key, variants }] }`). Answers `{ updated: FlagView[], skipped: [{ key, reason }] }` — `skipped` holds a key already at the asked position (no change row, `lastGoodState` untouched) and the later of an alias and its key named together. Audit: one `FEATURE_FLAG_CHANGED` per key written, with the diff and `{ note, bulk: true, changeId }`, plus one `FLAGS_BULK_UPDATED` summary row carrying `{ note, patch, keys, updated, skipped }` |
| POST | `/api/v1/flags/bulk/rollback` | ADMIN + `system.flags` | L-B: `{ keys, note }` (as above) — every key back to its `lastGoodState` through the rollback path, in one transaction, each with `rollbackOfId` and the port fired; a key that has never moved is skipped with the reason `/:key/rollback` would 409 with; unknown keys refuse the batch. Same answer shape. Audit: one `FEATURE_FLAG_ROLLED_BACK` per key restored (`{ restored, rollbackOfId, note, bulk: true }`) plus one `FLAGS_BULK_ROLLED_BACK` summary row `{ note, keys, updated, skipped }` |
| GET | `/api/v1/flags/:key/changes` | ADMIN | that flag's history, newest first, capped at 50 |
| GET | `/api/v1/app/flags` | authenticate | for the caller: `{ key: { enabled, variant } }` for every feature on an app surface (or an unclassified manual row), plus `{ legacyKey: boolean }` for the three aliases |

`:key` accepts an alias, and so does every entry of a bulk `keys` list.
`/flags/bulk` and `/flags/bulk/rollback` are mounted ahead of `/:key`, or
"bulk" would be read as a flag key. `/app/flags` sits beside `/app/status` because it
answers the other question a build asks before it does anything; unlike status
it needs a session, because a partial rollout is bucketed on the caller and the
list of what ADX is trialling is not something to publish. `Cache-Control:
no-store`.

## Enforcement

`requireFeature(key)` (exported) on a router or a route answers **503
FEATURE_OFF `{ key }`** when the flag is off for the caller and passes
otherwise. It reads the token's subject and roles (mount it behind
`authenticate` for a rollout by role) and the city through the port. A state
read that fails lets the request through and logs: a kill switch is for a
buggy feature, and turning a flags-table hiccup into a platform-wide 503 would
be the bigger outage. It is named `requireFeature(key)` in the route inventory,
which is also how the architecture test reads coverage off the chain.

The Lot A call sites (`isFeatureEnabled('instant-booking', publisherId)`,
`isFeatureEnabled('multi-market-campaigns', advertiserId)`) keep working
through the aliases and keep their 409s. `featureAnswer(key, subject)` returns
`{ enabled, variant }` for a call site that runs two implementations.

G10: `requireFeatureWhen(key, (req) => boolean)` is the same switch on a
route that only sometimes asks for the feature — the flag is evaluated only
when the predicate holds, so the ordinary write never touches the table. It
is named apart (`requireFeatureWhen(key)` in the inventory) so the
architecture test does not read it as full coverage of the route, which
stays under its module's prefix.

### Where the switches are mounted (G10)

| Key | Guard | Routes |
| --- | --- | --- |
| `marketplace.instant-booking` | `requireFeatureWhen`, body `instantBooking: true` | `POST /listings`, `PATCH /listings/:listingId` |
| `campaigns.multi-market` | `requireFeatureWhen`, body `targetMarkets` longer than one | `POST /campaigns`, `PATCH /campaigns/:id` |
| `publisher.spot-insights` | `requireFeature` | `GET /publishers/me/bookings/:orderId/insights` |
| `payments.gateways` | `requireFeature` | `POST /payments/intents` (a payment in flight still confirms and reads) |
| `campaigns.landing-pages` | `requireFeature` | the five `/campaigns/:id/landing-page*` routes and `GET /campaigns/landing-pages` (the public `/p/:slug` and the beacon stay up: the slug falls through to the package payment link) |
| `marketplace.reviews` | `requireFeature` | every route of `reviewRouter` and `reviewPartyRouter` |
| `comms.announcements` | `requireFeature` | `POST /announcements/:id/send` (a draft is still written and read) |
| `users.data-export` | `requireFeature` | `POST` / `GET /users/me/data-export` |
| `comms.push` | `requireFeature` | the three `/users/me/devices*` routes |

`tests/contract/feature-enforcement.test.ts` drives the live app with every
flag off and watches each probe answer 503 FEATURE_OFF `{ key }`, and checks
that every key above is registered and sits on at least one route of the
committed inventory.

## Evaluation (answer 146)

```
off                                  -> off
rollout.userIds non-empty            -> on iff the subject is on it (regardless of the rest)
rolloutPercent < 100                 -> needs a subject; sha1(key + subjectId) mod 100 < percent
rollout.roles non-empty              -> the caller's roles must intersect
rollout.cities non-empty             -> the caller's city must match (case-insensitive)
```

The subject is whatever the caller buckets on — the user id for `/app/flags`
and `requireFeature`, the party id where the feature is the party's. The city
comes from `Publisher.city` / `Advertiser.city` / `AgentProfile.city` through
`registerFlagSubjectCityPort` (filled by bootstrap; the first profile with a
city wins), read only when some enabled flag rolls out by city. Unregistered,
or a lookup that throws, a caller has no city and a city rollout is closed.

## Owned Prisma entities

`FeatureFlag` (keyed by its own `key`; Lot G added `surfaces`, `kind`,
`source`, `owner`, `variant`, `variants`, `rollout`, `lastGoodState`,
`registeredAt`) and `FeatureFlagChange` (`variant`, `rollout`, `rollbackOfId`).

## Public exports (`index.ts`)

- `flagRouter`, `appFlagsRouter`.
- `isFeatureEnabled(key, subjectId?, { roles?, city? }?)`, `featureAnswer(key, subject)`.
- `requireFeature(key)`.
- `ensureFeatureRegistry()` — bootstrap calls it at boot.
- `declaredFeatures`, `featureForPath`, `jobCoverage`, `knownAliases`,
  `canonicalKey` — the registry reads, for scripts and the architecture test.
- `checkRegistry(committed)`, `compareRegistryDocuments(committed, fresh,
  { missingSurfaces?, invalid? })` — G11-2, the check above.
  Declaring a feature is `import { feature } from '../../shared/features'`
  in the module's own `features.ts`, never through this index.
- `registerFlagUserLabelPort` (E6: `byUser` on the history),
  `registerFlagSubjectCityPort` (the city), `registerFlagChangePort` (fires
  after every write with `{ flag, changeId, byUserId, rollback }` — G6
  registers the push that tells the apps to refresh `/app/flags`).

## Invariants

- **An unknown key is false; a declared key answers.** A typo in a call site
  fails closed. A key declared in code but not yet written by the boot upsert
  answers from its `launch` — on for `'on'`, off for `'dark'`.
- **A partial rollout is deterministic.** Same person, same answer, for the
  life of the rollout. A caller with no subject and a partial rollout is told
  no.
- **Named accounts win.** A `userIds` list is an allowlist; nobody else is on
  while it is set.
- **A patch, never a replacement.** Naming one of `enabled`, `rolloutPercent`,
  `variant`, `rollout` leaves the other three where they are. A body naming
  none is a 400.
- **A variant is one of the declared variants.** Or null. Anything else is a
  400 naming the list.
- **A flag never moves without an author, and never without a way back.** The
  update, the change row and `lastGoodState` are one transaction.
- **A bulk move is one transaction, or none** (L-B). Every key is resolved
  and every variant checked before anything is written; half a batch landed
  would be a position nobody asked for with no single change to undo. A key
  already at the asked position is left alone — no change row, no
  `lastGoodState` overwritten with itself — and reported under `skipped`.
  A bulk move always carries a note.
- **Rows come from the registry, not from PATCH.** A key nobody declared is a
  404. A MANUAL row (created by hand, or a Lot A row before the fold) is never
  overwritten by the upsert.
- **30-second cache**, in Redis, invalidated by every write and by the boot
  upsert: a kill switch takes effect at once on the instance that threw it and
  within the TTL everywhere else. Redis being down degrades to a database
  read, never to a wrong answer.

## Dependencies

`shared/features`, `shared/cache`, `shared/audit`, `shared/auth`,
`shared/errors`, `shared/logging`. No module imports; `campaigns`, `listings`
and `orders` import `isFeatureEnabled`, and every module's `features.ts`
imports `shared/features`.

## Tests

```bash
npx vitest run src/modules/feature-flags tests/architecture/feature-registry.test.ts
```

`__tests__/feature-flags.test.ts` — L-B: the bulk write (two keys written
in one `updateMany`, a third skipped with no change row, the port fired per
key; the per-key audit rows plus the `FLAGS_BULK_UPDATED` summary; a 404
naming the unknown keys and a 400 naming the key without the variant, both
with nothing written; the required note, distinct keys and the guards; an
alias and its key named together; a no-op rollout compared as sets), the
bulk rollback (restored through the rollback path in one transaction, the
never-moved key skipped with its reason, `system.flags`, the summary row),
and the list (the bare array untouched without a parameter, each filter and
their AND, the vocabulary 400s, the paged contract with the three count
facets counted with their own facet removed); G11-2: the registry check (current in
any order; per-surface new / gone / differs; a missing manifest not
compared, a broken one behind; a missing document behind everywhere) and
`GET /flags/me` (every surface, `{ enabled, variant }` only, the same
bucket as `/app/flags`); the evaluator (unknown key, launch
default, 0 and 100, bucket stability and spread, the anonymous case, the
variant, the four rollout rules and their order, the alias and the unfolded
legacy row, the city port), the patch semantics (variant validation, rollout
cleaning, `lastGoodState`, the change port), rollback, the boot upsert
(fold, create on/dark, refresh REGISTERED, skip MANUAL, the document's
surfaces and manifest-only features), `requireFeature`, and the seven routes
through supertest. `tests/architecture/feature-registry.test.ts` — the gate.

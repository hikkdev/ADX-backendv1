# pricing

A price-range **suggester**, not a quoter.

Publishers set their own prices. This module tells them whether the number they
just typed looks right for where they are, in one sentence under a form field.
It never blocks a listing and it never returns a price the platform intends to
charge.

Full rationale in [`docs/pricing-engine.md`](../../../docs/pricing-engine.md).

## The one query everything serves

> Find the spots that are the same kind of thing within 200 m, and report the
> lowest and highest price among them.

Every model in the schema either feeds that query or explains its answer.

**Match key — all four, exactly:** media type, category (implied by media type),
size class, and within 200 m. Material is *not* in the key; it is approximate by
nature and gating on it would empty the set.

**The radius does not widen.** A spot with no comparables within 200 m has no
comparables, and the engine says so. Reaching further to avoid saying nothing is
how a suggester becomes quietly wrong.

## What the module exports

| Export | For |
| --- | --- |
| `evaluatePrice` | The sentence under the pricing field |
| `comparablesFor` | The inspectable set behind that sentence |
| `matchMediaType` | Which media type a new spot belongs to |
| `suggestedRate` | Base plus applied factors — the offer to exclusive publishers; each applied factor carries its `mode` (Lot E) |
| `registerListingRepricePort` | Lot E (Q125): how a BINDING factor writes a rate and raises a price case — filled by bootstrap with `listings.updateListing` and `rate-cards.raisePriceCase` |
| `activeSurge` | Whether a window is lifting the ceiling here right now |
| `resolveCity` / `buildCityResolver` / `listCities` | Free-text city name to a canonical key (active rows only) |
| `assertCityAllows` / `citySupport` | Lot A (Q31) / Lot V: is ADX open for business there — and for which function? |
| `slugify`, `CITY_FUNCTIONS`, `CITY_STAGES`, `pickCityRow` | Lot V: the spelling key and the vocabulary `geo` builds the catalogue on |
| `cityKeyFor` / `withCityKey` / `buildCityKeyResolver` | Lot X-B: the `City` row id a typed city denotes — stamped as `cityId` beside the string on every party write |
| `listUnresolvedCities` / `backfillCityKeys` / `CITY_KEYED_TABLES` | Lot X-B: the typed strings with no key (what `GET /geo/unresolved` answers) and the re-resolve over them (`npm run backfill:city-keys`) |

Nothing else is public. The rest of the router is ops surface.

## Cities — which geographies ADX is open in, and for what (Lot A Q31, Lot V)

`City` lives here because the resolver does: the same table that makes
"Bangalore" and "Bengaluru" one comparable pool decides where ADX trades.
Since Lot V (the owner, 15 Sep 2026) the table is the country — ~6,500
GeoNames towns under their districts and states — and each row carries a
rollout **stage** (PLANNED, SEEDING, LAUNCHED, PAUSED, WITHDRAWN) and six
function **switches** (`supplyIntake`, `publishing`, `demand`,
`agentOnboarding`, `printPartners`, `leadFeeds`). The stage machine, the
catalogue's editor, the seed and the wind-down are `geo`'s
(`modules/geo/README.md`); this module keeps the resolver and the gate,
because every gated module already imports it and `geo` sits above it.

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/api/v1/pricing/cities` | ADMIN — every city, retired ones included: slug, name, state, aliases, isActive, stage, switches, population (the whole catalogue; the paged, filtered read is `GET /geo/cities`) |
| PATCH | `/api/v1/pricing/cities/:slug` | ADMIN — `{ aliases? }`, audited `CITY_UPDATED`. `isActive` is accepted only when it already agrees with the row: it mirrors the stage now, and a change answers 400 pointing at `PATCH /geo/cities/:slug/rollout`. Lot X-B: each alias **added** folds in the rows typed under it (as stored and de-hyphenated) whose key is still null — one `updateMany` per party table — and forgets the key cache |

`citySupport(name)` answers `{ support, city, resolved, stage, switches }`
with one query per name (by slug, by a stored alias or by the display name,
case-insensitively — never the whole table, which is six and a half thousand
rows). A name India has several of (Rampur, Raipur) picks the most advanced
stage, then the biggest place (`pickCityRow`). Three supports, and the
middle one is the point:

- `ACTIVE` — a catalogued city whose stage resolves (SEEDING, LAUNCHED, PAUSED).
- `INACTIVE` — a catalogued city whose stage does not (PLANNED — the towns the
  country catalogue added — or WITHDRAWN).
- `UNKNOWN` — a name the catalogue has never heard of. **Allowed.** The city
  field is free text; a listing form that refused a hamlet ADX had not
  catalogued would be a worse product than one that takes the name and sorts
  it out later. `resolved` is false and every switch reads true.

`assertCityAllows(name, function)` is the gate, per function: it throws
`400 CITY_NOT_OPEN { stage, function, city }` on a catalogued city whose
switch for that function is off, and lets an unknown or empty name through
(noting an unknown one once a day under `geo:unknown-city:<day>:<slug>` in
Redis, so ops can add the town by hand). Who calls it for what is the table
in `geo`'s README: `listings.createListing` and the listing importer
(`supplyIntake`); `listings.publishListing` and `supply.reviewVerification`
(`publishing`); `campaigns.patchDraft` and the browse city filter (`demand`);
`agents.createAgent` and the party importer's agent rows (`agentOnboarding`);
`print-partners.createPartner` / `activatePartner` (`printPartners`);
`leads.importLeads` (`leadFeeds`). It replaces Lot A's `assertCitySupported`,
which knew only on and off.

`resolveCity` / `buildCityResolver` / `listCities` stay over **active rows
only**, so the PLANNED towns never claim a spelling; names and slugs are
indexed before aliases, so one town's alias never shadows another town's
name. Name and state are not editable through the PATCH — a city is renamed
by the seed. Aliases are slugified on the way in, so one spelling cannot be
stored twice.

### The city key — Lot X-B

Every party table that carries a free-text city (`Publisher`, `Advertiser`,
`AgentProfile`, `PrintPartner`, `Listing`, `Lead`, `FieldVisit`; `Campaign`
as `targetMarket`) carries the `City` row id beside it — `cityId`
(`targetMarketCityId`), nullable, `onDelete: SetNull`, indexed. **Every
write that sets the string stamps the key** through `cityKeyFor(name)` →
`{ cityId, slug } | null` (`withCityKey(data)` spreads it beside `city`;
`buildCityKeyResolver(cities)` for `supply`'s batch): publishers (agent
onboarding, console create, the two patches, the legacy-book importer),
advertisers (register, patch — the party importer goes through both), agents
(create, patch), print partners (create, the two patches), listings (create,
patch, `supply`'s attempt batch; the listing importer creates through
`createListing`), leads (create, patch, import, waitlist), visits (create),
campaigns (`targetMarket` / `targetMarkets` on `patchDraft`). The string
**stays as typed** — the owner's rule that a town outside the catalogue is
allowed — and a string that resolves to nothing leaves the key null.

The key resolves the way the gate does: one query by slug, alias or display
name over the **whole** catalogue, PLANNED towns included (a publisher in a
town ADX has not opened yet still keys to that town — that is what makes
`geo`'s counts exact), `pickCityRow` picking when India has several of a
name; cached a minute per normalised spelling (`clearCityKeyCache` for
tests and the alias edit). `assertCityAllows(name, fn, cityId?)` judges a
row by the key it carries and by the spelling only for a row that has none.

**The key is the identity on every read.** A group-by, count or facet
compares keys: a row keyed to Bengaluru is Bengaluru whatever it was typed
as; a row with no key is matched by its spelling, case-insensitively; a
facet that resolves to no key (a typed town nobody catalogued) matches only
rows with no key. `?city=` takes a slug (the console's older links still
pass a name — either resolves). The rows typed under towns with no key are
one "Other (typed)" bucket on the overviews, the raw strings listed under
it; `GET /geo/unresolved` lists those strings with their row counts so ops
can add an alias here or a manual city (`POST /geo/cities`) and fold them
in — the alias edit folds its own rows at once, `npm run backfill:city-keys`
(`backfillCityKeys`; from the console, Lot X-L's `POST /geo/backfill-city-keys`,
under a lock) re-runs the resolver over every null key for a city
added by hand.

Lot X-L closed the reads Lot X-B left on the string: `GET /visits?city=`,
the print quote fan-out (`findPartnersInReach`), `listings.findSimilar`, the
lead clusters' city scope, and — by design still the spelling, with the key
added beside it — `GET /listings/browse?city=`. Each module's README says
how.

## Three things that will bite a reader

**1. The verdict is settled before surge is considered.** Inside the range the
two 5% edges are tested against the observed market; where both fire — any
spread under ~10.5%, so routinely — the nearer end wins, and an exact tie is the
going rate. Surge then does exactly one thing: relax a `TOO_HIGH` into a `GOOD`.
It must not touch `TOO_LOW`, `LOW_SIDE` or the proximity comparison, because it
lifts what a publisher may charge and says nothing about what the market is.
Three earlier versions each broke this differently; `observedVerdict` exists to
keep the two questions apart.

**2. One contributor, one voice.** A publisher with ten hoardings on one road is
one opinion, not ten. `collapseByContributor` reduces each contributor to their
median before the range is taken, so nobody can move the market rate by adding
listings. The same `contributorKey` shape covers ADX listings (`pub:<id>`) and
research rows (`res:<competitor>`), which is what lets one rule cover both.

**3. Trust is a ladder, not a coefficient.** `pickTier` prefers ADX listings
that actually sold, falls back to untested asks (ours *and* research, which are
worth the same), and reaches for a publisher rate card only when there is
nothing else. At launch tier one is empty so research decides the range; as real
orders accumulate tier one crosses `validatedTakeoverCount` and takes over. The
shift from research-led to ADX-led pricing is implemented, not scheduled.

Two details that look like nits and are not. The crossover has its **own**
setting rather than borrowing `thinEvidenceCount`, which governs a sentence —
sharing one column meant raising the caveat threshold silently postponed the
handover. And `weakestTier` labels a mixed set by its weakest member, because
one sale among six contributors is not `VALIDATED` evidence and saying so would
overstate the provenance of five-sixths of the range.

## Surge moves the indicator, never the price

During a surge window the `TOO_HIGH` edge lifts by the window's uplift and
nothing else changes. A publisher can raise their rate without being flagged;
the baselines the engine compares against are untouched, which is why surge
never contaminates the pool.

Overlapping windows do not compound — the strongest wins. Two events in one week
are two descriptions of a busy week, not two reasons to double a price.

`isEnabled` is a kill switch and the upsert deliberately never touches it: a
window ops switched off stays off the next time the scraper sees the same event.
A scraped window must carry an `externalRef` for that to hold — without one the
upsert takes the create branch and a re-scrape raises a fresh enabled duplicate
beside the disabled one, which `activeSurge` would then pick as the strongest.

Keeping surge out of the *pool* takes one more step, because comparables read
listing prices live. A listing records **when the window ends**
(`ratePerDaySurgeUntil`), stamped at write time by `classifySpot`'s callers, and
sits out of every comparable set until then. Without it the price rise the
indicator invites becomes every neighbour's baseline.

It is a timestamp and not a flag for a reason: a flag was never cleared by
anything, and a national window covers every spot in the country, so one
election would have drained the pool permanently — visible only as the indicator
going quiet more often.

## The taxonomy is the fragile part

Fragmentation is the failure that matters. Two media types that should have been
one is repairable; a split taxonomy silently empties every comparable set, and
nobody notices until the indicator has stopped appearing for half the catalogue.

So matching is biased toward matching, every decision is logged
(`MediaTypeMatchLog`), unrecognised vocabulary is proposed rather than created
(`VocabularyProposal`), and ops can merge (`mergeMediaTypes`, which re-points
listings and market data in one transaction and leaves a tombstone).

T-B: `POST /pricing/media-types` and `PATCH /pricing/media-types/:id` answer
what `GET /pricing/media-types` lists — the row with `sizeClassIds` and
`materialIds` (`MediaTypeDetail`, the same include on the write, no second
read), so the vocabulary screen updates its row from the answer.

Token singularisation in `tokenise` is **not** stemming and must not become it.
It exists so "Unipole Hoardings" matches "Unipole Hoarding"; "hoarding"
collapsing to "hoard" would be the opposite error.

## Factors: the engine proposes, ADX decides

`suggested` and `applied` are separate columns because a suggestion the engine
made and a decision a person took are different facts. Nothing multiplies a
price automatically. `suggestWhen` is a small predicate language
(`all`/`any`/`not` over comparisons) rather than an expression evaluator —
ops-authored JSON reaching an `eval` is a remote code execution with extra
steps.

### Lot E (Q59/Q125): ADVISORY and BINDING

A factor has a `mode`, and `POST /pricing/listings/:id/factors/apply` reads it:

| Mode | Applying it does | Trail |
| --- | --- | --- |
| `ADVISORY` (default, every factor before the lot) | Records the decision and nothing else moves. The publisher reads the offer at `GET /listings/me/:id/suggested-rate` and takes it, or not. | `LISTING_FACTOR_APPLIED` |
| `BINDING` | Reprices the listing to the suggested rate with the factor worked in — through `listings.updateListing` via the port, never a direct write — and stamps the rate on `ListingPricingFactor.appliedRatePerDay`. The publisher is told (SYSTEM). | `LISTING_REPRICED_BY_FACTOR` with a `ratePerDay` diff |
| `BINDING` + `bindingDuringSurgeOnly` | Binds only while `activeSurge()` covers the listing; advisory the rest of the time, and the audit row says which it was. | either of the above |

**The cap.** A binding apply may move the rate at most
`PricingSettings.maxBindingChangePct` (0.25) of what it found:
`|new − old| / old`. Above it nothing is written — the apply answers **409
`BINDING_CHANGE_TOO_LARGE`** with `details.priceApprovalId`, and a
PriceApproval (source `PUBLISH_REQUEST`, reason beginning `binding factor
exceeded cap`) is raised through the port for a person to decide; the row
is logged `LISTING_FACTOR_CASE_RAISED`. Exactly the cap passes. A listing
with no rate yet — `ratePerDay` null — **or a previous rate of zero** has
nothing to measure against (the cap is a ratio of the old rate, and zero
divides nothing) and is simply priced, as a listing being priced for the
first time is; a live listing at zero is a data fault, not a price move, and
the skip is deliberate rather than a gap (E7-2, Lot E verifier).

**Un-applying a binding factor reprices back** the same way, minus the
factor, under the same cap. A price that kept a multiplier nobody applied any
more would be the drift the `applied` column exists to prevent.

The price is computed before anything is written (`suggestedRateFrom` over the
proposals with the decision assumed), so a refused apply leaves no trace but
the case. With no comparables within the radius there is no base and the
binding apply refuses 409 like `suggestedRate` does — an advisory apply still
records.

Create and update schemas take `mode` and `bindingDuringSurgeOnly`; settings
take `maxBindingChangePct` as a fraction string.

Size is deliberately not a factor, and the enforcement is that `factsFor` does
not put `sizeClass` within a rule's reach. It is already counted once in the
size class, and prose in three files saying "do not do this" did not stop an
admin writing `{"field":"sizeClass", ...}` — not offering the field does.

The compounding cap **flags rather than clamps**. Ten individually reasonable
multipliers still reach somewhere absurd, and silently trimming the answer would
hide the misconfiguration that caused it.

## How a listing reaches the engine

`listings.service` and `supply.service` classify a spot on the way in — this is
the only path by which the taxonomy grows, and the only place fragmentation can
be caught:

- `ratePerDay` as a decimal string, or `monthlyPrice` for the old shape, each
  derived from the other at a flat 30 days.
- `classifySpot` resolves media type, size class and material from ids, names or
  slugs — one place, so the two paths cannot drift. The match key is **not
  partial**: a listing with a media type but no size class enters no pool at
  all, which looks like a working listing the indicator silently ignores.
- A bulk batch resolves **once per distinct description**, and fetches surge
  windows **once for the batch** then applies them purely per row. Five hundred
  scraped spots are usually a dozen real descriptions repeated.
- Surge provenance is stamped on create and on any edit that changes the price.
- Anything name- or slug-shaped is stripped before the row reaches Prisma.
  TypeScript does not flag excess properties through a spread, so a leftover
  slug reaches `createMany` as an unknown column and fails the whole batch at
  runtime — this has already happened once.

## Setup

```
npm run seed:pricing
```

Seeds size classes, materials and a starting media-type taxonomy. Without it the
engine rejects every row of market data, which is the controlled lists working
as intended rather than a bug.

```
npm run backfill:city-keys
```

Lot X-B: re-resolves the city key over every party row whose key is null and
reports resolved / still-null per table. Run after adding a manual city, or
whenever the Geographies overview's "unresolved" list should shrink; the
alias edit folds its own rows without it. Idempotent.

## Not in this module

Commission, platform fees, installation and design charges, publisher
subscriptions and promotional commission overrides. Those decide what an
advertiser pays; this decides what a publisher lists at.

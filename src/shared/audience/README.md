# shared/audience — the audience / footfall seam

G7 (Q109): the `AudienceProvider` port — `catchment(lat, lng, radiusM,
period)` → `footfall { daily, byHour[24], byWeekday[7] }`, `demographics
{ ageBands, gender, incomeBands, affinities }`, `provenance: 'PANEL'` — with
two adapters, `geoiq.ts` (Data Serving `getvariables`, the account's
catalogue ids mapped by `audience.geoiqVariables`; no hourly panel → null)
and `azira.ts` (footfall insights over a circle and a month; no public host →
503 until the contract's base URL is set). Rule for every adapter: **map what
the vendor documents, mark the rest null, never invent** — the recorded
shapes are `__tests__/fixtures/`. Nothing is stored here; the
per-(listing, vendor, month) snapshot is `listings`' `AudienceSnapshot`.

## Y-B: both vendors at once

The owner (15 Sep 2026): "in the Audience data section I want to add both
GeoIQ and Azira at the same time, for rich data on the audience in a
particular geography." So the seam runs an enabled **set**, not one vendor:

- **The set** — `audience.providers: ('GEOIQ' | 'AZIRA')[]` on the
  integrations row (`shared/integrations`, `getEffectiveAudienceConfig`);
  empty means nothing backs a figure. A legacy one-vendor `provider` row
  still reads as a one-element set (`resolveAudienceProviders`), so a stored
  row keeps working. `audienceVendorsInForce()` answers the set;
  `audienceVendorName()` keeps answering one name for old readers — the
  footfall primary when it is enabled, else the first enabled vendor, else
  NONE (`legacyAudienceProvider`).
- **The policy** — `audience.policy`, resolved over the defaults
  (`resolveAudiencePolicy`, `DEFAULT_AUDIENCE_POLICY`):

  | group | `primary` | `fallback` | `blend` | default |
  | --- | --- | --- | --- | --- |
  | `footfall` (daily, byHour, byWeekday) | which vendor's figure is printed | the other fills a null | `AVERAGE` both when both answer, else `PRIMARY` | Azira-primary (a mobility panel), fallback on, AVERAGE |
  | `demographics` (ageBands, gender, incomeBands) | ″ | ″ | — | GeoIQ-primary (a data panel), fallback on |
  | `affinities` | ″ | ″ | — | GeoIQ-primary, fallback on |

- **The ask** — `audienceCatchment(lat, lng, period)` asks EVERY enabled
  vendor in parallel (`askVendors`), each failure isolated: a 429 / 502 from
  one vendor never loses the other's answer; a vendor with no credentials
  (its own 503 `INTEGRATION_NOT_CONFIGURED`) is skipped, not fatal. Nothing
  enabled, or nothing configured among the enabled, is the one 503; a
  vendor's own 429 / 502 surfaces only when no vendor answered at all
  (`askFailure`); every vendor having nothing for the circle is null.
- **The blend** — `blendAudience(rawByVendor, policy)` in `blend.ts`, pure:
  each field is the primary's, the other's when the primary has null and
  the group's fallback is on, and footfall's three figures are averaged
  (daily rounded, profiles element-wise) when both answer under `AVERAGE`.
  The answer is a `BlendedAudienceCatchment`: the legacy `AudienceCatchment`
  shape (every old reader still finds `footfall`, `demographics`,
  `provenance: 'PANEL'`, a `vendor` — the footfall's source, or the footfall
  primary when it is blended) plus
  - `provenanceByField: { footfall, demographics, affinities }`, each
    `'GEOIQ' | 'AZIRA' | 'BLENDED' | null` — one vendor, both (an averaged
    figure, or a group whose fields came from different vendors), or nobody;
  - `vendors` — the list that answered;
  - `agreement: { footfall }` — `1 − |a − b| / max(a, b)` when both gave a
    daily figure (two zeros agree: 1), to three places, else null; a screen
    prints "both vendors agree within 12 %";
  - `rawByVendor: { GEOIQ?, AZIRA? }` — each vendor's own answer, for the
    desk.
- **Read-time blending** — `listings` stores each vendor's RAW answer as its
  own `AudienceSnapshot` row and blends on read, so a policy change
  re-blends with no vendor call and a vendor enabled later fills in on the
  next read (only the vendors lacking a fresh row are asked). `geo`'s city
  profile folds the stored rows the same way. `foldProvenance`,
  `provenanceOf` (a raw row's groups are that vendor's) and `meanAgreement`
  are the helpers those folds use.

## AC-B2: GeoIQ made to actually work (16 Sep 2026)

The live probe with the owner's key taught three things, all in `geoiq.ts`:

- **The host is regional.** `dataserving.geoiq.io` (the first cut's default)
  does not resolve. GeoIQ's Data Serving API is `dataserving-in.geoiq.io`
  for India — now `GEOIQ_DEFAULT_BASE_URL` in `shared/integrations` — and
  `dataserving-us.geoiq.io` for the US; `audience.geoiqBaseUrl` (or
  `GEOIQ_BASE_URL`) points elsewhere.
- **The gateway envelope.** The host answers HTTP 200 whatever happened,
  with the real answer as a JSON STRING under `body` and the real status as
  `statusCode` beside it: `{ "body": "{\"status\": 401, \"message\": \"You
  are not authorized to access this API. …\", \"data\": null}", "statusCode":
  401 }`. `unwrapGeoiqAnswer(httpStatus, raw)` takes it off (a plain
  answer's own numeric `status` counts the same way; otherwise the HTTP
  status stands) and `throwForGeoiqStatus` runs the error table on the
  EFFECTIVE status: 401/403 → 503 `INTEGRATION_NOT_CONFIGURED` "not
  authorised — contact GeoIQ", carrying GeoIQ's own sentence; 400/422 →
  400 with its message; 429 → 429; 404 → nothing for the circle; else 502.
  A dead host is 502 with the failure named — never the key.
- **The call limits** (docs.geoiq.io): radius 100–2000 m — `clampGeoiqRadius`,
  and the catchment's `radiusM` reports the circle actually asked about —
  and 50 variables a call — `geoiqGetVariables` chunks the mapped ids and
  merges the answers.

**The vendor test** — `testAudienceVendor(vendor)` in `probe.ts`, behind
`POST /integrations/audience/test`: asks the vendor ONCE at
`AUDIENCE_TEST_POINT` (MG Road, Bengaluru — 12.9755, 77.6068) at the row's
radius (clamped) with the mapped variables, or with GeoIQ's documented
sample `w_pop_tt` (total population) when none are mapped so the KEY can be
tested before the map exists, and answers an `AudienceVendorTest` —
`{ vendor, keyPresent, variablesMapped, reachable, authorized, status,
message, fieldsAnswered, fieldsMissing, sample: { footfallDaily } }`. It
never throws for what the vendor did: no key, a refused key, a dead host, a
vendor 5xx are verdicts. `geoiqTest` names the mapped fields that did / did
not come back; `aziraTest` names the seam's groups (`footfall.daily`,
`footfall.byHour`, `footfall.byWeekday`, `age`, `gender`, `income`,
`affinity`) and skips gracefully when the key or the base URL is absent.

**The field catalogue** — `AUDIENCE_FIELD_CATALOGUE` / `AUDIENCE_FIELD_GROUPS`
in `types.ts`, behind `GET /integrations/audience/fields`: `footfall.daily`
(required), the age bands `18_24 / 25_34 / 35_44 / 45_54 / 55_plus`
(`AUDIENCE_AGE_BANDS`), `gender.male / female / other`, the income bands
`low / mid / high / affluent` (`AUDIENCE_INCOME_BANDS`), and affinity as a
free-form group (`affinity.<name>`). The pattern stays open on `age.*` and
`income.*` — an account that bought another cut maps it and it is printed
under its own label.

## Exports

`audienceCatchment`, `audienceVendorsInForce`, `audienceVendorName`,
`getAudienceSetup` (`{ vendors, policy, radiusM }`), `audienceProviderFor`,
`askVendors` / `askFailure`, `getAudienceProvider` (pre-Y-B readers),
`blendAudience`, `footfallAgreement`, `foldProvenance`, `provenanceOf`,
`meanAgreement`, `otherVendor`, the types and `AUDIENCE_FIELD_PATTERN`,
`AUDIENCE_PERIOD_PATTERN`, `periodBounds`; AC-B2: `testAudienceVendor`,
`AUDIENCE_TEST_POINT`, `geoiqTest`, `aziraTest`, `unwrapGeoiqAnswer`,
`clampGeoiqRadius`, `GEOIQ_RADIUS_MIN_M` / `GEOIQ_RADIUS_MAX_M` /
`GEOIQ_MAX_VARIABLES_PER_CALL` / `GEOIQ_SAMPLE_VARIABLE`,
`AUDIENCE_FIELD_CATALOGUE`, `AUDIENCE_FIELD_GROUPS`, `AUDIENCE_AGE_BANDS`,
`AUDIENCE_INCOME_BANDS`, `AUDIENCE_GENDERS`, `AudienceVendorTest`.

## Tests

`__tests__/audience.test.ts` — the seam over the stubbed adapters: nothing
enabled, one vendor, both (parallel, blended, the raw answers beside), one
vendor's 429 keeping the other's answer, a credential-less vendor skipped,
the legacy row as a set, the adapters' own shapes and failures; AC-B2: the
India host default, the gateway envelope (200-with-401 → 503 with GeoIQ's
sentence; 200-with-data → a catchment; an inner 429 / 400 / 500 by the
table), the radius clamp, chunking at 50, and the vendor test's verdicts
(no key, the refusal, fields answered / missing, a dead host, Azira absent
and present).
`__tests__/blend.test.ts` — the blend per field with primary / fallback /
average, the per-field provenance, the agreement maths, the fold helpers.

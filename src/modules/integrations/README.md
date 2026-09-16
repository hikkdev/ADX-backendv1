# integrations

The admin screen over third-party provider credentials: SMS (Lot E — the rail routing table), email, storage,
KYC, Twilio, Resend, Google Maps, Razorpay, Cashfree, CCAvenue (Lot C — the
`payments` gateways, each with a `testMode` switch drawn as-is), Stripe,
branding and (Lot E) the HR tool.

## This module owns the screen, not the storage

Resolving effective configuration — stored override falling back to `.env`, with
a Redis cache — lives in **`shared/integrations`**, not here. It has to:
`shared/sms`, `shared/email` and `shared/storage` all read it, and shared
infrastructure may not import a business module. This module is the HTTP surface
over that resolver.

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/api/v1/integrations` | `authenticate` + ADMIN |
| PUT | `/api/v1/integrations` | `authenticate` + ADMIN |
| GET | `/api/v1/integrations` → `maps` | G7 (Q101/132/137): `{ provider: GOOGLE \| MAPBOX \| OSM, googleBrowserKey, googleServerKey, mapboxPublicToken, mapboxSecretToken, osm }` — all four keys masked; the server key shows the pre-G7 `googleMaps.apiKey` row through, then `GOOGLE_MAPS_API_KEY`. Z-B: `osm` is always present, defaults filled in: `{ nominatimBaseUrl, osrmBaseUrl, photonBaseUrl, contactEmail, userAgent, tileUrlTemplate, tileAttribution, tileMaxZoom, tileApiKey (masked), publicTiles }` — `publicTiles` is true while the template still names `tile.openstreetmap.org`; a legacy row without `osm` reads the same defaults. **AC-B1:** under `provider: 'OSM'` only, `phoneEngine: { engine: 'MAPBOX', tokenPresent }` — the phones run the Mapbox engine on every provider and need the PUBLIC token (`mapboxPublicToken`, env `MAPBOX_PUBLIC_TOKEN`) to initialise it before drawing OSM tiles; only the verdict leaves, the token stays the masked field beside it, the secret token is not consulted. Absent on Google / Mapbox |
| PUT | `/api/v1/integrations` `{ section: 'maps' }` | same guard — the provider switch, the four keys and, Z-B, the `osm` sub-object (**strict**; merged over the stored sub-object, blank keeps, `null` clears back to the default; `tileUrlTemplate` must carry `{z}`, `{x}`, `{y}`; `tileMaxZoom` 1–22; `publicTiles` is written by the server from the template, refused from the screen). **Selecting OSM — or clearing the email while on it — without `osm.contactEmail` is refused 400** `VALIDATION_ERROR` (`fieldErrors['osm.contactEmail']`) and nothing is written: the public Nominatim usage policy requires one. A change of `provider` is audited `MAPS_PROVIDER_CHANGED` (targetType `AppConfig`, targetId `integrations`, before/after diff, never a key) beside the usual `INTEGRATION_CONFIG_UPDATED` |
| GET | `/api/v1/integrations` → `audience` | G7 (Q109) / Y-B: `{ providers: ('GEOIQ' \| 'AZIRA')[] (the enabled set — empty means nothing backs a figure; a legacy one-vendor row shows through as a one-element set), provider: NONE \| GEOIQ \| AZIRA (for the old screen: the footfall primary in force), policy: { footfall: { primary, fallback, blend: PRIMARY \| AVERAGE }, demographics: { primary, fallback }, affinities: { primary, fallback } } (the full policy, defaults filled in — Azira-primary AVERAGE footfall, GeoIQ-primary demographics and affinities, every fallback on), geoiqApiKey (masked), geoiqBaseUrl, geoiqVariables, aziraApiKey (masked), aziraClientId, aziraBaseUrl, catchmentRadiusM }` |
| GET | `/api/v1/integrations` → `push` | G11-2: `{ configured: boolean, reason?: 'FCM_NOT_CONFIGURED' \| 'FCM_MISCONFIGURED' }` from `shared/push`'s `readServiceAccount` (`FIREBASE_SERVICE_ACCOUNT_JSON`) — the verdict only, computed in the mapper; the service account is never a field of the response and `push` is not a section the PUT accepts |
| PUT | `/api/v1/integrations` `{ section: 'audience' }` | same guard — Y-B: `providers` (the set, deduplicated; `[]` switches the audience off) or the legacy `provider` (NONE → `[]`, a vendor → a one-element set; the old key is cleared from the row); `policy` is **strict** — any subset of the three groups, each any subset of its fields, unknown keys or a vendor off the seam refused — and is laid over the stored policy and the defaults so the row always holds a full one; `geoiqVariables` keys must be seam field names (`footfall.daily`, `age.<band>`, `gender.male\|female\|other`, `income.<band>`, `affinity.<name>`) — AC-B2: a stray key is refused **400 `VALIDATION_ERROR` naming it** (`Not audience fields: footfall.hourly, retail.spend …`), at most 200 entries; `catchmentRadiusM` 50–5000; a change of the set or the policy is audited `AUDIENCE_PROVIDER_CHANGED` with `{ providers, policy }` before and after — never a key |
| GET | `/api/v1/integrations/audience/fields` | `authenticate` + ADMIN — AC-B2: the field catalogue the console draws the GeoIQ variable map from: `{ fields: [{ field, group, label, required }] (footfall.daily — required — then age.18_24 / 25_34 / 35_44 / 45_54 / 55_plus, gender.male / female / other, income.low / mid / high / affluent), groups: [{ group, label, freeForm, pattern? }] in drawing order (affinity is free-form: any affinity.<name>), pattern (the regex the PUT validates keys against), testPoint }` — from `shared/audience`'s `AUDIENCE_FIELD_CATALOGUE` / `AUDIENCE_FIELD_GROUPS` |
| GET | `/api/v1/integrations` → `email` | AE-B: `{ host, port, user, password (masked), from, primary: SMTP \| RESEND \| null, mode: SMTP \| ETHEREAL }` — `mode` is the SMTP door's switch in force (the row, then `EMAIL_MODE`, then SMTP). **Under ETHEREAL only**, `ethereal: { user, webUrl: 'https://ethereal.email/login' }` — the test inbox's login name (a throwaway, not a secret; `null` until the first send or test mints the inbox — a read never creates one) and where it lives. The test account's password is never a field of the response |
| PUT | `/api/v1/integrations` `{ section: 'email' }` | same guard — AE-B: the section is **strict** (`host, port, user, password, from, primary, mode`; a stray key is 400); `mode: 'SMTP' \| 'ETHEREAL'` (anything else 400). A change of `mode` is audited `EMAIL_MODE_CHANGED` (targetType `AppConfig`, targetId `integrations`, `{ mode: { before, after } }`, never the password) beside the usual `INTEGRATION_CONFIG_UPDATED` |
| POST | `/api/v1/integrations/email/test` `{ to }` | `authenticate` + ADMIN + `settings.edit` — AE-B: sends ONE message (subject `ADX test message`; a short HTML body naming the door, the from address and the time) to `to` through the one door (`shared/email`'s `sendEmail` — SMTP, Resend or the Ethereal inbox, as the row says) and answers `{ provider: SMTP \| RESEND \| ETHEREAL, configured, ok, messageId, previewUrl, response (the vendor's line, secrets masked, 500 chars), message }` — a plain verdict the card prints. **Never 5xx for what the vendor did**: SMTP with no host is `ok: false` "SMTP is not configured - fill the host, or switch the mode to Ethereal for a test inbox."; Resend with no key likewise; a refused login (a bad Gmail app password), a Resend 4xx (Resend's own sentence rides along after the status) and a dead host are `ok: false` with the vendor's sentence, the SMTP password and the Resend key masked out of it; a door that does not answer in **15 s** is `ok: false` "The door did not answer in time". Under ETHEREAL `ok: true` carries the `previewUrl` to read the message. `to` must be an email address; the body is strict. Audited `INTEGRATION_TESTED` with `{ section: 'email', provider, verdict: { configured, ok, previewUrl } }` — never a secret, never the address |
| POST | `/api/v1/integrations/audience/test` `{ vendor: 'GEOIQ' \| 'AZIRA' }` | `authenticate` + ADMIN + `settings.edit` — AC-B2: asks the vendor ONCE at a fixed point (MG Road, Bengaluru — 12.9755, 77.6068; radius = `catchmentRadiusM` clamped to the vendor's bound, GeoIQ 100–2000 m) with the mapped variables, or with GeoIQ's documented sample `w_pop_tt` when none are mapped so the KEY can be tested before the map exists, and answers `{ vendor, keyPresent, variablesMapped, reachable, authorized, status, message, fieldsAnswered[], fieldsMissing[], sample: { footfallDaily } }` — a plain verdict the card prints. **Never 5xx for what the vendor did**: no key, a refused key (GeoIQ's gateway envelope — HTTP 200 carrying `{ body: "{\"status\": 401, …}", statusCode: 401 }` — is read for its effective status and GeoIQ's own sentence), a dead host and a vendor 5xx are all verdicts; Azira without its key or base URL is `reachable: false` with the sentence. Audited `INTEGRATION_TESTED` (targetType `AppConfig`, targetId `integrations`) with `{ vendor, verdict: { keyPresent, variablesMapped, reachable, authorized, status, fieldsAnswered: n, fieldsMissing: n } }` — never a key. `vendor` off the seam is 400 |

The guard is applied to the whole router, not per route, because every endpoint
here exposes or mutates credentials.

## Owned Prisma entities

None directly. Configuration is one `AppConfig` row, written through
`shared/integrations`.

## Public exports (`index.ts`)

- `integrationsRouter`.

## Files

- `integrations.mapper.ts` — builds the GET response. **Every secret is masked
  here and nowhere else**, so there is one place to audit that a raw credential
  never leaves the server.
- `integrations.schema.ts` — `sectionSchema` and the per-section `patchSchemas`,
  typed against `IntegrationsConfig` so a new config section cannot be added
  without a matching validator; AC-B2's `audienceTestSchema` (`{ vendor }`);
  AE-B's `emailTestSchema` (`{ to }`, strict).

## The maps seam and the audience vendor (G7 — Q101/132/137, Q109)

Two more provider switches beside Digio's, resolved in `shared/integrations`
(`getEffectiveMapsConfig`, `getEffectiveAudienceConfig`) and consumed by
`shared/maps` and `shared/audience`:

- **maps** — Google unless ops chose Mapbox or (Z-B) OpenStreetMap. Two keys
  per commercial vendor because they are two different things: the browser
  key / public token is what a phone or the console draws tiles with
  (restricted by bundle id / referrer; the only thing `GET /app/maps` ever
  answers), the server key / secret token is what this backend spends on
  geocoding and directions (restricted by IP; never leaves the server). The
  pre-G7 `googleMaps` section stays so an old row parses, and its `apiKey`
  is read as the server key's fallback. AC-B1 (the owner, 16 Sep 2026): the
  phones keep the Mapbox engine whatever the provider, so on OSM the
  PUBLIC token is carried beside the tile line — the phones draw OSM tiles
  through the Mapbox SDK, which needs the public token to initialise; the
  console and the backend never do. The GET says `phoneEngine.tokenPresent`
  under OSM so ops can see what the phones are missing; the PUT is unchanged
  (the token is already a field of this section).
- **maps.osm** — Z-B (the owner, 15 Sep 2026: "In maps, let's integrate
  OpenStreetMap besides Google and Mapbox"). OSM has no key but has THREE
  USAGE POLICIES, and the section is shaped around them
  (`resolveOsmConfig` in `shared/integrations`, `shared/maps/osm.ts`):
  1. **Nominatim** (geocoding, reverse, place lookup). The public instance
     `nominatim.openstreetmap.org` allows **one request a second** per
     application, requires a **User-Agent naming the app and a contact
     email**, and forbids bulk geocoding. So `contactEmail` is required to
     select OSM (the adapter sends it as the `email` parameter and inside
     the default `userAgent`, `ADX/<version> (<contactEmail>)`); the adapter
     meters the PUBLIC host through a Redis bucket (`maps:osm:nominatim:public`,
     `SET NX PX 1000` — one token a second across every instance; empty →
     429 `TOO_MANY_REQUESTS` with the policy sentence, Redis down → let
     through); and a Nominatim of ops' own on `nominatimBaseUrl` is not
     metered by us. A listing import of a hundred spots without coordinates
     is bulk geocoding: on the public host the rows beyond the first each
     second warn "No coordinates" and ops place them by hand — point
     `nominatimBaseUrl` at a self-hosted Nominatim (or a commercial one —
     MapTiler, Geoapify, LocationIQ all serve Nominatim's API) before
     importing at scale.
  2. **OSRM** (directions). The public demo router
     `router.project-osrm.org` is **for testing only**, with no uptime
     promise and the car profile alone — production points `osrmBaseUrl`
     at a self-hosted OSRM or an OSRM-compatible host. Q137's `two_wheeler`
     is answered with the driving profile and `modeUsed` says so.
  3. **Tiles.** The public tile server `tile.openstreetmap.org` **forbids
     heavy app use** (no bulk downloading, no distribution to many users
     without a proper User-Agent, and apps are asked to use a provider) —
     production points `tileUrlTemplate` at MapTiler, Stadia,
     Thunderforest, Geoapify or a self-hosted stack (all OSM-based), with
     `tileApiKey` where the host wants one (`{key}` in the template or
     appended as `?key=`). `publicTiles` is the warning the screen prints
     while the template still names the public server. `tileAttribution`
     (default `(c) OpenStreetMap contributors`) is **mandatory on every
     map**, ODbL — the clients print it verbatim.
  Photon (`photonBaseUrl`, komoot's search-as-you-type, no session, no key)
  answers autocomplete; a prediction's placeId is the OSM object
  (`N123` / `W456` / `R789`), which Nominatim's `/lookup` turns into the
  point. Nothing here falls back to the environment: there is no key to
  fall back to.
- **audience** — Y-B (the owner, 15 Sep 2026: "both GeoIQ and Azira at the
  same time"): `providers` is the enabled SET, empty until ops choose, and
  empty means the analytics say "no panel backs this" rather than draw a
  figure; the pre-Y-B one-of-three `provider` is still read as a one-element
  set so a stored row keeps working (`resolveAudienceProviders`). `policy`
  says per field group which vendor is printed, whether the other fills a
  null, and for footfall whether two answers are averaged
  (`resolveAudiencePolicy` over `DEFAULT_AUDIENCE_POLICY`: Azira — a
  mobility panel — first on footfall and AVERAGE when both answer; GeoIQ — a
  data panel — first on demographics and affinities; every fallback on).
  `shared/audience` asks every enabled vendor and blends by it; `listings`
  keeps one snapshot row per vendor and re-blends on read, so a policy
  change is a form change here, not a vendor call. GeoIQ's catalogue ids are
  per account, so `geoiqVariables` maps the seam's field names to the ids the
  account bought; Azira has no public default host, so `aziraBaseUrl` comes
  from the contract. `catchmentRadiusM` (500 m) is the circle every spot is
  asked about, so two spots' figures compare.

- **audience — GeoIQ made to actually work (AC-B2, 16 Sep 2026).** The
  live probe: the first cut's default host `dataserving.geoiq.io` does not
  resolve; GeoIQ's Data Serving API is regional — **`dataserving-in.geoiq.io`**
  (India, the default `GEOIQ_DEFAULT_BASE_URL`) and `dataserving-us.geoiq.io`
  — and sits behind an API Gateway that answers **HTTP 200 whatever
  happened**, the real answer a JSON string under `body` and the real status
  as `statusCode` beside it. `shared/audience/geoiq.ts` unwraps that
  envelope (`unwrapGeoiqAnswer`) and runs its error table on the effective
  status (401/403 → 503 `INTEGRATION_NOT_CONFIGURED` "not authorised —
  contact GeoIQ", carrying GeoIQ's own sentence; 400 → 400; 429 → 429;
  else 502), clamps the radius to GeoIQ's 100–2000 m and asks at most 50
  variables a call (chunked and merged). The card gets two routes for it —
  `GET /integrations/audience/fields` (the catalogue to draw the variable
  map from) and `POST /integrations/audience/test` (the verdict) — so the
  key can be tested the moment it is pasted, before any variable is mapped.

Environment fallbacks: `GOOGLE_MAPS_BROWSER_KEY`, `MAPBOX_PUBLIC_TOKEN`,
`MAPBOX_SECRET_TOKEN`, `GEOIQ_API_KEY`, `GEOIQ_BASE_URL`, `AZIRA_API_KEY`,
`AZIRA_CLIENT_ID`, `AZIRA_BASE_URL` (all in `.env.example`).

## The Digio switch (Lot D, Q129)

The `kyc` section carries `kycProvider: DIGIO | DEGRADED | MANUAL` beside the
Digio keys — not a secret, drawn as-is. `PUT /integrations { section: 'kyc' |
'digio', patch: { kycProvider } }` (`digio` is the KYC screen's alias for the
same section) is ops' switch; a change is audited `KYC_PROVIDER_CHANGED` with
the before and after. **DEGRADED is the probe's verdict, not ops':**
`shared/vendors/probe.ts` on `src/jobs/kyc-provider-probe.job.ts`'s five-minute
tick flips DIGIO → DEGRADED when Digio stops answering and back when it does,
notifies every admin either way, and never moves MANUAL. Every Digio initiate
and restart, for every party, passes through `shared/integrations`'
`assertDigioAvailable`, which answers **503 `KYC_PROVIDER_UNAVAILABLE`** with
`details.retryAfter` (300 s while DEGRADED, 3600 s under MANUAL) — the apps
offer the manual upload branch instead, and `users`' onboarding manifest says
so in `verification.digio`.

## The HR tool (Lot E, Q98)

The `hrms` section: `provider: NONE | ZOHO_PEOPLE | KEKA | GREYTHR` (Zoho
People is the default), `portalUrl`, `apiBaseUrl?`, `apiKey?` (the one
secret, masked) and `employeeLinkTemplate?` — `https://…/employees/{externalId}`,
refused without the placeholder because it could not name anybody.
`PUT /integrations { section: 'hrms', patch }` is the same deep patch as every
other section, and beside the generic `INTEGRATION_CONFIG_UPDATED` row it
audits `HRMS_CONFIG_UPDATED` with a diff over provider, portal and template —
never the key.

**A portal link, not a sync.** The console follows `portalUrl` and
`employees` builds `hrmsLink` per person from the template and
`Employee.externalHrmsId`; `getEffectiveHrmsConfig()` in `shared/integrations`
defaults the template to Zoho's employee page when the provider is Zoho and a
portal is set. `apiBaseUrl` and `apiKey` are stored for the day a tier with an
API is bought and are read by nothing today — that seam is documented in
`employees`' README.

## The work tool (E10-1)

The `workTool` section beside `hrms`: `provider: NONE | JIRA | TRELLO | ASANA |
OTHER` (NONE is the default), `portalUrl` and an optional `name` ("ADX
Jira", "Ops board"). A link the console follows, nothing more — there is no
secret in it, so nothing is masked and the section is drawn as-is, the way
`branding` is; the masked mapper's secret handling is untouched. Read on
`GET /integrations` and written by `PUT /integrations { section: 'workTool',
patch }`, the same deep patch as every other section, audited by the generic
`INTEGRATION_CONFIG_UPDATED` row.

## The SMS rails and the email door (Lot E, Q87/Q128)

The `sms` section is a **routing table**, not one key:

| Field | What it is |
| --- | --- |
| `authKey` | MSG91's key — the one secret, masked. |
| `templateId` | MSG91's pre-DLT single template; kept so an old row parses, read by nothing. |
| `primaryRail` | `msg91` (default) \| `twilio` \| `third` — which adapter in `shared/sms/rails` sends first. |
| `fallbackRails[]` | Tried in order when the primary throws, each only if it has the kind registered and its keys on file. |
| `dltEntityId`, `senderId` | The TRAI DLT principal entity and the six-letter header, quoted by every rail. |
| `templates` | `{ <rail>: { <SmsKind>: { templateId, vars?, body? } } }` — each rail's own id for each kind of message ADX sends (`shared/sms/kinds.ts` lists the nine), the variables the template takes, and the registered text for a rail that posts text (Twilio). |

Twilio's own keys stay in the `twilio` section. None of the routing table is
secret and it is returned as-is; a kind with no registration on the rail in
use is **skipped, never sent** — the operator would reject it and bill the
attempt (decision 128).

The `email` section gains `primary: SMTP | RESEND` — which door the
dispatcher (`notifications`) sends by. Unset, the resolver picks SMTP unless
only a Resend key is on file.

## The one email door and the Ethereal test inbox (AE-B, 16 Sep 2026)

**One door.** `shared/email`'s `sendEmail(to, subject, html)` is the only
way an email leaves ADX: it picks Resend when `email.primary` says so, else
the SMTP door in its `mode`, and answers
`{ provider: SMTP | RESEND | ETHEREAL, configured, messageId, response, previewUrl }`.
The dispatcher (`notifications`), the password-reset link
(`auth/password` — which used to call `sendMail` directly and so always went
SMTP whatever the primary said) and this module's test route all go through
it, so a switch on this screen moves everything. The delivery log's attempt
row keeps its `provider` (lower-case: `smtp`, `resend`, `ethereal`),
`providerMessageId` and `responseText`; an Ethereal preview URL is appended
to `responseText` (`… | preview: https://ethereal.email/message/…`) so the
Delivery log shows where to read the message.

**Ethereal — temporary testing with zero credentials.** `mode: 'ETHEREAL'`
on the `email` section (or `EMAIL_MODE=ETHEREAL` in the environment; the row
wins) makes the SMTP door send to an [Ethereal](https://ethereal.email)
test inbox instead of `host`. **Ethereal never delivers** — it is a
catch-all viewer for testing: every message it accepts is held in a
throwaway inbox and readable at a preview URL (`nodemailer.getTestMessageUrl`),
which the server log prints, the delivery log carries and the test route
answers. The inbox is minted ONCE (`nodemailer.createTestAccount()`) and
cached in Redis (`email:ethereal:account`, 24 h) so it stays the same across
sends and instances; a Redis miss — or a Redis that is down — just mints a
new one. `configured` is always true under ETHEREAL; `host`, `user` and
`password` are not consulted; `from` is still what the message says. The
masked GET names the inbox (`ethereal.user`, a throwaway login, and the web
URL) so ops know where messages went; the account's password never leaves
the server — the preview links need no login. `mode` bears on the SMTP door
only: under `primary: 'RESEND'` it is not consulted, and the test route
says so through `provider`. Switch back to `mode: 'SMTP'` before anything
real must reach anybody.

**Gmail for real temporary sends.** The section helper for a Gmail /
Google Workspace account: `host` `smtp.gmail.com`, `port` `587`, `user` the
Gmail address, `password` a **Google App Password** (2-step verification
must be on; minted at https://myaccount.google.com/apppasswords — never the
account's login password), `from` the same address (Gmail rewrites any
other). Port **465** is implicit TLS (`secure: true`), **587** is STARTTLS
(`secure: false`, upgraded on the wire) — `sendMail` sets `secure` by the
port, nothing else to fill. Press the test to confirm before switching the
primary or the mode; a refused app password comes back as the verdict's
sentence (`535-5.7.8 Username and Password not accepted`).

## Invariants

- Secrets are returned masked (`••••` + last 4), never raw. Values of 4
  characters or fewer mask completely.
- `branding` is **not** masked — it is not secret.
- `infra` is read-only and never editable from this UI: changing the database
  URL or a JWT secret live would either need a restart or invalidate every
  active session, including the editor's own. The database URL is returned with
  its password masked; the secrets report the literal string `configured`.
- `PUT` takes `{ section, patch }`. A field omitted from `patch` keeps its
  stored value — necessary because the client never receives the real secret
  and so cannot round-trip it, only supply a deliberately entered new one.
- `PUT` answers `{ message, ...<the GET view> }` (T-B): the same masked
  config `GET /integrations` answers, re-read after the store, so a screen
  (`ai`, `kyc`) updates its state from the write without a second read.
- An unknown `section` is **400**, distinguished from an invalid `patch`, which
  is also 400 but with the section's own field errors.
- Every successful update writes an `INTEGRATION_CONFIG_UPDATED` activity log
  recording the section and the field names — never the values.
- AC-B2: every vendor test writes an `INTEGRATION_TESTED` activity log with
  the vendor and the verdict's flags and counts — never the key, and never
  the vendor's raw answer.
- AE-B: the email test's verdict and its audit row carry no secret: the SMTP
  password and the Resend key are masked out of every sentence and response
  line (`maskSecretsIn` in `shared/email/probe.ts`); the Ethereal account's
  password is never a field of any response.

## Tests

```bash
npx vitest run src/modules/integrations
```

## Suggested ownership

Platform team. Credential handling — review changes to the mapper carefully.

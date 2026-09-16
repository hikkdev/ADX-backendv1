# app-config

The single `AppConfig` row (`key: 'main'`) holding the enum catalogue and the
flow-editor definitions the agent app boots from.

## Three different things called "config"

| | what | where |
| --- | --- | --- |
| **app-config** (this) | enums + flow definitions, edited by the flow editor | `AppConfig` row `main` |
| `src/config/` | process environment validation | `.env` via Zod |
| `integrations` | third-party provider credentials | a different `AppConfig` row |

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/api/v1/config` | **none** |
| PUT | `/api/v1/config` | ADMIN |
| POST | `/api/v1/config/revert` | ADMIN |
| GET | `/api/v1/config/schema` | ADMIN — the vocabulary the console builds its editor from (Q83/Q148) |
| GET | `/api/v1/config/flows` | ADMIN — every key under `flows`: `version`, `updatedAt`, `label`, `description` (Q126), `audience` (G13-B), `shape` (`wizard`, `ladder` or `steps`), `stored`. Lot G (Q141): the four known keys — `listing`, `onboarding`, `agent-job`, `employee-intake` — are always listed, one the row does not hold yet at `version: 0, stored: false` with the code's label and description |
| PATCH | `/api/v1/config/flows/:key` | ADMIN — one flow, Zod-validated against the vocabulary; `main:previous` first, `flows.<key>:v<N>` snapshot, version bumped, audited. E10-2: a refusal's `details` carries `issues: [{ path: string[], pointer, message, code }]` with the full Zod path (`['branches','indoor','screens','1','fields','0','type']`, pointer `branches.indoor.screens[1].fields[0].type`) beside the flattened `fieldErrors` / `formErrors`, which stay one release; `PATCH /config/enums/:group` refuses the same way |
| PATCH | `/api/v1/config/enums/:group` | ADMIN — one enum group, the array of `{ value, label, description? }` |
| GET | `/api/v1/app/status` | **none** |
| PUT | `/api/v1/app/status` | ADMIN |
| GET | `/api/v1/app/limits` | `authenticate` — E7-2: `{ marketplace: { minBookingDays, maxMarketsPerCampaign }, kyc: { reviewSlaHours } }` from `getPlatformSettings()`, the non-secret numbers the apps' wizards print; nothing else on the row leaves |
| GET | `/api/v1/app/maps` | `authenticate` — G7 (Q101/132): the CLIENT config of the maps seam, `{ provider: 'GOOGLE', googleBrowserKey }`, `{ provider: 'MAPBOX', mapboxPublicToken }` or, Z-B, `{ provider: 'OSM', tileUrlTemplate, tileAttribution, tileMaxZoom, publicTiles, mapboxPublicToken, engineReady }` from `shared/maps.getMapsClientConfig()`. The browser key / public token only — the server key and secret token never leave through here; `null` while the key is still to come (Q128). On OSM the console and the phones draw raster tiles straight from the template (`{z}/{x}/{y}`, a Leaflet / MapLibre raster source), no key of their own; the `tileApiKey` is put into the template server-side ONLY for the public-safe hosts (`api.maptiler.com`, `tiles.stadiamaps.com`, `tile.thunderforest.com`, `maps.geoapify.com` — their keys are browser keys by design, restricted by referrer / bundle on the vendor's side); on any other host the template is answered as stored, `{key}` untouched, so a key meant for the server is never published. `tileAttribution` must be printed on every map (ODbL); `publicTiles: true` means the template still names `tile.openstreetmap.org`, whose policy forbids heavy app use — fine in dev, a warning in production. **AC-B1 (owner, 16 Sep 2026):** the phones keep the Mapbox engine (`@rnmapbox/maps`, impl `mapbox`) on every provider, so the OSM member also carries `mapboxPublicToken` (the PUBLIC token — `maps.mapboxPublicToken`, env fallback `MAPBOX_PUBLIC_TOKEN`; `null` when none is stored; the secret token is never read here) and `engineReady` (template present AND token present): the phones draw OSM tiles through the Mapbox SDK, which needs the public token to initialise; the console and the backend never do |
| GET | `/api/v1/settings/platform` | ADMIN |
| PUT | `/api/v1/settings/platform` | ADMIN |

The two GETs are deliberately public: both apps fetch them on boot, before
anyone has signed in, and a force-update gate that needs a token is useless —
an out-of-date build may not be able to sign in, and a maintenance window is
exactly when the token endpoint is down.

**The `x-admin-secret` header is gone (Lot A, Q33.)** `PUT /config` and
`PUT /app/status` used to accept it so the standalone flow editor could write
without a login. Both are now ordinary `authenticate + requireRole('ADMIN')`
routes, `ADMIN_SECRET` is out of `config/env.ts` and `.env.example`, and the
flow editor signs in like every other client. Both writes leave an audit row
(`APP_CONFIG_UPDATED`, `APP_STATUS_UPDATED`).

`POST /config/revert` is the safety net that replaced the header's
convenience: every `PUT /config` copies the row it is about to replace into
`main:previous`, and the revert puts it back — then makes the step it just
undid the new `previous`, so a revert is itself undoable. It is one step of
history, not a log; the audit trail is where "who changed what, when" lives.

## The flow editor (Q83, Q148)

G11-1: the two step-ladder vocabularies `GET /config/schema` serves
(`flows['agent-job']`, `flows['employee-intake']`) carry `proofOptions:
[{ key, label }]` beside the bare `proofs` list — 'Check in', 'Government ID
front', … from `AGENT_JOB_PROOF_LABELS` / `EMPLOYEE_INTAKE_PROOF_LABELS` in
`step-ladder.ts`, in the order of the keys — so the editor prints a name,
not a column.

The console is the sole editor of `flows` and `enums` (decision 83), and it
speaks the apps' vocabulary rather than one of its own (decision 148): it
builds its editor from `GET /config/schema`, which is `flow-schema.ts` and
`onboarding-template.ts` read back as a document. Two shapes live under
`flows`:

| key | shape | validated by | rendered by |
| --- | --- | --- | --- |
| `listing` (and any other key the console adds) | **wizard** — `label`, root `screens`, `branches` as a Record keyed by the branching option's id, each branch its own `screens` | `wizardFlowSchema` | both apps' listing wizard (`fields.tsx`), live today |
| `onboarding` | **ladder** — a library of `steps` keyed by id and a ladder per party × account type naming the ids in order | `onboardingTemplateSchema` | `GET /users/me/onboarding-manifest` in `users`, which composes the phone's DR 08 ladder from it |
| `agent-job` (Lot G, Q126/Q141) | **steps** — the A1–A8 job checklist: `steps[]` of `{ key, number, title, subtitle?, hint?, cta?, proofs: [{ key, label }] }`, the proofs among `PICKUP`, `CHECK_IN`, `CONDITION`, `INSTALLATION` | `agentJobLadderSchema` (`step-ladder.ts`) | `orders` — `fulfilmentEvidence` builds the submit gate's requirements from it and `GET /orders/job-ladder` serves it; the code ladder `CODE_AGENT_JOB_LADDER` in `orders` is the fallback |
| `employee-intake` (Lot G, Q126/Q141) | **steps** — the same shape, the proofs the `EmployeeKyc` columns (`govIdFrontUrl` … `bankProofUrl`, `panNumber`) | `employeeIntakeLadderSchema` | `kyc/employee` — `GET /employee-kyc/ladder` and the `intake` progress on the case read; `CODE_EMPLOYEE_INTAKE_LADDER` in `kyc` is the fallback |

**The step-ladder vocabulary** (`step-ladder.ts`) is one shape parameterised
by its proof list: step keys unique, a proof collected by at most one step,
every proof the code requires (`REQUIRED_AGENT_JOB_PROOFS`: CHECK_IN,
CONDITION, INSTALLATION; `REQUIRED_EMPLOYEE_INTAKE_PROOFS`: govIdFrontUrl,
panFrontUrl, addressProofUrl, selfieUrl) collected by some step — so the
console can reorder and reword, add a pickup photograph to the gate or a
bank proof to the desk, but cannot drop a proof the code waits on or invent
one it has no way to check. `GET /config/schema` serves both vocabularies
under `flows['agent-job']` and `flows['employee-intake']`. Every flow shape
now takes an optional **`description`** (Q126), the sentence the flow list
prints under the key, and an optional **`audience`** (G13-B), the short
phrase saying who climbs it — at most 80 characters, set through the same
`PATCH /config/flows/:key`. `KNOWN_FLOWS` carries the defaults (`listing`
"Publishers", `onboarding` "Publishers and advertisers", `agent-job`
"Agents", `employee-intake` "Employees"); a stored value wins over the
code's, and a key the code does not know lists `audience: null` until one is
stored.

**The field kinds are the twenty-three hyphenated names both apps' `fields.tsx`
switch on** — `selectable-cards`, `venue-type`, `media-type`, `section`,
`city`, `document-upload`, `sub-venue`, `material`, `textarea`, `number`,
`computed`, `geo-point`, `select`, `base-price`, `date`, `time-range`,
`content-stance`, `content-prohibited`, `image-upload`, `file-upload`,
`checkbox`, `switch`, `text`. `FIELD_KINDS` says which props each reads and
which it needs; a field carrying a prop its kind does not read is refused, so
the editor cannot store a switch the phone will never look at. The other
rules the console reads back: screen keys unique within the root and within
each branch (every listing branch has a `venue` step, deliberately); field
ids unique on any one root-plus-branch path; `dependsOn` and `from` name a
field asked earlier on that path; every option of a branching field is a key
under `branches` and every branch is targeted; `required` only on kinds that
collect an answer (`section` and `computed` do not).

**The ladder's vocabulary** is the seven step kinds — `account-type`, `form`,
`kyc-intro`, `capture`, `checklist`, `review`, `agreement` — the seven KYC
columns a capture tile may bind to (`KYC_CAPTURE_COLUMNS`: six on both KYC
rows under the same names, `selfVideoUrl` on `UserKyc`), and
`REQUIRED_KYC_COLUMNS` per account type, which every ladder must capture on
a tile that is not `inert` before the template may be stored. The required
list lives here rather than beside `PublisherKyc`'s schema because both
`publishers` and `kyc` already import this module for the platform settings;
a list they exported could not be read from here without a cycle. `review`
and `agreement` are in the vocabulary ahead of a renderer so the console can
name them; the code ladder uses `checklist`.

**Versions.** Every flow object carries a `version` (`GET /config` prints 1
for one written without) and, once PATCHed, an `updatedAt`. A PATCH copies
the whole row to `main:previous`, writes the flow it replaces as
`flows.<key>:v<N>` (the last five kept, older ones deleted), stores the new
one at N+1, and audits `APP_CONFIG_UPDATED` with `flow`, `version: { before,
after }` and a summary of screens `added / removed / changed` (steps and
ladders for the onboarding key) — named `key` at the root and `branch/key`
inside a branch, compared with keys sorted so a row jsonb reordered does
not read as changed. A body that names a `version` other than the current
one is a stale editor: 409 `CONFLICT` with `currentVersion`. `users` reads a
flow at a version through `getFlow(key, version)`, which serves the
snapshot, or today's flow when that snapshot has been pruned.

The wholesale `PUT /config` is kept for scripts and validates nothing beyond
its two keys; `scripts/seedConfig` runs both flows through the same schemas
before writing, and carries each version forward (unchanged content keeps
its number, changed content moves on by one). The PATCH routes answer the
ordinary `{ code, message, details }` envelope — they are new and the
console is their only client — while the PUT keeps its plain-string one.

**Campaign launch is NOT data-driven** (Q83). It stays coded in
`campaigns` until it has a renderer: the launch flow is not a list of
screens with fields but a sequence that reads the inventory match, the cart
and the wallet balance at each step, so it would need a **campaign-launch
renderer** in both apps — a `fields.tsx`-style switch whose kinds are
`market-picker`, `inventory-match`, `cart`, `creative-brief`, `payment` —
before a `flows.campaign` key could mean anything. Until such a switch
exists in the apps there is no vocabulary for the console to speak.

## The platform settings row (Q31)

`AppConfig` key `platform`, in `platform-settings.ts`: the handful of numbers
other modules read on their hot paths.

| Key | Default | Read by |
| --- | --- | --- |
| `kyc.reviewSlaHours` | 48 | the publisher and advertiser KYC queues — `ageHours`, `slaBreached`, breaches first |
| `kyc.escalationSlaMultiplier` | 2 | Lot G (Q127/142): `jobs/kyc-escalation.job.ts` escalates a PENDING publisher or advertiser case older than this × `reviewSlaHours` to Compliance (source AGE) |
| `kyc.printPartnerActivationRequiresKyc` | false | Lot N: `print-partners.activatePartner` — on, a partner whose `PrintPartner.kycStatus` is not VERIFIED is refused **409 `KYC_REQUIRED`**; off (the default, today's behaviour) ops activate and KYC follows |
| `fraud.scanThreshold` / `fraud.scanLimitPerType` | 0.6 / 500 | Lot G (Q118/138): `jobs/fraud-signal-scan.job.ts` — a signal above the threshold opens a SIGNAL_SCAN case when none is open; each party type is walked up to the limit, most recently active first |
| `listings.autoPublishOnVerification` | true | `supply.reviewVerification` — off, a cleared site visit leaves the listing at AWAITING_SITE_VERIFICATION and notifies the desk |
| `marketplace.minBookingDays` | 1 | `campaigns.setCart` — the floor under each listing's own minimum |
| `marketplace.maxMarketsPerCampaign` | 3 | multi-market campaigns (later lot) |
| `publisher.spotInsightsVisible` | false | publisher spot insights (later lot) |
| `retention.financialYears` / `retention.kycYears` | 8 / 8 | retention sweeps (later lot) |
| `support.sla.{URGENT,HIGH,NORMAL,LOW}` | 1/4, 4/24, 8/72, 24/168 hours | support ticket ageing |
| `support.liveChat.enabled` | true | Lot I: ops' own switch on live chat beside the `support.live-chat` kill switch — off, `GET /support/live/status` answers `entitled: false, reason: FEATURE_OFF` and the phones keep the ticket thread |
| `support.liveChat.hours` | `09:00`–`21:00` `Asia/Kolkata` | the window the desk answers live; outside it `POST /support/live/start` opens a TICKET promising a reply by the next opening |
| `support.liveChat.firstResponseTargetSec` | 120 | the live SLA — the inbox's `firstResponseBreached`, the expected wait on the status read, and the minute sweep's breach alert |
| `support.liveChat.publisherTiers` | `[]` (every tier) | which publisher subscription tiers are entitled; a running subscription on a tier not listed is `PLAN_EXCLUDED` |
| `support.liveChat.attachmentMaxMb` | 10 | the cap on an image or PDF attached to a support message |
| `auth.adminPasswordLoginEnabled` | true | the admin sign-in screen |
| `auth.adminTwoFactor.authenticatorRequired` | false | Lot K2: `auth`'s second factor — on, an admin with no authenticator enrolment signs in (SMS / EMAIL as today) into a **must-enrol** state: the tokens carry `mustEnrolAuthenticator` and every route but the enrolment, status, logout and `/users/me` ones answers 403 `TOTP_ENROLMENT_REQUIRED` (`shared/auth`'s `ENROLMENT_ONLY_PATHS`) |
| `auth.adminTwoFactor.smsAllowedWhenEnrolled` | true | Lot K2: off, an enrolled admin's challenge lists `AUTHENTICATOR` alone and `/auth/2fa/send` refuses SMS and EMAIL; a recovery code always works |
| `installation.commissionMode` | `FLAT` | installation commission (later lot) |
| `finance.primaryRail` / `finance.railFallbackOrder` | `MANUAL_NEFT` / `[RAZORPAY_X, CASHFREE, MANUAL_NEFT]` | `payouts.railFor` — one platform-wide primary rail, the fallback walked when it is unconfigured, manual always last (Lot B, Q85) |
| `finance.payoutEtaHours` | 48 | what a party is told to expect between release and the bank line |
| `finance.clearingDays` | 7 | the daily earning's clearing window (stored here; `accrual.service` still carries `CLEARING_DAYS` as its constant) |
| `insights.gmvDropWarnPct` / `insights.gmvDropCriticalPct` | 10 / 30 | `admin-overview` insights (Lot G, Q112) — a month-on-month GMV fall at or past these reads WARN / CRITICAL |
| `insights.withdrawalReleaseHours` | 48 | an APPROVED withdrawal older than this, unreleased, is counted as waiting on finance |
| `insights.fraudOpenDays` | 7 | a fraud case open past this many days is stale |
| `insights.floorGraceDays` | 3 | a below-floor listing whose grace ends within this many days is about to be unpublished |
| `insights.paymentHoldHours` | 2 | a PENDING_PAYMENT campaign whose spot hold ends within this many hours |
| `insights.criticalCount` | 10 | a count-rule at or past this many reads CRITICAL rather than WARN |
| `hr.workloadThresholds.medium` / `.high` | 10 / 25 items per week | `employees.workloadReport` (Lot G, Q120/Q139) — the bands of the workload chart; `high` must be above `medium` |
| `geo.launchMinListings` | 10 | Lot V: `GET /geo/cities/:slug/readiness` — the live-listings check a city should pass before ops launch it (advisory: the launch is never refused) |
| `geo.launchNeedsPrintPartner` | false | Lot V: whether the readiness read also wants an active print partner in the city |
| `geo.comingSoonWaitlist` | true | Lot V: `GET /app/geo/cities` lists SEEDING cities and PLANNED capitals as `comingSoon` for the advertiser waitlist; off, the pickers answer launched cities only |
| `audience.cityProfileSamplePoints` | 0 | Y-B: `GET /geo/cities/:slug/audience` — up to this many grid points across a city are asked of every enabled audience vendor once per month and kept as snapshots (`city:<slug>:<n>`) beside the spots' own; 0 means the profile only folds what the spot reads already fetched and never calls a vendor. Each point is a billable call per vendor per month per city (max 64) |
| `subscriptions.publisher.*` / `subscriptions.advertiser.*` | see below | Lot J2 (the owner, 14 Sep 2026): the purchase rules for a subscription, one policy per audience — `revenue` reads `publisher`, `packages` reads `advertiser`, `payments` asks the payer's audience which gateways it may offer, `support` reads the grace. **Every default is today's behaviour**, so nothing changed on the day it landed |

### The subscription policies (Lot J2)

The same shape for both audiences; the defaults are the same too save the
tier keys of `trialDays` (`STANDARD` / `PLUS` / `PRO` for publishers,
`STARTER` / `GROWTH` / `PRO` for advertisers). **GST is not here**: both
pricing paths read `revenue`'s `TaxSettings.mediaGstPct`
(`GET/PATCH /revenue/tax`), the one configurable GST.

| Field | Default | What reads it |
| --- | --- | --- |
| `cyclesOffered` | `['MONTHLY', 'ANNUAL']` (non-empty) | the quote on both sides — a cycle not offered is refused 400 `CYCLE_NOT_OFFERED`, naming the offered ones |
| `annualDiscountPct` | 20 (0–90) | the quote on both sides: twelve months less this percent |
| `changePolicy` | `REPLACE_NOW` | what a different tier does to the running one at activation: `REPLACE_NOW` starts now and ends the running term now; `QUEUE_AFTER_TERM` starts at the running term's end, like a same-tier renewal (`revenue.resolveTerm`, `packages.resolveSaleTerm`) |
| `prorateOnChange` | false | `REPLACE_NOW` only: the replaced term's `pricePerMonth` × whole days left ÷ days in the month, rounded down to the paisa, credited to the party's wallet (ADJUSTMENT, against `platform:revenue`, reason "Unused days of <plan>") |
| `graceDays` | 0 (0–90) | the entitled reads — `revenue.entitledSubscriptionForPublisher`, `packages.entitledPackageForAdvertiser` — which `support`'s live-chat door asks: a term that ended within this many days still answers (`inGrace`, `graceEndsAt`). Never the commission rate |
| `trialDays.<TIER>` | 0 for every tier (0–90) | `POST /revenue/subscription-orders/trial`, `POST /packages/sales/trial`: a first-ever subscriber may start this many free days; `GET …/subscriptions/me` and `GET /packages/active` answer `trialAvailable` |
| `reminderLeadDays` | 7 (1–30) | the daily sweeps' expiring notice, this many days before `endsAt` |
| `unpaidOrderExpiryDays` | 7 (1–30) | the publisher sweep: a PENDING_PAYMENT order older than this becomes EXPIRED |
| `payment.walletAllowed` | true | `POST /revenue/subscription-orders/:id/pay`, `POST /packages/sales/:id/pay` — 403 `PAYMENT_METHOD_NOT_OFFERED` when false |
| `payment.gatewaysAllowed` | every gateway `payments` exposes (`RAZORPAY`, `CASHFREE`, `CCAVENUE`) | `POST /payments/intents` for a `subscriptionOrderId` or a `packageSaleId` — 400 `PAYMENT_METHOD_NOT_OFFERED` for a gateway not listed; an empty list closes the gateway path. Campaign payments are untouched |
| `autoRenew.allowed` | false | `PATCH /revenue/subscriptions/me { autoRenew }`, `PATCH /packages/active { autoRenew }` — 409 `AUTO_RENEW_NOT_OFFERED` when false; and the daily sweeps, which charge nobody while it is off whatever a row's flag says |
| `autoRenew.chargeFromWallet` | `true` (the only value) | the rail a renewal charges — stated so the console shows it |

The PUT takes any subset (`trialDays` merges tier by tier; `cyclesOffered`
and `gatewaysAllowed` replace whole), audited `PLATFORM_SETTINGS_UPDATED`
like the rest, e.g. `subscriptions.publisher.trialDays.PLUS: 0 → 14`.

Invariants:

- **Every reader goes through `getPlatformSettings()`**, exported from
  `index.ts` and cached 60s in Redis (`shared/cache/read-through.ts`). The PUT
  invalidates it, so a floor takes effect at once on the instance that changed
  it and within the minute everywhere else.
- **The PUT is a deep patch, never a replacement.** Naming one number leaves
  the fifteen beside it alone. Unknown keys are refused rather than stored.
- **A row that does not parse is served as the defaults**, not as a partial
  document — a missing floor is worse than a stale one. A row written before a
  section existed is laid over the defaults, so it still answers for it.
- The audit row is `PLATFORM_SETTINGS_UPDATED`, with the diff taken over the
  flattened document (`kyc.reviewSlaHours`, not `kyc`).

## Owned Prisma entities

`AppConfig`: the `main` key, plus the named rows `main:previous`,
`flows.<key>:v<N>` (the five most recent replaced versions of each flow),
`categoryPlans`, `app-status`, `platform`, `tier-ladder` and `support-lines`.

## Public exports (`index.ts`)

- `configRouter`, `appStatusRouter`, `platformSettingsRouter`.
- `APP_ENUMS` — the fallback enum catalogue, also read by `scripts/seedConfig`.
- `getPlatformSettings()` / `DEFAULT_PLATFORM_SETTINGS` — Q31's row, cached.
- `getConfigObject` / `saveConfigObject` — named rows (`tier-ladder`, `support-lines`).
- `getFlow(key, version?)` / `ONBOARDING_FLOW_KEY` — Q83: a flow at a version, for `users`' manifest.
- Lot G (Q126/Q141): `KNOWN_FLOWS`, `LISTING_FLOW_KEY`, `AGENT_JOB_FLOW_KEY`, `EMPLOYEE_INTAKE_FLOW_KEY`, `agentJobLadderSchema`, `employeeIntakeLadderSchema`, the proof lists and the `StepLadder` / `AgentJobLadder` / `EmployeeIntakeLadder` types — for `orders`, `kyc` and `scripts/seedConfig`, which seeds all four flows through `seedAppConfig`.
- `onboardingTemplateSchema`, `templateIssues`, `KYC_CAPTURE_COLUMNS`, `REQUIRED_KYC_COLUMNS` and the template types — the ladder vocabulary `users` composes against.
- `wizardFlowSchema`, `canonicalJson` — for `scripts/seedConfig` to check and compare the listing flow.
- `seedAppConfig({ flows, enums })` — Lot F: the seed's door. A byte-equal flow (keys sorted, `version`/`updatedAt` aside) keeps its version; a changed one is bumped by one and the flow it replaces is kept as `flows.<key>:v<N>` (five deep), exactly as the editor keeps it; a fresh row starts at 1.

## Invariants

- `GET` responds with `Cache-Control: no-store`. The agent app polls this after
  edits; a cached copy would serve a stale flow definition.
- With no row written yet, `GET` serves `{ enums: APP_ENUMS, flows: {} }` so a
  fresh install still boots.
- Every flow object `GET` serves carries a `version`, so an app can stamp
  what it rendered; the row itself is left as written.
- `PUT /config` requires `flows` and `enums` to both be plain objects, and
  **replaces** the row wholesale — it is not a merge. The replaced row is kept
  as `main:previous` for `POST /config/revert`.
- `PUT` validation is hand-rolled, not Zod, and its error envelope is
  `{ success: false, error: "<string>" }` — a plain string, **not** the
  `{ code, message }` object every other endpoint returns. The flow editor
  depends on this shape; do not normalise it without changing that client.

## Tests

```bash
npx vitest run src/modules/app-config
```

## Suggested ownership

Platform team, alongside `integrations`.

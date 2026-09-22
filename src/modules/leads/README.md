# leads

> Lot V: `closeOpenLeadsInCity(spellings, actorUserId)` — every open lead
> whose free-text `city` is one of the spellings, LOST in one transaction
> with a STATUS_CHANGED activity noting "city withdrawn"; the city
> wind-down's duty here (`modules/geo/README.md`). `importLeads` refuses a
> row in a catalogued city whose stage has `leadFeeds` off — outcome
> `CITY_NOT_OPEN` on the report, one lookup per distinct city in the sheet;
> a town the catalogue lacks is free text and passes.

DR 06's prospect: a business an agent can go and see, before it is anybody's
account.

## LH1 — score and temperature (the Lead Hunt, 22 Sep 2026)

"HOT" used to be a status the agent set. It is now a **computed score** the
platform keeps fresh, with the agent's judgement as one of five signals
(`scoring.rules.ts`, pure; `scoring.service.ts` reads and writes):

| Signal | Points | Reads |
| --- | --- | --- |
| Fit | 0–30 | category × side (`leads.scoring.fit.categoryBySide`, a default for a category nobody weighted), AG-5's band (+4 KEY, +8 ENTERPRISE), the locality's live-listing count within 1 km (+6 for a publisher lead where supply is thin, an advertiser lead where it is rich) |
| Intent | 0–35 | the thread's last 90 days: a call 5, a message 5, a follow-up 5, a visit booked/done 20, a reply (ENGAGED) 15, the link opened 10, a proposal 5, a manual touch 5; an INBOUND / QR / ADS / REFERRAL source starts with 15 |
| Recency | −25–0 | days since `lastTouchedAt` (the creation until anybody touches it): −5 at 7, −15 at 21, −25 at 45 |
| Source quality | 0–15 | `LeadSource.quality`, learned nightly from the source's own 90-day conversion rate (`learnedQuality`: rate × 50, 1–15; fewer than 20 leads keep the figure) |
| Agent flag | +10 | `agentFlaggedHotAt` within 14 days — `POST /leads/:id/flag-hot { hot }` from the app, `status: HOT` on the desk's PATCH (honoured as the flag, the status untouched) |

Hot ≥ 70, warm 40–69, cold < 40; every number is `leads.scoring` in the
platform settings (`shared/lead-scoring/policy.ts`, Settings › Leads
scoring on the console, a strict diff-only patch). Recomputed on every
touch (`touchLead` — a contact, a visit, a conversion, a flag, a patch)
and once an Indian day by `jobs/lead-scoring.job.ts` (the sources learned
first, then every open lead; the day key is written **after** the run, so
a failed night is retried on the next tick). A change of temperature is a
`TEMPERATURE_CHANGED` activity row with the reason ("Warmed up to Hot:
opened the invite link"); the first computation writes none.

The row carries `score`, `temperature`, `scoreReasons[]` (`{ signal, points,
note }`), `scoreComputedAt`, `estimatedValue` (a publisher's wall at the
comparables' median daily rate × 30; an advertiser's likely campaign at the
city's 90-day average budget — not the agent's fee, which stays
`estimatedCommission`), `agentFlaggedHotAt`, `lastTouchedAt`, `sourceId`.
Both lists take `?temperature=` and `sort=HOTTEST` and answer
`temperatureCounts` beside `counts`; the pill reads the temperature for an
open lead (`leadPillOf(status, temperature)`), so the apps needed no
release. The migration folded every distinct legacy `source` label into a
`LeadSource` row (kind IMPORT; WAITLIST → INBOUND; a label with "referr" →
REFERRAL), moved each HOT status into the flag (status back to CONTACTED /
NEW), and seeded the seven doors (`manual`, `import`, `capture`, `qr`,
`inbound`, `referral`, `ads`). `GET /leads/sources` (ADMIN) lists them;
`PATCH /leads/sources/:id` edits label, quality, active, quota, terms
(audited `LEAD_SOURCE_UPDATED`); `POST /leads/:id/rescore` (ADMIN) scores
now. Feature `leads.scoring`; job `lead-scoring`.

## LH2 — the twelve stages (D11, D12, D14)

`Lead.stage` is where the deal is; `status` stays for the pill. SOURCED at
birth → SCORED on the first computation → CLAIMED (assigned, or LH5's
claim) → CONTACTED (a call or a message) → ENGAGED (any inbound: `POST
/leads/:id/engaged { note?, channel? }`) → VISIT_BOOKED (`/visit`) →
PROPOSED (`POST /leads/:id/proposed`; LH7 attaches the record) →
CONVERTED (only `/convert`) → ONBOARDING → ACTIVATED → RETAINED; LOST from
any open stage (`POST /leads/:id/lost { reason, note? }` for the agent,
`PATCH /leads/:id/stage { stage, reason?, lostNote?, note? }` for the
desk, audited `LEAD_STAGE_MOVED`). `stages.rules.ts` is the law: forward
only; CONVERTED / ACTIVATED / RETAINED are the system's (they pay); a
loss needs a reason, OTHER needs a note; every move syncs the status the
pill reads, writes a `STAGE_CHANGED` row and restarts the recency clock.

**Losses (D11):** NOT_INTERESTED, WRONG_CONTACT, COMPETITOR, PRICE,
TIMING, OTHER. PRICE and TIMING carry `recycleAt` = +60 days and come
back to SCORED, unassigned, through `recycleDue` (the hourly
`lead-pipeline` job; LH6's `registerLeadRecyclePort` enrols a fresh
sequence). WRONG_CONTACT is not a loss — the row goes back to SOURCED,
unassigned, for a better number.

**The retention watch** (`watchRetention`, the same job): every
CONVERTED / ONBOARDING lead's account is read narrowly here — a
publisher's first ACTIVE listing, an advertiser's first paid campaign —
and ACTIVATED is stamped at that moment with `LEAD_ACTIVATED` recorded
once to the agent holding the lead (`recordIncentiveOnce`, keyed on the
account; D1's ₹500 publisher / ₹750 advertiser through a rate qualified
`*:ADVERTISER` — `payouts.rateFor(event, tier, now, side)`); an ACTIVATED
lead with a second booking / paid campaign, or thirty days live, is
RETAINED with `LEAD_RETAINED` (₹100). `/convert` records `LEAD_CONVERTED`
(₹100, once per account) to the holder, or to the converting agent for
an unassigned lead. Nobody's hand sets these three.

**Attribution (D14):** `Lead.attribution` = `{ firstContact?, engaged?,
converted? }`, each `{ channel, at }`, stamped once by the first channel
that produced the moment (a call is CALL, a field conversion IN_PERSON,
the invite page LINK; LH6 stamps the rest). `GET /leads/funnel?side&
sourceId&agentId&city&category&from&to` (ADMIN) answers aggregates only:
`byStage` (count, pipeline value, average days in stage), `bySource` /
`byAgent` / `byCity` / `byCategory` (total, converted, activated),
`byChannel` (first contacts, engagements, conversions), `lossMix`,
`avgDaysToConvert`, `totals`. Both lists take `?stage=` (a comma list)
and answer `stageCounts`; every card carries `stage`, `stageChangedAt`,
`nextStep { label, action }` ("what moves this lead forward"), the loss
fields and `attribution`. Feature `leads.pipeline`; job `lead-pipeline`.

## LH3 — sources, feeds, inbound, referrals (D4, D9, D3's caps)

**Feeds** (`feeds/`): one port (`LeadFeed { key, label, needs,
configured(), search({ side, category, city | polygon, limit }) }`) and six
adapters. Google Places (New) Text Search is live on the maps seam's
server key (`places.googleapis.com/v1/places:searchText`, a rectangle
restriction from the polygon's bbox, the ring honoured exactly after).
JustDial, MCA, GST and RERA have no public search API — each is a
credential card (`integrations.leadFeeds.<key>`: endpoint, apiKey,
headerName) and, once filled, POSTs `{ category, city, side, limit,
polygon }` to the partner and reads `{ results: [{ id, name, phone?,
email?, address?, locality?, city?, lat?, lng?, contact? }] }` — the
contract ADX hands its data partner. IndiaMART reads the seller CRM API
natively (`glusr_crm_key`; buy leads are advertiser-side candidates).
`GET /leads/feeds` (ADMIN) says per feed: configured, why not, the
source row (quality, quota, terms, active, used today), `ready`. `POST
/leads/feeds/:key/run { side, category, city | polygon, limit ≤ 200 }`
refuses 503 NOT_CONFIGURED, 409 TERMS_NOT_CONFIRMED (every partner feed
needs `LeadSource.termsAcceptedAt`; Google Places does not), 409
SOURCE_OFF, 429 QUOTA_EXHAUSTED (`quotaPerDay` counted over the Indian
day; a QUOTA run is recorded), then asks the adapter, drops the rows ADX
already holds by `Lead.externalKey` (`<feed>:<provider id>`), hands the
rest to `importLeads` (geocoding, phone / name-city dedup, the
EXISTING_ACCOUNT refusal, one transaction), records the `LeadFeedRun`
(candidates / imported / skipped / warnings / the per-row report) and
routes each new lead. `GET /leads/feeds/runs?feed=` and `/runs/:id`.
Audited `LEAD_FEED_RUN`.

**The importer**: `party-imports` gained `leads` as a party (`POST
/party-imports/leads`, the two steps, the report CSV, revoke) — a create
goes through `createLead`, a merge through `patchLead`; a mobile on a
publisher or advertiser account blocks the create (`matchLeads`). The
JSON `POST /leads/import` stays for the paste and the feeds; its rows
take an optional `externalKey`.

**Inbound** (`inbound.service.ts`): every door creates through
`inboundLead` — a repeat number answers the lead it has (a NOTE, an
ENGAGED stamp), a number on an account is 409 EXISTING_ACCOUNT ("sign
in"), a provider id already held answers that lead, the row starts on
its source with the INBOUND intent (warm on the default fit), D14's
`firstContact` stamped with the door's channel, and is routed. Public
(above `authenticate`): `POST /leads/inbound/web` (the website form;
Turnstile through `verifyCaptcha` when `TURNSTILE_SECRET_KEY` is set; a
`website` honeypot swallows a bot with a 201), `POST
/leads/inbound/site/:qrId` (the SITE poster — "Own this wall? / Want to
advertise here?" — the spot's locality and point), `POST
/leads/inbound/agent/:qrId` (the AGENT card: the lead lands on that
agent, CLAIMED), `POST /leads/inbound/referral/:code` (a referral link).
Webhooks under `/webhooks/leads`: `GET|POST /meta` (the subscription
handshake on `leadForms.meta.verifyToken`; `X-Hub-Signature-256` over
the raw body with `appSecret`; the answers fetched from the Graph API
with `pageAccessToken`), `POST /google` (`google_key` in the payload
against `leadForms.google.key`), `POST /linkedin` (`X-LI-Signature`,
base64 HMAC with `clientSecret`); `?side=` on the registered URL names
the side (advertiser by default); idempotent by `externalKey`
(`meta:<leadgen_id>`, `google:<lead_id>`, `linkedin:<id>`); a form with
no phone is logged, never a lead.

**Routing** (`routing.service.ts`): a territory's agent (LH5's
`registerTerritoryRouter`) → the nearest ACTIVE agent of the side with
room under D3's cap (`leads.claims.caps`, by tier; Platinum unlimited)
by LT-1's last fix of the day (`registerAgentPositionPort`, filled in
bootstrap from `agent-locations.readLastFix`) → the same catalogue city
with the fewest open leads → the pool. Assignment is CLAIMED with the
note.

**Referrals** (`referrals.service.ts`, D9): `GET /leads/referrals/me/link`
mints one code per account (`ReferralLink`, 8 characters, no
confusables; `${PUBLIC_WEB_URL}/j/r/<code>`); `POST /leads/referrals {
side, businessName, phone, city?, message? }` from any signed-in
publisher, advertiser or agent (the party read narrowly through
`partyOfUser`) creates the lead on the `referral` source and the
`LeadReferral` row (an agent's referral is their own lead); `GET
/leads/referrals/me` lists them with totals; `GET /leads/referrals`
(ADMIN) names every referrer. When the referred lead ACTIVATES, the
retention watch's activation hook credits the referrer's wallet
`leads.referralCredit` (₹250) through `wallets.move` (REFERRAL entry,
GOODWILL kind, `platform:goodwill` counter-leg, idempotent on the
referral) — once, never to an agent.

Sources seeded by the migration: the six feeds (Google Places on, the
five partners off until their terms), `web`, `site-qr`, `agent-qr`,
`meta-lead-ads`, `google-lead-forms`, `linkedin-lead-gen`. Feature
`leads.sources`.

## LH4 — street capture

`POST /leads/capture` (AGENT_PUBLISHER / AGENT_ADVERTISER; `capture.
service.ts`): `{ side, category, businessName?, contactName?, phone?,
latitude, longitude, accuracy?, address?, locality?, city?, note?,
photoFileIds[] ≤ 6 }`. The photos are uploaded first under purpose
`LEAD_CAPTURE` (private) and must be the same agent's; the address is
read back from the point through the maps seam when the agent typed none
(a seam that cannot answer never stops a capture); a nameless capture is
named "Wall surface near 5th Cross". The same side within
`CAPTURE_RADIUS_M` (30 m) is the same wall — 409 `DUPLICATE_NEARBY`
naming the lead, how far, and whether it is the caller's own; a number
on a lead or an account is refused as everywhere. The lead lands on the
`capture` source, on the agent's own list (CLAIMED), with
`capturedByAgentId` / `capturedAt` / `photoFileIds`, an IMPORTED row
("Spotted in the street · 2 photos"), a TOUCH_LOGGED row (it counts
toward the contact target) and its first score. Audited `LEAD_CAPTURED`.
The card carries the three columns; the console's lead page opens the
photos through `/files/:id`. Feature `leads.capture`. The agent app's
centre disc opens a sheet — "Spot a lead" beside "Scan a code" — and the
capture screen (`agent-app/src/features/leads/capture-screen.tsx`).

## LH5 — the hunting map, territories, claims (D3, D7, D8)

`map.rules.ts` is the arithmetic; `map.service.ts` reads the rows; `map.
controller.ts` is the door. **No PostGIS**: a territory or a zone keeps its
ring as GeoJSON (`[lng, lat][]`, closed or open) beside a bounding box the
index takes (`south/west/north/east`); the query narrows by the box and the
ring is tested in code (`inRing`).

- **The viewport** — `GET /leads/map?bbox=south,west,north,east&side&
  temperature&priority&claimed=MINE|OPEN|ANY&category&pins` (any session).
  Above `CLUSTER_ABOVE_KM2` (60 km²) it answers `mode: CLUSTERS` — grid
  cells about a fifteenth of the shorter side (never under 500 m) with
  `count / hot / warm / cold` — below, `mode: PINS` capped at `PIN_CAP` (500,
  the browse cap) each with `temperature`, `score`, `estimatedValue`,
  `stage`, `claim: { agentId, mine, expiresAt } | null` and `priority` (inside
  an active zone's ring). `pins=true` forces pins for the desk's bulk plot
  after an import (ignored for agents). Every answer carries the active
  zones' rings and, for ADMIN, the active territories. The map is open to
  every agent of the side (D8) — `claimed=MINE` is the agent's own view.
- **The heat** — `GET /leads/map/heat?bbox&side`: live listings (supply)
  and the last 90 days' campaign spots (demand) counted per cell; `gap =
  demand − supply`; `weight` is what the tint reads (publisher-side: where
  demand outruns supply; advertiser-side: where supply is rich).
- **Claims (D3)** — `POST /leads/:leadId/claim` (agent roles) holds an open
  pin for `leads.claims.holdHours` (72): a `LeadClaim` row, `claimedByAgentId
  / claimExpiresAt` on the lead, `assignedAgentId` set, CLAIMED, a touch.
  `claimVerdict` refuses with 409 `CONFLICT` and `details.reason` =
  `CLAIMED_BY_OTHER` (a live hold or an assignment that is not theirs),
  `CLAIM_CAP` (`leads.claims.caps` by tier — Bronze 10 / Silver 20 / Gold
  40 / Platinum unlimited, counted on open assigned leads), `COOLDOWN`
  (`leads.claims.cooldownDays` = 7 after *their* claim on *that* lead lapsed,
  `details.until`), `CLOSED`. `POST /leads/:leadId/release` `{ reason? }`
  hands it back (409 `NOT_HOLDER` otherwise). An ops assignment (`PATCH
  /leads/:id` with `assignedAgentId`, or assign-from-polygon) overrides a
  running claim ("overridden by ops"). The hourly **`lead-claim-sweep`**
  job (`sweepClaims`): a hold past its time with no work since the claim
  lapses back to the pool (assignment cleared, a NOTE, the lapse is what
  the cooldown reads); a *worked* hold (CONTACTED / ENGAGED / VISIT_BOOKED
  / PROPOSED and touched since) simply ends and the lead stays theirs; an
  hour before, the holder gets `LEAD_CLAIM_LAPSING` once per claim.
- **Territories (D8)** — `GET/POST /leads/territories`, `PATCH /leads/
  territories/:id` (ADMIN, audited `LEAD_TERRITORY_CREATED / _UPDATED` with
  the diff). `{ name, side, polygon, agentId, city? }`; the agent must work
  the side. **Route-only**: `registerTerritoryRouter` runs ahead of LH3's
  nearest / city routing — a fresh lead inside a ring lands on its agent
  (`territoryId` stamped, CLAIMED "routed by territory"), and nothing else
  changes: every agent of the side still sees the whole map.
  `POST /leads/map/assign` `{ polygon, side, agentId }` (ADMIN, audited
  `LEADS_ASSIGNED_FROM_MAP`) is the desk's bulk move — every open,
  unassigned lead inside the ring to the agent; held ones are left alone.
- **Priority zones (D7)** — `GET/POST /leads/priority-zones`, `PATCH
  /leads/priority-zones/:id` (ADMIN, audited). A zone is a ring, a category,
  or both (never neither), for a side or both, between `startsAt` and
  `endsAt`, with its own `topUp` (0 = the platform's `leads.priority.topUp`,
  ₹200) and an optional `budgetCap`. On an activation inside a zone
  (`registerActivationHook` → `payPriorityTopUp`) the agent is paid the
  top-up **once per lead** (an `AgentIncentive` LEAD_ACTIVATED row keyed
  `priority:<zone>:<lead>` with the explicit amount, checked first by
  `priorityTopUpPaid`), under `min(zone top-up, zone budget left, platform
  monthly cap left)` (`leads.priority.monthlyCap`, ₹25,000, read off the
  month's `priority:` rows); the zone's `spent` climbs. The console shows
  the budget meter.
- **Alerts** (PUSH, not transactional, deep link `adx://lead/<id>`, each
  deduped through Redis): `LEAD_NEARBY_HOT` — a lead that turns HOT
  (`registerTemperatureHook`) and is unclaimed is offered to every agent of
  the side with a fix today (LT-1, through `registerMapPositionPort`)
  within `NEARBY_HOT_KM` (1 km), once per lead per agent per week;
  `LEAD_CLAIM_LAPSING` (above); `LEAD_LINK_OPENED` — `alertLinkOpened`,
  which LH7 raises when a lead opens the agent's link, once an hour per
  lead.

Feature `leads.map` (routes + the job). The console's Leads › Map plots
the viewport (bulk after an import), draws polygons, assigns from one,
toggles the heat, and has the Territories and Priority zones desks; the
agent app's hunting map draws pins by temperature with the estimate, the
priority tint, claim / release, the day route ordered by distance, and
opens a lead from the pushes.

The platform deliberately did not have this. `agents/dashboard.service.ts`
declared a `LeadCluster` shape, returned `leads: []`, and a test pinned the
empty list as correct "until a lead model exists" — the shape was published so
the app could draw the map layer without an app release on the day the model
landed. This is that model, and that test now asserts the other side of it.

## LH6 — the outreach hub (D5, D13, D14)

One channel port, ten channels. `conversations.service.ts` is the writer
(a `LeadConversation` per lead per channel, a `LeadMessage` per thing said,
idempotent on the provider's id); `outreach.service.ts` is the hub (`send`,
`receiveWebhook`, `reachability`, the two rules, the attribution stamps);
`sequences.service.ts` the scripted follow-up; `calls.service.ts` the
telephony; `outreach.controller.ts` the doors. The provider adapters live
in `shared/outreach` (WhatsApp over Gupshup / Interakt / Meta, Instagram DM
and Messenger over the Graph API, Google Business Messages, telephony over
Exotel / Knowlarity / Twilio Voice) — every one **NOT_CONFIGURED** until
its card under Settings › Integrations › **Channels** (`leadChannels`) is
filled. SMS and email need no card: they leave by the comms dispatcher
(`notify('LEAD_OUTREACH')`, the `lead-outreach` template, `{{body}}` the
copy the hub already rendered — one DLT registration with one variable,
SMS kind `LEAD_OUTREACH`).

- **Reachability** — `GET /leads/:leadId/thread` answers `channels[]`, one
  per channel: `configured`, `provider`, `reachable`, `reason` (a sentence
  the sheet prints), `mode` (`FREEFORM` / `TEMPLATE` / `REPLY` / `CALL` /
  `MANUAL`), `windowClosesAt`, a masked `address`. SMS, WhatsApp and a
  call need a number; email an address; the three Meta DMs a thread the
  lead opened and an open window; LinkedIn, in person and "other" are
  always offered — logged, never sent (**D13: no cold DMs by API**).
- **The window rule** — WhatsApp: free text inside the 24 h after the lead's
  last message, an approved template (the card's `templates[templateKey]`)
  outside it, nothing without one (`NO_WINDOW` / `NO_TEMPLATE`). Instagram,
  Messenger, Business Messages: replies only inside the window — a DM or a
  story reply opens a day, a comment seven (Meta's private-reply rule).
- **Sending** — `POST /leads/:leadId/messages` `{ channel, body? |
  templateKey?, subject? }` (the holder or the desk). A template key names
  a comms template (Comms › Templates) whose `smsBody` is the short copy
  and `subject` + `emailBody` the email; the vars are `contactName`,
  `businessName`, `agentName`, `agentPhoneLine`, `link` (LH7's invite once
  it lands; the site until then), `city`. The answer is `{ outcome: SENT |
  QUEUED, message }`; a refusal is 503 `INTEGRATION_NOT_CONFIGURED` or 409
  `CONFLICT` with `details.reason` ∈ `UNREACHABLE`, `NO_WINDOW`,
  `NO_TEMPLATE`, `WEEKLY_CAP`, `CLOSED`, `PROVIDER_ERROR` (502). The first
  thing that leaves stamps `attribution.firstContact` with the channel
  (**D14**), moves SOURCED/SCORED/CLAIMED → CONTACTED, and is a touch.
- **The two rules on every outbound** — quiet hours and the weekly cap
  (`comms.quietHours`, `comms.weeklyCapPerUser`) rule every send before
  any adapter, counted **per lead across every channel** (QUEUED, SENT,
  DELIVERED, READ rows this Indian week). A send in the quiet hours is a
  QUEUED row with `scheduledFor`; the tick flushes it. A send past the cap
  is refused (`WEEKLY_CAP`); a sequence step past it leaves a SKIPPED row.
  **Default recorded (D5-a):** a reply inside an open window — the lead
  wrote in the last day — is a conversation, not outreach, and is exempt
  from both. The `lead-outreach` template is flagged transactional so the
  dispatcher does not rule a second time.
- **Inbound** — `POST /webhooks/outreach/meta` (WhatsApp Cloud, Instagram,
  Messenger — signed with the cards' app secrets; `GET` is the handshake on
  the cards' verify tokens), `/gupshup` and `/interakt` (`?token=` = the
  WhatsApp card's verify token), `/google-business` (signed; the
  `{clientToken, secret}` handshake echoed). Every message is idempotent on
  `(channel, providerId)`; a status never downgrades (SENT < DELIVERED <
  READ, FAILED with its reason). **Any inbound on any channel:** the lead's
  sequence stops (`REPLIED`), `attribution.engaged` is stamped, the stage
  moves to ENGAGED, a hand-off task (`tag: reply`, due in 4 h) lands on
  the agent holding the lead with a push (`LEAD_REPLY_RECEIVED`). A thread
  nobody knows: a WhatsApp number finds the lead by phone (an account
  holder's number is ignored); a DM handle from a stranger **creates a
  lead** (`externalKey` `instagram:<id>` / `messenger:<id>`, source of the
  channel's name) — **default recorded (D5-b):** sided PUBLISHER when the
  text mentions a wall / shutter / shop / screen / space / rent / earn,
  else ADVERTISER; ops re-sides it on the lead page.
- **A touch by hand** — `POST /leads/:leadId/touch` `{ channel, note?,
  direction?, at? }`: a `TOUCH_LOGGED` activity and a row on the thread;
  OUTBOUND stamps the first contact, INBOUND engages. LinkedIn, in person
  and "other" arrive only this way.
- **Telephony (D5)** — `POST /leads/:leadId/call` `{ record? }` rings the
  caller's own mobile (the `User.mobile` of the sign-in) first, then the
  lead on one of the card's `callerIds` (the masked numbers, rotated) —
  503 `INTEGRATION_NOT_CONFIGURED` with a sentence pointing at the phone
  when the card is empty. Recording is asked for only when the card's
  `recordCalls` is on **and** a consent line is set (default *"This call may
  be recorded for quality"*); the line plays before the lead is connected
  (`answerTwiml` for Twilio; Exotel and Knowlarity play their own flow);
  `consentPlayed` on the row is what admits the file. The operator's
  status hook (`/webhooks/outreach/telephony/status`) closes the row with
  `outcome` (ANSWERED / NO_ANSWER / BUSY / VOICEMAIL), `durationSec`, and —
  consent played — the recording fetched with the operator's auth and
  kept as a private `CALL_RECORDING` file (`recordingUrl` on the thread;
  the owner, the desk and the party's agent open it), **purged after 90
  days** by the tick. An answered call is the first contact (channel CALL)
  and CONTACTED. `POST /leads/:leadId/call-log` `{ outcome, durationSec?,
  note? }` logs a call the agent dialled by hand. The **missed-call
  number** (`/telephony/missed-call`) and the **IVR** (`/telephony/ivr`
  answers TwiML or JSON prompts; `/telephony/ivr/choice` reads the key —
  1 a publisher, 2 an advertiser) each find or create a lead by the number
  (an account holder's number opens nothing) and land a **callback task**
  (`tag: callback`, due in 4 h, `LEAD_CALLBACK_REQUESTED` push) on the
  holder's day (`GET /agents/me/day` now carries `CALLBACK` entries). A
  missed call from a stranger is sided PUBLISHER by default (the number is
  what the "earn from your wall" posters carry). `POST /leads/:leadId/
  callback` asks on the lead's behalf. Twilio signs its hooks; Exotel and
  Knowlarity are admitted by `?token=` = the card's `webhookSecret`.
- **Sequences** — `LeadSequence` per side and temperature, steps
  `[{ channel, delayHours, templateKey }]` (a CALL step needs no template:
  it lands a "Call {business}" task, `tag: call`, on the holder, or
  unassigned for the tele team). Six defaults are seeded once at boot
  (`ensureDefaultSequences`); the desk edits them at `GET/POST
  /leads/sequences`, `GET/PATCH /leads/sequences/:id` (`GET
  /leads/sequences/preview?templateKey=` renders the copy with sample
  values). A lead is **enrolled** when it is open, before ENGAGED, has a
  temperature and walks nothing yet — on the temperature hook (a change of
  temperature leaves the old run, `TEMPERATURE_CHANGED`, and joins the
  new), or by hand (`POST /leads/:leadId/sequence` `{ sequenceId?, force? }`;
  `DELETE` stops it, `MANUAL`). The tick (`lead-outreach-tick`, every five
  minutes) sends each due step through the hub (source SEQUENCE — a step
  that cannot go leaves a SKIPPED row naming why and the run moves on) and
  stops a run when its steps run out (`COMPLETED`), the lead passes
  CONTACTED (`STAGE_MOVED`), closes (`CLOSED`), or the sequence is switched
  off (`DEACTIVATED`).
- **The queues and the funnel** — `GET /leads/outreach/inbox?channel&side&
  city&unanswered&mine` (conversations with an inbound, newest first,
  `byChannel` counts; an agent sees their own); `GET
  /leads/outreach/tele-queue?side&city&temperature&q` (ADMIN: cold,
  unclaimed leads with a number, hottest first, with the last call, the
  attempts and any callback due); `GET /leads/outreach/funnel?from&to&side`
  (ADMIN: per channel, `outbound / delivered / failed / inbound / replies`
  from the messages and `firstContact / engaged / converted` from the
  leads' attribution stamps); `GET /leads/outreach/channels` (every
  adapter's configured state).
- **Audit** — the desk's writes: `LEAD_MESSAGE_SENT`, `LEAD_TOUCH_LOGGED`,
  `LEAD_CALL_PLACED`, `LEAD_CALL_LOGGED`, `LEAD_SEQUENCE_CREATED`,
  `LEAD_SEQUENCE_UPDATED` (an `auditDiff`), `LEAD_SEQUENCE_ENROLLED`,
  `LEAD_SEQUENCE_STOPPED`. An agent's sends are the lead's own activity.
- **`NotificationChannel += WHATSAPP`** — a comms template may now name
  WHATSAPP; the dispatcher sends it through the WhatsApp adapter (the
  card's approved template of the same key, else the `smsBody` as free
  text), SKIPPED `WHATSAPP_UNCONFIGURED` without a card. WhatsApp follows
  the person's SMS preference.

Tests: `__tests__/lh6-outreach.test.ts` (the hub, the sequences, the
telephony, over an in-memory outreach repository) and
`shared/outreach/__tests__/outreach-adapters.test.ts` (every adapter).

## LH7 — digital conversion (D6, D14)

`invites.rules.ts` is the arithmetic, `invites.service.ts` the link and the
landing, `proposals.service.ts` the three proposals, `landing.controller.ts`
the doors. The web page itself is the console's `src/app/(public)/j/[code]`
(no session, mobile-first, both themes); the copy it prints per side is the
`lead-landing` step ladder under the flow editor (`app-config/step-ladder.ts`
— one step per side; `title` the headline, `subtitle` the line, `hint` the
bullets one per line, `cta` the button, the "proofs" the hook blocks the
page shows, repeatable across the two sides; `GET /leads/landing-copy`
answers the ladder in force with its `source`).

- **The invite (D6)** — `POST /leads/:leadId/invite` `{ reissue? }` mints
  the lead's one live link `${PUBLIC_WEB_URL}/j/<code>` (eight unambiguous
  characters, thirty days) or hands the live one back; `reissue` revokes
  the old code first. `GET /leads/:leadId/invite` and `GET /leads/:leadId`
  (`invite`) carry it: `state` LIVE / EXPIRED / REVOKED / CONVERTED,
  `opens`, `lastOpenedAt` ("opened 2 h ago" on the phone), `appLink`
  `adx://join/<code>`. The outreach copy's `{{link}}` is this link, minted
  by the platform on the first send (`registerInviteLinkPort`).
- **The landing** — `GET /j/:code` (public) answers the page: the business,
  the agent's name, the copy per side, the hook (publisher: the median live
  rate within 200 m as a day and a month figure with the comparables'
  count, the campaigns booked within 2 km in six months; advertiser: the
  live spots within 2 km, a three-spot thirty-day sample at the nearby
  median, the first four packages of the catalogue) and the proposals.
  Every open is recorded on the invite (the last fifty) and, once an hour,
  as a `LINK_OPENED` activity (LH1's intent signal), a touch, and LH5's
  push to the holder; the proposals it shows are marked opened. An expired
  or replaced code still answers the page with its state.
- **The OTP door** — `POST /j/:code/otp` `{ mobile }` sends the code
  (auth's LOGIN purpose: an existing account signs in, a new number becomes
  one); `POST /j/:code/verify` `{ mobile, otp, name?, accountType? }`
  verifies it, opens the lead's side through the app's own door
  (`users.chooseParty`), converts the lead through the link
  (`convertLead`, channel **LINK** — the holder is paid LEAD_CONVERTED),
  marks the invite `convertedAt` and starts a session (`accessToken`,
  `refreshToken`, the party, `appLink`). `POST /j/:code/link` (a session)
  is the same door for a phone the deep link opened while signed in.
- **The two asks** — `POST /j/:code/callback` `{ when?, note? }` lands a
  callback task on the holder's day through LH6's door (via LINK) and
  engages the lead; `POST /j/:code/slot` `{ at, kind: VISIT | CALL, note? }`
  offers an ONBOARDING field visit to the holder (the visits offer, as the
  desk would dispatch it) or, with nobody holding the lead or a call asked
  for, a call task at the slot.
- **Proposals** — `POST /leads/:leadId/proposals` `{ kind, … }`:
  `RATE_ESTIMATE` (publisher; the comparables' median within 200 m, then
  2 km, or the agent's own `perDay`; 409 `NO_COMPARABLES` without either),
  `CAMPAIGN_ESTIMATE` (advertiser; `spots` × `days` at the nearby median or
  the agent's `perSpotPerDay`), `PACKAGE_QUOTE` (advertiser; `tier`,
  `addOnCodes`, `cycle` through `packages.quote`, no term). Sending one is
  `PROPOSAL_SENT` and PROPOSED (LH2). `GET /leads/:leadId/proposals` lists
  them; the thread view carries them too. The landing's Accept
  (`POST /j/:code/proposals/:id/accept`) stamps `acceptedAt`, engages the
  lead through the link (D14) and pushes the holder
  (`LEAD_PROPOSAL_ACCEPTED`); the desk may mark one accepted by hand
  (`POST /leads/:leadId/proposals/:id/accept`, audited with a diff).
- **Audit** — `LEAD_INVITE_ISSUED` / `LEAD_INVITE_REISSUED`,
  `LEAD_PROPOSAL_SENT`, `LEAD_PROPOSAL_ACCEPTED` on the desk's writes.

Tests: `__tests__/lh7-invites.test.ts`.

## LH8 — the motivation layer (D1, D2, D7)

Most of what the brief lists under LH8 landed with the lot that needed it,
and this section says where:

- **The three rewards and their seeded rates (D1)** — `IncentiveEvent`
  `LEAD_CONVERTED` (₹100), `LEAD_ACTIVATED` (₹500, `*:ADVERTISER` ₹750),
  `LEAD_RETAINED` (₹100) in `payouts.DEFAULT_INCENTIVE_RATES` since LH2,
  paid by `payConversion` / `payStage` through `recordIncentiveOnce`;
  editable on the incentive settings like every other rate.
- **An activation is one onboarding toward the rung (D2)** — new here.
  The tier ladder counts publishers and advertisers by the `agentId` on the
  account, so `watchRetention`, right after the catch pays `LEAD_ACTIVATED`,
  stamps the holder onto the account through
  `repository.attributeAccountToAgent` — **only where the account names no
  agent yet** (a QR-scanned or desk-onboarded account keeps the agent who
  brought it in, and no account counts for two people) and **only now,
  after the catch**, so the onboarding commissions the account doors pay at
  `ONBOARDING_COMPLETE` / KYC (`PUBLISHER_ONBOARDED`, `ADVERTISER_ONBOARDED`)
  are never triggered by a link conversion: the hunt paid `LEAD_ACTIVATED`
  for that, the rung climbs on the next read, nothing is paid twice. The
  stamp writes one activity line on the lead, "Counted toward the tier
  ladder (D2)".
- **The priority top-up at payout under the cap (D7)** — LH5's
  `payPriorityTopUp`, an activation hook: the zone's own figure (or the
  platform's ₹200) under the zone's budget and the ₹25,000 monthly cap,
  once per lead, recorded as a `LEAD_ACTIVATED` row keyed
  `priority:<zone>:<lead>`.
- **The three alert templates** — `lead-nearby-hot`, `lead-claim-lapsing`,
  `lead-link-opened` (LH5 / LH7), non-transactional pushes.
- **The milestone templates** — `MilestoneType` gains `LEAD_CONVERSIONS`
  and `LEAD_CONTACTS` (`20260922200000_lh8_motivation`); the agents module
  derives them from `Lead.convertedAt` / `Lead.firstContactedAt` by holder
  inside the row's window and seeds "5 lead conversions this month" (5 in
  30 days, ₹1,500) and "10 first contacts this week" (10 in 7 days, ₹300)
  once per type at boot (`ensureLeadMilestoneTemplates`) — see the agents
  README.
- **The leaderboard's "from leads" column** — the agents module's
  `leadFiguresByAgent`: credited `LEAD_*` incentives as a share of the
  earnings (podium and the viewer's own row only, decision 9) and the count
  of leads held that converted in the window (every row — a count is not a
  figure).
- **The detail's `rewards`** — `GET /leads/:id` lists what the hunt
  recorded on a converted lead (`LEAD_*` rows keyed on its account, and the
  priority top-up keyed on the lead), as money with the row's status; the
  phone's success modal on ACTIVATED prints that figure, never a card's.

Tests: the D2 cases in `__tests__/lh2-stages.test.ts`, the `rewards` case
in `__tests__/leads.test.ts`; the milestone and leaderboard cases live in
`agents/__tests__/milestones.test.ts` and `leaderboard.test.ts`.

## LH9 — analytics

The Leads section's Overview lives in `section-overviews` (`GET
/section-overviews/leads?from&to&city`, aggregates only) and carries this
module's funnel rather than re-deriving it: `leadFunnel` (the desk's
`/leads/funnel`, exported from the index) answers the funnel by stage with
the pipeline value per stage, the conversion by source / agent / city /
category / channel and the loss mix over the leads created in the window;
the overview adds the day series, the previous-window figures, the median
time to convert, the cost per activation (the hunt's recorded rewards plus
the priority top-ups over the catches) and the recycle yield. For the
yield, `recycleDue` now stamps `Lead.recycledAt` and bumps
`Lead.recycleCount` (`20260922210000_lh9_analytics`, with indexes on
`convertedAt`, `activatedAt` and `recycledAt`); LH11's board flag reads the
same two columns. The console's Leads section tabs are Overview | Board |
List | Map | Sources | Sequences | Conversations | Import, the list having
moved to `/leads/list` so the overview can sit at the section's root like
every other section's.

Tests: `section-overviews/__tests__/leads.test.ts`, the recycle stamp in
`__tests__/lh2-stages.test.ts`.

## LH10 — anti-gaming and quality

Three things, all of them read-and-tell rather than act-and-punish.

**The integrity scan** (`integrity.service.ts`, hourly under the
`lead-integrity` job) reads the last 48 hours of leads for four patterns and
opens a `LeadFlag` for each — one per lead and kind, never re-opened over a
decision, so a dismissed pattern does not come back every hour:

| Kind | What it is |
| --- | --- |
| `SELF_REFERRAL` | D9's referral points at the referrer's own number, at their own login, or at an account sharing their device. The evidence says which, and whether the credit was already paid |
| `PHONE_REUSE` | **A reading recorded while building this:** the leads table already refuses a second lead on a *normalised* number (a partial unique index from the leads migration), so the reuse that can actually happen is a row whose number never normalised sitting beside one that did — or a "new lead" whose number **already belongs to an account**, which is the cheapest way to farm a conversion out of a customer who is already ours. Both are this flag |
| `CAPTURE_BURST` | More than `BURST_PER_HOUR` (12) street captures by one agent in an hour |
| `WEBHOOK_REPLAY` | One provider key on more than one lead, or one lead-form payload threaded onto two leads |

A flag is decided by a person — `POST /leads/flags/:flagId/decide`
(CONFIRMED / DISMISSED, audited `LEAD_FLAG_CONFIRMED` / `_DISMISSED`), once;
a second decision is a 409. **Only a CONFIRMED flag counts** — against the
agent's quality score, and nowhere else. Nothing here suspends anybody.

**QA sampling** (`qa.service.ts`, once a day inside the same job) draws one
in `VISIT_SAMPLE_RATE` (5) completed visits and one in `CALL_SAMPLE_RATE`
(10) recorded calls from the last day, deterministically (`everyNth`, so a
re-run draws the same work) and once per row. A visit passes when it carries
a photo and a fix within `PROOF_RADIUS_M` (300 m) of the site — LH10 added
`FieldVisit.proofFileId / proofLatitude / proofLongitude / proofAt`, stamped
by `POST /visits/:id/complete` when the phone sends them, left null when it
does not, which is what a FAIL reads. A call fails when a recording was kept
**without** the consent line (D5's rule, the other way round) or an answered
call was shorter than `MIN_CALL_SEC` (20 s). Ops review a sample
(`POST /leads/qa/:sampleId/review`) and must say why when they overrule the
evidence.

**The quality score** (`GET /leads/quality/:agentId`) is the share of PASSes
over 90 days — a reviewed verdict beating the automatic one — less
`FLAG_PENALTY` (0.1) per confirmed flag, capped at `MAX_FLAG_PENALTY` (0.5)
and floored at 0. Null under `MIN_QUALITY_SAMPLE` (5) samples: too little
history is no score, not a bad one — the same honesty `AgentRating` keeps.

**The clawback** (`clawback.service.ts`, hourly) reads the leads activated
in the last `CLAWBACK_DAYS` (30). If the account has closed, or its business
has come down (a publisher with no ACTIVE listing left, an advertiser with
no live campaign), the **LEAD_ACTIVATED** reward comes back through
`payouts.clawbackIncentive`: money that had not moved is refused, money that
had is **reversed** — an equal and opposite movement under `REVERSAL`, so
both legs are in the ledger and nothing is edited in place (`AgentIncentive`
gained a `REVERSED` status and `reversedAt` / `reversalReason` /
`reversalLedgerTransactionId`). It is audited (`LEAD_ACTIVATION_CLAWED_BACK`)
and the agent is told (`INCENTIVE_REVERSED`). Deliberately narrow: never
LEAD_CONVERTED (the account was opened, and it was), never the priority
top-up, never anything a person credited by hand.

**What was already there, and stays there:** the claim caps and the seven-day
cooldown are LH5's (`map.rules.ts` `claimVerdict`, enforced at the claim);
and every hunt reward is recorded `PENDING_VERIFICATION` for ops to release
— the platform pays on server-verified events only, which is why the
clawback has a PENDING branch at all.

Tests: `__tests__/lh10-integrity.test.ts`.

## LH11 — retention and recycling

- **The trailing reward.** `watchRetention` moves an ACTIVATED lead to
  RETAINED on the **second booking / second paid campaign**, or on thirty
  days still live (`RETAINED_AFTER_DAYS`), and pays `LEAD_RETAINED` once
  (D1, ₹100). Built with LH2; nothing here changes it.
- **The sixty-day recycle, with a fresh sequence.** `recycleDue` brings a
  PRICE / TIMING loss back to SCORED, unassigned, after sixty days (D11).
  LH11 fills the port LH2 declared: `registerRecycleSequencing()` (wired in
  bootstrap) enrols the returning lead in its side's sequence with
  `force: true` — whatever run it had is stopped and a **new** one starts,
  because the point of a recycle is that the conversation begins again. A
  lead the enrolment cannot take (no temperature, no active sequence for the
  side) is logged and still recycled: the sequence is the follow-up, not the
  recycle itself.
- **Flagged wherever it is drawn.** `Lead.recycledAt` / `recycleCount`
  (LH9's migration) ride the lead card, so the console's board draws a
  "Recycled" / "Recycled 3×" badge with the date on hover and the agent's
  card carries it on the eyebrow. The Leads overview's recycle yield
  (LH9) counts the same two columns.

Tests: the recycle and its port in `__tests__/lh2-stages.test.ts`.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /leads/near` | any session | The agent's list. `?lat&lng` ranks by distance; without a point it is newest-first. |
| `GET /leads/:leadId` | any session | One lead with its activity. |
| `POST /leads/:leadId/contact` | any session | Records a call, a message, a note or a follow-up. |
| `POST /leads/:leadId/visit` | any session | Books the visit — the card's **Visit** button. |
| `POST /leads/:leadId/convert` | any session | Records the account it became — or links the account its phone already belongs to (Lot D). |
| `GET /leads` | ADMIN | The ops desk. |
| `POST /leads` | ADMIN | One lead. T-B: answers what `GET /leads/:leadId` answers — the card (`pill`, `distanceM`, `visitBooked`) with `address`, `email` and `activity` — the way the patch does. |
| `POST /leads/import` | ADMIN | A batch, up to 500 rows, in one transaction with a per-row report; `dryRun: true` reports without writing (Lot D). |
| `PATCH /leads/:leadId` | ADMIN | Edit, reassign, close. |
| `GET /leads/map` · `GET /leads/map/heat` | any session | LH5: the viewport (clusters / pins) and the heat. |
| `POST /leads/:leadId/claim` · `POST /leads/:leadId/release` | agent roles | LH5 (D3): the 72-hour hold and handing it back. |
| `POST /leads/map/assign` | ADMIN | LH5: every open, unassigned lead inside a polygon to an agent. |
| `GET/POST /leads/territories` · `PATCH /leads/territories/:id` | ADMIN | LH5 (D8): route-only territories. |
| `GET/POST /leads/priority-zones` · `PATCH /leads/priority-zones/:id` | ADMIN | LH5 (D7): the top-up zones under their budget and the monthly cap. |
| `GET /leads/flags` · `POST /leads/flags/:flagId/decide` · `POST /leads/flags/scan` | ADMIN | LH10: the integrity scan's flags, the desk's decision (audited, once), and the scan by hand. |
| `GET /leads/qa` · `POST /leads/qa/:sampleId/review` · `POST /leads/qa/sample` | ADMIN | LH10: the sampled field work, ops' verdict (a reason required to overrule), and the draw by hand. |
| `GET /leads/quality/:agentId` | ADMIN | LH10: the agent's quality score over 90 days, with what it is made of. |
| `POST /leads/clawbacks/run` | ADMIN | LH10: the clawback watch by hand — activations that did not last. |
| `GET /leads/:leadId/thread` · `GET /leads/:leadId/messages` | holder / ADMIN | LH6: the unified conversation, every channel, with reachability and the sequence run. |
| `POST /leads/:leadId/messages` · `POST /leads/:leadId/touch` | holder / ADMIN | LH6: send on a channel (typed or from a template); log a touch by hand (D13). |
| `POST /leads/:leadId/call` · `POST /leads/:leadId/call-log` · `POST /leads/:leadId/callback` | holder / ADMIN | LH6 (D5): click-to-call on a masked number; a hand-dialled call's outcome; a callback asked on the lead's behalf. |
| `POST/DELETE /leads/:leadId/sequence` | holder / ADMIN | LH6: enrol in (or stop) the sequence. |
| `GET /leads/outreach/channels` · `GET /leads/outreach/inbox` | any session | LH6: every adapter's state; the inbound queue by channel (an agent's own). |
| `GET /leads/outreach/tele-queue` · `GET /leads/outreach/funnel` | ADMIN | LH6: the tele-team queue of cold leads; the funnel by channel. |
| `GET/POST /leads/sequences` · `GET /leads/sequences/preview` · `GET/PATCH /leads/sequences/:id` | ADMIN | LH6: the sequence editor and its preview. |
| `/webhooks/outreach/*` | providers | LH6: Meta (`GET` handshake, `POST` events), Gupshup, Interakt, Business Messages, telephony (`status`, `missed-call`, `answer`, `ivr`, `ivr/choice`). |
| `GET/POST /leads/:leadId/invite` | holder / ADMIN | LH7 (D6): the live invite link; mint, or re-issue. |
| `GET/POST /leads/:leadId/proposals` · `POST /leads/:leadId/proposals/:id/accept` | holder / ADMIN | LH7: the three proposals; one marked accepted by hand. |
| `GET /leads/landing-copy` | ADMIN | LH7: the invite landing's copy per side, the ladder in force. |
| `/j/:code` (`GET`, `otp`, `verify`, `callback`, `slot`, `proposals/:id/accept`; `link` with a session) | public | LH7: the landing behind adx.in/j/<code>. |
| _(no route)_ `registerWaitlistLead` | `geo` | W-B: the coming-soon waitlist (`POST /app/geo/waitlist`) creates its lead here — `source` WAITLIST, an IMPORTED row naming it (the tap's note appended). The phone rule dedupes: a second tap from the same number answers the lead it already has (`created: false`) and notes the ask on its thread — and two taps racing each other end the same way: the partial unique on `phoneNormalised` refuses the second insert and the loser answers the lead the winner wrote, never a 500, never a second lead. The account half of the rule does **not** apply — the number is the caller's own publisher or advertiser account by construction — and the city gate is not asked: a waitlist is for a city whose lead feeds are off. |

`/near` is not role-gated beyond a session: a publisher-side and an
advertiser-side agent both work leads, and `?side=` is what separates them.

## The city key (Lot X-B)

`Lead` carries `cityId` beside the free-text `city` — the `City` row the
string denotes, stamped by the service through `pricing.withCityKey` on
`createLead`, `patchLead` when the patch carries `city`, `importLeads` (once per distinct town — the key is cached a minute per spelling) and `registerWaitlistLead`; null for a typed town the catalogue lacks, and the string stays as typed
(the owner's rule). A caller never sends the key. `GET /leads?city=` (ADMIN) takes a slug (a name still resolves) and matches by the key, the `contains` spelling only for rows whose key is null; `closeOpenLeadsInCity({ cityId, spellings })` — the wind-down — closes every open lead keyed to the city whatever it was typed as, and the null-keyed rows typed under one of its spellings. `/leads/near` stays on coordinates. Lot X-L: `leadClusters({ city })` — the hunting map without a position — resolves the city to its key and clusters the leads keyed to it (whatever they were typed as) plus the null-keyed ones typed under this spelling, so the map is one map rather than one per spelling; a town nobody catalogued clusters by the spelling alone; a point scope is untouched.

## Invariants

- **A lead is work, so it is not handed to a suspended agent.** Lot A's
  BLOCK_NEW is checked whenever `assignedAgentId` is set — on creation and on a
  reassignment — and answers 409 `AGENT_SUSPENDED`. Clearing the assignment
  (`null`) is never blocked: that is how a lead comes off a suspended agent and
  back into the open pool.
- **Six statuses, one vocabulary.** The card draws three pills (HOT, NEW,
  CONTACTED) and the lifecycle needs three more (VISIT_BOOKED, CONVERTED,
  LOST). They were reconciled into one enum the way DR 07 reconciled
  `DisputeStatus`, and the app is handed `leadPillOf` rather than a second
  list — `VISIT_BOOKED` reads as **Contacted** on the pill, and the fact that a
  visit exists is told in the money slot instead.
- **The money slot is not always money.** A lead with a visit booked replaces
  "Est. ₹1,450" with "Visit booked"; `visitBooked` travels on the card so the
  app does not re-derive it.
- **The estimate is quoted, never typed.** "Est. ₹1,450" is read from the
  effective `IncentiveRate` — `PUBLISHER_ONBOARDED` for a publisher lead,
  `CAMPAIGN_ASSIST` for an advertiser one — because an estimate that does not
  match what the platform actually pays is worse than no estimate, and rates
  are effective-dated so a stored number would quietly go stale. Where no rate
  is configured the field is **null**, not zero: zero is a promise to pay
  nothing.
- **First contact is stamped once.** The detail screen prints "First contact —
  Not yet", which a field that reset on every call could never answer. A call
  moves `NEW` to `CONTACTED` and nothing else: `HOT` is the agent's judgement
  and a booked visit is a fact, and neither is undone by a phone call.
- **A lead converts exactly once, through `/convert`.** The funnel counts
  conversions, so a lead that could convert twice would be counted twice; the
  second attempt is a **409**. `PATCH` refuses `status: CONVERTED` outright —
  the table's own `Lead_converted_is_dated` check requires `convertedAt`
  beside it, and a patch that set one without the other would surface as a 500
  rather than a sentence.
- **Converted and lost leads leave the agent's list.** "23 publisher leads near
  you" is work to do; counting closed ones would inflate it with things nobody
  should visit. They stay on the ops desk, which filters by status.
- **`NEAREST` needs a point.** The query refuses `sort=NEAREST` without
  `lat`/`lng`, and refuses half a point at all — the same refinement browse
  makes. Answering a distance-ranked question with an unranked list would be
  worse than refusing it. The **default is `NEWEST`**, because a default that
  fails on a bare request is not a default.
- **Around a point, the box is read whole and sorted by exact distance**, then
  cut to the radius — a box corner is farther than its edge, and the card
  promises "0.8 km away" in order. Capped at 500 rows, the same bound browse
  uses.
- **Clusters are grouped in the database.** The point of a bubble is not to
  send a thousand rows to a phone and count them there. A bubble sits at the
  mean position of the leads it covers, because the platform does not hold
  official locality centres.
- **The map layer never takes the dashboard down.** `getAgentDashboard` catches
  a failing cluster query and answers with an empty layer: the header, the
  wallet and the day's counters are what that screen is for.
- **Without a position, clusters fall back to the agent's city.** A dashboard
  that stays blank until location permission is granted teaches people the
  feature is broken. Lot X-L: that city is matched by its key (see "The city
  key"), so an agent whose profile says 'Bangalore' sees the Bengaluru leads.
- **`LED-####` comes from the one counter.** Minted through `identifiers` like
  every other party. A second numbering scheme is how two different things end
  up both called LED-0001.

## Not decided here

The **category** is a controlled string — "Print vendor", "Gym", "Cafe" — the
same choice `Listing` makes for illumination and facing, so ops can extend the
vocabulary without a migration. It is deliberately **not** `VenueType`, which
the build brief suggested: that is an ad-placement taxonomy about where a screen
hangs (`shopping-malls-retail-centers-department-stores-atrium-led-walls`), not
what a business is.

Where leads **come from** is still open. The domain accepts them from ops one
at a time and in batches of up to 500, and from any signed-in agent; there is
no scraper and no partner feed behind it yet.

## Dedup (Lot D, Q56/Q93)

- **The normalised phone is the hard key.** `leads.phone.ts` folds a number
  to E.164 with +91 as the default country (the same rule a login takes) and
  writes it to `Lead.phoneNormalised`, which carries a partial unique index.
  Written on create, patch and import; a phone that is not a phone is 400.
- **Duplicates are skipped and reported, never merged.** A number already on
  a lead is 409 `CONFLICT` with `details.reason = 'DUPLICATE_LEAD'` on the
  single create, and `DUPLICATE_LEAD` on the import row (naming the lead, or
  the earlier row of the same sheet).
- **A number on a Publisher or Advertiser account is an account, not a
  prospect.** 409 with `details.reason = 'EXISTING_ACCOUNT'` on create;
  `EXISTING_ACCOUNT` on the import row, naming the account. Never converted
  into a lead. The lookup reads `Publisher.mobile` and `Advertiser.mobile`
  from this module's repository because neither module exports a lookup by
  mobile, and a read is not a decision — the same call `disputes` makes for
  an order's parties.
- **Business name + city is the soft key** (`foldNameCity`: lower-cased,
  spaces removed). A match against an existing lead or an earlier row is a
  `WARNING` on the report and the lead is still created — two cafés can
  share a name in one city.
- **The import** checks every row first, then mints one LED- number per
  surviving row, then writes the whole batch — leads and their IMPORTED
  activity — in **one transaction** (`importBatch`), so a duplicate the
  pre-checks missed rolls the sheet back rather than landing half of it.
  The answer is `{ dryRun, imported, skipped, warnings, ids, report }` with
  `report[]` = `{ row, outcome: CREATED | DUPLICATE_LEAD | EXISTING_ACCOUNT | INVALID | WARNING, ref, message }`;
  created rows get their LED- number as `ref`. `dryRun: true` stops after
  the report, mints nothing and answers 200 rather than 201; only a real
  import writes `LEADS_IMPORTED`.
- **Converting checks the phone against both account tables.** With no
  account named, the match is linked; a caller naming a different account
  than the phone belongs to is 409; with no match and nothing named, 400.

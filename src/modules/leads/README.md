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

The platform deliberately did not have this. `agents/dashboard.service.ts`
declared a `LeadCluster` shape, returned `leads: []`, and a test pinned the
empty list as correct "until a lead model exists" — the shape was published so
the app could draw the map layer without an app release on the day the model
landed. This is that model, and that test now asserts the other side of it.

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

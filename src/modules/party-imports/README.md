# party-imports

Lot S (owner, 15 Sep 2026): the publisher importer, generalised — one
two-step import (validate with a per-row report, then commit) for the four
parties that had none: **advertisers, agents, print partners, employees**.
The publisher's own importer (`publishers/import`, Lot D Q43/Q86) stays as
it is and is the pattern this follows.

Lot U (owner, 15 Sep 2026) adds two kinds that are FOR a publisher rather
than of a party — **their listings and their rate card** — on the same
table, the same two steps and the same report, and the **format guide**:
one JSON per import kind on the platform and a template.csv each. See
"The publisher's two kinds" and "Import formats" below.

## What it owns

`PartyImport` and `PartyImportRow` — and nothing else. The module never
writes a party row: every CREATE goes through that party's own creation
service and every MERGE through its update service, so display ids, wallets,
brands, users, roles, `kycStatus PENDING` and the creation audit rows happen
exactly as a console Create. Lot U keeps the rule: a listing is created
through `listings.createListing`, filed under its attempt through
`supply.attachListingToAttempt`, and repriced through
`listings.updateListing` — never a `Listing` row from here.

| Party | Create | Merge | Console door it mirrors |
| --- | --- | --- | --- |
| advertisers | `advertisers.registerAdvertiser` with the mobile, `userId: null`, `agentId: null` (identifier, wallet, brand) | `advertisers.updateProfile` | `POST /advertisers` (on-behalf), `PATCH /advertisers/:id` |
| agents | `agents.createAgent` (User + role + profile in one write; a number already on an account gains the role and a profile) | `agents.updateAgent` (city, state) | `POST /agents`, `PATCH /agents/:id` |
| print-partners | `print-partners.createPartner` (the sign-in-disabled User, identifier, wallet) | `print-partners.updatePartner` | `POST /print-partners`, `PATCH /print-partners/:id` |
| employees | `users.createUser` (no role — console access comes from an invitation) then `employees.createEmployee`; a number already on an account with no record gets the record only | `employees.updateEmployee` (by user id) | `POST /users` + `POST /employees`, `PATCH /employees/:userId` |

Every created party is PENDING KYC and therefore in its queue as
AWAITING_DOCUMENTS from the moment it exists (N3-B) — pinned for advertisers
by `advertiser-lands-in-queue.test.ts`, which runs the real `advertisers`
module and the real advertiser KYC queue over an in-memory Prisma table.

## Routes — `/party-imports/:party` (ADMIN at the router)

`:party` is `advertisers | agents | print-partners | employees`; anything
else is **400** before any table is read. An id is read only under its own
party (a wrong party is 404).

- `POST /party-imports/:party` — a multipart CSV under `file` (through
  `uploads`' `csvUploadMiddleware`, `note` as a field) or a JSON body
  `{ rows[], fileName?, note? }` — **201**, a VALIDATED import with its
  per-row plan. Audited `PARTY_IMPORT_VALIDATED { party, counts }`.
- `GET /party-imports/:party?status=&page=&pageSize=` — the imports, on the
  list contract (`{ items, total, page, pageSize, counts }`, the histogram over
  the party).
- `GET /party-imports/:party/:id` — the import with its rows.
- `GET /party-imports/:party/:id/report.csv` — outcome and message first,
  then the party's columns.
- `POST /party-imports/:party/:id/commit` — see below. 409 twice, 409 after
  a revoke. Audited `PARTY_IMPORT_COMMITTED`.
- `POST /party-imports/:party/:id/revoke` — only an uncommitted import.
  Audited `PARTY_IMPORT_REVOKED`.

## The columns, per party

Header names in any order; `mobile` is the only required column everywhere.
Row numbers count the header as line 1.

**advertisers** — `name, mobile, email, type, companyName, industry, gstin,
panNumber, address, city, state, contactName`. `type` is
`INDIVIDUAL | COMMERCIAL | NGO | AGENCY`; `industry` one of
`ADVERTISER_INDUSTRIES` (any casing). `address` lands as `billingAddress`.
`panNumber` and `contactName` are validated and kept on the row and the
report but **not written**: the advertiser's PAN lives on the KYC record,
which only a submission writes, and the profile has no contact-name column.
The row's message says so.

**agents** — `name, mobile, email, side, city, state`. `side` is
`PUBLISHER | ADVERTISER` and **required** (it picks the role). `name` and
`email` are the User's; a merge fills only `city` and `state`.

**print-partners** — `name, mobile, legalName, gstin, panNumber, contactName,
email, address, city, capabilities, maxWidthFt, turnaroundDays`.
`capabilities` is pipe-separated (`flex|vinyl|backlit`); `maxWidthFt` a
number with at most two decimals; `turnaroundDays` a whole number ≤ 365.

**employees** — `name, mobile, email, department, designation, region,
workMode, employmentType`. `workMode` is `OFFICE | REMOTE | HYBRID | FIELD`,
`employmentType` `FULL_TIME | PART_TIME | CONTRACT | INTERN` (any casing).
`name` and `email` are the User's; a merge fills only the record's five
columns.

## The rules (decision 86, party for party)

- `mobile` required, normalised through `auth.normalizeMobile`; `email`
  lower-cased; PAN and GSTIN upper-cased and format-checked; enums accept
  any casing.
- `city` resolved through `pricing.resolveCity`; unknown is a **WARNING**,
  kept as typed.
- A mobile already in the party's table plans **MERGED** — filling only the
  columns the party has empty, and not a column an earlier row of the same
  batch already claimed — or **SKIPPED** when there is nothing to fill.
- A duplicate mobile inside the batch is **SKIPPED** (the later row).
- A PAN or GSTIN already on another row of the party is a **WARNING** and
  the row still creates (`warningCount` counts these beside `createdCount`).
- A malformed value is **INVALID** and names the field
  (`turnaroundDays: Use a whole number of days`; `mobile is required`).
- A create the party's own service would refuse is INVALID here, named,
  rather than a failure at commit: a print partner's number already on an
  ADX account (`createPartner` never attaches to an existing person); an
  email already on another account, or twice in the batch, for the parties
  whose create makes a User (agents, print partners, employees). An email on
  the account that holds this very number is not "another account".
- **Nothing refuses the batch.**

## Commit: per row, resumable — not one transaction

The publisher's importer writes its own rows and wraps the commit in one
`$transaction`. This one cannot: a party is created through its module's own
service, which runs on the shared client and mints identifiers off an atomic
counter — none of that can be handed a transaction client without reopening
four modules. So:

- Rows run in order, each its own unit. As a row lands, its result is written
  on the row — `data.result { action, targetId, targetUserId?, at }`, `targetId`, and the
  outcome (a WARNING row keeps WARNING so the report still shows what ops
  were told). T-B: every row answered (validate, get, commit, revoke) carries
  `targetUserId` beside `targetId` — the account behind the record, from the
  merge plan or the commit's stamp — because `targetId` is the Employee id and
  the console's employees page is addressed by the user id; null for the
  parties whose page takes the record itself. That stamp is the **resumable marker**: a commit that dies
  half-way leaves the import VALIDATED with the finished rows stamped, and
  the next `commit` call skips them and carries on.
- The parties are re-read once at commit, as they are now: a number that
  joined between validation and commit is **merged into, not duplicated**
  (the row becomes MERGED with a message saying so), and a planned merge is
  recomputed against the current values so a column filled since validation
  is not overwritten.
- A row the party's service refuses (a 4xx of its own — a 409 on an email,
  say) is marked INVALID with `Not created: <reason>` and the commit goes on;
  a retried commit picks it up again. An infrastructure error stops the
  commit where it is, to be resumed.
- The counts written at COMMITTED are the rows as they landed.
- Each create and merge is audited under the action the console's handler
  uses — `ADVERTISER_CREATED` / `ADVERTISER_PROFILE_UPDATED`,
  `AGENT_CREATED` / `AGENT_UPDATED`, `PRINT_PARTNER_CREATED` /
  `PRINT_PARTNER_UPDATED`, `USER_CREATED_BY_ADMIN` + `EMPLOYEE_CREATED` /
  `EMPLOYEE_UPDATED` — with `{ importId, rowNumber, source: 'import' }` in
  the metadata, and the import itself under `PARTY_IMPORT_COMMITTED`.

## The publisher's two kinds — Lot U

`ImportParty` gained `LISTING` and `RATE_CARD`; `PartyImport` gained
`publisherId` (the publisher the import is for) and `attemptId` (the supply
attempt a LISTING commit opened). The routes are the party routes' shape
with a literal segment and `?publisherId=`:

- `POST /party-imports/listings?publisherId=` and
  `POST /party-imports/rate-card?publisherId=` — a multipart CSV under
  `file` or a JSON body `{ rows[], fileName?, note? }`; **201** VALIDATED with
  the plan. `publisherId` is required (400) and must exist (404).
- `GET /party-imports/listings?publisherId=&status=&page=&pageSize=` and
  `/rate-card` — the list contract; ADX may omit `publisherId` and read all,
  an agent must name one.
- `GET /:id`, `GET /:id/report.csv`, `POST /:id/commit`,
  `POST /:id/revoke` — as for the parties.
- `GET /party-imports/formats`, `/formats/:kind`, `/formats/:kind/template.csv`
  — the guide, ADMIN.

**Who may.** ADMIN, or an `AGENT_PUBLISHER` under the act rule an agent's
own listing creation uses — `listings.assertCanCreateForPublisher`: the
agent who onboarded the publisher (`Publisher.agentId`) or one under a live
LISTINGS grant. The router lets both roles through; the service asks the
rule against the publisher the import is for, on every write and on an
agent's every read. The same rule guards the rate-card kind: an agent who
may add a spot for a publisher may state its rate.

### `listings` — the publisher's spots

Columns (any order): `externalRef, title, category, subType, description,
address, city, state, latitude, longitude, mediaType, sizeClass, size,
material, ratePerDay, monthlyPrice, slotsTotal, instantBooking, photos`.
Required: `title`, `category` (`LISTING_CATEGORIES`, any casing),
`address`, and one of `ratePerDay` / `monthlyPrice` (÷ 30, the way the
listing schema documents). `latitude` and `longitude` come together or not
at all; `instantBooking` is yes/no; `photos` is pipe-separated URLs (≤ 20);
`slotsTotal` 1–24. `state` is used to geocode only — the listing has no
state column.

The plan, per row:

- **Vocabulary.** `mediaType` (name or slug), `sizeClass` (slug or name) and
  `material` (slug or name) are resolved against the controlled lists at
  validation and the ids written on the row; unknown is **INVALID naming
  the field**. A media type by name is therefore never run through the
  similarity threshold from a file: a spreadsheet of five hundred rows
  must not grow the taxonomy by forty variants. `city` is resolved through
  `pricing.resolveCity`; unknown is a WARNING, kept as typed.
- **Coordinates.** A row without them is geocoded through
  `shared/maps.geocodeAddress` (`address, city, state`), once per distinct
  query. The seam answering null — or throwing its 503 / 429 / 502 — is a
  **WARNING** "No coordinates — place it on the map before publishing"; the
  import never fails for it. A row that merges is not geocoded (the edit
  door does not move a pin).
- **The floor.** A rate under the ADX rate-card floor for that media type
  in that city (`rate-cards.floorFor`, the default grade, memoised for the
  batch) is a **WARNING**; the publish gate (`409 BELOW_RATE_CARD_FLOOR`)
  stays the guard.
- **Merges.** The same `externalRef` as a row an earlier LISTING import
  committed for this publisher, or the same normalised address
  (lower-cased, punctuation collapsed) as one of the publisher's listings,
  plans **MERGED** — filling only the blanks among `description, subType,
  mediaTypeId, sizeClassId, materialId`, and the rate only when the
  listing has none — or **SKIPPED** with "rate kept at …" when there is
  nothing to fill. A set rate is never overwritten. City, size and
  coordinates are not filled on an existing listing: the platform's own
  edit door does not take them.
- **Duplicates.** The same `externalRef` (or, without one, the same
  address) twice in the file is **SKIPPED** (the later row). Another
  publisher's listing within **25 m** of the point is a **WARNING**
  "Possible duplicate of <displayId or title> — another publisher's spot
  N m away" and the row still creates.
- **Nothing refuses the batch.** Audited `LISTING_IMPORT_VALIDATED
  { publisherId, counts }`.

The commit, per row with the resumable marker (as Lot S):

- The **first** run opens ONE supply attempt for the publisher —
  `supply.createAttempt({ origin: ADMIN_BULK | AGENT })` — and writes its
  id on `PartyImport.attemptId`; a resumed run reads it back and reuses it,
  so the batch sits under one agreement however many runs it took.
- Every CREATE goes through `listings.createListing` (DRAFT, the console's
  door: photos, the loop gate, the instant-booking gate, the surge stamp)
  and then `supply.attachListingToAttempt` (AWAITING_AGREEMENT). **Never
  ACTIVE from an import** — that is the attempt flow's and the desk's. An
  agent's import stamps the agent (`Listing.agentId`); an admin's carries
  none. Audited `LISTING_CREATED { importId, rowNumber, attemptId, source:
  'import' }` per spot.
- A MERGE goes through `listings.updateListing`, recomputed against the
  listing as it is now; a spot that joined between validation and commit
  (by reference or by address) is merged into rather than duplicated.
  Audited `LISTING_UPDATED` with the diff.
- A row `createListing` refuses (a 4xx — the instant-booking flag off, a
  loop on a static wall) is INVALID "Not created: …" and the commit goes
  on; a spot created but refused by the attempt is a WARNING "Created as a
  draft, but not under the agreement: …".
- The agreement is **not** sent: the answer carries `attemptId` and the
  console offers "Send the agreement" — the existing
  `POST /supply/attempts/:id/request-acceptance`. Audited
  `LISTING_IMPORT_COMMITTED { publisherId, attemptId, counts }`.

### `rate-card` — the publisher's rates

Columns: `listing, ratePerDay, monthlyPrice, slotsTotal, effectiveFrom`.
`listing` is resolved against the publisher's own listings by **displayId**,
then **externalRef** (from the rows earlier LISTING imports committed), then
**exact title** (case-insensitive) — in that order; unmatched is INVALID
naming the reference, and a title two listings share is INVALID ("use the
displayId"). The plan: a set is reported as **MERGED** (the outcome enum is
the publisher importer's five; "MATCHED" is MERGED here), **WARNING** when
the rate is under the floor or the listing has an order holding a slot
right now (the message says the running order's accrual snapshots keep the
rate it was placed at); an unchanged rate and loop is **SKIPPED**; the
same listing twice in the file skips the later row. Nothing refuses the
batch. Audited `RATE_CARD_IMPORT_VALIDATED`.

**`effectiveFrom`.** `YYYY-MM-DD`, today when omitted; a past day applies
now (nothing is backdated). **A future day is INVALID — "future rates are
not supported".** The alternative the brief allowed — storing the plan on
the row and applying it from a daily sweep on the publisher-timer job —
was not built: it needs a JSON-path read over committed rows, a daily
lock on a job that ticks by the minute, revoke and resume semantics for a
COMMITTED import whose rows are still pending, and its own tests; more
than this lot should carry. The row keeps `effectiveFrom` in its data, so a
sweep can be added without changing the file format.

Commit sets each rate through `listings.updateListing({ ratePerDay,
slotsTotal? })` — the door a typed rate goes through: the listings
repository stamps `ratePerDaySetAt`, the surge state is recorded, the loop
is re-checked — and audits `LISTING_REPRICED_BY_IMPORT { from, to,
importId, rowNumber }` with the diff per listing. A manual edit on the
console writes no `LISTING_REPRICED_BY_FACTOR` row (that log is the
pricing engine's) and opens no price case, and neither does this: the
below-floor rate is warned about, and the publish gate — or the
publisher's own `POST /rate-cards/approvals` — is where a case opens. A
listing already at the rate since validation is SKIPPED. Audited
`RATE_CARD_IMPORT_COMMITTED`.

## Import formats — Lot U

`GET /party-imports/formats` (ADMIN) answers one JSON per import kind on
the platform — `publishers, advertisers, agents, print-partners, employees,
listings, rate-card, leads, market-data, finance-reconciliation` —
`{ kind, title, purpose, route, columns: [{ name, required, type, description,
example, enumValues?, maxLength? }], rules: [sentences], sampleRows: [2],
templateCsvUrl }`; `GET /formats/:kind` one of them (404 otherwise);
`GET /formats/:kind/template.csv` the header row and the two sample rows.
`type` is one of `text | mobile | email | enum | number | money | date |
url | list`.

The guide is a column table kept beside each validator (`import-formats.ts`):
this module's six row schemas, and — through their modules' indexes — the
publisher book's `publisherImportRowSchema`, the leads importer's
`createLeadSchema` (minus `source`, which is the batch's), the market-data
importer's `marketDataImportRowSchema`, and the reconciliation reader's
`DEFAULT_COLUMNS` (the bank profile can rename them).
`__tests__/import-formats.test.ts` is the contract: for every kind, the
guide's column names and the validator's keys are the same set, every
sample row passes the validator (the reconciliation samples through
`parseStatement`), and the template is the header plus those rows — so the
guide cannot drift from what the validator accepts.

## Files

- `party-imports.schema.ts` — the party keys, the four row schemas, the
  body and list-query schemas; Lot U: `LISTING_KINDS`, the listing and
  rate-card row schemas, `publisherQuerySchema`.
- `party-adapters.ts` — one adapter per party: columns, mergeable columns,
  the match read, `create` and `merge` through the party's own exports.
- `party-imports.service.ts` — validate / commit for the parties; list /
  get / revoke / report for every key.
- `listing-imports.service.ts` — Lot U: validate / commit for the
  publisher's two kinds.
- `import-formats.ts` — Lot U: the format guide and the templates.
- `prisma-party-imports.repository.ts` — the import rows, and the match
  reads over the parties' tables (reads only); Lot U: the publisher's
  listings, the external references, the 25 m read, the vocabulary, the
  running-booking read.
- `features.ts` — `console.party-imports` (CONSOLE); Lot U:
  `console.listing-imports` (CONSOLE, APP_AGENT), `console.import-formats`.

## Exports it relies on

Lot S: `advertisers.updateProfile`, `advertiserTypeSchema`,
`ADVERTISER_INDUSTRIES`; `agents.updateAgent`; `print-partners.createPartner`,
`updatePartner`; `employees.updateEmployee`; `users.createUser`.

Lot U: `listings.createListing`, `updateListing`,
`assertCanCreateForPublisher`, `LISTING_CATEGORIES`, `slotHoldingOrdersWhere`;
`supply.createAttempt`, `attachListingToAttempt` (new — files an existing
listing under an attempt at AWAITING_AGREEMENT, refusing another
publisher's, an accepted attempt, or a listing already under one);
`rate-cards.floorFor` (new — the floor for a kind of spot before a listing
exists); `shared/maps.geocodeAddress`; `pricing.resolveCity`;
`publishers.publisherImportRowSchema`, `PUBLISHER_IMPORT_COLUMNS`,
`PUBLISHER_TYPES`; `leads.createLeadSchema`, `LEAD_SIDES`;
`pricing.marketDataImportRowSchema`; `reconciliation.DEFAULT_COLUMNS`,
`parseStatement`.

# agreements

The text each party accepts, versioned, and the record of who accepted which
version and when. This is the module behind DR 10's Agreements screen and the
reason both personas can get past their agreement gate at all: with no live
version of the platform terms, `acceptPlatformAgreement` on either side answers
`NO_ACTIVE_TEMPLATE` and the party sits at activation forever.

## The click: whose route, whose row (Lot D, Q123)

| | `agreements` (here) | `supply` | `advertisers` | `packages` | `orders` |
| --- | --- | --- | --- | --- | --- |
| Writes the text | yes | — | — | — | — |
| Records a publisher's platform / listing click | — | `POST /supply/agreements/accept-platform`, `accept-listing` | — | — | — |
| Records an advertiser's platform click | — | — | `POST /advertisers/:id/agreements/platform` | — | — |
| Records the insertion order | **yes** — `acceptInsertionOrder`, rendered here | — | the route: `POST /advertisers/:id/agreements/insertion-order { campaignId }` | — | — |
| Records the package terms | **yes** — `recordAcceptance` | — | — | the route: `POST /packages/sales/:id/accept-terms` | — |
| Records the agent's job terms | **yes** — `recordAcceptance` | — | — | — | inside `agentAcceptOrder`, on the agent's own tap |
| Reads the record | yes | its own funnel counts | its own gate | its payment gate | — |

The platform clicks stay where activation happens. The **transaction** kinds
are recorded here, through `recordAcceptance`, by the module that owns the
transaction: one row per anchor (campaign, sale, order, attempt) per template
version, idempotent on the version, with the click's IP and user agent and
the document exactly as rendered. Nothing is e-signed (`signatureProvider`
stays NONE); the columns are the seam for Digio later.

The legacy `GET/POST /supply/agreements/templates` and
`/advertisers/agreements/templates` pairs are **retired** (Lot D): they
published-and-activated in one step without stamping `activatedAt`, and the
console has only ever used `/agreements/templates`.

## Kinds

| Kind | Party | Scope | Anchor | Gates |
| --- | --- | --- | --- | --- |
| `PLATFORM` | publisher | platform terms | — | activation (gate 3 of the supply funnel); the listing agreement |
| `LISTING` | publisher | per attempt | `attemptId` | publishing the listings in that attempt |
| `ADVERTISER_PLATFORM` | advertiser | platform terms | — | activation (gate 4 of the demand funnel); `assertCanBook` |
| `INSERTION_ORDER` | advertiser | per campaign | `campaignId` | `checkout.authorizeCampaign` — 403 `AGREEMENT_REQUIRED` until accepted on the live version |
| `PACKAGE_SALE` | advertiser | per sale | `packageSaleId` | `/packages/sales/:id/pay` and `record-payment` — same code |
| `JOB_TERMS` | agent | per order | `orderId` | the agent's tap on Accept records it in the same call; no live version refuses the tap with `NO_ACTIVE_TEMPLATE` |
| `AGENT_PUBLISHER_PLATFORM` / `AGENT_ADVERTISER_PLATFORM` | agent | platform terms | — | AG-1: the applicant's click at the terms step; DS-1: e-signed at activation, gates working |
| `EMPLOYEE_APPOINTMENT` | employee | platform terms | — | DS-2: e-signed only, from a hosted link; gates the console invitation |
| `PRINT_PARTNER_SERVICE` | print-partner | platform terms | — | DS-2: e-signed only, once KYC verifies; gates quotes and jobs |
| `PUBLISHER_LICENCE` | publisher | platform terms | — | DS-3: e-signed only, at the first approved listing; gates the next attempt's listing agreement |

`KIND_META`, `PLATFORM_KIND_FOR` and `ANCHOR_FOR` are exported for anything
that needs the mapping rather than restating it. An agent has no platform
terms: their party view carries `platform: null`. The three DS kinds bind
parties with no acceptance row (`KIND_META[kind].party` is `employee` or
`print-partner`) or are signed-only: `recordAcceptance` refuses them 400;
their SigningRequest is the record.

## DS-1 → DS-4 (Digio eSign, 22 Sep 2026): e-signatures beside the click

The owner's five documents — the agent's engagement terms, the employee's
appointment letter and NDA, the advertiser's insertion order, the
publisher's licence to display, the print partner's service agreement —
are e-signed through Digio (Aadhaar OTP by default, DSC for company
signatories, a drawn "electronic" signature as the third option) when the
platform-settings policy says so. `shared/esign/policy.ts` holds the policy
shape and the table of when each is sent and what it gates; off (the
default) every gate keeps its click and nothing is sent.

**One request** (`SigningRequest`, `esign/`): the live template of a kind,
merge fields filled from the party's record (`{{party.name}}`,
`{{party.displayId}}`, `{{agent.grade}}`, `{{employee.designation}}`,
`{{party.gstin}}`, `{{date}}`, `{{reference}}` … — the placeholder draft of
each kind lists its own), the insertion order's `{{spots}}` and the
licence's `{{listings}}` schedule rendered as before, the whole rendered to
a PDF (`esign.render.ts`, pdfkit, a signature page at the end) and kept
under the private upload purpose `SIGNED_AGREEMENT`; the provider asked for
the signer sequence — the party first, ADX's countersign last when
`countersign` is on (DS-4, the Document Signer Certificate on the Digio
account) — with the e-stamp the settings table names for the document and
the party's state (DS-4); the party's gateway page recorded and sent by
email, SMS and push (`AGREEMENT_SIGNATURE_REQUESTED`, deep link
`adx://sign/<id>`), beside Digio's own link when `notifyThroughDigio`.

**The provider's word** arrives on `POST /webhooks/digio/esign` (HMAC over
the raw body with `DIGIO_WEBHOOK_SECRET`, routed by Digio's document id) or
on a refresh (`POST /agreements/signing/:id/refresh` — the phone polls it
every five seconds while the request is open; the desk presses it). On
completion the signed PDF (and the audit certificate, when Digio serves
one) are stored, the acceptance row is written for the three parties that
have one (`signatureProvider` DIGIO, `signatureRef` the request; a click on
the same version is upgraded rather than duplicated), the owning module's
completion hook runs (`onSigningCompleted(kind, hook)` — employees send the
deferred console invitation), and the signer is told (`AGREEMENT_SIGNED`).
Expired, voided and declined requests close the same way; the hourly
`esign-expiry` sweep closes what the provider did not.

**The gates** ask `signingStanding(partyType, partyId, kind, anchor?,
context?)`: `required` (the policy, and for an insertion order the
campaign's media value against `insertionOrder.valueThreshold` or the
advertiser's band in `insertionOrder.bands`) and `satisfied` (a COMPLETED
request on the live version, or on any version unless
`resignOnNewVersion`). `assertSigned` is 403 `SIGNATURE_REQUIRED` with the
open request in `details.signing`, which the apps open straight into the
signing screen. Where each gate sits:

| Document | Opened by | Gate |
| --- | --- | --- |
| Agent engagement terms | `agents.decideApplication` ACTIVATE (`requestEngagementSignature`, never fails the activation) | `agents.requireWorkingAgent` 403; `agentAcceptsWork` false (dispatch skips); the dashboard's `application.mayWork` false + `signing` slice |
| Employee appointment | `POST /employees` (`requestAppointmentSignature`; the console invitation rides the request as `followUp`) | the invitation waits for the completion hook |
| Print partner service agreement | the partner's KYC turning VERIFIED — the desk's review or Digio's webhook (`requestServiceAgreement`) | `submitQuote` and `acceptJob` 403; `GET /print-partners/me` → `agreement` |
| Publisher licence | the first approved listing (`listings.publishListing`) or the first submission (`supply.acceptListingAgreement`), by `publisherLicenceAt` | the next attempt's `acceptListingAgreement` 403 once asked for and unsigned; `GET /publishers/me` → `licence` |
| Insertion order | `POST /advertisers/:id/agreements/insertion-order` answers `{ accepted: false, signing }` instead of the click when required (`openInsertionOrderSigning`) | `checkout.authorizeCampaign` 403; the review's `signing` slice and a `SIGNATURE_REQUIRED` line under `missing` |

**Routes** (`/agreements/signing`, `esign.routes.ts`): `GET /mine` (every
request on the caller's parties), `GET /:id`, `POST /:id/refresh`, `POST
/:id/mock-sign` (development only, on a mocked request) for any signed-in
person who belongs to the request's party; `GET /` (filters `kind`,
`status`, `partyType`, `partyId`, `campaignId`, `q`; cursor pages), `POST /`
(the desk's "send for signature", forced past the policy), `POST
/:id/remind`, `POST /:id/void { reason }` under ADMIN. The console's
Agreements › Signatures desk and Settings › E-signing (the policy) and
Settings › Integrations › Digio eSign (the wire) sit on these.

**The wire** (`shared/integrations/digio-esign.ts`) is what the sandbox
answered on 22 Sep 2026: multipart `POST /v2/client/document/upload`
(`file` + `request`), `GET /v2/client/document/{id}`, `POST
/v2/client/document/{id}/cancel`, `GET /v2/client/document/download?
document_id=`; no reminder or certificate route answered on this account
(reminders are best-effort, the certificate download tolerates a 404). The
gateway page is `<gateway>/#/gateway/login/<doc>/<nonce>/<identifier>?
token_id=<access token>`. Hosts: `DIGIO_ESIGN_API_URL` (sandbox
`https://ext.digio.in:444`, production `https://api.digio.in`) and
`DIGIO_ESIGN_GATEWAY_URL` (`https://ext-gateway.digio.in` /
`https://app.digio.in`), overridable on the integrations row's `esign`
section beside keys of its own (else the KYC section's Digio account
signs). Without credentials the rail is mocked in development (the request
carries `mock: true` and the mock-sign door closes it) and refused 503
`ESIGN_UNAVAILABLE` in production. The e-stamp fields on the upload and
the certificate path are the two places to check against Digio's docs when
the account has eStamp enabled.

**Ports** (`esign.ports.ts`, filled in `bootstrap/register-modules`): the
policy (`app-config` reaches `users`, which reaches this module), the
messages (`notifications` reaches `app-config`), and the completion hooks
(registered by `employees`). Unregistered, the policy is off and nothing is
sent.

## Re-acceptance (Lot D, Q55)

A platform-scope version may be activated with `requiresReacceptance`. Until
then any acceptance of the kind clears the gate; with it, only the live
version or later does. The rule is `isCurrentAcceptance(acceptance,
template)` — pure, exported, and applied by `advertisers.bookingEligibility`
/ `acceptInsertionOrder` and by `supply.acceptListingAgreement`, never
restated. A party's next platform click writes a new row for the new version
(the older row stays; it was agreed). `GET /agreements/stale?kind=` lists who
is behind the live version and says whether that is `enforced`. Transaction
kinds never need it: each transaction is bound by the version live at that
moment, which is what `transactionAcceptance(...).current` reports.

## The insertion order (Lot D, Q123)

`renderInsertionOrder(body, snapshot)` fills `{{spots}}` (or appends a
"Sites covered by this insertion order" section) with the campaign's
reference, advertiser, flight and every non-cancelled spot at its rate, days,
quantity and line total. `acceptInsertionOrder(campaignId, advertiserId,
ctx)` reads the campaign narrowly here (this module sits under `campaigns`),
refuses 403 when the campaign is not that advertiser's, and records the row.
The text a client sends is never recorded.

## Owned routes

All under `/api/v1/agreements`.

| Method | Path | Guard | Notes |
| --- | --- | --- | --- |
| GET | `/current/:kind` | `authenticate` | the live text of any of the six kinds; 404 `NO_ACTIVE_TEMPLATE` when nothing is published |
| GET | `/templates?kind=` | ADMIN | every version, with acceptance counts and `state` |
| POST | `/templates` | ADMIN | a new version, numbered after the highest; a draft unless `activate: true`; `requiresReacceptance` on the platform kinds (**201**) |
| GET | `/templates/:id` | ADMIN | |
| PATCH | `/templates/:id` | ADMIN | drafts only; 409 otherwise |
| DELETE | `/templates/:id` | ADMIN | drafts only; **204** |
| POST | `/templates/:id/activate` `{ requiresReacceptance? }` | ADMIN | makes it live, retires the previous; idempotent. E7-3: the optional body sets the re-acceptance switch in the same transaction as the activation — platform kinds only, 400 otherwise; on an already-live version only the switch moves |
| GET | `/acceptances?publisherId=&advertiserId=&agentId=&templateId=&kind=&campaignId=&orderId=&packageSaleId=&attemptId=` | ADMIN | paged, newest first; E7-3: the four transaction anchors filter too, and `agentId` now applies to the list as it always did to the count |
| GET | `/stale?kind=PLATFORM\|ADVERTISER_PLATFORM` | ADMIN | parties whose highest accepted version is below the live one; `enforced` says whether the live version blocks them |
| GET | `/parties?q=` | ADMIN | publishers and advertisers by displayId, name or mobile |
| GET | `/parties/:partyType/:partyId` | ADMIN | what one party accepted (`publisher`, `advertiser`, `agent`), and where they stand on the platform terms |

## Owned Prisma entities

- `AgreementTemplate` — one version of one kind. `isActive`, `activatedAt`,
  `retiredAt`, `createdByUserId`, `changeNote` are this module's; the body is
  Markdown and a `LISTING` body may hold `{{listings}}` for supply to fill.
- `AgreementAcceptance` — the platform kinds written by supply and
  advertisers; the transaction kinds written here through `recordAcceptance`.
  Exactly one of `publisherId` / `advertiserId` / `agentId`; the anchor
  column the kind names; the migration's partial indexes make each (party or
  anchor, template) pair unique.

`Publisher`, `Advertiser` and `AgentProfile` are read for the party lookup and
never written; `Campaign` and its spots are read for the insertion order.

## Invariants

- **A version is one of three things.** `ACTIVE` (`isActive`), `SUPERSEDED`
  (was live: `activatedAt`, `retiredAt`, or any acceptance on it), else
  `DRAFT`. Only a draft may be edited or discarded. A version that has been
  live is what people accepted, and an acceptance points at the row rather than
  a copy of it, so its text is frozen.
- **Version numbers only go up.** The next version is the highest that exists
  plus one, drafts and retired versions included, so a number never means two
  different texts. A concurrent create loses with a 409, not a 500.
- **Never two live, never none by accident.** Activation retires the previous
  live version and promotes the new one in a single transaction. Activating a
  retired version is the rollback: it goes live again, restamped, and the one
  it replaces is retired.
- **Activation does not touch acceptances.** Nobody's row is rewritten when
  a new version goes live. Whether they must click again is the live
  version's `requiresReacceptance` (Lot D, Q55), read through
  `isCurrentAcceptance`; without it the gates accept *any* acceptance of the
  kind, and the party view and the stale report show `outdated` for ops.
- **A transaction accepts the version live at that moment.** One row per
  anchor per version; a retry returns the row; a version change since the
  click makes `transactionAcceptance(...).current` false and the gate asks
  again. The rendered document is what was shown, never what was sent.
- **`effectiveFrom` is when it went live**, not when somebody started drafting
  it. Activation moves it.

## Dependencies

`shared/*` and — DS-1 — `uploads` (which imports no module) only, which is
what lets `advertisers`, `supply`, `campaigns`, `packages`, `orders`,
`agents`, `employees`, `print-partners`, `listings` and `publishers` all
import it. The console reads the rest over HTTP, and the apps read
`/current/:kind` for the agreement-text screens and `/signing/*` for the
signing screen.

Exports that leave the module:

- `countAcceptancesFor({ publisherId, advertiserId })` — `account-lifecycle`,
  Lot A's closure review (Q21). Reported, never blocking: an acceptance is
  never withdrawn, because the text *was* agreed.
- `recordAcceptance`, `transactionAcceptance`, `platformStanding`,
  `isCurrentAcceptance`, `currentTemplate`, `acceptInsertionOrder`,
  `renderInsertionOrder`, `staleParties`, `ANCHOR_FOR` — Lot D (Q123/Q55), for
  the modules named in the table at the top.
- DS-1: `openSigningRequest`, `signingStanding`, `assertSigned`,
  `signingRequired`, `signingSlice`, `onSigningCompleted`,
  `expireSigningRequests`, `handleEsignWebhook` / `esignWebhookHandler`,
  the three `register…Port`s; DS-3: `requestPublisherLicence`,
  `assertPublisherLicenceSigned`, `publisherLicenceFor`,
  `insertionOrderSigning`, `openInsertionOrderSigning`.

## E6: the placeholder drafts

A fresh database has no template of any kind, so every gate answers 503
`NO_ACTIVE_TEMPLATE` and nothing tells ops where to type. `ensureAgreementDrafts()`
— called at boot beside `ensureSystemRoles` — seeds version 1 of each of
PLATFORM, ADVERTISER_PLATFORM, INSERTION_ORDER, PACKAGE_SALE and JOB_TERMS as a
DRAFT whose body opens with `[PLACEHOLDER - ADX legal text to be supplied
before publishing]` and names the variable the kind renders (`{{spots}}`,
`{{sale}}`). A DRAFT satisfies no gate, so behaviour is unchanged until ops
edit and publish it at `/agreements/templates`; a kind with any row — draft,
live or superseded — is never touched. LISTING is not seeded: the supply desk
publishes it with its own enumeration.

# supply

How a publisher and their inventory get from "signed up" to "rentable and
earning", and what happens when a listing stops being verifiable.

The specification is [docs/publisher-supply-lifecycle.md](../../../docs/publisher-supply-lifecycle.md).
Read it before changing anything here — the states and thresholds in this module
are policy, not implementation detail.

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/api/v1/supply/funnel` | ADMIN |
| GET | `/api/v1/supply/funnel/publishers` | ADMIN |
| POST | `/api/v1/supply/agreements/accept-platform` | PUBLISHER \| ADMIN (**201**) |
| POST | `/api/v1/supply/agreements/accept-listing` | PUBLISHER \| ADMIN (**201**) |
| GET | `/api/v1/supply/attempts` | ADMIN |
| POST | `/api/v1/supply/attempts` | ADMIN \| AGENT_PUBLISHER (**201**) |
| GET | `/api/v1/supply/attempts/:attemptId` | ADMIN \| PUBLISHER \| AGENT_PUBLISHER |
| POST | `/api/v1/supply/attempts/:attemptId/listings` | ADMIN \| AGENT_PUBLISHER (**201**) |
| POST | `/api/v1/supply/attempts/:attemptId/request-acceptance` | ADMIN \| AGENT_PUBLISHER |
| GET | `/api/v1/supply/listings/:listingId/documents` | ADMIN \| PUBLISHER \| AGENT_PUBLISHER |
| POST | `/api/v1/supply/listings/:listingId/documents` | PUBLISHER \| AGENT_PUBLISHER \| ADMIN (**201**) |
| PATCH | `/api/v1/supply/documents/:documentId/review` | ADMIN |
| GET | `/api/v1/supply/listings/:listingId/verifications` | ADMIN \| PUBLISHER \| AGENT_PUBLISHER |
| POST | `/api/v1/supply/listings/:listingId/verifications` | PUBLISHER \| AGENT_PUBLISHER \| ADMIN (**201**) |
| PATCH | `/api/v1/supply/verifications/:verificationId/review` | ADMIN |
| GET | `/api/v1/supply/verification-queue` | ADMIN |
| POST | `/api/v1/supply/listings/:listingId/reverification/remind` | ADMIN (`supply.edit`) |
| POST | `/api/v1/supply/listings/:listingId/reverification/site-check` | ADMIN (`supply.edit`, **201**) |
| POST | `/api/v1/supply/listings/:listingId/reverification/extend` | ADMIN (`supply.approve`) |
| POST | `/api/v1/supply/enforcement/sweep` | ADMIN |
| GET | `/api/v1/supply/claims` | ADMIN |
| POST | `/api/v1/supply/claims` | PUBLISHER \| AGENT_PUBLISHER \| ADMIN (**201**) |
| PATCH | `/api/v1/supply/claims/:claimId/decide` | ADMIN |
| GET | `/api/v1/supply/compliance/cases` | ADMIN |
| POST | `/api/v1/supply/compliance/cases/:caseId/attempts` | ADMIN (**201**) |
| PATCH | `/api/v1/supply/compliance/cases/:caseId/resolve` | ADMIN |

## Owned Prisma entities

`AgreementTemplate`, `AgreementAcceptance`, `ListingAttempt`, `ListingDocument`,
`ListingVerification`, `ListingVerificationPhoto`, `ListingClaim`,
`ComplianceCase`, `ComplianceContactAttempt`, `EarningsHold`.

It also drives `Listing.status`, `Listing.verifiedAt`,
`Listing.verificationExpiresAt` and `Listing.documentsClearedAt`, but the
`Listing` row itself is owned by `listings`.

## Invariants

**Acceptance is attempt-level, publication is per-listing.** One listing
agreement covers a whole batch, and a publisher can accept it with documents in
for a fraction of it. Nothing in here may gate acceptance on document
completeness — the agreement's own conditional publication clause is what makes
that safe.

**An existing listing may join an attempt (Lot U).** `attachListingToAttempt`
files a listing `listings` already created under an attempt at
AWAITING_AGREEMENT — the listing importer's door, so a whole file sits
under one agreement — and refuses (409) an accepted attempt, another
publisher's listing, or a listing already under an attempt. Nothing is
created; the row stays `listings`' own.

**Documents are checked before an agent travels.** `reviewDocument` is the only
thing that moves a listing to `AWAITING_SITE_VERIFICATION`, so a failed paper
check never wastes a site visit. A later rejection sends the listing back.

**A rejection always carries a reason.** Both `reviewDocument` and
`reviewVerification` refuse to reject without one — the publisher has to know
what to fix, and "Image unreadable" is the difference between a retry and a
support ticket.

**Publication on a first verification is a switch, not a rule (Lot A, Q31).**
Lot V: the city's `publishing` switch sits over both halves below — a cleared
visit in a city whose rollout stage does not publish (SEEDING, PAUSED,
WITHDRAWN) holds the listing exactly as auto-publish-off does, and a
re-verification leaves a SUSPENDED listing suspended and tells the desk; a
town the catalogue lacks publishes as ever (`pricing.citySupport`).

With `listings.autoPublishOnVerification` on — the default — an accepted first
site visit takes the listing from `AWAITING_SITE_VERIFICATION` to `ACTIVE` as
it always has. Off, the listing stays exactly where it was (no new status is
invented for the waiting room: one nobody else knows about is a listing that
falls out of every count) and every admin is notified "Verified — waiting for
a human look"; the desk finishes the job with `POST /listings/:id/publish`,
which accepts a verified listing from that state. A re-verification lifting a
`SUSPENDED` listing is **not** behind the switch: that listing was published
once already. A failure to notify never undoes the accepted verification.

**The clock restarts from acceptance, not from expiry.** `reviewVerification`
sets `verificationExpiresAt` to now plus the listing's cadence. A publisher who
re-verifies late does not inherit a shortened window.

**The hold converts 24 hours after expiry, not after the sweep.**
`runEnforcementSweep` computes `convertsAt` from the listing's own
`verificationExpiresAt`, so a sweep that runs late does not extend the grace
period.

**The sweep is idempotent.** Every step guards itself —
`findOpenCaseForListing` before opening a case, status checks before
suspending — so running it twice in a window changes nothing the first run did
not already do. That matters because it is exposed as a route as well as being
intended for a scheduler.

**A tolerance miss is not a rejection.** `submitVerification` records the
capture and returns `withinTolerance` for the caller to act on. Deciding is
`reviewVerification`'s job. Hoardings sit exactly where GPS degrades, so an
honest publisher failing the radius check must be able to retry.

**One visit is one verification, however many photos it carried.**
`submitVerification` takes either the original `photoUrl` — a publisher's own
re-verification still sends that — or `photos: [{ url, label }]`, which is what
the agent app's guided sequence submits after walking a milestone template's
named proofs one at a time. They become a single `ListingVerification` with
`ListingVerificationPhoto` rows, because four calls would have been four things
for a reviewer to accept with nothing tying them to the same trip. The first
shot is mirrored onto `photoUrl`, so the admin queue and the review screen read
what they always read.

## Not implemented here

`EarningsHold` records the obligation and nothing else. Pausing accrual,
forfeiting to a goodwill credit and recovering installation cost all need a
ledger, which the money workstream owns. When it lands, the hold is the hook.

## Dependencies

- `shared/database` for the Prisma client and model types.
- `shared/auth` for `authenticate` and `requireRole`.
- `app-config` for the platform settings row (the auto-publish switch), and
  `notifications` + `users` to tell the desk when that switch is off.
- `agents` (`dispatchAskFor`, `findAssignableAgentInCity`) and `visits`
  (`createVisit`, `getVisit`) for the queue's "Send an agent", and
  `shared/audit` for the queue actions' trail and the reminder's clock.
- `listings`, `orders` and `publishers` are untouched — supply moves a listing
  through its status but never creates one outside an attempt.

## QR-24 (20 Sep 2026): the right to sell a space, and its term

A hoarding, a digital billboard, a bus shelter — many spots are held on a
lease, a licence or a permit a civic body renews every year, and a publisher
who stopped holding it must stop selling it. The listing now carries how it
is held and until when:

- `Listing.rightsBasis` (`OWNED | LEASED | LICENSED | PERMIT`, default
  OWNED), `rightsValidUntil` (the last instant, in India, of the day the term ends),
  `rightsLapsedAt` (stamped by the sweep, or at once when a past date is
  set), `rightsRemindedAt` (the last reminder day, so each window is sent
  once). Migration `20260920090000_qr24_listing_rights_term`.
- `POST /listings` takes `rightsBasis` and `rightsValidUntil` (YYYY-MM-DD);
  the wizard's documents step asks both (`seed:config` re-seeded the flow
  to v2).
- `PATCH /supply/listings/:listingId/rights { basis, validUntil }` —
  PUBLISHER (their own spot), AGENT_PUBLISHER, ADMIN. OWNED clears the
  term and any lapse; a term already past lapses the spot at once and takes
  it off the shelf (`availableNow: false`).
- `POST /supply/listings/:listingId/documents` takes `expiresAt`
  (YYYY-MM-DD); the app's renew screen files the renewed permit or
  agreement with it. `PATCH /supply/documents/:id/review` approving a
  DISPLAY_AGREEMENT / MUNICIPAL_PERMIT / OWNER_NOC whose `expiresAt` is
  later than the term on file **extends the term, lifts the lapse and puts
  the spot back on the shelf** — the desk's approval is the renewal.
- `GET /supply/rights-queue?horizonDays=60` (ADMIN): every term ending
  within the horizon and every lapse, soonest first, with `state`
  (`OWNED | CURRENT | ENDING | LAPSED`) and `daysLeft`. The console's
  Listings › Renewals tab.
- `POST /supply/rights/sweep` (ADMIN) runs `runRightsSweep(now)` on demand;
  `jobs/rights-renewal.job.ts` runs it every six hours under a Redis lock:
  reminders at 30 and 7 days (the tightest window the day falls in, once
  per window, to the publisher's account), the lapse on the day (to the
  publisher and every admin). Running campaigns are not touched — the lapse
  is the publisher's to fix; the browse (`findActive`,
  `findActiveForCategories`) leaves a lapsed spot off the shelf.

Invariants: the reminder for a window is sent once (`rightsRemindedAt` at
or after the window opened means sent); a lapse is stamped once; a renewal
never shortens a term (an approved paper with an earlier date changes
nothing); OWNED never lapses. Tests: `__tests__/qr24-rights.test.ts`.

3 Oct 2026 — the renewals desk's row menu and bulk bar:
`POST /supply/listings/:listingId/rights/remind` (ADMIN, `supply.edit`) is
"Remind publisher to renew": the sweep's in-app notice (ending, or run out)
to the publisher's login, `rightsRemindedAt` stamped so the sweep counts it
for its window, audited as `LISTING_RIGHTS_REMINDED`, which is also its
clock — once per 24 hours per listing (429 inside it). Refused (409) for an
owned spot or one with no end date, and with no publisher, login or working
account. `rightsDue` rows carry the listing's `displayId` for the table.
Tests: `__tests__/rights-desk-remind.test.ts`.
## ST-2 (28 Sep 2026) — a listing's papers are private

The owner said "Sure, go ahead, build it" to venue papers and audience
reports no longer being public files. `submitDocument` (the only writer of
`ListingDocument.url`) hands the URL to `uploads.adoptListingDocument` with
the filer and the host (the controller passes both): a PUBLIC file in the
upload register that the filer uploaded (or the desk is filing) is moved to
the private `LISTING_DOCUMENT` purpose and the document stored with its
`/files/:id` URL; an outside link, or a file that could not be moved, is
stored as given — a paper is never refused over its file.

`listingsNamingFile({ fileId, objectName })` (exported) is the read the
private-file door asks through bootstrap: the listings whose documents name
the file — by `/files/<id>`, or by the object's own name for a URL recorded
while it was public (names under twelve characters are not matched) — each
with its publisher's login. Tests: `__tests__/st2-listing-documents.test.ts`.

## The verification queue's actions (3 Oct 2026)

The owner, of Listings › Verification: "If verifications lapsed, what action
can we take here?" Three routes, none of which marks a listing verified —
only an accepted check (`reviewVerification`) restarts the clock:

- `POST /supply/listings/:listingId/reverification/remind` (`supply.edit`) —
  `notify('LISTING_REVERIFICATION_DUE', publisherUserId, { listing, due, detail }, { inApp })`:
  the in-app row names the listing (relatedType LISTING, so a tap opens the
  listing and its "Is the spot still standing?" card) and the seeded
  `listing-reverification-reminder` template sends the push; no SMS (no DLT
  kind). Once per 24 hours per listing — the audit trail is the clock (the
  last `LISTING_REVERIFICATION_REMINDED` against the listing, as
  `remind-payment` does it): 429 with `nextAllowedAt` inside it; 409 for a
  listing off the clock, with no publisher, no login, or an account that is
  not working.
- `POST /supply/listings/:listingId/reverification/site-check { agentId?, note? }`
  (`supply.edit`, 201) — a re-verification has no order, so the
  order-milestone lane cannot carry it; this books a `visits` FieldVisit
  through `createVisit` as the dispatch board does: kind AUDIT, to the
  listing's publisher, at the spot's pin, tagged `Re-verification`, offered
  with the 25-minute window and the VISIT_OFFER notice. Without `agentId` the
  agent is `agents.findAssignableAgentInCity` — the dispatch sweep's ranking
  over the listing's city's working publisher-side agents. The visit id is on
  the `LISTING_SITE_CHECK_DISPATCHED` audit row, and a second dispatch is
  refused (409) while that visit is still open. **Gap:** the agent app files
  a listing verification only from an order milestone, so the visit's own
  proof photo does not become a `ListingVerification`; the check still
  arrives as the publisher's re-verification or a desk-filed one.
- `POST /supply/listings/:listingId/reverification/extend { days: 1–30, reason }`
  (`supply.approve`) — `verificationExpiresAt` moves `days` past the later of
  now and the date on file (`verifiedAt` stays the last real check), the
  lapse's earnings holds are released, its open compliance case is resolved,
  the publisher is told the new date, and `LISTING_REVERIFICATION_EXTENDED`
  records the reason with the before and after. 409 for a listing never
  verified, not live, or suspended — a desk suspension: "Reinstate it first";
  a suspension for the lapse itself: an accepted check is the way back.

Beside them: `PATCH /supply/compliance/cases/:caseId/resolve` takes an
optional `{ outcome, note }` onto a `COMPLIANCE_CASE_RESOLVED` audit row; a
contact attempt's channel may be `VISIT` (migration
`20261003090000_compliance_contact_visit`); `GET /supply/compliance/cases`
rows carry `listingTitle`, `listingDisplayId`, `publisherName`,
`attemptCount` and `lastAttemptAt`; the verification queue rows carry
`displayId`, `city`, `cityId` and `suspensionScopes`.
Tests: `__tests__/verification-queue-actions.test.ts`.

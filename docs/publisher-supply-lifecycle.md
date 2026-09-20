# Publisher supply lifecycle

How a publisher and their inventory get from "signed up" to "rentable and
earning", and what happens when a listing stops being verifiable.

This is the specification the `supply` module implements. Everything here was
settled in the DR 10 walkthrough; anything still open is listed at the bottom
and is **not** implemented.

## The five gates

Supply acquisition is a funnel with a drop-off at every gate. Ops needs to know
which side of each gate a publisher is stuck on, because two of the waits are
theirs and three are ours.

| # | Gate | Waiting on | Cleared when |
| --- | --- | --- | --- |
| 1 | Account created | publisher | user + `Publisher` record exists |
| 2 | KYC verified | ADX / Digio | `PublisherKyc.status = VERIFIED` |
| 3 | Platform agreement accepted | publisher | `AgreementAcceptance` of kind `PLATFORM` |
| 4 | Inventory listed | either | a `ListingAttempt` exists with ≥1 listing |
| 5 | Listing agreement accepted | publisher | `AgreementAcceptance` of kind `LISTING` on that attempt |

A publisher is **activated** once gates 1–3 are cleared. Individual listings then
clear their own document and verification gates independently.

**QR-5 (17 Sep 2026): gate 2 no longer holds a listing back.** The owner's
rule: a publisher uses the account unverified and lists once the basics are
in — name, email, address, date of birth (`shared/kyc-state`'s
`profileBasicsMissing`). `publishListing` refuses only on a missing basic
(409 `PROFILE_INCOMPLETE`); a spot of a PENDING / NEEDS_INFO / REJECTED
publisher goes live, marked unverified, and ranks below the verified when an
advertiser browses (`listings.findActive` partitions verified-first; every
card carries `publisherVerified`). Gate 2 still counts in the funnel and
still earns the tick; it just moves a publisher up the list rather than
gating them.

**QR-6 (17 Sep 2026): where the two agreements are asked.** The terms of use
and privacy policy are consented to on the first screen after the OTP, before
any detail is asked (`User.consentAcceptedAt` + the document versions, via
`POST /users/me/consent`) — not a funnel gate. Gate 3 (the platform, i.e.
commercial, agreement) is presented when the publisher submits a listing:
`POST /listings/:id/submit` refuses 409 `AGREEMENT_REQUIRED` until
`activatedAt` is stamped, and the app shows the agreement right there. It no
longer appears on the home's readiness checklist.

## Agreements

Two agreements, and they are not the same kind of object.

**Platform agreement** — one per publisher account, accepted by button click
once KYC clears. Static terms, one active version at a time. Blocks everything
downstream.

**Listing agreement** — one per *listing attempt*, not per publisher and not per
listing. Where an attempt covers several spots the document enumerates all of
them, and it carries a conditional publication clause: ADX publishes only those
spots whose documents have been submitted and verified. So the publisher can
accept with documents in for ten of two hundred, and each listing then clears at
its own pace.

Both are click-accept, so what is recorded is an acceptance, not a signature:
who accepted, which template version, when, from which address and user agent,
plus the rendered document for the listing agreement. The rendered copy matters
because listings change — a rate revised after acceptance leaves the agreement
on file describing the old spot.

> Not to be confused with the **display agreement** the publisher uploads as a
> listing document. That is third-party evidence of their right to the space.
> These two are the contract with ADX.

## Listing attempts

Every listing belongs to exactly one attempt. An attempt is how a listing
agreement finds its listings, and it records where the inventory came from.

| Origin | Who creates it | Typical size |
| --- | --- | --- |
| `SELF` | publisher, in the app | 1 |
| `AGENT` | ADX agent on the publisher's behalf | 1 |
| `ADMIN_SINGLE` | ops, via Add Inventory | 1 |
| `ADMIN_BULK` | ops, importing a partner's spreadsheet | up to hundreds |
| `SCRAPE` | ops, seeding unowned inventory | many |

An `AGENT`, `ADMIN_SINGLE` or `ADMIN_BULK` attempt is complete but unaccepted
until the publisher accepts — a state that will be common, since whoever built
the listing is usually not the person who can accept for it.

A `SCRAPE` attempt has **no publisher at all** until someone claims it, which is
why `Listing.publisherId` is nullable.

## Listing states

`ListingStatus` distinguishes who is being waited on. The four middle states are
the ones the old enum could not express.

```
UNCLAIMED            no owner yet (scraped)          waiting on: nobody
DRAFT                being built                     waiting on: creator
AWAITING_AGREEMENT   listed, attempt not accepted    waiting on: publisher
AWAITING_DOCUMENTS   accepted, documents missing     waiting on: publisher
PENDING_REVIEW       documents in, desk check due    waiting on: ADX
AWAITING_SITE_VERIFICATION  desk cleared, visit due  waiting on: ADX agent
ACTIVE               published, rentable, earning    —
SUSPENDED            enforcement, see below          waiting on: publisher
REJECTED / INACTIVE  terminal
```

Desk verification of documents and the agent site visit run in that order, so a
failed document check never wastes a visit.

## Verification

A listing is verified by an ADX agent visiting the site and photographing it.
That first verification buys the listing its full cadence, which is why a spot
booked shortly after listing has runway rather than an imminent lapse.

**Cadence follows removability**, recorded per listing rather than derived from
asset type — a gym mirror decal and a mall atrium banner are both "indoor" and
nothing alike:

- `PERMANENT` (hoardings, gantries, structures) — 180 days
- `REMOVABLE` (decals, panels, small-format) — 90 days

**Re-verification is self-service.** The publisher captures a photo through the
in-app GPS camera; the capture is matched against the listing's stored
coordinates within a tolerance (default 15 m, configurable, widened where the
listing's `qrToken` is also scanned at the site). A miss is a retry, not a
rejection.

Every verification, agent or self, is stored with its coordinates, distance from
the listing, captured timestamp and photo, so a challenged listing can be
evidenced rather than argued.

**Where it lives (QR-26, 20 Sep 2026).** The publisher's own re-verification
is the user app's "Is the spot still standing?" card on the listing page
(`ReverifyScreen`: fix first, camera only, `SELF_REVERIFICATION` with the fix;
the row wears "Verify again in N days" inside the risk window). The agent's
verification is the agent app's site visit — an order milestone's checklist:
travel → check-in → confirmations and venue papers (the image picker, which now
asks for the camera at runtime) → photo proofs through the in-app viewfinder →
`AGENT_INITIAL` with the distance from the pin. Both land at the verification
desk as SUBMITTED. Reminders to the publisher at T−15 / T−7 are not built.

### The risk window

Fifteen days before expiry for `PERMANENT`, seven for `REMOVABLE`, a listing
enters its **risk window**: reminders start, and the listing is presented to
advertisers as *verified for now, but re-verification due*.

The marker is a disclosure, not a penalty. **Price does not change** — a spot
that clears re-verification is identical to any other, and re-verification takes
minutes, so discounting it would be arbitrary. It sorts below equivalent fresh
listings and shows its marker; nothing else moves.

Verification freshness is an input to the match score. The others are location,
angle, size, reach, price and audience; reach and audience have no supply-side
data yet, so the engine cannot be completed until they do.

## Enforcement

When verification lapses, the cost lands on the party who can fix it, without
breaking the advertiser's campaign.

```
T −15d / −7d   reminders begin, per cadence
T 0            verification expires · earnings pause on that listing
T +24h         held earnings forfeit to the advertiser as goodwill credit,
               and daily thereafter
T +3d          compliance case opens · 3–4 contact attempts across 48 hours
T +5d          booking suspended on that listing · installation cost and
               recoverable ADX losses deducted from earnings
```

Every step of this is named in the platform agreement the publisher accepted.

Forfeited earnings become a **goodwill credit** to the advertiser — not a credit
note against the original invoice, since the spend has already landed on the
books. Where several advertisers ran on the lapsed spot, the goodwill divides in
proportion to what each paid.

> **Scope.** This module implements the schedule, the risk window, the state
> transitions and the compliance case. The earnings hold, forfeiture and
> goodwill credit require a ledger that does not exist yet; they belong to the
> money workstream and are stubbed here behind `EarningsHold`, which records the
> obligation without moving money.

## Claiming

A scraped listing has no owner. A publisher claims it by asserting ownership and
submitting documents for that specific spot; ADX adjudicates, and on approval
the listing transfers to the claimant's account and joins a new attempt so the
listing agreement applies to it.

Two people can claim the same hoarding, so claims are queued and decided rather
than granted on arrival.

## Still open

Not implemented, and flagged rather than guessed:

- **Authority to accept on behalf.** Whether a partner publisher's agency can
  accept the listing agreement for owners it represents, and what evidences it.
- **Material-change re-acceptance.** Which listing edits after acceptance
  invalidate the agreement on file.
- **Reach and audience data.** Sources for the two missing match inputs, and
  whether the reach shown at booking is snapshotted onto the booking.
- **Ranking weights.** How the six match inputs and verification freshness
  combine. Deferred deliberately.
- **Recoverable cost heads.** Which costs are deductible and whether capped.
  Depends on cost-to-serve, which depends on print quoting.

## The right to the space (QR-24, 20 Sep 2026)

The re-verification clock above says the spot still stands and looks like
this. A second clock says the publisher still has the right to sell it: a
hoarding on a highway, a shelter, a digital billboard are held on a lease, a
licence or a permit a civic body renews every year. The listing carries
`rightsBasis` and `rightsValidUntil`; ADX reminds the publisher 30 and 7
days out; on the day the spot lapses — off the shelf, running campaigns
untouched — until the renewed permit or agreement, uploaded from the
listing page with its new end date, is approved at the review desk. The
console watches it all from Listings › Renewals. Details in the supply
module README, "QR-24".
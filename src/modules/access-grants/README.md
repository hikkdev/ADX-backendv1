# access-grants

A publisher lending an agent a limited hand with their own account.

## Why this exists

The platform's default is that an agent acts for the publishers they onboarded
and nobody else. That default is load-bearing rather than tidy: listings are read
live as comparables, so an agent who can edit any listing can reprice a
competitor's spot and move the range every neighbour inside that 200 m circle is
measured against. Before this module, `PATCH /listings/:id` was gated on the role
`AGENT_PUBLISHER` and nothing compared the caller to the listing.

Publishers do need help, though — the ones who most need it are the ones least
able to fix a mistyped rate themselves. So there is one exception, and it is the
publisher's to grant.

## The flow

1. The publisher raises a **support ticket** asking for help.
2. ADX **assigns an agent** to that ticket.
3. The publisher **generates a QR from their own app**, saying in their own words
   what they want changed, and is shown a warning naming what the code hands over
   and for how long.
4. The assigned agent **scans it**. The window starts *then*.
5. It **closes by itself**.

Nobody in that sequence can grant themselves access, and nothing in it depends on
anyone remembering to switch access off.

## The parts that carry weight

**`reason` is required and has a minimum length.** It is the only record of what
the publisher thought they were agreeing to, it is shown to the agent on the
scan, and it is what an argument three months later gets settled against. "Help"
describes nothing, so ten characters is the floor.

**`assignedAgentId` is why a leaked QR image is not an open door.** The code
resolves for agent publishers as a class, but the claim checks one id. A
forwarded screenshot is a picture of a code the recipient cannot use.

**`expiresAt` is set on the claim, not on issue.** A publisher who generates a
code and then puts their phone down has not started a clock they cannot see.

**`listingIds` empty means every listing.** That is a *larger* grant than naming
three, so the API never treats an empty array as an unset field — a narrowing
that names a listing the publisher does not own is rejected rather than ignored,
because an id from somewhere else would sit in the array looking like a
restriction while restricting nothing.

**Expiry is filtered in SQL.** `findLiveForAgent` excludes windows that have run
out rather than relying on a sweep to mark them `EXPIRED`. A late sweep would
mean access outliving its window, which is precisely the failure this design is
built to avoid.

## Requested grants (QR-27)

The third way a grant opens, beside a ticket and an onboarding scan: an
agent scans an onboarded account's own code, says what for and for how
long, and the owner allows it on their phone. `openRequestedGrant` writes
it — purpose SUPPORT, `supportTicketId` null, the scanning agent as
`assignedAgentId`, the ask's scope, the duration clamped to 15 minutes–1
day, ACTIVE from the approval — and audits `ACCESS_GRANT_ISSUED` with
`requested: true` under the agent's login. The QR module reaches it through
`AccessGrantPort.openRequested`. Revocable and listed like every grant.

## Wiring

`qr` cannot import this module — this module imports `qr` to mint the code — so
the claim behaviour is declared as `AccessGrantPort` in `qr.ports.ts` and
registered by `registerAccessGrantsModule()` during bootstrap. Same shape, and
for the same reason, as the publisher-onboarding port beside it.

`listings` imports `holdsLiveGrant` for `assertCanEditListing`. That is the only
consumer today; `PROFILE`-scoped grants are modelled and issued but nothing reads
them yet, because the KYC edit path still has its own onboarding-QR route.

## Not covered here

Assigning the agent to the ticket is a `support` concern and happens before any
of this. `supportTicketId` is optional so ops can issue a grant for a request
that arrived by phone — the ticket is evidence, not the mechanism.

### D6 — ops oversight

- `GET /access-grants/open` (ADMIN): every grant still PENDING or ACTIVE.
- `GET /access-grants/agent/:agentId` (ADMIN): every grant the agent ever held,
  with the party's name.
- `GET /access-grants/log/:partyType/:partyId` (ADMIN): the party's whole record
  (`accessLogFor`) — scans with who and how far, grants, writes under them.
- `GET /qr/scans?scannedBy=<userId>` (ADMIN, in `qr`): what one person has
  scanned, refusals included.
- `POST /access-grants/:grantId/revoke`: ops or the owner, as before.

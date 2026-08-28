# publishers

The people and organisations who own advertising inventory: their profile,
their KYC, and the agent-mediated onboarding flow.

```
publishers/
  publishers.*      profile CRUD, the agent-ownership policy
  kyc/              PublisherKyc + the Digio integration and its webhook
  onboarding/       self-registration, the onboarding QR, claim/cancel/complete
```

The inventory itself is `listings`.

## Why PublisherKyc is here and not in `kyc`

`PublisherKyc` is part of the publisher onboarding aggregate: its routes hang
off `/publishers/:publisherId/kyc`, its status is mirrored onto the publisher
row in the same transaction, and it is driven by the Digio integration. The
`kyc` module owns the two *standalone* record types, `AdvertiserKyc` and
`UserKyc`, which share a review workflow and nothing else with this one.

## Owned routes

Mounted at `/api/v1/publishers`, all `authenticate`d, plus one webhook.

| Method | Path | Guard |
| --- | --- | --- |
| POST | `/register` | PUBLISHER (**201** or 200) |
| GET | `/me` | PUBLISHER |
| GET | `/me/qr` | PUBLISHER (**201** or 200) |
| POST | `/me/cancel-onboarding` | PUBLISHER |
| GET | `/` | any authenticated |
| POST | `/` | AGENT_PUBLISHER (**201**) |
| GET | `/:publisherId` | any authenticated |
| PATCH | `/:publisherId` | AGENT_PUBLISHER |
| POST | `/:publisherId/kyc` | AGENT_PUBLISHER |
| POST | `/:publisherId/kyc/review` | ADMIN |
| POST | `/:publisherId/kyc/digio/initiate` | AGENT_PUBLISHER |
| GET | `/:publisherId/kyc/digio/status` | any authenticated |
| GET | `/:publisherId/onboarding-status` | any authenticated |
| POST | `/:publisherId/cancel-onboarding` | AGENT_PUBLISHER \| ADMIN |
| POST | `/:publisherId/complete-onboarding` | AGENT_PUBLISHER \| ADMIN |
| GET | `/:publisherId/listings` | any authenticated |
| POST | `/api/v1/webhooks/digio` | **none** |

The four `/me` and `/register` paths are registered **before** the
`/:publisherId` routes. Reordering would make `me` match as a publisher id.

## Owned Prisma entities

`Publisher`, `PublisherKyc`.

## Public exports (`index.ts`)

- `publisherRouter`, `digioWebhookHandler`.
- `registerPublisherModule()` — supplies the QR module's port. See below.

## The QR port

`publishers` imports `qr` to mint onboarding codes. `qr` needs `publishers` to
claim a publisher when one is scanned. Importing both ways would be a cycle, so
`qr` declares a `PublisherOnboardingPort` and this module implements it;
`bootstrap/register-modules` calls `registerPublisherModule()` before serving.

The port is two methods, not one, on purpose: `prepareClaim` validates and
writes nothing, `commitClaim` writes. QR then deactivates the code and commits
the claim together, so a rejected claim never burns a valid QR.

If bootstrap ever stops calling it, scanning a publisher QR throws a loud
"port not registered" error rather than silently logging a successful scan
that claimed nothing.

## Dependencies

- `qr` — mint, look up and expire onboarding codes.
- `agents` — `requireAgentProfile`, `findAgentProfile`.
- `listings` — `getListingsForPublisher`.
- `notifications` — Digio KYC outcomes notify the claiming agent.
- `shared/integrations` (Digio credentials), `shared/logging`, `shared/http`,
  `shared/auth`, `shared/errors`, `shared/validation`, `shared/database`
  (repositories only).

## Invariants

- **404 vs 403 is deliberate and opposite to `banking`/`advertisements`**: an
  unknown publisher is 404, one owned by another agent — or a caller with no
  agent profile — is 403.
- KYC submission and review each write the `PublisherKyc` row and the mirrored
  `Publisher.kycStatus` in **one transaction**; they must never disagree.
- A rejection requires a `rejectionReason`; the schema enforces it rather than
  leaving it to the caller.
- Every publisher is created with an empty KYC row, so there is always something
  to submit into.
- Self-registration is idempotent: a second `POST /register` returns the
  existing profile with **200**, not a conflict. It also writes the supplied
  name and email onto the `User`.
- `GET /me/qr` reuses the live code if one exists (**200**) and only mints a new
  one when there is none (**201**). Regenerating would invalidate a code the
  publisher may already have on screen. It is refused with **409** once
  onboarding is in progress or complete.
- Cancelling expires the QR codes **first**, then clears the claim. The reverse
  order would briefly leave a scannable code pointing at a claimable publisher.
- Only the claiming agent or an ADMIN may complete an onboarding, and only from
  `IN_ONBOARDING`.
- `category=KYC` on the publisher listing is the UI's tab name, not a column —
  it filters to `kycStatus: VERIFIED`.
- The Digio webhook **always answers 200**, even for a payload that fails
  validation: an error would make Digio retry the same bad body indefinitely.
- Digio degrades gracefully when unconfigured, returning a mock pending KYC so
  the flow is testable without credentials — disabled by real credentials, not
  by `NODE_ENV`.

## Tests

```bash
npx vitest run src/modules/publishers
```

## Suggested ownership

Supply-side team, alongside `listings`. The Digio integration is the riskiest
part; changes there need real-credential testing.

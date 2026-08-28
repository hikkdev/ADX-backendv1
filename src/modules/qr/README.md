# qr

Signed, tamper-proof QR codes and the scan log — the platform's physical
touchpoints: publisher onboarding, site check-ins, ad health checks, agent
referrals.

## Owned routes

Mounted at `/api/v1/qr`.

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/:qrId/image.png` | **none** |
| GET | `/:qrId/image.svg` | **none** |
| POST | `/resolve` | `authenticate` |
| POST | `/` | ADMIN (**201**) |
| GET | `/:qrId/scans` | ADMIN |
| DELETE | `/:qrId` | ADMIN |
| GET | `/:qrId` | `authenticate` |

### The image routes are load-bearing

Both image routes are registered **above** `qrRouter.use(authenticate)` and must
stay there. An `<img>` tag cannot send an `Authorization` header, so moving them
below the authenticate layer turns every rendered QR code into a broken image.
The route-inventory test asserts this.

## Owned Prisma entities

`QrCode`, `QrScan`.

## Public exports (`index.ts`)

- `qrRouter`.
- `generateQr`, `deactivateQr`, `getQrById`, `findActiveQrFor`,
  `deactivateQrsFor` — so no other module queries `QrCode` itself.
- `registerPublisherOnboardingPort` and its types.

## The publisher-claim port

Scanning a PUBLISHER-type code claims that publisher for the scanning agent.
That is publisher onboarding logic, and `publishers` already imports this module
to mint codes — so importing it back would be a cycle.

Instead `qr.ports.ts` declares what QR needs and `publishers` registers an
implementation at bootstrap. QR depends on the shape, never on the module.

The port is split in two: `prepareClaim` validates and writes nothing;
`commitClaim` writes. QR runs validation first, then deactivates the code and
commits the claim together — so a rejected claim never burns a valid code. An
unregistered port throws loudly rather than logging a scan that claimed nothing.

## Invariants

- Tokens are `base64url(payload).base64url(HMAC-SHA256)` signed with
  `QR_SECRET`. Signature comparison uses `timingSafeEqual`, not `===`.
- The signature covers the row id, so the row is created first with a throwaway
  token and immediately updated with the real one.
- An unrecognised code type degrades to `VIEW_ONLY` rather than failing, so an
  older app scanning a newer code type still gets a sensible response.
- The action depends on the **scanner's role**, not only the code: a SITE code
  is `ONBOARD_PUBLISHER` for an agent-publisher and `ORDER_CHECKIN` for an
  agent-advertiser.
- SITE codes that resolve to `ONBOARD_PUBLISHER` are the legacy site check-in
  flow and are deliberately **not** claimed — only PUBLISHER codes are.
- The scan is logged **only after** all validation and the claim succeed, so the
  log never records a scan that did nothing.
- The service throws opaque `QR_*` sentinels; `qr.controller.ts` is the single
  place they become status codes (400/403/404/409).
- Images are cached `public, max-age=86400`; requested size is clamped to
  100..1000 px, default 300.
- Every image and metadata route requires the code to be **active**; a
  deactivated code is 404.

## Tests

```bash
npx vitest run src/modules/qr
```

## Suggested ownership

Platform team — it is signed-token infrastructure, not a business domain.

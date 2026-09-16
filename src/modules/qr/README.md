# qr

Signed, tamper-proof QR codes and the scan log — the platform's physical
touchpoints: publisher onboarding, site check-ins, ad health checks, agent
referrals.

## Owned routes

Mounted at `/api/v1/qr`.

QR-1 (16 Sep 2026): the two image routes draw the **printed** types — SITE
(a listing's plaque), AGENT (a referral card), ORDER (a pickup label), AD (a
health code) — through the QR engine seam (`shared/qr-engine`'s
`renderPrinted`: GenQR's styled artwork when it is the engine, the house
style otherwise; a print job never fails to draw) with a caption naming the
code's purpose ("Scan to check in", "Scan to refer", "Scan to collect",
"Scan to report"). The rest — PUBLISHER, ADVERTISER, ACCESS_GRANT, the
ninety-second codes on a phone screen — are drawn locally and their signed
token never leaves ADX. `X-QR-Engine` and `X-QR-Styled` on the response say
which. `PRINTED_QR_TYPES` / `isPrintedType` / `renderQrImage` in `qr.image.ts`.

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/:qrId/image.png` | **none** |
| GET | `/:qrId/image.svg` | **none** |
| POST | `/resolve` | `authenticate` |
| GET | `/scans/:scanId` | `authenticate` — the scanner's own scan, for polling an approval |
| GET | `/scans` | ADMIN — D6: `?scannedById=` (or the older `scannedBy=`) — one person's scans, newest first, each with its code; K-B1: `&outcome=` and `&from=&to=` narrow it. An array, as the console reads it |
| GET | `/` | ADMIN — K-B1, the desk: `?type=&active=true\|false&refId=&q=&page&pageSize`, the list contract with `counts` per type (the type facet removed); each row `{ id, type, refId, ref: { kind, id, label, href, displayId }, isActive, expiresAt, scansCount, lastScanAt, createdAt, imagePngUrl, imageSvgUrl }` — `ref` is what the refId names, resolved through the ref-label port below, one batch per kind on the page |
| POST | `/` | ADMIN (**201**) — K-B1: audited `QR_GENERATED` against the admin |
| GET | `/:qrId/scans` | ADMIN — K-B1: the list contract (`?page&pageSize&outcome=`), `counts` per outcome, each row with `scannedBy { id, name, mobile }` (the number stands in for a missing name) |
| POST | `/:qrId/regenerate` | ADMIN (**201**) — K-B1: deactivates the code (if still live) and issues a new token for the same type / ref / roles / metadata / remaining expiry / position, answering the new row with `previousQrId` and the image urls; audited `QR_REGENERATED` |
| DELETE | `/:qrId` | ADMIN — K-B1: `{ reason }` in the body (400 without); audited `QR_DEACTIVATED` with the reason; 404 for a code that does not exist |
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
- `confirmPickupHandover` (Lot H) — the print partner's handover scan, above.
- `registerPublisherOnboardingPort` and its types.

## The pickup code (A9)

`orders` mints an `ORDER` code with `metadata.purpose = PICKUP` when the prints
are marked ready for an agent (`fulfilment.markPrintReady`), restricted to
`AGENT_PUBLISHER`. Resolving it answers `PICKUP_MATERIAL`; an `ORDER` code
without that purpose is still `ORDER_CHECKIN`. `assertQrForRef(qrId, type,
refId)` is what `collect-prints` calls to check the scanned code is this
order's. Printed on the package via `GET /qr/:id/image.png`, found through
`GET /orders/:id/pickup-code`.

Lot H (Q147): the same code read from the other side of the counter.
`confirmPickupHandover(token, orderId, scannedById)` — for `print-partners`'
`POST /print-partners/me/jobs/:jobId/handover` — verifies the signed string,
checks it is this order's **live** ORDER code with `purpose: PICKUP`, logs
the scan (action `PICKUP_HANDOVER`, role PARTNER, outcome GRANTED) and
answers `{ qrId }`; `QR_INVALID` for a string that is not a signed code,
`QR_MISMATCH` otherwise, and a refused string logs nothing.

## The ref-label port (K-B1)

`GET /qr` names each code's subject. The spot, the agent, the order, the
publisher, the advertiser and the grant live in six modules that all import
`qr` to mint codes, so `qr.ports.ts` declares `QrRefLabelPort` —
`Partial<Record<QrType, (ids) => Promise<{ id, label, displayId }[]>>>` — and
`bootstrap/register-modules` registers each module's own batch export
(`findListingLabels`, `findAgentLabels`, `findOrderLabels`,
`findPublisherLabels`, `findAdvertiserLabels`, `findAccessGrantLabels`).
`resolveRefs` asks each kind once per page, never once per row; a kind with
no resolver (AD today) or an id the module no longer has answers
`label: null, href: null` rather than failing the page — a code can outlive
what it pointed at.

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

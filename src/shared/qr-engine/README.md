# shared/qr-engine — the QR engine seam

QR-1 (16 Sep 2026): the owner's decision to run **GenQR** — our own QR
platform, its own repository, deployment, database and public pricing — as
the engine behind every ADX code that goes to print, while ADX keeps the
meaning of every scan. ADX is a **tenant** of GenQR: an Enterprise account,
one scoped key, an ADX-branded short domain. Nothing is shared but HTTP.

## Two engines, one door

| | `LOCAL` | `GENQR` |
| --- | --- | --- |
| what | the `qrcode` package in the house style (`local.ts`) | GenQR's `/api/v1` with a Bearer key (`genqr.ts`) |
| draws | colours and size (`styled: false`) | SVG with dots, frame, caption, logo (`styled: true`); PNG colours-only |
| hosts dynamic codes | no | yes — `/r/<shortCode>` on the ADX short domain, 302 to ADX `/t/:code` |
| engine analytics | none | per-code scans by day / hour / device / browser / OS / country / city |
| chosen by | the default | `qrEngine.provider` on the integrations row |

`index.ts` is the door: `renderPrinted` (a code going to print —
GenQR, else LOCAL, the fallback logged), `renderDynamic` (a hosted code's
image — GenQR's, else the stored short URL drawn locally, else ADX's own
`/t/` link), `registerDynamicCodes` (503 when nothing hosts), `retireDynamicCode`,
`dynamicCodeAnalytics` (a code the engine cannot answer for is absent,
never a throw) and `testQrEngine` (the card's verdict). Config:
`getEffectiveQrEngineConfig` in `shared/integrations` — row first, then
`GENQR_BASE_URL` / `GENQR_API_KEY` / `GENQR_SHORT_BASE_URL`.

## What goes through it, and what never does

- **Campaign hoarding codes** (`campaigns/tracking.service`): the scan path
  the owner chose is `GenQR /r/XXXX → ADX /t/XXXX → destination`. ADX
  stays the counter it always was (bot filter, IST hour, measured-vs-
  reported, the landing beacon untouched); GenQR adds the styled artwork,
  the short printed URL and its own breakdowns, which the analytics screen
  draws **beside** ADX's number under `engine`, provenance `GENQR`. When
  GenQR is not configured at issue time the code is ADX-only and the
  hoarding carries `/t/`; `POST /campaigns/:id/tracking-codes/sync-engine`
  links it later.
- **Printed identity codes** (`qr` module: SITE plaques, AGENT cards, ORDER
  pickup labels, AD health codes): drawn by `renderPrinted` — GenQR's
  `POST /api/v1/render`, content the signed ADX token, nothing stored on
  GenQR.
- **Never**: the ninety-second onboarding and access-grant codes (PUBLISHER,
  ADVERTISER, ACCESS_GRANT). They live on a phone screen and are drawn
  LOCAL; their tokens do not leave ADX.

## GenQR's side of the contract

GenQR gained, for this: enforced key scopes (`qrcodes:read`, `qrcodes:write`,
`qrcodes:delete`, `analytics:read`, `render`), a per-account **redirect
base** (the printed host), `GET /api/v1/analytics`,
`GET /api/v1/qrcodes/:id/analytics`, `GET /api/v1/qrcodes/:id/image.(svg|png)`,
`POST /api/v1/render`, and `shortUrl` on every code it returns. The probe
(`genqrTest`) reads `/api/v1/me` and says whether the key holds the four
scopes the integration needs and whether GenQR's redirect base matches the
short base ADX prints. The key goes in the `Authorization` header and
nowhere else — never a log line, an error message or a verdict.

## Errors

By GenQR's own table: 401 and 403 `insufficient_scope` are 503
`INTEGRATION_NOT_CONFIGURED` carrying GenQR's sentence; 403 `quota_exceeded`
is 409; 429 is 429; 400/422 is 400; 404 is 404; anything else, and an
unreachable host, is 502. `renderPrinted` and `renderDynamic` swallow all of
these into a LOCAL fallback (a print job must never fail to draw);
`registerDynamicCodes` does not.

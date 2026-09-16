# uploads

The single ingest point for files — and, since Lot D, the one door to a
private one.

Every other module takes **URLs, not files**: `kyc`, `employees`, `publishers`
and `orders` all expect a client to POST the file here first and send the
returned URL onward. Keeping that one-way rule is what stops multipart handling
spreading across the codebase.

## Owned routes

| Method | Path | Guard | Status |
| --- | --- | --- | --- |
| POST | `/api/v1/upload` | `authenticate` | **201** — `{ url, id }`; `purpose`, and `ownerUserId` when the file is someone else's document. Lot F: naming an owner is an on-behalf write — ADMIN, or the party's agent (AGENT_PUBLISHER / AGENT_ADVERTISER) under a **live PROFILE grant** on that party, through the same port as the read; anyone else is **403** before anything is stored |
| GET | `/api/v1/files/:id` | `authenticate` | **302** to a public URL or a 5-minute presigned R2 read, or a local stream; 403 unless owner / agent under a live grant / ADMIN — and, Lot F, for `DISPUTE_EVIDENCE`, the other side of the case the file sits on (the dispute's raiser or the party it is against, or their agent under a grant), asked through `FileAccessPort.disputePartyMayView`, filled in bootstrap from `disputes.disputePartiesForEvidenceFile` — only cases the file's own owner or uploader is a party to count; Lot I: for `SUPPORT_ATTACHMENT`, the requester of the ticket the file's message sits on, through `FileAccessPort.supportPartyMayView`, filled in bootstrap from `support.supportAttachmentViewer` |
| DELETE | `/api/v1/files/:id` | `authenticate` (owner or ADMIN) | 200 — object and row, audited `FILE_DELETED` |

Chain on the upload: `authenticate` → `handleUploadMiddleware` → `uploadFileHandler`.
`handleUploadMiddleware` must stay a distinct layer ahead of the handler —
multer has to consume the multipart body before anything can read `req.file`.

## Private files (Lot D, Q61/Q127)

Some purposes are never handed a public URL: **KYC, AGENT_KYC, ADVERTISER_KYC,
EMPLOYEE_KYC, USER_KYC, TOPUP_PROOF, DISPUTE_EVIDENCE, INVOICE**, Lot N's
**PRINT_PARTNER_KYC** (a print partner's KYC documents — uploaded by the
partner under their own account, or by an admin on their behalf with
`ownerUserId` the partner's user, and named to `print-partners` by the
`/files/:id` URL; a KYC purpose, so opening one is `FILE_VIEWED`), and Lot G's
**REPORT**, **DATA_EXPORT** (G6/Q104 — a person's own data export, owned by
them, purged at seven days), **BOOKING_REPORT** (G6/Q110 — a publisher's
booking report PDF, owned by the publisher), Lot H's **PARTNER_RATE_CARD**
and **PARTNER_INVOICE** (Q147 — a print partner's rate card and their monthly
invoice to ADX, uploaded by the partner under their own account and named to
`print-partners` by id), and Lot I's **SUPPORT_ATTACHMENT** (an image or PDF
on a support message — opened by its uploader, the desk, and the requester of
the thread it sits on)
(`PRIVATE_PURPOSES` in `uploads.schema.ts`). Such a file is stored under a
non-public prefix — locally under `private-uploads/` (outside the static
`/uploads` mount), on R2 under `private/` — with `visibility: PRIVATE`, a
`storageKey` (`<provider>:<key>`) and an `ownerUserId` when the uploader is not
the party the document belongs to. Its recorded URL is `${BASE_URL}/api/v1/files/:id`,
so every KYC column that used to hold a public URL now holds this one and
nothing downstream has to change. Public URLs recorded before Lot D keep
working: `GET /files/:id` on a PUBLIC row is a 302 to where it always lived.

Who may open a private file: its **owner** (`ownerUserId ?? userId`), an
**ADMIN**, or **the party's agent under a live PROFILE grant** — including the
door-to-door onboarding grant. That third answer needs `agents`,
`access-grants`, `publishers` and `advertisers`, and this module sits underneath
`payouts` and `invoices`, which `publishers` reaches, so it is asked through
`FileAccessPort` (`file-access.port.ts`), filled in `bootstrap/register-modules.ts`.
Unregistered, the answer is no. Opening an identity document (the five KYC
purposes) writes `FILE_VIEWED` against the `UploadedFile`; a top-up proof or an
invoice does not.

An R2 read is a presigned GET signed by hand in `shared/storage/presign.ts`
(SigV4 query form, pinned against the AWS documentation vector) — the SDK's
presigner package is not a dependency. A local read streams the file with its
content type and `Cache-Control: private, no-store`.

**The console's `<PrivateFile>` contract (Lot D console's job):** render a
private document by fetching `GET /files/:id` with the bearer token and
`redirect: 'follow'` (the presigned URL carries its own signature and needs no
header; a same-origin local stream keeps the token), or open it in a new tab
through a short-lived object URL. Never put `/files/:id` in an `<img src>`
without the token — it is 401 there. A 403 means the viewer is not the owner,
the desk, or an agent holding a live grant.

## Owned Prisma entities

`UploadedFile` (with `visibility`, `ownerUserId`, `storageKey`).

## Public exports (`index.ts`)

- `uploadRouter`, `filesRouter`.
- `storeGeneratedFile(userId, { content, filename, mimeType, purpose, ownerUserId? })` (Lot B,
  Q85) — a file the platform generated or already holds in memory, stored and
  recorded like any upload; `payouts` files a batch's bank upload with it
  (`PAYOUT_EXPORT`), `reconciliation` the statement as imported (`BANK_STATEMENT`),
  `invoices` the rendered PDF (`INVOICE`, private — pass the party as `ownerUserId`
  so they can open it).
- `findUploadedFile(id)` — the record behind a file id, never a URL trusted from a body.
- `csvUploadMiddleware` — a narrow multer for one CSV in memory (`.csv` or a CSV
  type, 5 MB, field `file`), for the statement import and the publisher import.
- `registerFileAccessPort(port)` — bootstrap's, see above. Lot F: the port's
  optional `disputePartyMayView(viewerUserId, fileId, holders)` opens evidence to
  the case's other side — `holders` are the file's owner and uploader, and only a
  case one of them is a party to counts, so attaching somebody else's `/files/:id`
  to a case of one's own opens nothing; `agentMayView` also gates the on-behalf
  upload. Lot I adds the optional `supportPartyMayView(viewerUserId, fileId)`,
  filled from `support.supportAttachmentViewer`: it opens a
  `SUPPORT_ATTACHMENT` to the requester of the thread its message sits on, and
  a file on no message opens to nobody but its owner and the desk.
- `PRIVATE_PURPOSES`, `isPrivatePurpose` — which purposes are private.
- `purgeStoredFile(id)`, `fileIdFromUrl(url)` (Lot D, Q127) — for the KYC purge
  job through `kyc` and `publishers`: a file removed by id with no viewer, and
  the id inside a `/files/:id` URL (null for a pre-Lot-D public URL).

## Dependencies

- `shared/storage` — the provider adapter (local disk or Cloudflare R2, chosen
  from the integrations config), the presigner, and the delete.
- `shared/http`, `shared/auth`, `shared/errors`, `shared/audit`, `config/env`,
  `shared/database` (repository only).
- No other business module — the grant question goes through the port.

## Invariants

- Accepted types: JPEG, PNG, WebP, HEIC, SVG, PDF, MP4 and QuickTime video.
  Anything else is **400**, not 415.
- Maximum 10 MB for images and documents, 50 MB for video; multer's own errors
  are translated into the API envelope, so a rejected upload is a 400 rather
  than a bare 500.
- Files land in `uploads/tmp` first and the temp file is removed in a `finally`
  block, so a failed upload cannot leak it. Deletion failure is non-fatal.
- An unrecognised `purpose` falls back to `OTHER` rather than failing the
  upload; the folder for an unknown purpose is `misc`. `TOPUP_PROOF` (Lot B)
  is the receipt or cheque scan behind a wallet top-up, filed under
  `top-up-proofs`. `INVOICE` and `STATEMENT` (Lot B, Q13) are `invoices`'
  rendered documents — and a publisher's own invoice to ADX — under
  `invoices` and `statements`. `PAYOUT_EXPORT` and `BANK_STATEMENT` (Lot B,
  Q85) are the payout batch's bank file and the statement kept as imported.
  `AGENT_KYC`, `ADVERTISER_KYC`, `EMPLOYEE_KYC`, `USER_KYC` (the liveness
  video), `PRINT_PARTNER_KYC` (Lot N, under `print-partner-kyc`) and
  `DISPUTE_EVIDENCE` (Lot D) are private. `SUPPORT_ATTACHMENT`
  (Lot I) is private too, filed under `support-attachments`; `support` checks
  the type and the size against `support.liveChat.attachmentMaxMb` before it
  will name one on a message.
- A private file's id is minted **before** the row is written, so the recorded
  URL can name it; the id is a 32-hex UUID rather than a cuid, which nothing
  depends on.
- The response is deliberately narrow — `{ url, id }` only, never the whole row.
- `baseUrl` comes from `BASE_URL`, falling back outside production to the
  request's **Host header** rather than `req.hostname`, because `req.hostname`
  strips the port and would produce unreachable dev URLs.
- Deleting removes the object best-effort and the row for certain: the row is
  what the platform answers from.

## Tests

```bash
npx vitest run src/modules/uploads src/shared/storage
```

## Suggested ownership

Platform team — it is infrastructure with three routes.

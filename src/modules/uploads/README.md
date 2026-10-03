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
the thread it sits on), and ST-2's **LISTING_DOCUMENT** (a listing's venue
papers and audience reports — adopted from whatever public file a filed
document names; opened by the listing's publisher and the field agent sent
to it, see below)
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

## The GPS camera stamp (GC-1, 23 Sep 2026)

The owner: "make sure GPS details are embedded in the photos our camera
takes … like there's a flash on/off button." A photo may arrive with a `geo`
field beside it in the multipart form — the fix the phone had at the
shutter, the address it was already showing, the moment, and a label — and
when it does the picture is changed in two ways before it is stored, the way
the popular GPS camera apps change it (`geo-stamp.ts`):

1. **A stamp is burned into the pixels.** A translucent band along the
   bottom: the address (or the coordinates when there is none), then the
   coordinates with the fix's accuracy, the time in IST, and the ADX mark.
   Drawn as SVG the width of the picture and composited with sharp, so a
   12 MP original and a 1,600 px downscale carry the same stamp in
   proportion. Anyone who opens the file, anywhere, sees where and when.
2. **The EXIF GPS block is written.** `GPSLatitude`/`Longitude` with their
   refs, `GPSMapDatum` WGS-84, the UTC date and time stamps, plus
   `DateTimeOriginal` in local time with `OffsetTimeOriginal +05:30` — the
   tags a phone gallery, Google Photos or a forensic viewer read.

The same facts land on the row (`latitude`, `longitude`, `accuracyM`,
`takenAt`, `geoStamped`) so they can be queried without opening the file.

**Why here and not on the phone.** `sharp` is already in the backend and
tested on real pixels; stamping on the phone would need a native image
library in both apps and an APK rebuild before a single photo carried a
stamp. The phone draws the same band live over its viewfinder
(`mobile/shared/lib/geo-stamp.ts` mirrors `stampLines`, and both suites pin
the same strings), so the person sees what they will get; the pixels are
settled once, in one place, in a test.

**Three rules.** Opt-in per photo — no `geo`, no stamp; documents, proofs of
payment and creatives never carry one. Never a non-image, never an avatar
(whose own normalisation strips every scrap of metadata for a public file).
And the fix is the phone's, sent beside the file: EXIF that came in with the
picture is neither trusted nor preserved — it is trivially edited, and the
picker re-encodes it away anyway.

**A deployment note.** librsvg draws the band's text with whatever
fontconfig finds. This development box has Arial; a Linux host needs a font
package (`fonts-dejavu-core` is named first in the SVG). On a host with no
font at all the band renders with no text — the EXIF is still written — so
the first stamped photo after a deploy is worth opening.

Tests: `__tests__/gc1-geo-stamp.test.ts`.

## Reading a picture for a model (VA, 23 Sep 2026 — `image-read.ts`)

The vision lot (VA-1 creative analysis in `campaigns`, VA-2 competitor
sightings in `competitor-sightings`) reads stored images through one door:
`readImageForModel(fileUrl)` fetches the bytes behind a `/files/:id` URL or a
public URL of ours, downscales to 1,024 px on the long side as JPEG q80
(what a model is sent — never the 10 MB original), and computes a
**perceptual hash** (`differenceHash`: 9×8 greyscale, 64 bits, hex) so two
artworks can be compared by `hammingDistance` without a model at all.
`isModelReadableImage(mimeType)` says whether a file can be read this way
(JPEG, PNG, WebP; never a video or a PDF). A file that cannot be decoded is
**409** `FILE_UNREADABLE`.

The purpose **COMPETITOR_CAPTURE** (VA-2, private, folder
`competitor-captures`) is an agent's photograph of somebody else's hoarding,
taken with the GPS stamp on.

## Reading a document (DR-1, 23 Sep 2026 — `document-reading.ts`)

The owner: "if someone uploads a document's photo, how do we know what's
written there?" Until DR-1 a person did — the desk by eye, or Digio for the
identity documents it handles. Now there is one door through which software
reads a document:

| Method | Path | Who | What |
| --- | --- | --- | --- |
| POST | `/files/:id/read { kind }` | ADMIN | the desk names the kind of document it is looking at (`DOCUMENT_KINDS`: PAN, DRIVING_LICENCE, PASSPORT, VOTER_ID, GST_CERTIFICATE, INCORPORATION_CERTIFICATE, UTILITY_BILL, BANK_STATEMENT, AGREEMENT, VEHICLE_RC, VEHICLE_INSURANCE, PERMIT_OR_LICENCE, AUTHORISATION_LETTER, OTHER); the file goes to the configured vision model — a photo at 2,000 px (small print survives), a PDF as itself to Anthropic or Google (an OpenAI-shaped provider is **409** `READING_UNSUPPORTED`) — and the answer is held to that kind's field list (`DOCUMENT_FIELDS`): every field a `{ value, confidence }`, never invented, dates as `YYYY-MM-DD`. Kept on the row (`readingKind`, `reading`, `readAt`, `readByUserId`); audited `FILE_READ_BY_MODEL`. A video or an avatar is **409**; no provider **503** `AI_UNAVAILABLE`; a bad answer **502** `AI_FAILED` |
| GET | `/files/:id/reading` | ADMIN | the reading kept on the file, or null |
| POST | `/files/read { url, kind }` / GET `/files/reading?url=` | ADMIN | the same pair for a file the desk knows only by its public URL — a listing's agreement, permit or NOC; **404** when no stored file has that URL |

It prefills and cross-checks; it never decides. The console draws the fields
under the document on every desk that shows one (the KYC workbenches, the
agent's Papers tab, the listing review's documents), badges a value that
disagrees with what was typed, and lets the reviewer Accept or Flag as before.

**DR-2: Digio as the second reader.** On the KYC integration card
(`kyc.documentReader`, `PUT /integrations { section: "digio", patch: {
documentReader: "MODEL" | "DIGIO" } }`) ops can send the four identity
papers Digio reads — PAN, driving licence, passport, voter id — to Digio's
OCR on the account ADX already holds instead of the model
(`shared/integrations/digio-ocr.ts`). Everything else, and every PDF, still
goes to the model; the reading comes back in the same shape with `provider:
"digio"` and a vendor's confidence of 0.9 per answered field, Digio's whole
answer kept under `raw`. Digio's developer portal renders in the browser
only, so the adapter's endpoint (`/v2/client/kyc/ocr`, overridable as
`kyc.ocrPath`) and its reading of the answer's field names are held loosely
and fail loudly with the body logged — the first real call after Digio
enables OCR says what to adjust. Tests: `__tests__/dr2-digio-ocr.test.ts`.

**Aadhaar is not a kind, on purpose.** Storing a full Aadhaar number is
restricted and the Digio channel already handles Aadhaar properly. The model
is told never to transcribe one; a value that looks like one is withheld
whatever key it arrived under, with `AADHAAR_NUMBER_PRESENT` in `warnings`.
A bank statement's account number comes back as its last four digits only.

Tests: `__tests__/dr1-document-reading.test.ts`.

## Owned Prisma entities

`UploadedFile` (with `visibility`, `ownerUserId`, `storageKey`; GC-1's fix columns; DR-1's `readingKind`, `reading`, `readAt`, `readByUserId`).

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
- `readImageForModel(fileUrl, { maxPx?, quality? })`, `isModelReadableImage(mimeType)`,
  `differenceHash`, `hammingDistance` (VA) — see above.
- `readDocument(fileId, kind, actor)`, `getDocumentReading(fileId)`,
  `DOCUMENT_KINDS`, `DOCUMENT_FIELDS`, `PRIMARY_NUMBER_FIELD`, `EXPIRY_FIELD`
  (DR-1) — for a module that wants a reading beside its own record.
- `purgeStoredFile(id)`, `fileIdFromUrl(url)` (Lot D, Q127) — for the KYC purge
  job through `kyc` and `publishers`: a file removed by id with no viewer, and
  the id inside a `/files/:id` URL (null for a pre-Lot-D public URL).
- `adoptListingDocument(url, { filer, baseUrl })`, `ADOPTABLE_PURPOSES` (ST-2) —
  for `supply` when a paper is filed on a listing; `privatiseListingDocuments`
  for the script. `stripExistingPublicImages`, `CLEAN_QUALITY` (ST-1) — for
  `storage:strip-existing`. The port's optional
  `listingDocumentMayView(viewerUserId, fileId)` (ST-2) is filled in bootstrap
  from `supply.listingsNamingFile` and `order-milestones.agentSentToListing`.

## Dependencies

- `shared/storage` — the provider adapter (local disk or Cloudflare R2, chosen
  from the integrations config), the presigner, and the delete.
- `shared/http`, `shared/auth`, `shared/errors`, `shared/audit`, `config/env`,
  `shared/database` (repository only).
- No other business module — the grant question goes through the port.

## Invariants

- Accepted types: JPEG, PNG, WebP, HEIC, SVG, PDF, MP4 and QuickTime video.
  Anything else is **400**, not 415. SVG only for BRANDING and MEDIA, and
  only a safe one (ST-1). Every PUBLIC image is stored with no metadata but
  the GPS stamp it asked for (ST-1).
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

## 26 Sep 2026 — WebM for the liveness clip

A browser's webcam (`MediaRecorder`) records WebM. `video/webm` is admitted for
purpose `USER_KYC` only (`PURPOSE_ONLY_MIME`, `mimeAllowedFor`): multer lets it
through, and the handler checks it against the purpose once the whole form is
read (a multipart field may arrive after the file) — any other purpose is 400
and the temp file removed. Also here: `spreadsheetUploadMiddleware` (.csv or
.xlsx, 5 MB, memory) for the bulk listing upload, and `XLSX_MIME`. Pinned in
`__tests__/webm-liveness.test.ts`.

## ST-1 (28 Sep 2026) — hidden photo data stripped at the door, and the SVG gate

The owner asked how media is arranged ("security, data collection, ease of
storage") and said "Sure, go ahead, build it". A phone photo carries more
than its pixels — the camera's make and model, the editing app, the time,
and often the GPS fix of where the person stood — and a PUBLIC file goes to
anyone holding its URL. So (`image-clean.ts`):

- **Every PUBLIC image is re-encoded before it is stored** — JPEG, PNG,
  WebP, and HEIC when this build can decode it. Decoded, turned upright by
  its EXIF orientation, rebuilt from bare pixels (encoding the decoded image
  directly is not enough: libvips carries a PNG's text chunks into the PNG
  it writes), written back in the same format at the same size: JPEG and
  WebP at quality 90 (`CLEAN_QUALITY`), PNG lossless — a palette PNG stays a
  palette PNG — and an animated WebP frame for frame. The name and the type
  do not change; the row's size is the new one.
- **The one EXIF a public photo keeps is the GPS stamp (GC-1).** A stamped
  photo is not encoded twice: the stamp re-encodes the picture itself and
  `withExif` writes only `exifFor`'s block, replacing whatever came in. The
  test compares the stamped phone photo's tags with a bare picture's under
  the same stamp: nothing of the phone's survives.
- **Never a failed upload over it.** Bytes sharp cannot decode (a HEIC — the
  prebuilt sharp decodes AV1 only, not HEVC) are stored as sent and logged
  once per type. A HEIC therefore still keeps its metadata until the phones
  send JPEG or the backend gains an HEVC decoder.
- **Private purposes are stored as sent** — they are evidence, and never
  public. Avatars were already stripped by their own normalisation.
- **SVG** is text and can carry script. It is taken for **BRANDING** and
  **MEDIA** only (any other purpose: **400 `UNSUPPORTED_TYPE`**), and never
  with a `<script`, an `on…=` handler, a `javascript:` URL (character
  references decoded, whitespace squeezed first), `<foreignObject`,
  `<iframe`, `<embed`, `<object`, or an `href`/`xlink:href` (any prefix)
  that is not `#…` or `data:image/…` — **400 `UNSAFE_SVG`**. Also refused,
  because they get around that list: an entity declaration, an animation
  that targets an event handler or a link, a CSS `@import` or outside
  `url(…)`, and text that is not UTF-8. The temp file goes with the refusal.
- **The stored name's extension follows the declared type**
  (`storedExtension`, `uploads.middleware.ts`), not the name the client sent:
  the disk provider's static mount types a file by its extension, so
  `evil.svg` sent as `image/png` would otherwise have been served back as an
  SVG without ever passing the gate.
- Along the way: the GPS stamp and the avatar crop were sized to the stored
  frame, not the upright picture, so a photo stored sideways (EXIF
  orientation 5–8) failed to stamp (the band wider than the picture) or to
  crop. Both now read the orientation.

`npm run storage:strip-existing [-- --check]` runs the same re-encode over the
PUBLIC images stored before (`stripExistingPublicImages`): in pages, each
row whose object still carries EXIF, XMP, IPTC, Photoshop's block or PNG
text is rewritten over the **same object** (R2 at the same key, the disk at
the same file — `public-objects.ts`), so its URL keeps working, and the row's
size follows. Geo-stamped rows are skipped; clean ones left alone; a file
that cannot be read or decoded is reported. An R2 object on a provider the
server no longer writes to is refused, never written elsewhere. Idempotent.
`--check` reads and reports, and writes nothing. (An R2 public URL behind a
CDN may serve the old bytes until the edge cache expires.)

Tests: `__tests__/st1-image-clean.test.ts` (real bytes),
`__tests__/st1-strip-existing.test.ts`.

## ST-2 (28 Sep 2026) — a listing's papers are private

The owner said "Sure, go ahead, build it" to a listing's venue papers (the
permit, the owner's NOC, the lease) and audience reports (a BARC sheet, a
footfall audit) no longer being public files. They are the private purpose
**LISTING_DOCUMENT** (folder `listing-documents`).

**Adopted at the door, whatever they were uploaded as.** The apps, the
website and the console upload papers as VERIFICATION, OTHER or LISTING_PHOTO
— and VERIFICATION also carries the installation, condition and site-visit
photos an advertiser is shown, so it stays PUBLIC. So when a document is
filed on a listing (`POST /supply/listings/:id/documents`, the only writer of
`ListingDocument.url`), `supply` hands the URL to `adoptListingDocument`
(`listing-documents.ts`). A URL that names a PUBLIC file in the register —
found by `/files/:id`, by the URL as recorded, or by the object's own name at
its end (a URL recorded on another host; the old public URL of a file since
moved, whose key kept the name) — is adopted: the object is copied to
`private/listing-documents/<name>`, the row becomes `LISTING_DOCUMENT`,
`PRIVATE`, with the new `storageKey` and `url = ${BASE_URL}/api/v1/files/:id`,
and only then is the public object deleted; the document is stored with the
`/files/:id` URL. Guards: only the purposes papers arrive under
(`ADOPTABLE_PURPOSES`: VERIFICATION, OTHER, LISTING_PHOTO — never an avatar, a
brand file, a creative or an order photo), and only a file the filer
uploaded or owns, or any file for the desk — otherwise anyone could name
somebody else's public picture as a paper on a listing of their own and take
it off the public web. An outside link is stored as given; a file already
private is answered with its working URL; a move that fails stores the URL as
given and logs (a paper is never refused or lost over its file), leaving the
row and the public object as they were.

**Who opens one.** The owner, the desk and the party's agent under a live
grant, as for every private file — and, through
`FileAccessPort.listingDocumentMayView(viewerUserId, fileId)`, composed in
bootstrap: the publisher of a listing whose document names the file
(`supply.listingsNamingFile` — by `/files/<id>`, or the object's name for a
URL recorded while it was public), the **field agent sent to that listing**
(`order-milestones.agentSentToListing`: a visit of theirs on one of its
orders dispatched or in progress, or completed within 30 days; or the
order's own agent while it is live or within 30 days after — the rule the
verification drawer's own read applies, widened from one milestone to the
listing), and an agent under a live grant on the listing's publisher.
Unregistered, the answer is no.

`npm run storage:privatise-listing-documents [-- --check]` does the same for
the documents filed before (`privatiseListingDocuments`): it selects files
by being named from `ListingDocument.url` (not by purpose), adopts each
public paper once (the platform as the filer), and rewrites every document
URL that named it — including one naming a file an earlier run moved — to
`<base>/api/v1/files/:id` (`BASE_URL`; without it, the host the file's own
`/uploads/…` URL was recorded under). Idempotent; `--check` reports only.

**ORDER_EVIDENCE** (public, folder `order-evidence`) is the order proof photo
both phones upload (pickup, condition, installed). It was not a purpose, so
it fell back to OTHER under `misc/` — never a 400, but misfiled.

Tests: `__tests__/st2-listing-documents.test.ts`,
`supply/__tests__/st2-listing-documents.test.ts`,
`order-milestones/__tests__/st2-agent-sent.test.ts`.

## ST-3 / ST-4 (28 Sep 2026) — the storage sweep and Settings › Storage

The owner asked how media is arranged and then said "Sure, go ahead, build
it" to a weekly sweep of files nothing on the platform refers to and a
read-only Storage page with the sweep's switch. The condition that shapes all
of it: **a wrong reference index must never delete a live file.** So the
sweep always marks and removes only when told to — removal is **OFF by
default** — and the retention-governed purposes are never touched.

| Method | Path | Guard | What |
| --- | --- | --- | --- |
| GET | `/api/v1/storage/summary` | ADMIN, `settings.view` | `{ generatedAt, totals: { files, bytes }, byPurpose: [{ purpose, folder, visibility, files, bytes, unreferencedFiles, unreferencedBytes, protected }], largest: [25 × { id, filename, purpose, mimeType, sizeBytes, createdAt, uploadedBy: { id, name } \| null }], sweep: { lastRunAt, lastMarked, lastRemoved, removeEnabled, graceDays, protectedPurposes, lastTrigger, lastChecked, lastCleared, lastUnreferenced, lastRemovalHeld, lastFailedAt, lastError } }` — one `byPurpose` row per purpose and visibility, largest space first |
| GET | `/api/v1/storage/unreferenced?purpose&page&pageSize` | ADMIN, `settings.view` | `{ items: [{ id, filename, purpose, mimeType, sizeBytes, createdAt, unreferencedSince, removableAt, url }], total, page, pageSize }` — oldest mark first; `removableAt` is the mark plus the grace days; pageSize 1–100 (25); never a protected purpose |
| POST | `/api/v1/storage/sweep` | ADMIN, `system.jobs` | "Check now": the mark phase, now — `{ checked, marked, cleared, unreferenced, ranAt, durationMs }`. It never removes on demand. **409** `CONFLICT` (`details.reason: SWEEP_RUNNING`) while another sweep holds the run lock |

The switch and the days are `platformSettings.storage = { removeUnreferenced
(false), graceDays (7–365, 30) }`, saved through the existing `PUT
/settings/platform`. Feature `settings.storage` (routes `/api/v1/storage`,
job `storage-sweep`).

**The reference registry (`references.ts`).** One explicit list —
`FILE_REFERENCES`, `(model, column, kind)` — of every column that can hold a
stored file: the KYC columns of all five parties, avatars, agent papers, the
employee file, listing photos, papers (`ListingDocument.url`, ST-2) and
verification photos, orders and their installation photos, a milestone's
evidence `value`, creatives, the media library (`MediaAsset` — the referrer
for every layout block, tile and paid placement drawn from it), invoices,
statements, payout exports, bank statements, top-up and bank proofs, reports,
data exports, e-sign documents, support attachments, dispute and fraud
evidence, lead photos, recordings, visit proofs, competitor sightings,
training media, and the JSON and text that carry URLs inside them (the
integrations/branding row and every other `AppConfig` document, brand
releases, layout versions, landing pages, forms and their answers, listing
drafts, onboarding submissions, custom field values, import rows, print
specs, lead evidence and proposals, content pages, legal documents,
agreement templates and what was signed). Kinds: `url`, `urlArray`,
`fileId`, `fileIdArray`, `json` (walked whole — keys too), `text`.
`NOT_A_FILE_REFERENCE` excuses, with a reason each, the columns whose name
looks like a file and is not one (a MediaType id, a display name, a
click-through URL). **`__tests__/st3-references.test.ts` reads
`prisma/schema.prisma` and fails** when a String / String[] / Json column
whose name matches `/(url|urls|photo|image|document|file|attachment|logo|icon|avatar|media|proof|evidence|artwork|creative|pdf)/i`
is in neither — a new file column cannot be forgotten, only decided. It also
fails on a registered column that no longer exists or changed type, and on a
stale excuse. `ActivityLog`, `Notification` and `NotificationDelivery` are
never referrers: the audit trail and a sent message do not keep a file.

**How a reference is recognised.** Every string a registered column holds is
URL-decoded and cut into tokens on the separators a URL, a path, JSON or
prose use; a file is referenced when one of its keys — its id, the last
segment of its URL, the last segment of its storage key — is a token. That
finds a public file under whatever host its URL was recorded with
(localhost, `10.0.2.2`, a LAN IP, Render, a later R2 domain), a private one
by its `/files/:id` URL or a bare id, and a link inside JSON, Markdown or an
encoded query. Every mistake the rule can make keeps a file (two files
sharing a name) — never the reverse. Only the keys of the files being judged
are kept, so the index is as big as the file table, not as every word read.

**The sweep (`sweep.service.ts`, `jobs/storage-sweep.job.ts`).** Hourly tick,
Redis tick lock + a week key (the week starts Monday 03:00 IST), skipped when
Redis is away (`orSkipWhenRedisDown`); a run lock shared with "Check now".
Every file older than 24 hours, in pages of 1,000:

1. **Mark.** The index is built WHOLE first — every registered table read in
   id-ordered pages of 1,000 — and a table that cannot be read (a renamed
   column, a model the client does not know) fails the run before a single
   row is written; it never reads as "nothing refers to anything". Then:
   referenced → `unreferencedSince` cleared; unreferenced → set if null (the
   first mark stands); `referenceCheckedAt` stamped either way.
2. **Remove** — scheduled runs only, only when `storage.removeUnreferenced`
   is on, only with an actor to audit under (the system user, else the first
   admin): the object and the row (`purgeStoredFile`, the path `DELETE
   /files/:id` takes) of each file unreferenced for `graceDays` or more,
   **re-checked in this run**, of a known removable purpose, with a storage
   key, audited **`FILE_SWEPT`** (purpose, visibility, name, size, URL, the
   mark, the grace days). A row with no storage key is kept and counted —
   the object cannot be found by it.

**Protected purposes are never touched** — not marked (a stale mark is
cleared), never removed: the five KYC purposes and `PRINT_PARTNER_KYC`,
`INVOICE`, `STATEMENT`, `PAYOUT_EXPORT`, `BANK_STATEMENT`, `TOPUP_PROOF`,
`SIGNED_AGREEMENT`, `DISPUTE_EVIDENCE`, `CALL_RECORDING` (its own 90-day
purge), `DATA_EXPORT` (its own 7-day purge), `REPORT`, `BOOKING_REPORT`,
`PARTNER_INVOICE` (`PROTECTED_PURPOSES`). A purpose this build does not know
is never removable either. What the index would have said about the
protected files is counted (`protectedUnreferenced`) and logged, so a gap in
the registry shows without anything being written. The last run (and a
failure beside it) is kept in the `AppConfig` row `storage-sweep`.

Reads across the schema happen in `prisma-storage.repository.ts` by model
name (`prisma[<model>]`), read-only; a model the client does not have is an
error, never an empty table.

Tests: `__tests__/st3-references.test.ts` (the schema scan, resolution on
fixtures), `__tests__/st3-sweep.test.ts` (mark / clear / the day's grace /
protected / a failed read writes nothing / removal off by default / grace /
manual never removes / paging), `__tests__/st4-storage-summary.test.ts`,
`app-config/__tests__/st4-storage-settings.test.ts`,
`jobs/__tests__/storage-sweep.job.test.ts`.

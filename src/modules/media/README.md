# media

LM-1 (27 Sep 2026): the picture library — every image a layout block, a tile
or a paid placement draws (`MediaAsset`).

A picture is stored once through the uploads door (`storeUpload`, purpose
`MEDIA`, public, folder `media`) and described here: pixel size (read with
sharp, EXIF quarter turns swapped), bytes, the spec it was checked against,
alt text, title, tags. It is never edited — a different picture is a new
asset — and never deleted, only archived, because layout history names it.

## Specs

| Key | Size | Minimum | Max bytes |
| --- | --- | --- | --- |
| `PROMO_WIDE` | 1600×480 | 1200×360 | 2 MB |
| `PROMO_SQUARE` | 1080×1080 | 810×810 | 2 MB |
| `TILE` | 600×600 | 450×450 | 1 MB |
| `AD_SIDEBAR` | 600×750 | 450×563 | 1 MB |
| `AD_BANNER` | 1456×180 | 1092×135 | 1 MB |

JPEG, PNG or WebP. With a spec named, the upload is held to the exact aspect
ratio within 1%, the minimum and the byte cap, and refused (400
`INVALID_IMAGE`, `details.problems[]`) before anything is stored. Without one,
any picture in those formats is taken as it is.

## Routes

| Method | Path | Guard | |
| --- | --- | --- | --- |
| GET | `/api/v1/media/specs` | ADMIN / ADVERTISER / AGENT_ADVERTISER, `content.view` (checked for ADMIN) | the specs |
| GET | `/api/v1/media?q=&tag=&spec=&archived=&owner=&limit=` | ADMIN `content.view` | newest first; `spec` may be comma-separated; `owner` = `adx` \| `advertisers` \| `all` (default) |
| POST | `/api/v1/media` | ADMIN `content.edit` | multipart `file` + `altText`, `title`, `tags` (list, JSON list or "a, b"), `spec` → 201 |
| GET | `/api/v1/media/:id` | ADMIN `content.view` | |
| PATCH | `/api/v1/media/:id` | ADMIN `content.edit` | `{ altText?, title?, tags? }` |
| POST | `/api/v1/media/:id/archive` | ADMIN `content.edit` | 409 `CONFLICT` `details: { reason: 'MEDIA_IN_USE', surfaces, usedIn[] }` while a PUBLISHED layout draws it; 409 `AD_ARTWORK_IN_USE` `details: { reason, ownerAdvertiserId, bookings[] }` for an advertiser's artwork while a booking showing it is not ENDED / REJECTED / CANCELLED |
| POST | `/api/v1/media/:id/restore` | ADMIN `content.edit` | |

Audited: `MEDIA_UPLOADED`, `MEDIA_EDITED`, `MEDIA_ARCHIVED`, `MEDIA_RESTORED`.

## For other modules

- `storeMediaFile(file, { spec, altText, title, tags, ownerAdvertiserId }, actor)` —
  `promotions` stores a buyer's ad artwork through it (behind uploads'
  `handleUploadMiddleware`), with `ownerAdvertiserId` set.
- `findMediaByIds`, `mediaRef`, `mediaIdsIn`, `MEDIA_SPECS`, `specFor`,
  `ratioMatches`, `checkAgainstSpec` — `layouts` resolves and validates with them.

The "used by a published layout" check reads `LayoutVersion` rows through this
module's own repository, so `media` never imports `layouts` (which imports it).
The "artwork on an open booking" check reads `AdBooking` (id, displayId,
status by `mediaId`) the same way, so `media` never imports `promotions`.

## Whose pictures (28 Sep 2026)

ADX's own pictures — tiles, banners, Studio images — have no
`ownerAdvertiserId`. An advertiser's ad artwork has one: it is uploaded with a
display ad, reviewed with it, and shown with it on the console's Ads &
sponsored › Display ads (the Gallery view). The console's Content › Media
library and both layout pickers (the console's and the website Studio's) ask
`owner=adx`; nothing else changes, because `all` is the default.

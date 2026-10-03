# layouts

LM-1 (27 Sep 2026): what each screen draws, in what order, for whom and when.
The owner: "Let's go for the layout management now."

Thirteen **surfaces** (`LayoutSurface`): the website's home, explore,
ad-formats and listing pages, the five other pages the website draws itself
(categories, how it works, advertise, for publishers, help — PB-3), and the
four app homes (advertiser, publisher, print partner, agent). Each is an
ordered list of **blocks**, versioned draft → published with history and
restore (`LayoutVersion`, one row per version). Clients draw the published
layout, skip block types they do not know, and fall back to their own baked
order when there is none or the read fails.

PB-1 (27 Sep 2026): a custom Studio page (`site-pages`) is versioned by the
same desk and resolved the same way — its rows are keyed `{ pageId }`
instead of a surface (`VersionKey`, exactly one of the two), its blocks are
checked in the `CUSTOM` scope (content blocks only), and a version may carry
`meta` (PB-4: the page's SEO). Every service function takes a `VersionRef`:
a surface by name, or a key.

## Blocks (`block-registry.ts`)

`{ id, type, props, visibility?: { sides?, cityIds?, stages? }, schedule?: { startsAt?, endsAt? }, hidden? }`

- **System blocks** — a section the client already draws natively. The
  layout controls order, visibility, schedule, and (for titled sections)
  `props.title`. Each belongs to the surfaces whose default order names it;
  on no other surface, at most once, and never on a custom page. On
  `WEB_EXPLORE`, `results` is always present, last, shown and untargeted.
- **Content blocks** (any surface, and a custom page): LM-1's
  `promo_banner`, `tile_grid`, `listing_rail`, `rich_text`, `ad_slot`, and
  PB-1's page blocks `hero`, `cta_strip`, `columns`, `image`, `video`,
  `faq`, `steps`, `stats`, `divider`, `button_row`, `category_tiles`,
  `listing_grid` (a rail laid out two to four across) and `form` (a form
  from Content › Forms by key) — each with a zod props schema and a
  `FieldSpec[]` the console builds its form from. `FieldSpec.input` adds
  `'list'` (with `of: FieldSpec[]`, `min`, `max`) for repeated groups,
  `'formKey'` for a form picked from the forms desk, and `'cta'` for a
  button (label + target; `of` spells the two); `hint` is an optional line
  of guidance.
- **Targets**: `{ kind, value? }` with kinds `ROUTE, URL, LISTING, CATEGORY,
  VENUE, CONTENT, NEW_CAMPAIGN, EXPLORE, PAGE`. `PAGE` names a Studio page by
  its key; the resolve adds `href`.
- **Meta** (`pageMetaSchema`): `{ seoTitle?, seoDescription?,
  seoImageMediaId?, noindex? }`, strict.
- **Defaults** = each surface's sections in today's order (`SURFACE_DEFAULT_ORDER`),
  with stable uuid-shaped ids; `WEB_LISTING`'s includes an `ad_slot` for
  `WEB_LISTING_SIDEBAR`. A custom page has none.

Safety-critical things (suspension banners, KYC/agreement gates, app bars,
full-screen gates) are not blocks and always draw where they are.

## Routes

| Method | Path | Guard | |
| --- | --- | --- | --- |
| GET | `/api/v1/app/layouts/:surface?side=&city=&cityId=&stage=&preview=` | `authenticateOptional` | the resolved layout (below); with a valid preview token for this surface, the draft |
| GET | `/api/v1/layouts` | ADMIN `content.view` | every surface: live `{number, publishedAt}` / draft `{number, updatedAt}` |
| GET | `/api/v1/layouts/block-types` | ADMIN `content.view` | the registry for the console |
| GET | `/api/v1/layouts/:surface` | ADMIN `content.view` | `{ surface, label, live, draft, defaults }` |
| PUT | `/api/v1/layouts/:surface/draft` | ADMIN `content.edit` | `{ blocks, meta?, changeNote? }` → the draft (created or replaced); `meta` left out keeps the draft's, `null` clears it |
| DELETE | `/api/v1/layouts/:surface/draft` | ADMIN `content.delete` | the delete power, as `content`'s own draft discard |
| GET | `/api/v1/layouts/:surface/preview?side=&city=&cityId=&stage=&version=draft\|default\|<n>` | ADMIN `content.view` | the public shape for that version |
| POST | `/api/v1/layouts/:surface/preview-token` | ADMIN `content.view` | `{ token, expiresAt }` — a day's token for the real page to show the draft |
| POST | `/api/v1/layouts/:surface/publish` | ADMIN `content.approve` | `{ changeNote? }`; the live one retires |
| GET | `/api/v1/layouts/:surface/versions` | ADMIN `content.view` | newest first |
| POST | `/api/v1/layouts/:surface/versions/:number/restore` | ADMIN `content.approve` | publishes a copy as the newest version |

`:surface` takes `APP_ADVERTISER_HOME` or `app-advertiser-home`. Every write is
audited (`LAYOUT_DRAFTED`, `LAYOUT_DRAFT_EDITED`, `LAYOUT_DRAFT_DISCARDED`,
`LAYOUT_PUBLISHED`, `LAYOUT_RESTORED`) — with `surface` or `pageId` in the
metadata. A custom page's versions go through `site-pages`' routes
(`/site/pages/:key/draft` …), which call the same service under `{ pageId }`.

A draft is refused (400 `VALIDATION_ERROR`, `details.issues[]` with
`index`, `blockId`, `type`, `path`, `message` — every problem at once) for an
unknown type, a system block off its surface, twice, or on a custom page, a
repeated id, a prop that fails its schema, and a picture that is missing,
archived, without alt text, or the wrong shape for its place (a banner's
aspect, a tile's square, a hero's wide, a column's tile or square, within
1%; a picture block takes any shape). `meta` is checked the same way
(`path: meta.<field>`, index -1; its picture must exist, be live and carry
alt text). Publish and restore check again.

## Preview tokens (`preview-token.ts`)

`signPreviewToken({ kind: 'page' | 'surface', ref })` → a JWT signed with the
access secret, `purpose: 'preview'`, 24 h. `verifyAccessToken` refuses any
token carrying `purpose`, so a preview token opens exactly the draft of the
one thing it names and never an authenticated route. `verifyPreviewToken`
answers false for an expired token, another ref or kind, or anything else.

## Resolution (`resolve.service.ts`)

`{ surface, version, isDefault, meta, blocks: [{ id, type, props }], preview? }`
— version 0 and `isDefault: true` while nothing is published; `meta` always
`{ seoTitle, seoDescription, seoImage: MediaRef | null, noindex }`.

- **Who**: `side` as sent; else, with a token, the side the surface is for when
  the account has it, else the account's first side; signed out is `VISITOR`.
  A custom page is for no side in particular (`sideFor(null, …)`).
- **Where**: `cityId`, or `city` by name through `pricing.citySupport` (the
  browse's resolver); the stage from the catalogue unless `stage` is sent.
- **Filter**: `hidden`, `schedule`, `visibility.sides/cityIds/stages` — a
  targeted block with nothing to match against is dropped.
- **Additions, all inside `props`**: `media: { url, width, height, altText }`
  beside every `mediaId` (tiles and columns too); `listing_rail` and
  `listing_grid` `props.query` — `{ sort?, category?, venueTypeId?,
  publisherId?, near?, ids?, pageSize }` for `GET /listings/browse` (`near:
  true` = add the device's lat/lng; `ids` = a curated list, which browse does
  not filter by today); `rich_text.props.markdown` from the published content
  page; `ad_slot.props.slot` `{ key, label, spec }` and `props.ads` — LIVE
  `AdBooking`s in the slot today in this city (or everywhere), shuffled per
  read, `[]` when none or when `promotions.ads` is off (the client then draws
  nothing); `form.props.form` — the form's published view through the port
  `forms` registers (`registerFormResolver`), `null` without one or when the
  form is not published (the client draws nothing); and every `PAGE` target,
  wherever it sits in the props, gains `href` = the page's current address
  when the page is live (`value` stays; no `href` otherwise).
- **Drops** a block that cannot be drawn: a banner, tile or picture block
  whose picture is archived since (a hero or a column keeps drawing without
  its picture), a page taken down, a slot that is gone or inactive, a type
  this build does not know.

**Cache**: in process, 60 s, keyed on the surface (or `page:<id>`), the live
version, the side, city, stage and UTC day (`resolve.cache.ts`); the live row
per key is cached the same way and forgotten on publish/restore. A preview read is never
cached (`Cache-Control: no-store`). Not Redis, so the homes keep answering
while Redis is down — and no Redis-backed rate limiter for the same reason.
`site-pages` forgets every entry on an address change, since `PAGE` hrefs sit
in every surface's answer.

`AdSlot`/`AdBooking` belong to `promotions`, `SitePage` to `site-pages`; this
module reads the one slot, the day's LIVE bookings and a live page's address
by key through its own repository, so `site-pages` imports `layouts` and
never the other way.

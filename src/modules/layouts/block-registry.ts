import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CityStage, LayoutSurface, ListingCategory } from '../../shared/database';

/**
 * LM-1 (27 Sep 2026): the block registry — every kind of section a layout
 * may name, what it takes, and where it may go.
 *
 * Two kinds. A SYSTEM block is a section the client already draws natively —
 * the greeting, the occupancy gauge, the results grid; the layout only
 * decides its order, who sees it and when, and at most overrides its title.
 * A CONTENT block is ADX's own: a banner, a grid of tiles, a rail of
 * listings, some text, a slot where sold ads rotate. Safety-critical things
 * (suspension banners, the KYC and agreement gates, app bars, full-screen
 * gates) are not blocks at all and always draw where they are.
 *
 * The console builds its forms from `FieldSpec[]` here, so a new block type
 * is one entry in this file and appears on the desk without a console change.
 */

export const LAYOUT_SURFACES = [
  'WEB_HOME',
  'WEB_EXPLORE',
  'WEB_FORMATS',
  'WEB_LISTING',
  'APP_ADVERTISER_HOME',
  'APP_PUBLISHER_HOME',
  'APP_PARTNER_HOME',
  'AGENT_HOME',
  // PB-3 (27 Sep 2026): the rest of the website's own pages, sections in Studio.
  'WEB_CATEGORIES',
  'WEB_HOW_IT_WORKS',
  'WEB_ADVERTISE',
  'WEB_PUBLISHERS',
  'WEB_HELP',
] as const satisfies readonly LayoutSurface[];

/** The website's surfaces — the pages Studio lays out on the web; the rest are app homes. */
export const WEB_SURFACES: readonly LayoutSurface[] = LAYOUT_SURFACES.filter((surface) => surface.startsWith('WEB_'));

/**
 * What the console calls each surface. Named after the page or screen it
 * lays out (the owner, 27 Sep 2026: "ad formats" read as if it configured the
 * ads product — it is the website's "Advertising formats" page).
 */
export const SURFACE_LABEL: Record<LayoutSurface, string> = {
  WEB_HOME: 'Website — Home page',
  WEB_EXPLORE: 'Website — Explore page',
  WEB_FORMATS: 'Website — Advertising formats page',
  WEB_LISTING: 'Website — Listing page',
  APP_ADVERTISER_HOME: 'User app — Advertiser home',
  APP_PUBLISHER_HOME: 'User app — Publisher home',
  APP_PARTNER_HOME: 'User app — Print partner home',
  AGENT_HOME: 'Agent app — Home',
  WEB_CATEGORIES: 'Website — All categories page',
  WEB_HOW_IT_WORKS: 'Website — How it works page',
  WEB_ADVERTISE: 'Website — Advertise with ADX page',
  WEB_PUBLISHERS: 'Website — For publishers page',
  WEB_HELP: 'Website — Help page',
};

/** A city's stage, as the catalogue stores it (Lot V) — targeting names these. */
export const CITY_STAGES = ['PLANNED', 'SEEDING', 'LAUNCHED', 'PAUSED', 'WITHDRAWN'] as const satisfies readonly CityStage[];

/** The four listing categories a category rail may name — the enum, spelled here so the registry stays a leaf. */
export const LISTING_CATEGORIES = ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] as const satisfies readonly ListingCategory[];

/** Who is looking. VISITOR is signed out; an account with several sides names the one it is on. */
export const SIDES = ['VISITOR', 'ADVERTISER', 'PUBLISHER', 'PARTNER', 'AGENT_FIELD', 'AGENT_SALES'] as const;
export type Side = (typeof SIDES)[number];

/** PB-1: `PAGE` names a Studio page by its key — the website resolves it to the page's current address, the apps open the Page screen. */
export const TARGET_KINDS = ['ROUTE', 'URL', 'LISTING', 'CATEGORY', 'VENUE', 'CONTENT', 'NEW_CAMPAIGN', 'EXPLORE', 'PAGE'] as const;
export const RAIL_SOURCES = ['RATING', 'NEWEST', 'NEAR_YOU', 'CATEGORY', 'VENUE', 'PUBLISHER', 'CURATED'] as const;

/* ── System blocks ──────────────────────────────────────────────────── */

type SystemMeta = { label: string; titled: boolean };

const SYSTEM_META: Record<string, SystemMeta> = {
  greeting: { label: 'Greeting', titled: false },
  setup_card: { label: 'Set-up progress card', titled: false },
  search_bar: { label: 'Search bar', titled: false },
  category_mosaic: { label: 'Category mosaic', titled: true },
  popular_rail: { label: 'Popular listings rail', titled: true },
  nearby_listings: { label: 'Listings near you', titled: true },
  campaign_summary_strip: { label: 'Campaign summary strip', titled: true },
  occupancy_gauge: { label: 'Occupancy gauge', titled: true },
  quick_tiles: { label: 'Quick tiles', titled: false },
  spots_map: { label: 'My spots map', titled: true },
  licence_sign_card: { label: 'Licence signing card', titled: false },
  onboarding_slot: { label: 'Onboarding slot', titled: false },
  platform_terms_card: { label: 'Platform terms card', titled: false },
  plan_upsell_card: { label: 'Plan upsell card', titled: false },
  access_log_button: { label: 'Access log button', titled: false },
  off_roster_note: { label: 'Off-roster note', titled: false },
  kyc_banner: { label: 'KYC banner', titled: false },
  agreement_sign_card: { label: 'Agreement signing card', titled: false },
  partner_hero: { label: 'Partner hero', titled: false },
  today_jobs: { label: "Today's jobs", titled: true },
  open_quote_requests: { label: 'Open quote requests', titled: true },
  wallet_card: { label: 'Wallet card', titled: true },
  tier_header: { label: 'Tier header', titled: false },
  tasks_card: { label: 'Tasks card', titled: true },
  agent_map: { label: 'Agent map', titled: true },
  explore_search: { label: 'Explore search', titled: false },
  category_strip: { label: 'Category strip', titled: true },
  campaign_strip: { label: 'Campaign strip', titled: true },
  results: { label: 'Filters and results', titled: false },
  formats_hero: { label: 'Formats hero', titled: false },
  format_cards: { label: 'Format cards', titled: true },
  venue_tiles: { label: 'Venue tiles', titled: true },
  guides_strip: { label: 'Guides strip', titled: true },
  legacy_home: { label: 'Home page body', titled: false },
  publisher_listings: { label: "Publisher's other listings", titled: true },
  // PB-3: the five pages' own sections, named after what the reader sees.
  categories_hero: { label: 'Categories heading', titled: false },
  category_sections: { label: 'Category and venue tiles', titled: false },
  hiw_hero: { label: 'How it works hero', titled: false },
  hiw_steps: { label: 'The steps, with "On this page"', titled: false },
  advertise_hero: { label: 'Advertise hero', titled: false },
  display_ads_section: { label: 'Display ads', titled: true },
  sponsored_listings_section: { label: 'Sponsored listings', titled: true },
  publishers_hero: { label: 'Publishers hero', titled: false },
  publishers_steps: { label: 'How listing works (steps)', titled: false },
  publishers_forms: { label: 'What you can list (formats)', titled: false },
  publishers_faq: { label: 'Questions before you list', titled: true },
  help_hero: { label: 'Help hero with search', titled: false },
  help_topics: { label: 'Help topics', titled: true },
  help_contact: { label: 'Need a hand?', titled: true },
  help_faq: { label: 'Common questions', titled: true },
};

/**
 * Each surface's blocks in today's order — the default layout, answered as
 * version 0 while nothing is published. `ad_slot` on the listing page is a
 * content block (the sidebar slot ADX sells), placed there by default.
 */
export const SURFACE_DEFAULT_ORDER: Record<LayoutSurface, readonly string[]> = {
  APP_ADVERTISER_HOME: ['greeting', 'setup_card', 'search_bar', 'category_mosaic', 'popular_rail', 'nearby_listings', 'campaign_summary_strip'],
  APP_PUBLISHER_HOME: [
    'greeting',
    'occupancy_gauge',
    'quick_tiles',
    'spots_map',
    'licence_sign_card',
    'onboarding_slot',
    'platform_terms_card',
    'plan_upsell_card',
    'access_log_button',
  ],
  APP_PARTNER_HOME: ['off_roster_note', 'kyc_banner', 'agreement_sign_card', 'partner_hero', 'today_jobs', 'open_quote_requests', 'wallet_card'],
  AGENT_HOME: ['tier_header', 'quick_tiles', 'tasks_card', 'agent_map'],
  WEB_EXPLORE: ['explore_search', 'category_strip', 'campaign_strip', 'popular_rail', 'results'],
  WEB_FORMATS: ['formats_hero', 'format_cards', 'venue_tiles', 'guides_strip'],
  WEB_HOME: ['legacy_home'],
  WEB_LISTING: ['publisher_listings', 'ad_slot'],
  WEB_CATEGORIES: ['categories_hero', 'category_sections'],
  WEB_HOW_IT_WORKS: ['hiw_hero', 'hiw_steps'],
  WEB_ADVERTISE: ['advertise_hero', 'display_ads_section', 'sponsored_listings_section'],
  WEB_PUBLISHERS: ['publishers_hero', 'publishers_steps', 'publishers_forms', 'publishers_faq'],
  WEB_HELP: ['help_hero', 'help_topics', 'help_contact', 'help_faq'],
};

/** The ad slot the listing page's sidebar sells, as the promotions seed names it. */
export const WEB_LISTING_SIDEBAR_SLOT = 'WEB_LISTING_SIDEBAR';

/** Blocks that must close their surface and can never be hidden or targeted away. */
export const PINNED_LAST: Partial<Record<LayoutSurface, string>> = { WEB_EXPLORE: 'results' };

/** Which surfaces a system block belongs to — read off the default order, so the two never disagree. */
export function surfacesOfSystem(type: string): LayoutSurface[] {
  return LAYOUT_SURFACES.filter((surface) => SURFACE_DEFAULT_ORDER[surface].includes(type) && type in SYSTEM_META);
}

export const isSystemType = (type: string): boolean => type in SYSTEM_META;

/* ── Content blocks ─────────────────────────────────────────────────── */

const id64 = z.string().trim().min(1).max(64);

export const targetSchema = z
  .object({
    kind: z.enum(TARGET_KINDS),
    value: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((target, ctx) => {
    const needsValue = target.kind !== 'NEW_CAMPAIGN' && target.kind !== 'EXPLORE';
    if (needsValue && !target.value) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `A ${target.kind} target says where it goes` });
      return;
    }
    if (target.kind === 'ROUTE' && target.value && !target.value.startsWith('/')) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'A route is a website path that starts with "/" — "/spaces?city=Pune"' });
    }
    if (target.kind === 'URL' && target.value && !/^https?:\/\/\S+$/i.test(target.value)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'A URL starts with http:// or https://' });
    }
  });
export type Target = z.infer<typeof targetSchema>;

const titleOverride = z.object({ title: z.string().trim().min(1).max(80).optional() });
const untitled = z.object({});

const promoBanner = z.object({
  mediaId: id64,
  headline: z.string().trim().max(120).optional(),
  body: z.string().trim().max(400).optional(),
  ctaLabel: z.string().trim().max(40).optional(),
  target: targetSchema,
  aspect: z.enum(['WIDE', 'SQUARE']),
});

const tileGrid = z.object({
  title: z.string().trim().max(80).optional(),
  tiles: z
    .array(z.object({ mediaId: id64, label: z.string().trim().min(1).max(40), target: targetSchema }))
    .min(1, 'A tile grid has at least one tile')
    .max(12, 'A tile grid has at most twelve tiles'),
  columns: z.coerce
    .number()
    .int()
    .refine((value) => value === 2 || value === 3 || value === 4, 'Two, three or four columns')
    .optional(),
});

/* ── PB-1 (27 Sep 2026): the page-building blocks ───────────────────── */

/** A button: what it says and where it goes. */
const ctaSchema = z.object({ label: z.string().trim().min(1).max(40), target: targetSchema });

const hero = z.object({
  headline: z.string().trim().min(1).max(120),
  subheadline: z.string().trim().max(300).optional(),
  mediaId: id64.optional(),
  primaryCta: ctaSchema.optional(),
  secondaryCta: ctaSchema.optional(),
  align: z.enum(['LEFT', 'CENTER']).default('LEFT'),
});

const ctaStrip = z.object({
  headline: z.string().trim().min(1).max(120),
  body: z.string().trim().max(300).optional(),
  ctaLabel: z.string().trim().min(1).max(40),
  target: targetSchema,
  tone: z.enum(['BRAND', 'INK', 'PAPER']).default('BRAND'),
});

const columns = z.object({
  columns: z
    .array(
      z.object({
        title: z.string().trim().max(80).optional(),
        markdown: z.string().trim().min(1).max(4000),
        mediaId: id64.optional(),
        target: targetSchema.optional(),
      }),
    )
    .min(2, 'Two to four columns')
    .max(4, 'Two to four columns'),
});

const image = z.object({
  mediaId: id64,
  caption: z.string().trim().max(200).optional(),
  target: targetSchema.optional(),
  width: z.enum(['FULL', 'CONTAINED']).default('CONTAINED'),
});

/** A YouTube or Vimeo page or embed link, or an https .mp4 — the three players a client draws. */
export function isVideoUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    return /^[\w-]{6,}$/.test(url.searchParams.get('v') ?? '') || /^\/(embed|shorts|live)\/[\w-]{6,}$/.test(url.pathname);
  }
  if (host === 'youtu.be') return /^\/[\w-]{6,}$/.test(url.pathname);
  if (host === 'vimeo.com') return /^\/\d+/.test(url.pathname);
  if (host === 'player.vimeo.com') return /^\/video\/\d+/.test(url.pathname);
  return /\.mp4$/i.test(url.pathname);
}

const video = z.object({
  url: z.string().trim().max(500).refine(isVideoUrl, 'A video is a YouTube or Vimeo link, or an https link to an .mp4'),
  caption: z.string().trim().max(200).optional(),
});

const faq = z.object({
  title: z.string().trim().max(80).optional(),
  items: z
    .array(z.object({ question: z.string().trim().min(1).max(200), answer: z.string().trim().min(1).max(2000) }))
    .min(1, 'At least one question')
    .max(20, 'At most twenty questions'),
});

const steps = z.object({
  title: z.string().trim().max(80).optional(),
  items: z
    .array(z.object({ title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(400) }))
    .min(2, 'Two to eight steps')
    .max(8, 'Two to eight steps'),
});

const stats = z.object({
  items: z
    .array(z.object({ value: z.string().trim().min(1).max(20), label: z.string().trim().min(1).max(60) }))
    .min(2, 'Two to four figures')
    .max(4, 'Two to four figures'),
});

const divider = z.object({ style: z.enum(['LINE', 'SPACE']).default('LINE') });

const buttonRow = z.object({
  buttons: z
    .array(z.object({ label: z.string().trim().min(1).max(40), target: targetSchema, style: z.enum(['PRIMARY', 'SECONDARY']).default('PRIMARY') }))
    .min(1, 'At least one button')
    .max(4, 'At most four buttons'),
});

const categoryTiles = z.object({ title: z.string().trim().max(80).optional() });

/** A form's key — the same shape as a content slug or a page key. */
export const FORM_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const form = z.object({
  formKey: z.string().trim().regex(FORM_KEY, 'A form key is lowercase letters, digits and single hyphens').max(64),
  heading: z.string().trim().max(120).optional(),
  intro: z.string().trim().max(400).optional(),
});

/**
 * PB-4: what a search result and a shared link say about a page — versioned
 * with the blocks, so a draft's SEO goes live with it. `seoImageMediaId` is
 * a library picture of any spec; the resolve hands clients its `MediaRef`.
 */
export const pageMetaSchema = z
  .object({
    seoTitle: z.string().trim().max(120).nullish(),
    seoDescription: z.string().trim().max(300).nullish(),
    seoImageMediaId: id64.nullish(),
    noindex: z.boolean().nullish(),
  })
  .strict();
export type PageMeta = { seoTitle?: string; seoDescription?: string; seoImageMediaId?: string; noindex?: boolean };

const listingRailBase = z.object({
  title: z.string().trim().min(1).max(80),
  source: z.enum(RAIL_SOURCES),
  value: z.string().trim().min(1).max(64).optional(),
  listingIds: z.array(id64).max(12).optional(),
  count: z.coerce.number().int().min(1).max(12),
  seeAllLabel: z.string().trim().max(40).optional(),
});

/** What a rail (and PB-1's grid, which shares its source) must say beyond its shape. */
const railRefinement = (rail: z.infer<typeof listingRailBase>, ctx: z.RefinementCtx) => {
  if ((rail.source === 'CATEGORY' || rail.source === 'VENUE' || rail.source === 'PUBLISHER') && !rail.value) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: `A ${rail.source.toLowerCase()} rail names which one` });
  }
  if (rail.source === 'CATEGORY' && rail.value && !(LISTING_CATEGORIES as readonly string[]).includes(rail.value)) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: `A category is one of ${LISTING_CATEGORIES.join(', ')}` });
  }
  if (rail.source === 'CURATED' && !rail.listingIds?.length) {
    ctx.addIssue({ code: 'custom', path: ['listingIds'], message: 'A curated rail lists its listings' });
  }
};

const listingRail = listingRailBase.superRefine(railRefinement);

const columnsCount = z.coerce
  .number()
  .int()
  .refine((value) => value === 2 || value === 3 || value === 4, 'Two, three or four columns');

/** PB-1: a rail laid out as a grid — the rail's source, two to four across. */
const listingGrid = listingRailBase.extend({ columns: columnsCount.default(3) }).superRefine(railRefinement);

const richText = z
  .object({
    markdown: z.string().max(20_000).optional(),
    contentSlug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'A content slug is lowercase letters, digits and single hyphens')
      .max(80)
      .optional(),
  })
  .refine((text) => Boolean(text.markdown?.trim()) !== Boolean(text.contentSlug), {
    message: 'Text is either written here (markdown) or a published page (contentSlug) — one of the two',
  });

const adSlot = z.object({
  slotKey: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'A slot key is upper-case letters, digits and underscores — WEB_LISTING_SIDEBAR'),
});

/* ── The console's form descriptors ─────────────────────────────────── */

export type FieldInput =
  | 'text'
  | 'textarea'
  | 'markdown'
  | 'media'
  | 'target'
  | 'select'
  | 'multiselect'
  | 'number'
  | 'listingIds'
  | 'slotKey'
  | 'contentSlug'
  /** A repeated group of fields (the tiles of a tile grid): `of` describes one item, `min`/`max` bound the count. */
  | 'list'
  /** PB-1: a form's key, picked from the forms desk (`GET /forms`). */
  | 'formKey'
  /** PB-1: a button — a label and a target together; `of` spells the two fields for a builder that draws them apart. */
  | 'cta';

export type FieldSpec = {
  key: string;
  label: string;
  input: FieldInput;
  required?: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  /** For a `media` field: the spec key(s) the picture should meet, comma-separated when either shape fits. */
  spec?: string;
  /** For a `list` field: the fields of one item. */
  of?: FieldSpec[];
  /** One line of guidance the form may show under the field's label. */
  hint?: string;
};

const TARGET_FIELD = (key: string, label: string, required = true): FieldSpec => ({ key, label, input: 'target', required });

/** PB-1: a button field — the label and the target as one group. */
const CTA_FIELD = (key: string, label: string, required = false): FieldSpec => ({
  key,
  label,
  input: 'cta',
  required,
  of: [{ key: 'label', label: 'Label', input: 'text', required: true, max: 40 }, TARGET_FIELD('target', 'Opens')],
});

/** The rail's fields, shared with the grid. */
const RAIL_FIELDS: FieldSpec[] = [
  { key: 'title', label: 'Title', input: 'text', required: true, max: 80 },
  {
    key: 'source',
    label: 'Listings',
    input: 'select',
    required: true,
    options: [
      { value: 'RATING', label: 'Best rated' },
      { value: 'NEWEST', label: 'Newest' },
      { value: 'NEAR_YOU', label: 'Near the viewer' },
      { value: 'CATEGORY', label: 'One category' },
      { value: 'VENUE', label: 'One venue type' },
      { value: 'PUBLISHER', label: 'One publisher' },
      { value: 'CURATED', label: 'Hand-picked' },
    ],
  },
  { key: 'value', label: 'Which one', input: 'text', max: 64, hint: `Category (${LISTING_CATEGORIES.join(', ')}), venue type id or publisher id` },
  { key: 'listingIds', label: 'Listings', input: 'listingIds', max: 12, hint: 'For a hand-picked rail' },
  { key: 'count', label: 'How many', input: 'number', required: true, min: 1, max: 12 },
  { key: 'seeAllLabel', label: '"See all" label', input: 'text', max: 40 },
];

const COLUMNS_FIELD: FieldSpec = {
  key: 'columns',
  label: 'Columns',
  input: 'select',
  options: [{ value: '2', label: 'Two' }, { value: '3', label: 'Three' }, { value: '4', label: 'Four' }],
};

export type BlockKind = 'SYSTEM' | 'CONTENT';

type ContentEntry = { label: string; schema: z.ZodType; props: FieldSpec[] };

const CONTENT_BLOCKS: Record<string, ContentEntry> = {
  promo_banner: {
    label: 'Promo banner',
    schema: promoBanner,
    props: [
      { key: 'aspect', label: 'Shape', input: 'select', required: true, options: [{ value: 'WIDE', label: 'Wide — 1600×480' }, { value: 'SQUARE', label: 'Square — 1080×1080' }] },
      { key: 'mediaId', label: 'Picture', input: 'media', required: true, spec: 'PROMO_WIDE,PROMO_SQUARE', hint: 'Wide takes a PROMO_WIDE picture, square a PROMO_SQUARE one' },
      { key: 'headline', label: 'Headline', input: 'text', max: 120 },
      { key: 'body', label: 'Body', input: 'textarea', max: 400 },
      { key: 'ctaLabel', label: 'Button label', input: 'text', max: 40 },
      TARGET_FIELD('target', 'Opens'),
    ],
  },
  tile_grid: {
    label: 'Tile grid',
    schema: tileGrid,
    props: [
      { key: 'title', label: 'Title', input: 'text', max: 80 },
      { key: 'columns', label: 'Columns', input: 'select', options: [{ value: '2', label: 'Two' }, { value: '3', label: 'Three' }, { value: '4', label: 'Four' }] },
      {
        key: 'tiles',
        label: 'Tiles',
        input: 'list',
        required: true,
        min: 1,
        max: 12,
        of: [
          { key: 'mediaId', label: 'Picture', input: 'media', required: true, spec: 'TILE' },
          { key: 'label', label: 'Label', input: 'text', required: true, max: 40 },
          TARGET_FIELD('target', 'Opens'),
        ],
      },
    ],
  },
  listing_rail: {
    label: 'Listing rail',
    schema: listingRail,
    props: RAIL_FIELDS,
  },
  rich_text: {
    label: 'Text',
    schema: richText,
    props: [
      { key: 'markdown', label: 'Text', input: 'markdown', max: 20_000, hint: 'Or name a published content page below — one of the two' },
      { key: 'contentSlug', label: 'Content page', input: 'contentSlug', max: 80 },
    ],
  },
  ad_slot: {
    label: 'Ad slot (sold ads)',
    schema: adSlot,
    props: [{ key: 'slotKey', label: 'Slot', input: 'slotKey', required: true, hint: 'Ads booked in this slot rotate here; with none live, nothing is drawn' }],
  },
  // PB-1 (27 Sep 2026): the blocks a whole page is built from. The owner:
  // "create whole new pages … being able to add new elements besides old ones".
  hero: {
    label: 'Hero',
    schema: hero,
    props: [
      { key: 'headline', label: 'Headline', input: 'text', required: true, max: 120 },
      { key: 'subheadline', label: 'Subheadline', input: 'textarea', max: 300 },
      { key: 'mediaId', label: 'Picture', input: 'media', spec: 'PROMO_WIDE', hint: 'A wide picture behind or beside the words' },
      CTA_FIELD('primaryCta', 'Primary button'),
      CTA_FIELD('secondaryCta', 'Secondary button'),
      { key: 'align', label: 'Alignment', input: 'select', options: [{ value: 'LEFT', label: 'Left' }, { value: 'CENTER', label: 'Centred' }] },
    ],
  },
  cta_strip: {
    label: 'Call-to-action strip',
    schema: ctaStrip,
    props: [
      { key: 'headline', label: 'Headline', input: 'text', required: true, max: 120 },
      { key: 'body', label: 'Body', input: 'textarea', max: 300 },
      { key: 'ctaLabel', label: 'Button label', input: 'text', required: true, max: 40 },
      TARGET_FIELD('target', 'Opens'),
      {
        key: 'tone',
        label: 'Tone',
        input: 'select',
        options: [{ value: 'BRAND', label: 'Brand colour' }, { value: 'INK', label: 'Dark' }, { value: 'PAPER', label: 'Light' }],
      },
    ],
  },
  columns: {
    label: 'Columns',
    schema: columns,
    props: [
      {
        key: 'columns',
        label: 'Columns',
        input: 'list',
        required: true,
        min: 2,
        max: 4,
        of: [
          { key: 'title', label: 'Title', input: 'text', max: 80 },
          { key: 'markdown', label: 'Text', input: 'markdown', required: true, max: 4000 },
          { key: 'mediaId', label: 'Picture', input: 'media', spec: 'TILE,PROMO_SQUARE' },
          TARGET_FIELD('target', 'Opens', false),
        ],
      },
    ],
  },
  image: {
    label: 'Picture',
    schema: image,
    props: [
      { key: 'mediaId', label: 'Picture', input: 'media', required: true, hint: 'Any shape from the library' },
      { key: 'caption', label: 'Caption', input: 'text', max: 200 },
      TARGET_FIELD('target', 'Opens', false),
      { key: 'width', label: 'Width', input: 'select', options: [{ value: 'CONTAINED', label: 'Within the page' }, { value: 'FULL', label: 'Edge to edge' }] },
    ],
  },
  video: {
    label: 'Video',
    schema: video,
    props: [
      { key: 'url', label: 'Video link', input: 'text', required: true, max: 500, hint: 'A YouTube or Vimeo link, or an https .mp4' },
      { key: 'caption', label: 'Caption', input: 'text', max: 200 },
    ],
  },
  faq: {
    label: 'Questions and answers',
    schema: faq,
    props: [
      { key: 'title', label: 'Title', input: 'text', max: 80 },
      {
        key: 'items',
        label: 'Questions',
        input: 'list',
        required: true,
        min: 1,
        max: 20,
        of: [
          { key: 'question', label: 'Question', input: 'text', required: true, max: 200 },
          { key: 'answer', label: 'Answer', input: 'markdown', required: true, max: 2000 },
        ],
      },
    ],
  },
  steps: {
    label: 'Steps',
    schema: steps,
    props: [
      { key: 'title', label: 'Title', input: 'text', max: 80 },
      {
        key: 'items',
        label: 'Steps',
        input: 'list',
        required: true,
        min: 2,
        max: 8,
        of: [
          { key: 'title', label: 'Title', input: 'text', required: true, max: 80 },
          { key: 'body', label: 'Body', input: 'textarea', required: true, max: 400 },
        ],
      },
    ],
  },
  stats: {
    label: 'Figures',
    schema: stats,
    props: [
      {
        key: 'items',
        label: 'Figures',
        input: 'list',
        required: true,
        min: 2,
        max: 4,
        of: [
          { key: 'value', label: 'Figure', input: 'text', required: true, max: 20, hint: '"12,000+"' },
          { key: 'label', label: 'Label', input: 'text', required: true, max: 60, hint: '"ad spaces listed"' },
        ],
      },
    ],
  },
  divider: {
    label: 'Divider',
    schema: divider,
    props: [{ key: 'style', label: 'Style', input: 'select', options: [{ value: 'LINE', label: 'A line' }, { value: 'SPACE', label: 'Empty space' }] }],
  },
  button_row: {
    label: 'Buttons',
    schema: buttonRow,
    props: [
      {
        key: 'buttons',
        label: 'Buttons',
        input: 'list',
        required: true,
        min: 1,
        max: 4,
        of: [
          { key: 'label', label: 'Label', input: 'text', required: true, max: 40 },
          TARGET_FIELD('target', 'Opens'),
          { key: 'style', label: 'Style', input: 'select', options: [{ value: 'PRIMARY', label: 'Primary' }, { value: 'SECONDARY', label: 'Secondary' }] },
        ],
      },
    ],
  },
  category_tiles: {
    label: 'Category tiles',
    schema: categoryTiles,
    props: [{ key: 'title', label: 'Title', input: 'text', max: 80, hint: "The site's own category mosaic — the client draws it" }],
  },
  listing_grid: {
    label: 'Listing grid',
    schema: listingGrid,
    props: [...RAIL_FIELDS, COLUMNS_FIELD],
  },
  form: {
    label: 'Form',
    schema: form,
    props: [
      { key: 'formKey', label: 'Form', input: 'formKey', required: true, max: 64, hint: 'A published form from Content › Forms; unpublished, nothing is drawn' },
      { key: 'heading', label: 'Heading', input: 'text', max: 120 },
      { key: 'intro', label: 'Intro', input: 'textarea', max: 400 },
    ],
  },
};

/** PB-1: the content blocks, in registry order — what a custom page may be built from. */
export const CONTENT_TYPES: readonly string[] = Object.keys(CONTENT_BLOCKS);

export const isContentType = (type: string): boolean => type in CONTENT_BLOCKS;
export const isKnownType = (type: string): boolean => isSystemType(type) || isContentType(type);

/** The props schema a block of this type is held to. */
export function propsSchemaFor(type: string): z.ZodType | null {
  if (type in CONTENT_BLOCKS) return CONTENT_BLOCKS[type]!.schema;
  const meta = SYSTEM_META[type];
  if (!meta) return null;
  return meta.titled ? titleOverride : untitled;
}

export type BlockTypeView = { type: string; label: string; kind: BlockKind; surfaces: LayoutSurface[]; props: FieldSpec[] };

/** `GET /layouts/block-types` — every type, the surfaces it may go on, and the form for its props. */
export function blockTypes(): BlockTypeView[] {
  const system: BlockTypeView[] = Object.entries(SYSTEM_META).map(([type, meta]) => ({
    type,
    label: meta.label,
    kind: 'SYSTEM',
    surfaces: surfacesOfSystem(type),
    props: meta.titled ? [{ key: 'title', label: 'Title override', input: 'text', max: 80, hint: 'Leave empty for the section’s own title' }] : [],
  }));
  const content: BlockTypeView[] = Object.entries(CONTENT_BLOCKS).map(([type, entry]) => ({
    type,
    label: entry.label,
    kind: 'CONTENT',
    surfaces: [...LAYOUT_SURFACES],
    props: entry.props,
  }));
  return [...system, ...content];
}

/* ── The block envelope ─────────────────────────────────────────────── */

export const blockSchema = z.object({
  id: id64,
  type: z.string().trim().min(1).max(64),
  props: z.record(z.string(), z.unknown()).default({}),
  visibility: z
    .object({
      sides: z.array(z.enum(SIDES)).max(SIDES.length).optional(),
      cityIds: z.array(id64).max(200).optional(),
      stages: z.array(z.enum(CITY_STAGES)).max(CITY_STAGES.length).optional(),
    })
    .optional(),
  schedule: z
    .object({ startsAt: z.string().datetime({ offset: true }).optional(), endsAt: z.string().datetime({ offset: true }).optional() })
    .refine((window) => !window.startsAt || !window.endsAt || Date.parse(window.startsAt) < Date.parse(window.endsAt), {
      message: 'A block ends after it starts',
      path: ['endsAt'],
    })
    .optional(),
  hidden: z.boolean().optional(),
});
export type Block = z.infer<typeof blockSchema>;

export const MAX_BLOCKS = 40;

export type BlockIssue = { index: number; blockId: string | null; type: string | null; path: string; message: string };

/**
 * PB-1: where a list of blocks is going — a surface, or `CUSTOM` for a Studio
 * page of its own, which is built from content blocks only (a system section
 * is a part of the screen that draws it natively; a custom page has none).
 */
export type BlockScope = LayoutSurface | 'CUSTOM';

/**
 * Every way a list of blocks is wrong for a surface, or the clean blocks.
 * Unknown types, a system block off its surface or twice, a repeated id, a
 * prop that fails its type's schema, a pinned-last block moved, hidden or
 * targeted — each is one issue with the block's index and the prop path.
 */
export function validateBlocks(scope: BlockScope, raw: unknown): { blocks: Block[]; issues: BlockIssue[] } {
  const surface: LayoutSurface | null = scope === 'CUSTOM' ? null : scope;
  const issues: BlockIssue[] = [];
  if (!Array.isArray(raw)) return { blocks: [], issues: [{ index: -1, blockId: null, type: null, path: 'blocks', message: 'blocks is a list' }] };
  if (raw.length > MAX_BLOCKS) issues.push({ index: -1, blockId: null, type: null, path: 'blocks', message: `At most ${MAX_BLOCKS} blocks on one ${surface ? 'surface' : 'page'}` });
  const blocks: Block[] = [];
  const ids = new Set<string>();
  const systemSeen = new Set<string>();
  raw.forEach((candidate, index) => {
    const envelope = blockSchema.safeParse(candidate);
    const loose = (candidate ?? {}) as { id?: unknown; type?: unknown };
    const blockId = typeof loose.id === 'string' ? loose.id : null;
    const type = typeof loose.type === 'string' ? loose.type : null;
    const issue = (path: string, message: string) => issues.push({ index, blockId, type, path, message });
    if (!envelope.success) {
      for (const problem of envelope.error.issues) issue(problem.path.join('.') || '(block)', problem.message);
      return;
    }
    const block = envelope.data;
    if (ids.has(block.id)) issue('id', `Two blocks share the id "${block.id}"`);
    ids.add(block.id);
    const schema = propsSchemaFor(block.type);
    if (!schema) {
      issue('type', `Unknown block type "${block.type}"`);
      return;
    }
    if (isSystemType(block.type)) {
      if (!surface) {
        issue('type', `"${block.type}" is a section of ${surfacesOfSystem(block.type).join(', ') || 'no surface'} — a custom page is built from content blocks only`);
        return;
      }
      if (!surfacesOfSystem(block.type).includes(surface)) {
        issue('type', `"${block.type}" is a section of ${surfacesOfSystem(block.type).join(', ') || 'no surface'}, not ${surface}`);
        return;
      }
      if (systemSeen.has(block.type)) issue('type', `"${block.type}" is on this surface twice`);
      systemSeen.add(block.type);
    }
    const props = schema.safeParse(block.props ?? {});
    if (!props.success) {
      for (const problem of props.error.issues) issue(['props', ...problem.path].join('.'), problem.message);
      return;
    }
    blocks.push({ ...block, props: props.data as Record<string, unknown> });
  });
  const pinned = surface ? PINNED_LAST[surface] : undefined;
  if (pinned && surface && issues.length === 0) {
    const at = blocks.findIndex((block) => block.type === pinned);
    const block = blocks[at];
    if (!block) issues.push({ index: -1, blockId: null, type: pinned, path: 'blocks', message: `"${pinned}" is always on ${surface}` });
    else {
      const issue = (message: string) => issues.push({ index: at, blockId: block.id, type: pinned, path: '(block)', message });
      if (at !== blocks.length - 1) issue(`"${pinned}" is always the last block on ${surface}`);
      if (block.hidden) issue(`"${pinned}" cannot be hidden`);
      if (block.visibility || block.schedule) issue(`"${pinned}" is shown to everyone, always — no targeting or schedule`);
    }
  }
  return { blocks, issues };
}

/** A stable id for a default block, the same on every read and every instance. */
export function stableBlockId(surface: string, type: string): string {
  const hex = createHash('sha1').update(`adx-layout:${surface}:${type}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/** The layout a surface has while nothing is published: its sections in today's order. */
export function defaultBlocks(surface: LayoutSurface): Block[] {
  return SURFACE_DEFAULT_ORDER[surface].map((type) => ({
    id: stableBlockId(surface, type),
    type,
    props: type === 'ad_slot' ? { slotKey: WEB_LISTING_SIDEBAR_SLOT } : {},
  }));
}

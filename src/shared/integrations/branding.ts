import { prisma } from '../database';
import { getIntegrationsConfig, type BrandingConfig } from './integration-config';

/**
 * QR-9 (17 Sep 2026): the brand, as DR 11 draws it and as the console may
 * retune it. QR-11: the retune is a DRAFT until published.
 *
 * DR 11 — Brand Identity — gives ADX an angular wordmark, the "A" glyph as
 * the mark, the wordmark red `#E40209`, the tile red `#BD2020` the app icon
 * sits on, near-black ink and an off-white ground, and the lines the
 * posters carry ("Own the city.", "Real world. Real reach."). Those are the
 * defaults here, shipped with the backend under `/brand/*` so every surface
 * — the console, the two apps, the website when it exists — reads the same
 * file.
 *
 * Two brands exist at any moment. The DRAFT is the `branding` section of the
 * integrations row, edited on Settings › Brand & theme. The LIVE brand is
 * the latest `BrandRelease` — a frozen copy of the draft made by Publish —
 * and is what `GET /app/branding` answers to anyone, before sign-in, with a
 * version stamp the clients cache on. Until the first release, the live
 * brand is DR 11 whatever the draft says.
 *
 * What cannot be retuned from here: a phone's launcher icon and splash are
 * baked into the build (the OS owns them) — `brand/generated` holds the
 * DR 11 renders the two apps ship with.
 */

export const BRAND_DEFAULTS = {
  platformName: 'ADX',
  tagline: 'Space that gets seen.',
  /** The wordmark's red — buttons, links, the accent square. */
  primaryColor: '#E40209',
  /** The tile the icon sits on; the inverse lockups' ground. */
  deepColor: '#BD2020',
  inkColor: '#0F0F0F',
  groundColor: '#F5F5F5',
  wordmarkUrl: '/brand/adx-wordmark-red.svg',
  wordmarkInverseUrl: '/brand/adx-wordmark-white.svg',
  markUrl: '/brand/adx-mark-red.svg',
  markInverseUrl: '/brand/adx-mark-white.svg',
  iconUrl: '/brand/adx-icon-tile.svg',
} as const;

/** QR-11: the website kit's defaults — DR 11's three lines; no hero or share image until one is uploaded; the tile as favicon. QR-12: the site's title and description. */
export const WEBSITE_DEFAULTS = {
  taglines: ['Space that gets seen.', 'Own the city.', 'Real world. Real reach.'] as readonly string[],
  heroImageUrl: null as string | null,
  ogImageUrl: null as string | null,
  faviconUrl: '/brand/adx-icon-tile.svg' as string | null,
  siteTitle: 'ADX — Space that gets seen.',
  siteDescription: 'Real-world ad space, booked like a room: hoardings, screens, walls and windows across India, listed by the people who own them.',
};

/** QR-12: the phones' launcher icon for the NEXT build (null = DR 11's from brand/generated), and the console's tab title. */
export const SURFACE_DEFAULTS = {
  appIconUrl: null as string | null,
  consoleTitle: 'ADX Admin',
};

export type BrandField = keyof typeof BRAND_DEFAULTS;
export type WebsiteField = keyof typeof WEBSITE_DEFAULTS;
export type SurfaceField = keyof typeof SURFACE_DEFAULTS;

/** Every key a draft may carry — what a restore writes back in full. */
export const BRAND_FIELDS: readonly (BrandField | WebsiteField | SurfaceField)[] = [
  ...(Object.keys(BRAND_DEFAULTS) as BrandField[]),
  ...(Object.keys(WEBSITE_DEFAULTS) as WebsiteField[]),
  ...(Object.keys(SURFACE_DEFAULTS) as SurfaceField[]),
];

export type BrandWebsite = {
  taglines: string[];
  heroImageUrl: string | null;
  ogImageUrl: string | null;
  faviconUrl: string | null;
  /** QR-12: the `<title>` and the meta description. */
  title: string;
  description: string;
};

export type Brand = {
  platformName: string;
  tagline: string;
  primaryColor: string;
  deepColor: string;
  inkColor: string;
  groundColor: string;
  /** QR-11: what is written on the primary — white, or the ink when that reads better. */
  onPrimaryColor: string;
  /** Absolute URLs — the defaults resolved against `baseUrl`, an override as stored. */
  wordmarkUrl: string;
  wordmarkInverseUrl: string;
  markUrl: string;
  markInverseUrl: string;
  iconUrl: string;
  /** QR-11: the website kit. */
  website: BrandWebsite;
  /** QR-12: the phones' launcher icon for the next build — null means DR 11's, already baked. */
  apps: { iconUrl: string | null };
  /** QR-12: the console's tab title. */
  console: { title: string };
  /** Which of the fields are the DR 11 defaults rather than the console's (`website.taglines` and so on for the kit). */
  defaults: string[];
  /** Changes whenever any field does — the clients' cache key. */
  version: string;
};

const HEX = /^#[0-9a-fA-F]{6}$/;

const present = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== '';

/** A short stable hash of the effective values, so a client can cache on it. */
export function brandVersion(values: Record<string, string>): string {
  const text = Object.keys(values)
    .sort()
    .map((key) => `${key}=${values[key]}`)
    .join('|');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ── colour maths ─────────────────────────────────────────────────────────────

function toRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** WCAG relative luminance of a `#rrggbb`. */
export function luminance(hex: string): number {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = toRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two `#rrggbb`, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** White on the primary, unless the ink reads better there (a pale brand). The phones compute the same. */
export function onPrimaryFor(primary: string, ink: string): string {
  return contrastRatio(primary, '#FFFFFF') >= contrastRatio(primary, ink) ? '#FFFFFF' : ink;
}

export type BrandCheckLevel = 'ok' | 'warn' | 'fail';

export type BrandCheck = {
  key: 'text-on-primary' | 'primary-on-ground' | 'ink-on-ground' | 'white-on-deep';
  label: string;
  /** The two colours the check reads, in the order written-on-ground. */
  pair: [string, string];
  ratio: number;
  level: BrandCheckLevel;
  message: string;
};

/**
 * QR-11: what a brand would do to legibility before it ships to every phone.
 *
 * WCAG's two bars: 4.5 : 1 for body text, 3 : 1 for large text and UI
 * pieces. A `fail` is below the lower bar for text that must be read (the
 * label on every button; body copy on the page); a `warn` is between the
 * bars, or below 3 : 1 for icons and accents. Publish is never refused on
 * a check — the console shows them and asks — but the trail records them.
 */
export function brandChecks(brand: Pick<Brand, 'primaryColor' | 'onPrimaryColor' | 'inkColor' | 'groundColor' | 'deepColor'>): BrandCheck[] {
  const round = (n: number) => Math.round(n * 10) / 10;
  const grade = (ratio: number, fail: number, warn: number): BrandCheckLevel => (ratio < fail ? 'fail' : ratio < warn ? 'warn' : 'ok');
  const one = (key: BrandCheck['key'], label: string, pair: [string, string], fail: number, warn: number, said: Record<BrandCheckLevel, string>): BrandCheck => {
    const ratio = round(contrastRatio(pair[0], pair[1]));
    const level = grade(ratio, fail, warn);
    return { key, label, pair, ratio, level, message: said[level] };
  };
  return [
    one('text-on-primary', 'Button labels on the primary', [brand.onPrimaryColor, brand.primaryColor], 3, 4.5, {
      ok: 'Reads well.',
      warn: 'Readable, but under the 4.5 : 1 body-text bar — keep button labels bold.',
      fail: 'Too faint: the label on every primary button will be hard to read.',
    }),
    one('primary-on-ground', 'Links and icons on the page', [brand.primaryColor, brand.groundColor], 2, 3, {
      ok: 'Reads well.',
      warn: 'Faint: red links and icons will not stand out on the page.',
      fail: 'Nearly invisible on the page — links, active tabs and icons will disappear.',
    }),
    one('ink-on-ground', 'Body text on the page', [brand.inkColor, brand.groundColor], 4.5, 7, {
      ok: 'Reads well.',
      warn: 'Passes, but small text will tire the eye.',
      fail: 'Below 4.5 : 1 — body text on every page will be hard to read.',
    }),
    one('white-on-deep', 'The white mark on the deep colour', ['#FFFFFF', brand.deepColor], 2, 3, {
      ok: 'Reads well.',
      warn: 'Faint: the mark on the icon tile and the inverse lockups will look washed out.',
      fail: 'The white mark will vanish on the icon tile.',
    }),
  ];
}

// ── resolution ───────────────────────────────────────────────────────────────

const absolute = (value: string, baseUrl: string) => (value.startsWith('/') ? `${baseUrl.replace(/\/$/, '')}${value}` : value);

/** The effective brand: the console's overrides where set and valid, DR 11 where not. */
export function resolveBrand(config: BrandingConfig | undefined, baseUrl: string): Brand {
  const cfg = config ?? {};
  const defaults: string[] = [];
  const pick = (key: BrandField, override: string | null | undefined, valid: (v: string) => boolean = () => true): string => {
    if (present(override) && valid(override.trim())) return override.trim();
    defaults.push(key);
    return absolute(BRAND_DEFAULTS[key], baseUrl);
  };
  const values = {
    platformName: pick('platformName', cfg.platformName),
    tagline: pick('tagline', cfg.tagline),
    primaryColor: pick('primaryColor', cfg.primaryColor, (v) => HEX.test(v)),
    deepColor: pick('deepColor', cfg.deepColor, (v) => HEX.test(v)),
    inkColor: pick('inkColor', cfg.inkColor, (v) => HEX.test(v)),
    groundColor: pick('groundColor', cfg.groundColor, (v) => HEX.test(v)),
    // The two older fields keep working: a header logo is the wordmark, an auth logo the mark.
    wordmarkUrl: pick('wordmarkUrl', cfg.wordmarkUrl ?? cfg.headerLogoUrl),
    wordmarkInverseUrl: pick('wordmarkInverseUrl', cfg.wordmarkInverseUrl),
    markUrl: pick('markUrl', cfg.markUrl ?? cfg.authLogoUrl),
    markInverseUrl: pick('markInverseUrl', cfg.markInverseUrl),
    iconUrl: pick('iconUrl', cfg.iconUrl),
  };

  // QR-11: the website kit.
  const taglines = Array.isArray(cfg.taglines) ? cfg.taglines.map((t) => String(t).trim()).filter(Boolean) : [];
  if (taglines.length === 0) defaults.push('website.taglines');
  const pickUrl = (key: 'heroImageUrl' | 'ogImageUrl' | 'faviconUrl'): string | null => {
    const override = cfg[key];
    if (present(override)) return override.trim();
    defaults.push(`website.${key}`);
    const fallback = WEBSITE_DEFAULTS[key];
    return fallback ? absolute(fallback, baseUrl) : null;
  };
  const pickText = (key: 'siteTitle' | 'siteDescription' | 'consoleTitle', fallback: string, scope: string): string => {
    const override = cfg[key];
    if (present(override)) return override.trim();
    defaults.push(`${scope}.${key}`);
    return fallback;
  };
  const website: BrandWebsite = {
    taglines: taglines.length > 0 ? taglines : [...WEBSITE_DEFAULTS.taglines],
    heroImageUrl: pickUrl('heroImageUrl'),
    ogImageUrl: pickUrl('ogImageUrl'),
    faviconUrl: pickUrl('faviconUrl'),
    title: pickText('siteTitle', WEBSITE_DEFAULTS.siteTitle, 'website'),
    description: pickText('siteDescription', WEBSITE_DEFAULTS.siteDescription, 'website'),
  };
  // QR-12: the per-surface basics.
  const appIcon = present(cfg.appIconUrl) ? cfg.appIconUrl.trim() : null;
  if (!appIcon) defaults.push('apps.appIconUrl');
  const apps = { iconUrl: appIcon };
  const consoleBlock = { title: pickText('consoleTitle', SURFACE_DEFAULTS.consoleTitle, 'console') };

  const onPrimaryColor = onPrimaryFor(values.primaryColor, values.inkColor);
  const version = brandVersion({
    ...values,
    taglines: website.taglines.join('\n'),
    heroImageUrl: website.heroImageUrl ?? '',
    ogImageUrl: website.ogImageUrl ?? '',
    faviconUrl: website.faviconUrl ?? '',
    siteTitle: website.title,
    siteDescription: website.description,
    appIconUrl: apps.iconUrl ?? '',
    consoleTitle: consoleBlock.title,
  });
  return { ...values, onPrimaryColor, website, apps, console: consoleBlock, defaults, version };
}

/** The draft: the integrations row's `branding` section, resolved. What Settings › Brand & theme edits. */
export async function getDraftBrand(baseUrl: string): Promise<Brand> {
  const cfg = await getIntegrationsConfig();
  return resolveBrand(cfg.branding, baseUrl);
}

/** The live brand: the latest release, resolved — DR 11 until the first Publish. What every surface draws. */
export async function getBrand(baseUrl: string): Promise<Brand> {
  const release = await prisma.brandRelease.findFirst({ orderBy: { number: 'desc' }, select: { config: true } });
  return resolveBrand((release?.config as BrandingConfig | null) ?? undefined, baseUrl);
}

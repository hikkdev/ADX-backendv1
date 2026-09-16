import { env } from '../../config/env';
import { ApiError } from '../../shared/errors';
import { Decimal } from '../../shared/money';
import { prismaListingsRepository as repository } from './prisma-listings.repository';
import type { SpotPageListing } from './listings.repository';

/**
 * E11-2: the public spot page — what a shared link opens.
 *
 * An advertiser taps share on a spot and sends the link to a partner who
 * may have no ADX account and no app. What they open has to work on any
 * phone, at once: one document, rendered here, with the facts the card
 * prints — title, media type, size, rate per day, city and area, the
 * publisher's business name, the rating line when there are reviews — and
 * one way in: "Open in the ADX app", the deep link, with the store links
 * beside it when the environment names them.
 *
 * ACTIVE listings only. A spot that is off the market is a 404 rather than
 * a page that says it was once for sale; the link stops working the day
 * the spot does. The hero photograph is drawn only through a public URL —
 * a listing photograph always is, but a private file's `/api/v1/files/:id`
 * address is 401 in an `<img>` and would leak the id if it were not, so
 * the renderer checks rather than trusts.
 */

export type SpotPageModel = {
  displayId: string;
  title: string;
  /** The media type's name, or the category made readable when the spot was filed under none. */
  mediaType: string;
  /** "40 × 20 ft", when both sides are measured; the free-form size otherwise. */
  size: string | null;
  /** Money as a decimal string, per day; null while the publisher has set no rate. */
  ratePerDay: string | null;
  city: string | null;
  /** The address the publisher recorded — the area the frame prints under the city. */
  area: string;
  publisherName: string | null;
  ratingAvg: string | null;
  reviewCount: number;
  /** The first photograph that can be shown through a public URL, or null. */
  heroUrl: string | null;
};

export type SpotPageLinks = {
  /** The app deep link — always. */
  app: string;
  appStore: string | null;
  playStore: string | null;
};

/* ------------------------------------------------------------------ */
/* The read                                                            */
/* ------------------------------------------------------------------ */

const PRIVATE_FILE = /\/api\/v1\/files\//i;

/**
 * The first photograph the page may draw: a public http(s) URL, never the
 * private-file door. `main` first, the way the card orders them.
 */
export function publicPhotoUrl(photos: { url: string; type: string }[]): string | null {
  const ordered = [...photos].sort((a, b) => (a.type === 'main' ? -1 : b.type === 'main' ? 1 : 0));
  for (const photo of ordered) {
    if (/^https?:\/\//i.test(photo.url) && !PRIVATE_FILE.test(photo.url)) return photo.url;
  }
  return null;
}

const readable = (category: string): string =>
  category.charAt(0).toUpperCase() + category.slice(1).toLowerCase().replace(/_/g, ' ');

export function toSpotPageModel(listing: SpotPageListing): SpotPageModel {
  const width = listing.widthFt === null ? null : new Decimal(String(listing.widthFt));
  const height = listing.heightFt === null ? null : new Decimal(String(listing.heightFt));
  return {
    displayId: listing.displayId ?? '',
    title: listing.title,
    mediaType: listing.mediaType?.name ?? readable(listing.category),
    size: width && height ? `${width.toFixed(0)} × ${height.toFixed(0)} ft` : listing.size,
    ratePerDay: listing.ratePerDay === null || listing.ratePerDay === undefined ? null : new Decimal(String(listing.ratePerDay)).toFixed(2),
    city: listing.city,
    area: listing.address,
    publisherName: listing.publisher?.name ?? null,
    ratingAvg: listing.ratingAvg === null || listing.ratingAvg === undefined ? null : new Decimal(String(listing.ratingAvg)).toFixed(2),
    reviewCount: listing.reviewCount ?? 0,
    heroUrl: publicPhotoUrl(listing.photos),
  };
}

/** One ACTIVE spot by its display id; anything else reads as missing. */
export async function getSpotPage(displayId: string): Promise<SpotPageModel> {
  const listing = await repository.findActiveByDisplayId(displayId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'That spot is not available');
  return toSpotPageModel(listing);
}

/** The deep link, and the store links the environment names. */
export function spotPageLinks(displayId: string): SpotPageLinks {
  return {
    app: `adx://spaces/${encodeURIComponent(displayId)}`,
    appStore: env.APP_STORE_URL ?? null,
    playStore: env.PLAY_STORE_URL ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* The render                                                          */
/* ------------------------------------------------------------------ */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;

/** An href that can only be http(s) or the app's own scheme, escaped for an attribute. */
function safeHref(value: string | null): string | null {
  if (!value) return null;
  return /^(https?:\/\/|adx:\/\/)/i.test(value) ? e(value) : null;
}

/** ₹18,000 — Indian grouping, no paise on a day rate. */
export function rupees(value: string): string {
  const [whole = '0', fraction = '00'] = value.split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return fraction === '00' ? `₹${grouped}` : `₹${grouped}.${fraction}`;
}

const STYLES =
  ':root{color-scheme:light}*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a;background:#fff;line-height:1.5}main{max-width:560px;margin:0 auto;padding:0 0 48px}.hero{width:100%;max-height:360px;object-fit:cover;display:block}.body{padding:20px 16px}.kicker{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:#475569;margin:0 0 6px}h1{font-size:1.6rem;line-height:1.2;margin:0 0 6px}.place{color:#475569;margin:0 0 14px}.rate{font-size:1.4rem;font-weight:700;margin:0 0 4px}.rate small{font-size:.9rem;font-weight:400;color:#475569}.rating{margin:0 0 16px;color:#475569}.rating b{color:#0f172a}dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:16px 0;padding:16px 0;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0}dt{color:#475569}dd{margin:0}.open{display:block;text-align:center;background:#2563eb;color:#fff;text-decoration:none;padding:14px 20px;border-radius:999px;font-weight:600;font-size:1.05rem;margin:20px 0 12px}.stores{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}.stores a{color:#2563eb;text-decoration:none;font-size:.9rem;padding:8px 12px;border:1px solid #cbd5e1;border-radius:999px}footer{text-align:center;font-size:.75rem;color:#64748b;margin-top:32px}';

/**
 * One self-contained document. No stylesheet, script or font is fetched
 * from anywhere; the only outbound request is the hero photograph, and
 * only when it lives at a public address.
 */
export function renderSpotPage(spot: SpotPageModel, links: SpotPageLinks): string {
  const hero = safeHref(spot.heroUrl);
  const place = [spot.area, spot.city].filter((part) => part && part.trim()).map((part) => e(part!.trim()));
  const app = safeHref(links.app);
  const appStore = safeHref(links.appStore);
  const playStore = safeHref(links.playStore);
  const description = [spot.mediaType, spot.city ?? spot.area, spot.ratePerDay ? `${rupees(spot.ratePerDay)} per day` : null]
    .filter(Boolean)
    .join(' · ');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<meta name="description" content="${e(description)}">`,
    `<title>${e(spot.title)} · ADX</title>`,
    `<style>${STYLES}</style>`,
    '</head>',
    '<body>',
    '<main>',
    hero ? `<img class="hero" src="${hero}" alt="">` : '',
    '<div class="body">',
    `<p class="kicker">${e(spot.mediaType)}${spot.displayId ? ` · ${e(spot.displayId)}` : ''}</p>`,
    `<h1>${e(spot.title)}</h1>`,
    place.length ? `<p class="place">${place.join(', ')}</p>` : '',
    spot.ratePerDay
      ? `<p class="rate">${e(rupees(spot.ratePerDay))} <small>per day</small></p>`
      : '<p class="rate"><small>Rate on request</small></p>',
    spot.reviewCount > 0 && spot.ratingAvg
      ? `<p class="rating">★ <b>${e(new Decimal(spot.ratingAvg).toFixed(1))}</b> · ${spot.reviewCount} review${spot.reviewCount === 1 ? '' : 's'}</p>`
      : '',
    '<dl>',
    `<dt>Media type</dt><dd>${e(spot.mediaType)}</dd>`,
    spot.size ? `<dt>Size</dt><dd>${e(spot.size)}</dd>` : '',
    spot.city ? `<dt>City</dt><dd>${e(spot.city)}</dd>` : '',
    `<dt>Area</dt><dd>${e(spot.area)}</dd>`,
    spot.publisherName ? `<dt>Listed by</dt><dd>${e(spot.publisherName)}</dd>` : '',
    '</dl>',
    app ? `<a class="open" href="${app}">Open in the ADX app</a>` : '',
    appStore || playStore
      ? [
          '<p class="stores">',
          appStore ? `<a href="${appStore}" rel="noopener">App Store</a>` : '',
          playStore ? `<a href="${playStore}" rel="noopener">Google Play</a>` : '',
          '</p>',
        ].join('')
      : '',
    '</div>',
    '<footer>Powered by ADX</footer>',
    '</main>',
    '</body>',
    '</html>',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

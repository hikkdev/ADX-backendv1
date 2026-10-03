import type { MediaAsset } from '../../shared/database';

export type { MediaAsset };

/**
 * LM-1 (27 Sep 2026): the media library's size specs.
 *
 * A spec is a shape and a floor: the exact aspect ratio a slot draws (held
 * within 1%, because a 1600×481 export of a 1600×480 banner is the same
 * banner), the smallest size that still looks sharp there (three quarters of
 * the target on each side), and a byte ceiling so a phone on 4G is not
 * handed a print master. The target size is what the designer is asked for.
 */
export const MEDIA_FORMATS = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type MediaFormat = (typeof MEDIA_FORMATS)[number];

export const MEDIA_SPEC_KEYS = ['PROMO_WIDE', 'PROMO_SQUARE', 'TILE', 'AD_SIDEBAR', 'AD_BANNER'] as const;
export type MediaSpecKey = (typeof MEDIA_SPEC_KEYS)[number];

export type MediaSpec = {
  key: MediaSpecKey;
  label: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  maxBytes: number;
  formats: MediaFormat[];
};

const MB = 1024 * 1024;

const spec = (key: MediaSpecKey, label: string, width: number, height: number, maxBytes: number): MediaSpec => ({
  key,
  label,
  width,
  height,
  minWidth: Math.round(width * 0.75),
  minHeight: Math.round(height * 0.75),
  maxBytes,
  formats: [...MEDIA_FORMATS],
});

export const MEDIA_SPECS: readonly MediaSpec[] = [
  spec('PROMO_WIDE', 'Promo banner — wide', 1600, 480, 2 * MB),
  spec('PROMO_SQUARE', 'Promo banner — square', 1080, 1080, 2 * MB),
  spec('TILE', 'Tile', 600, 600, 1 * MB),
  spec('AD_SIDEBAR', 'Ad — sidebar', 600, 750, 1 * MB),
  spec('AD_BANNER', 'Ad — banner', 1456, 180, 1 * MB),
];

export const specFor = (key: string | null | undefined): MediaSpec | null => MEDIA_SPECS.find((entry) => entry.key === key) ?? null;

/** The tolerance on the aspect ratio: 1%. */
export const RATIO_TOLERANCE = 0.01;

/** Whether a picture's shape is the spec's, within 1%. */
export function ratioMatches(width: number, height: number, target: Pick<MediaSpec, 'width' | 'height'>): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  const want = target.width / target.height;
  return Math.abs(width / height - want) / want <= RATIO_TOLERANCE;
}

export type SpecCheck = { ok: true } | { ok: false; problems: string[] };

/** Every way a picture misses a spec, in words the desk can act on. */
export function checkAgainstSpec(
  file: { width: number; height: number; bytes: number; mime: string },
  target: MediaSpec,
): SpecCheck {
  const problems: string[] = [];
  if (!(target.formats as string[]).includes(file.mime)) problems.push(`${target.label} takes JPEG, PNG or WebP — this is ${file.mime}.`);
  if (!ratioMatches(file.width, file.height, target)) {
    problems.push(`${target.label} is ${target.width}×${target.height} (that shape, within 1%) — this is ${file.width}×${file.height}.`);
  }
  if (file.width < target.minWidth || file.height < target.minHeight) {
    problems.push(`${target.label} needs at least ${target.minWidth}×${target.minHeight} — this is ${file.width}×${file.height}.`);
  }
  if (file.bytes > target.maxBytes) {
    problems.push(`${target.label} is capped at ${(target.maxBytes / MB).toFixed(1)} MB — this is ${(file.bytes / MB).toFixed(1)} MB.`);
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

/** What a block, an ad or a client is handed for one picture. */
export type MediaRef = { url: string; width: number | null; height: number | null; altText: string | null };

export const mediaRef = (asset: Pick<MediaAsset, 'url' | 'width' | 'height' | 'altText'>): MediaRef => ({
  url: asset.url,
  width: asset.width,
  height: asset.height,
  altText: asset.altText,
});

/** Where a picture is drawn by a published layout — the reason it cannot be archived. */
export type MediaUsage = { surface: string; number: number; blockId: string; blockType: string };

/**
 * Whose pictures a list asks for (28 Sep 2026): ADX's own (tiles, banners,
 * Studio images — no advertiser), the advertisers' ad artwork (uploaded with
 * a display ad, reviewed with it, shown on Ads & sponsored), or both.
 */
export const MEDIA_OWNERS = ['adx', 'advertisers', 'all'] as const;
export type MediaOwner = (typeof MEDIA_OWNERS)[number];

export type MediaFilter = {
  q?: string | undefined;
  tag?: string | undefined;
  specs?: string[] | undefined;
  archived?: boolean | undefined;
  /** `all` (or unset) is every picture; a named `ownerAdvertiserId` is narrower and wins. */
  owner?: MediaOwner | undefined;
  ownerAdvertiserId?: string | null | undefined;
  limit: number;
};

/**
 * The booking states an ad is finished in. Artwork on a booking in any other
 * state — a draft, waiting for money or review, scheduled, live — is still
 * the ad's, and cannot be archived from under it.
 */
export const AD_BOOKING_CLOSED = ['ENDED', 'REJECTED', 'CANCELLED'] as const;

/** An open booking that shows a picture as its ad artwork — the reason that artwork cannot be archived. */
export type OpenAdBooking = { id: string; displayId: string | null; status: string };

export type NewMedia = {
  fileId: string | null;
  url: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  altText: string | null;
  title: string | null;
  tags: string[];
  spec: string | null;
  ownerAdvertiserId: string | null;
  createdByUserId: string | null;
};

export type MediaPatch = { altText?: string | null; title?: string | null; tags?: string[] };

/**
 * Every `mediaId` a block's props name, at any depth — a banner names one,
 * a tile grid one per tile. Walked rather than typed so a block type added
 * later is covered without this file knowing about it.
 */
export function mediaIdsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) mediaIdsIn(item, into);
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'mediaId' && typeof inner === 'string') into.add(inner);
      else mediaIdsIn(inner, into);
    }
  }
  return into;
}

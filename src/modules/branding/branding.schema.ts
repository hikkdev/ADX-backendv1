import { z } from 'zod';

/**
 * QR-11: what the draft takes. Every field optional; blank keeps, `null` or
 * `''` clears back to DR 11 (the integrations writer treats them so). The
 * colours are `#rrggbb`; the logos and the kit's images are absolute URLs —
 * what `POST /upload` purpose BRANDING answers.
 */
const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a #rrggbb colour');
const url = z.string().trim().url().max(500);
const clearable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional().or(z.literal(''));

export const brandDraftSchema = z.strictObject({
  platformName: clearable(z.string().trim().max(60)),
  tagline: clearable(z.string().trim().max(120)),
  primaryColor: clearable(hex),
  deepColor: clearable(hex),
  inkColor: clearable(hex),
  groundColor: clearable(hex),
  wordmarkUrl: clearable(url),
  wordmarkInverseUrl: clearable(url),
  markUrl: clearable(url),
  markInverseUrl: clearable(url),
  iconUrl: clearable(url),
  /** The website kit. An empty list clears back to DR 11's three lines. */
  taglines: z.array(z.string().trim().min(1).max(80)).max(6).nullable().optional(),
  heroImageUrl: clearable(url),
  ogImageUrl: clearable(url),
  faviconUrl: clearable(url),
  /** QR-12: per-surface basics. */
  appIconUrl: clearable(url),
  consoleTitle: clearable(z.string().trim().max(40)),
  siteTitle: clearable(z.string().trim().max(70)),
  siteDescription: clearable(z.string().trim().max(160)),
});

export type BrandDraftPatch = z.output<typeof brandDraftSchema>;

export const publishSchema = z.strictObject({
  note: z.string().trim().max(200).optional(),
});

export const releasesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const releaseNumberSchema = z.coerce.number().int().min(1);

import { z } from 'zod';
import { MEDIA_OWNERS, MEDIA_SPEC_KEYS } from './media.types';

/**
 * Tags arrive three ways from a multipart form or a JSON body — a list, a
 * JSON-encoded list, or "a, b, c" — and leave as one: trimmed, lower-case,
 * de-duplicated, at most twelve.
 */
export function parseTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(text);
        items = Array.isArray(parsed) ? parsed : [];
      } catch {
        items = text.split(',');
      }
    } else items = text ? text.split(',') : [];
  } else return undefined;
  return [...new Set(items.filter((item): item is string => typeof item === 'string').map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

const tagsSchema = z.preprocess(parseTags, z.array(z.string().min(1).max(40)).max(12).optional());
const optionalText = (max: number) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), z.string().trim().max(max).optional());

/**
 * `GET /media?q=&tag=&spec=&archived=&owner=` — `spec` may name several,
 * comma-separated (a block that takes either shape). `owner` (28 Sep 2026)
 * is `adx` (ADX's own pictures — the library and every picker), `advertisers`
 * (the ad artwork buyers upload, which lives with their ads) or `all`, the
 * default, so a caller that does not ask sees what it always saw.
 */
export const listMediaQuerySchema = z.object({
  q: z.string().trim().min(1).max(80).optional(),
  tag: z.string().trim().toLowerCase().min(1).max(40).optional(),
  spec: z
    .string()
    .optional()
    .transform((value) => (value ? [...new Set(value.split(/[,|]/).map((part) => part.trim().toUpperCase()).filter(Boolean))] : undefined))
    .pipe(z.array(z.enum(MEDIA_SPEC_KEYS)).optional()),
  archived: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  owner: z.preprocess((value) => (typeof value === 'string' ? value.trim().toLowerCase() : value), z.enum(MEDIA_OWNERS).default('all')),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** The fields beside the file on `POST /media`. */
export const uploadMediaFieldsSchema = z.object({
  altText: optionalText(300),
  title: optionalText(120),
  tags: tagsSchema,
  spec: z.preprocess(
    (value) => (typeof value === 'string' ? (value.trim() === '' ? undefined : value.trim().toUpperCase()) : value),
    z.enum(MEDIA_SPEC_KEYS).optional(),
  ),
});
export type UploadMediaFields = z.infer<typeof uploadMediaFieldsSchema>;

/** `PATCH /media/:id` — the words around a picture; the picture itself never changes. */
export const patchMediaSchema = z
  .object({
    altText: z.string().trim().max(300).nullable().optional(),
    title: z.string().trim().max(120).nullable().optional(),
    tags: tagsSchema,
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: 'Nothing to change' });

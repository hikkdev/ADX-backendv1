import { z } from 'zod';
import { CITY_STAGES, SIDES } from './block-registry';

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/** The caller's place and side — `?side=&city=&cityId=&stage=` on every resolve and preview. */
export const placeQuerySchema = z.object({
  side: z.preprocess(upper, z.enum(SIDES).optional()),
  city: z.string().trim().min(1).max(80).optional(),
  cityId: z.string().trim().min(1).max(64).optional(),
  stage: z.preprocess(upper, z.enum(CITY_STAGES).optional()),
});

/** `GET /app/layouts/:surface`, `GET /app/pages/:key` — the place, plus PB-1's `preview` token for the draft. */
export const resolveQuerySchema = placeQuerySchema.extend({
  preview: z.string().trim().min(1).max(2000).optional(),
});

export const previewQuerySchema = placeQuerySchema.extend({
  version: z
    .string()
    .trim()
    .optional()
    .transform((value, ctx): 'draft' | number => {
      if (!value || value.toLowerCase() === 'draft') return 'draft';
      if (value.toLowerCase() === 'default') return 0;
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0) {
        ctx.addIssue({ code: 'custom', message: 'version is "draft", "default" or a version number' });
        return z.NEVER;
      }
      return number;
    }),
});

/**
 * `PUT /layouts/:surface/draft`, `PUT /site/pages/:key/draft` — the blocks
 * are checked by the registry, not here, so every problem is named at once;
 * `meta` (PB-4, the SEO) the same way in the service. Left out, the draft's
 * meta stays; `null` clears it.
 */
export const saveDraftSchema = z.object({
  blocks: z.array(z.unknown()),
  meta: z.unknown().optional(),
  changeNote: z.string().trim().max(300).nullable().optional(),
});

export const publishSchema = z.object({ changeNote: z.string().trim().max(300).nullable().optional() });

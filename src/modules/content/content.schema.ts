import { z } from 'zod';
import { CONTENT_CATEGORIES, CONTENT_SURFACES } from './content.types';

const categorySchema = z.enum(CONTENT_CATEGORIES);
const surfacesSchema = z.array(z.enum(CONTENT_SURFACES)).max(4);
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(12);

/** `GET /content?surface=&category=&tag=` — the public index. */
export const indexQuerySchema = z.object({
  surface: z.enum(CONTENT_SURFACES).optional(),
  category: categorySchema.optional(),
  tag: z.string().trim().min(1).max(40).optional(),
});

/** `POST /content/pages` — a new version. The slug says which page it belongs to. */
export const createPageSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  category: categorySchema.default('PAGE'),
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().max(300).optional(),
  body: z.string().min(1).max(200_000),
  surfaces: surfacesSchema.optional(),
  tags: tagsSchema.optional(),
  seoTitle: z.string().trim().max(160).optional(),
  seoDescription: z.string().trim().max(300).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  changeNote: z.string().trim().max(300).optional(),
  /** Publish it the moment it is made, rather than leaving a draft. */
  publish: z.boolean().optional(),
});

/** `PATCH /content/pages/:id` — a draft's text. The slug is the address and never moves. */
export const updatePageSchema = z
  .object({
    category: categorySchema.optional(),
    title: z.string().trim().min(1).max(160).optional(),
    summary: z.string().trim().max(300).nullable().optional(),
    body: z.string().min(1).max(200_000).optional(),
    surfaces: surfacesSchema.optional(),
    tags: tagsSchema.optional(),
    seoTitle: z.string().trim().max(160).nullable().optional(),
    seoDescription: z.string().trim().max(300).nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    changeNote: z.string().trim().max(300).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to change' });

export const listQuerySchema = z.object({ slug: z.string().trim().max(80).optional() });

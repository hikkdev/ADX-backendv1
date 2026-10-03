import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiError } from '../../shared/errors';
import {
  createPage,
  currentPage,
  deletePage,
  getPage,
  listPages,
  publicIndex,
  publishPage,
  unpublishPage,
  updatePage,
} from './content.service';
import { createPageSchema, indexQuerySchema, listQuerySchema, updatePageSchema } from './content.schema';
import { slugify } from './content.types';

const actorOf = (req: Request) => ({ userId: req.user!.sub, req });
const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

/* ── Public ───────────────────────────────────────────────────────── */

/** `GET /content?surface=&category=&tag=` — no token: the website is read by people who never signed in. */
export async function indexHandler(req: Request, res: Response): Promise<void> {
  const parsed = indexQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await publicIndex(parsed.data) });
}

/** `GET /content/:slug` — one published page. */
export async function currentHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await currentPage(String(req.params['slug'])) });
}

/* ── The desk ─────────────────────────────────────────────────────── */

export async function listHandler(req: Request, res: Response): Promise<void> {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await listPages(parsed.data.slug) });
}

export async function getHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getPage(String(req.params['id'])) });
}

export async function createHandler(req: Request, res: Response): Promise<void> {
  const parsed = createPageSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const body = parsed.data as z.infer<typeof createPageSchema>;
  // A title typed into the slug field is a kindness, not a trap: normalise it.
  res.status(201).json({ success: true, data: await createPage({ ...body, slug: slugify(body.slug) }, actorOf(req)) });
}

export async function updateHandler(req: Request, res: Response): Promise<void> {
  const parsed = updatePageSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await updatePage(String(req.params['id']), parsed.data, actorOf(req)) });
}

export async function deleteHandler(req: Request, res: Response): Promise<void> {
  await deletePage(String(req.params['id']), actorOf(req));
  res.json({ success: true, data: { message: 'Draft discarded' } });
}

export async function publishHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await publishPage(String(req.params['id']), actorOf(req)) });
}

export async function unpublishHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await unpublishPage(String(req.params['id']), actorOf(req)) });
}

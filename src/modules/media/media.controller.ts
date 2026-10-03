import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { baseUrlFor } from '../uploads';
import { listMediaQuerySchema, patchMediaSchema, uploadMediaFieldsSchema } from './media.schema';
import { archiveMedia, getMedia, listMedia, listSpecs, patchMedia, restoreMedia, storeMediaFile } from './media.service';

const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());
const actorOf = (req: Request) => ({ userId: req.user!.sub, req });
const idOf = (req: Request) => String(req.params['id']);

/** `GET /media/specs` — the size specs, for the desk's library and a buyer's ad artwork. */
export async function specsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: listSpecs() });
}

/** `GET /media?q=&tag=&spec=&archived=&owner=` — the library, newest first; `owner=adx` is ADX's own, `advertisers` the ad artwork. */
export async function listHandler(req: Request, res: Response): Promise<void> {
  const parsed = listMediaQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  const { q, tag, spec, archived, owner, limit } = parsed.data;
  res.json({ success: true, data: await listMedia({ q, tag, specs: spec, archived: archived ?? false, owner, limit }) });
}

export async function getHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMedia(idOf(req)) });
}

/** `POST /media` multipart `file` + `altText`, `title`, `tags`, `spec`. */
export async function uploadHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) throw new ApiError(400, 'BAD_REQUEST', 'No file provided — send the picture as `file`');
  const parsed = uploadMediaFieldsSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const asset = await storeMediaFile(req.file, parsed.data, {
    ...actorOf(req),
    isAdmin: (req.user?.roles ?? []).includes('ADMIN'),
    baseUrl: baseUrlFor(req),
  });
  res.status(201).json({ success: true, data: asset });
}

export async function patchHandler(req: Request, res: Response): Promise<void> {
  const parsed = patchMediaSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await patchMedia(idOf(req), parsed.data, actorOf(req)) });
}

export async function archiveHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await archiveMedia(idOf(req), actorOf(req)) });
}

export async function restoreHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await restoreMedia(idOf(req), actorOf(req)) });
}

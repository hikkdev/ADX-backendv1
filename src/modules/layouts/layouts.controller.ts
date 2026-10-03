import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { blockTypes } from './block-registry';
import { previewQuerySchema, publishSchema, resolveQuerySchema, saveDraftSchema } from './layouts.schema';
import {
  blocksForPreview,
  discardDraft,
  getSurface,
  listSurfaces,
  listVersions,
  parseSurface,
  publishDraft,
  restoreVersion,
  saveDraft,
} from './layouts.service';
import { signPreviewToken, verifyPreviewToken } from './preview-token';
import { placeFor, resolveBlocks, resolveMeta, resolvePublic, shuffleAds, sideFor, type ResolveContext } from './resolve.service';

const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());
const actorOf = (req: Request) => ({ userId: req.user!.sub, req });
const surfaceOf = (req: Request) => parseSurface(req.params['surface']);

type PlaceQuery = { side?: string | undefined; city?: string | undefined; cityId?: string | undefined; stage?: string | undefined };

async function contextOf(req: Request, query: PlaceQuery): Promise<ResolveContext> {
  const place = await placeFor(query);
  return { side: sideFor(surfaceOf(req), req.user?.roles, query.side), ...place, now: new Date() };
}

/* ── Public ───────────────────────────────────────────────────────── */

/**
 * `GET /app/layouts/:surface?preview=` — what this screen draws for this
 * caller. No token needed; a token is read as its side. PB-1: a valid
 * preview token naming this surface answers the draft instead.
 */
export async function resolveHandler(req: Request, res: Response): Promise<void> {
  const surface = surfaceOf(req);
  const parsed = resolveQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  const preview = verifyPreviewToken(parsed.data.preview, { kind: 'surface', ref: surface });
  const layout = await resolvePublic(surface, await contextOf(req, parsed.data), preview);
  if (preview) res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: layout });
}

/* ── The desk ─────────────────────────────────────────────────────── */

export async function listHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listSurfaces() });
}

export async function blockTypesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: blockTypes() });
}

export async function getHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getSurface(surfaceOf(req)) });
}

export async function saveDraftHandler(req: Request, res: Response): Promise<void> {
  const parsed = saveDraftSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await saveDraft(surfaceOf(req), parsed.data, actorOf(req)) });
}

export async function discardDraftHandler(req: Request, res: Response): Promise<void> {
  await discardDraft(surfaceOf(req), actorOf(req));
  res.json({ success: true, data: { message: 'Draft discarded' } });
}

/** `GET /layouts/:surface/preview?side=&cityId=&version=draft|<n>` — the public shape, for a version that may not be live. */
export async function previewHandler(req: Request, res: Response): Promise<void> {
  const surface = surfaceOf(req);
  const parsed = previewQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  const { number, isDefault, blocks, meta } = await blocksForPreview(surface, parsed.data.version);
  const ctx = await contextOf(req, parsed.data);
  const [resolved, resolvedMeta] = await Promise.all([resolveBlocks(blocks, ctx), resolveMeta(meta)]);
  res.json({ success: true, data: { surface, version: number, isDefault, meta: resolvedMeta, blocks: shuffleAds(resolved) } });
}

/** `POST /layouts/:surface/preview-token` — PB-1: a day's token for `GET /app/layouts/:surface?preview=` to answer the draft. */
export async function previewTokenHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: signPreviewToken({ kind: 'surface', ref: surfaceOf(req) }) });
}

export async function publishHandler(req: Request, res: Response): Promise<void> {
  const parsed = publishSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await publishDraft(surfaceOf(req), parsed.data, actorOf(req)) });
}

export async function versionsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listVersions(surfaceOf(req)) });
}

export async function restoreHandler(req: Request, res: Response): Promise<void> {
  const number = Number(req.params['number']);
  if (!Number.isInteger(number) || number < 1) throw new ApiError(400, 'VALIDATION_ERROR', 'A version number is a whole number from 1');
  res.json({ success: true, data: await restoreVersion(surfaceOf(req), number, actorOf(req)) });
}

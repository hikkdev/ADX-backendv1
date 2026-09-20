import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { brandDraftSchema, publishSchema, releaseNumberSchema, releasesQuerySchema } from './branding.schema';
import { listReleases, publishDraft, readManager, restoreRelease, updateDraft } from './branding.service';

const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

/** Where the DR 11 files live, for the resolved URLs — the same rule `GET /app/branding` uses. */
function baseUrlOf(req: Request): string {
  const hostHeader = req.headers['host'] ?? `localhost:${env.PORT}`;
  return env.BASE_URL ?? (env.NODE_ENV !== 'production' ? `http://${hostHeader}` : '');
}

// GET /branding — the draft, the live brand, the checks.
export async function getManagerHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await readManager(baseUrlOf(req)) });
}

// PUT /branding/draft — a save on the page. Nothing goes live.
export async function putDraftHandler(req: Request, res: Response): Promise<void> {
  const parsed = brandDraftSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const before = await readManager(baseUrlOf(req));
  const view = await updateDraft(parsed.data, baseUrlOf(req));
  await logActivity(req.user!.sub, 'BRAND_DRAFT_UPDATED', {
    req,
    targetType: 'AppConfig',
    targetId: 'integrations',
    module: 'branding',
    diff: auditDiff(before.draft, view.draft, Object.keys(parsed.data)),
    metadata: { fields: Object.keys(parsed.data), dirty: view.dirty },
  });
  res.json({ success: true, data: view });
}

// POST /branding/publish — the draft becomes the next release.
export async function publishHandler(req: Request, res: Response): Promise<void> {
  const parsed = publishSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const before = await readManager(baseUrlOf(req));
  const { view, release, flagged } = await publishDraft(req.user!.sub, parsed.data.note, baseUrlOf(req));
  await logActivity(req.user!.sub, 'BRAND_PUBLISHED', {
    req,
    targetType: 'BrandRelease',
    targetId: release.id,
    module: 'branding',
    diff: auditDiff(
      { version: before.live.version, primaryColor: before.live.primaryColor, platformName: before.live.platformName },
      { version: view.live.version, primaryColor: view.live.primaryColor, platformName: view.live.platformName },
    ),
    metadata: { number: release.number, note: release.note, flaggedChecks: flagged },
  });
  res.status(201).json({ success: true, data: view });
}

// GET /branding/releases — the history, newest first.
export async function listReleasesHandler(req: Request, res: Response): Promise<void> {
  const parsed = releasesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await listReleases(parsed.data.page, parsed.data.pageSize, baseUrlOf(req)) });
}

// POST /branding/releases/:number/restore — an old release, live again as a new one.
export async function restoreHandler(req: Request, res: Response): Promise<void> {
  const parsed = releaseNumberSchema.safeParse(req.params['number']);
  if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', 'No such release');
  const { view, release, from } = await restoreRelease(req.user!.sub, parsed.data, baseUrlOf(req));
  await logActivity(req.user!.sub, 'BRAND_RESTORED', {
    req,
    targetType: 'BrandRelease',
    targetId: release.id,
    module: 'branding',
    diff: auditDiff({ number: from.number }, { number: release.number }),
    metadata: { restoredFrom: from.number, number: release.number, version: release.version },
  });
  res.status(201).json({ success: true, data: view });
}

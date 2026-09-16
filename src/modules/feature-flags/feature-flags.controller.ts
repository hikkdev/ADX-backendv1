import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { bulkRollbackFlagsSchema, bulkSetFlagsSchema, listFlagsQuerySchema, rollbackFlagSchema, setFlagSchema } from './feature-flags.schema';
import {
  bulkRollbackFlags,
  bulkSetFlags,
  evaluateAllFor,
  evaluateEverySurfaceFor,
  getFlagChanges,
  listFlags,
  pageFlags,
  registryView,
  rollbackFlag,
  setFlag,
  viewsOf,
  withActors,
  type FlagView,
} from './feature-flags.service';
import { subjectFromRequest } from './require-feature';

const AUDITED_COLUMNS = ['enabled', 'rolloutPercent', 'variant', 'rollout'] as const;

/** L-B: the page size when `?page` is given without one. */
const DEFAULT_FLAG_PAGE_SIZE = 50;

function flagKey(req: Request): string {
  const key = req.params['key'];
  if (typeof key !== 'string' || key.length === 0) throw new ApiError(400, 'BAD_REQUEST', 'Missing key');
  return key;
}

/** The row as the console reads it: every column, `lastChange` in place of the history. */
function flagView({ changes, ...flag }: FlagView) {
  return { ...flag, lastChange: changes[0] ?? null };
}

/**
 * GET /flags — every flag with its metadata and the change that last moved
 * it. L-B: `?surface=&kind=&source=&state=&owner=&q=` filter server-side
 * (the console's own rules), and `?page&pageSize` switch the answer to the
 * list contract `{ items, total, page, pageSize, counts: { surface, kind,
 * state } }`; without them the bare array the console reads today.
 */
export async function listFlagsHandler(req: Request, res: Response): Promise<void> {
  const parsed = listFlagsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const { page, pageSize, ...filter } = parsed.data;

  if (page !== undefined || pageSize !== undefined) {
    const result = await pageFlags({ ...filter, page: page ?? 1, pageSize: pageSize ?? DEFAULT_FLAG_PAGE_SIZE });
    res.json({ success: true, data: { ...result, items: result.items.map(flagView) } });
    return;
  }
  const flags = await listFlags(filter);
  res.json({ success: true, data: flags.map(flagView) });
}

/** GET /flags/registry — the committed document (every surface) merged with the rows. */
export async function registryHandler(_req: Request, res: Response): Promise<void> {
  const view = await registryView();
  res.json({
    success: true,
    data: {
      generatedBy: view.generatedBy,
      features: view.features.map(({ flag, ...entry }) => ({ ...entry, flag: flag ? flagView(flag) : null })),
      // G11-2: `{ current, surfaces: [{ surface, behind, reasons }] }` — what `npm run features:check` would say.
      check: view.check,
    },
  });
}

/**
 * G11-2: GET /flags/me — every flag on every surface as this admin sees
 * it, `{ key: { enabled, variant } }`, through the same evaluator
 * `/app/flags` uses. The console stops evaluating rollouts on its own.
 */
export async function myFlagsEverySurfaceHandler(req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await evaluateEverySurfaceFor(subjectFromRequest(req)) });
}

/** PATCH (and, for the shipped console, PUT) /flags/:key — a patch; writes a change and keeps the previous position. */
export async function setFlagHandler(req: Request, res: Response): Promise<void> {
  const parsed = setFlagSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const key = flagKey(req);
  const { before, after } = await setFlag(key, parsed.data, req.user!.sub);
  const { changes: rawChanges, ...flag } = after;
  // E6: the change that just landed, with the actor's name.
  const changes = await withActors(rawChanges);

  await logActivity(req.user!.sub, 'FEATURE_FLAG_CHANGED', {
    req,
    module: 'feature-flags',
    targetType: 'FeatureFlag',
    targetId: flag.key,
    diff: auditDiff(before, flag, AUDITED_COLUMNS),
    ...(parsed.data.note ? { metadata: { note: parsed.data.note } } : {}),
  });

  res.json({ success: true, data: { ...flag, lastChange: changes[0] ?? null } });
}

/** POST /flags/:key/rollback — back to `lastGoodState`; audited with what was restored. */
export async function rollbackFlagHandler(req: Request, res: Response): Promise<void> {
  const parsed = rollbackFlagSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const key = flagKey(req);
  const { before, after, restored } = await rollbackFlag(key, req.user!.sub, parsed.data.note ?? null);
  const { changes: rawChanges, ...flag } = after;
  const changes = await withActors(rawChanges);

  await logActivity(req.user!.sub, 'FEATURE_FLAG_ROLLED_BACK', {
    req,
    module: 'feature-flags',
    targetType: 'FeatureFlag',
    targetId: flag.key,
    diff: auditDiff(before, flag, AUDITED_COLUMNS),
    metadata: { restored, rollbackOfId: changes[0]?.rollbackOfId ?? null, ...(parsed.data.note ? { note: parsed.data.note } : {}) },
  });

  res.json({ success: true, data: { ...flag, lastChange: changes[0] ?? null } });
}

/* ── L-B: the bulk write ─────────────────────────────────────────────── */

/**
 * POST /flags/bulk — the patch `/:key` takes, applied to every key in one
 * transaction; `note` required. Audited as `/:key` is, one
 * FEATURE_FLAG_CHANGED per key written with the diff, plus one
 * FLAGS_BULK_UPDATED summary carrying the key list and the note — the line
 * an incident review reads first.
 */
export async function bulkSetFlagsHandler(req: Request, res: Response): Promise<void> {
  const parsed = bulkSetFlagsSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { keys, patch, note } = parsed.data;
  const byUserId = req.user!.sub;
  const { updated, skipped } = await bulkSetFlags(keys, patch, note, byUserId);
  const views = await viewsOf(updated.map((write) => write.after));

  for (const [index, { before, after }] of updated.entries()) {
    const { changes: _changes, ...flag } = after;
    await logActivity(byUserId, 'FEATURE_FLAG_CHANGED', {
      req,
      module: 'feature-flags',
      targetType: 'FeatureFlag',
      targetId: flag.key,
      diff: auditDiff(before, flag, AUDITED_COLUMNS),
      metadata: { note, bulk: true, changeId: views[index]?.changes[0]?.id ?? null },
    });
  }
  await logActivity(byUserId, 'FLAGS_BULK_UPDATED', {
    req,
    module: 'feature-flags',
    targetType: 'FeatureFlag',
    metadata: { note, patch, keys, updated: updated.map((write) => write.after.key), skipped },
  });

  res.json({ success: true, data: { updated: views.map(flagView), skipped } });
}

/** POST /flags/bulk/rollback — every key back to its `lastGoodState`; a key that has never moved is skipped with the reason. */
export async function bulkRollbackFlagsHandler(req: Request, res: Response): Promise<void> {
  const parsed = bulkRollbackFlagsSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { keys, note } = parsed.data;
  const byUserId = req.user!.sub;
  const { updated, skipped } = await bulkRollbackFlags(keys, note, byUserId);
  const views = await viewsOf(updated.map((write) => write.after));

  for (const [index, { before, after, restored }] of updated.entries()) {
    const { changes: _changes, ...flag } = after;
    await logActivity(byUserId, 'FEATURE_FLAG_ROLLED_BACK', {
      req,
      module: 'feature-flags',
      targetType: 'FeatureFlag',
      targetId: flag.key,
      diff: auditDiff(before, flag, AUDITED_COLUMNS),
      metadata: { restored, rollbackOfId: views[index]?.changes[0]?.rollbackOfId ?? null, note, bulk: true },
    });
  }
  await logActivity(byUserId, 'FLAGS_BULK_ROLLED_BACK', {
    req,
    module: 'feature-flags',
    targetType: 'FeatureFlag',
    metadata: { note, keys, updated: updated.map((write) => write.after.key), skipped },
  });

  res.json({ success: true, data: { updated: views.map(flagView), skipped } });
}

export async function flagChangesHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getFlagChanges(flagKey(req)) });
}

/**
 * GET /app/flags — every feature on an app surface as this caller sees it,
 * `{ key: { enabled, variant } }`, plus the flat boolean under each legacy
 * key for one release.
 *
 * Authenticated rather than public: a partial rollout is bucketed on the
 * caller's id, so an anonymous read could not answer it, and the set of
 * flags ADX is trialling is not something to publish.
 */
export async function myFlagsHandler(req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await evaluateAllFor(subjectFromRequest(req)) });
}

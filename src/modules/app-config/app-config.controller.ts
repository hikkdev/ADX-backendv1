import type { Request, Response } from 'express';
import { getAppConfig, listFlows, patchEnumGroup, patchFlow, revertAppConfig, saveAppConfig } from './app-config.service';
import { enumGroupNameSchema, fieldVocabulary, flowKeySchema } from './flow-schema';
import { onboardingVocabulary } from './onboarding-template';
import {
  AGENT_JOB_PROOF_LABELS,
  AGENT_JOB_PROOFS,
  EMPLOYEE_INTAKE_PROOF_LABELS,
  EMPLOYEE_INTAKE_PROOFS,
  REQUIRED_AGENT_JOB_PROOFS,
  REQUIRED_EMPLOYEE_INTAKE_PROOFS,
  stepLadderVocabulary,
} from './step-ladder';
import { appStatusSchema, getAppStatus, saveAppStatus } from './app-status';
import {
  flattenSettings,
  getPlatformSettings,
  platformSettingsPatchSchema,
  updatePlatformSettings,
} from './platform-settings';
import { ApiError } from '../../shared/errors';
import { getMapsClientConfig } from '../../shared/maps';
import { auditDiff, logActivity } from '../../shared/audit';

/**
 * GET /app/status — public, and deliberately so. A force-update gate that
 * needs a token is useless: an out-of-date build may not be able to sign in,
 * and a maintenance window is exactly when the token endpoint is down.
 */
export async function getAppStatusHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await getAppStatus() });
}

/**
 * GET /app/limits — E7-2: the non-secret numbers the apps' wizards print
 * ("up to 3 markets per campaign", "at least 1 day", "KYC reviewed within
 * 48 hours"), read off the platform settings row. Authenticated, unlike
 * /app/status: nothing here is needed before sign-in, and the row's other
 * sections are ops' own. Only these three leaves leave the module.
 */
export type AppLimits = {
  marketplace: { minBookingDays: number; maxMarketsPerCampaign: number };
  kyc: { reviewSlaHours: number };
};

export async function getAppLimitsHandler(_req: Request, res: Response): Promise<void> {
  const settings = await getPlatformSettings();
  const limits: AppLimits = {
    marketplace: {
      minBookingDays: settings.marketplace.minBookingDays,
      maxMarketsPerCampaign: settings.marketplace.maxMarketsPerCampaign,
    },
    kyc: { reviewSlaHours: settings.kyc.reviewSlaHours },
  };
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: limits });
}

/**
 * G7 (Q101/132): GET /app/maps — the CLIENT half of the maps seam, for the
 * phones and the console: which vendor to draw with and the browser key /
 * public token to draw with. The server key never leaves through here —
 * `getMapsClientConfig` is the one place that rule is kept. `null` while the
 * key is still to come (Q128), so a build can fall back to its demo key in
 * dev and say "maps unavailable" in production rather than crash. Z-B: on
 * OSM the answer is the raster tile line (template, attribution, max zoom,
 * the public-tiles warning) — no key, the tile key put in only for the
 * public-safe hosts.
 */
export async function getAppMapsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await getMapsClientConfig() });
}

const APP_STATUS_FIELDS = ['minimumBuild', 'latestBuild', 'storeUrl', 'maintenance', 'incident', 'services'] as const;

export async function putAppStatusHandler(req: Request, res: Response): Promise<void> {
  const parsed = appStatusSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const before = await getAppStatus();
  const saved = await saveAppStatus(parsed.data);
  await logActivity(req.user!.sub, 'APP_STATUS_UPDATED', {
    req,
    module: 'app-config',
    targetType: 'AppConfig',
    targetId: 'app-status',
    diff: auditDiff(before, saved, APP_STATUS_FIELDS),
  });
  res.json({ success: true, data: saved });
}

export async function getConfigHandler(_req: Request, res: Response): Promise<void> {
  const data = await getAppConfig();
  // The agent app polls this on boot and after edits; a cached copy would serve
  // a stale flow definition.
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data });
}

/**
 * Which top-level keys of the flow document changed. The document is large —
 * every screen of every flow — so the audit row names the keys that moved
 * rather than carrying two copies of it.
 */
export function changedTopLevelKeys(before: object, after: object): string[] {
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
}

export async function putConfigHandler(req: Request, res: Response): Promise<void> {
  const body = req.body;

  // Hand-rolled rather than Zod, and the error envelope is `{ success, error }`
  // with error as a plain string — not the `{ code, message }` object every
  // other endpoint returns. The flow editor depends on this shape.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
    return;
  }
  if (typeof body.flows !== 'object' || Array.isArray(body.flows)) {
    res.status(400).json({ success: false, error: 'Missing required field: flows (object)' });
    return;
  }
  if (typeof body.enums !== 'object' || Array.isArray(body.enums)) {
    res.status(400).json({ success: false, error: 'Missing required field: enums (object)' });
    return;
  }

  const before = await getAppConfig();
  const value = await saveAppConfig(body);
  await logActivity(req.user!.sub, 'APP_CONFIG_UPDATED', {
    req,
    module: 'app-config',
    targetType: 'AppConfig',
    targetId: 'main',
    metadata: { changedKeys: changedTopLevelKeys(before, value as object) },
  });
  res.json({ success: true, data: value });
}

/** POST /config/revert — the row as it was before the last PUT. */
export async function revertConfigHandler(req: Request, res: Response): Promise<void> {
  const before = await getAppConfig();
  const reverted = await revertAppConfig();
  await logActivity(req.user!.sub, 'APP_CONFIG_REVERTED', {
    req,
    module: 'app-config',
    targetType: 'AppConfig',
    targetId: 'main',
    metadata: { changedKeys: changedTopLevelKeys(before, reverted) },
  });
  res.json({ success: true, data: reverted });
}

/* ── The flow editor (Q83, Q148) ─────────────────────────────────────── */

/**
 * GET /config/schema — the vocabulary the apps render, so the console builds
 * its editor from the server's word: the field kinds of a wizard, the step
 * kinds of the onboarding ladder, and the shape of an enum group.
 */
export async function getConfigSchemaHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    data: {
      flows: {
        wizard: fieldVocabulary(),
        onboarding: onboardingVocabulary(),
        // Lot G (Q141): the two step ladders, one vocabulary each.
        'agent-job': stepLadderVocabulary({ proofs: AGENT_JOB_PROOFS, required: REQUIRED_AGENT_JOB_PROOFS, labels: AGENT_JOB_PROOF_LABELS }),
        'employee-intake': stepLadderVocabulary({ proofs: EMPLOYEE_INTAKE_PROOFS, required: REQUIRED_EMPLOYEE_INTAKE_PROOFS, labels: EMPLOYEE_INTAKE_PROOF_LABELS }),
      },
      enums: { entry: { value: 'string — unique in its group', label: 'string', description: 'string?' } },
      routes: {
        flows: 'PATCH /config/flows/:key — the whole flow; `onboarding` is a ladder, `agent-job` and `employee-intake` are step ladders, any other key a wizard',
        enums: 'PATCH /config/enums/:group — the whole group as an array of entries',
      },
    },
  });
}

/** GET /config/flows — keys, versions and when each last moved. */
export async function listFlowsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await listFlows() });
}

export async function patchFlowHandler(req: Request, res: Response): Promise<void> {
  const key = flowKeySchema.safeParse(req.params['key']);
  if (!key.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid flow key', key.error.flatten());
  const { before, after, summary } = await patchFlow(key.data, req.body);
  await logActivity(req.user!.sub, 'APP_CONFIG_UPDATED', {
    req,
    module: 'app-config',
    targetType: 'AppConfig',
    targetId: 'main',
    metadata: {
      changedKeys: ['flows'],
      flow: key.data,
      version: { before: before ? (before['version'] as number | undefined) ?? 1 : null, after: after['version'] },
      ...summary,
    },
  });
  res.json({ success: true, data: after });
}

export async function patchEnumGroupHandler(req: Request, res: Response): Promise<void> {
  const group = enumGroupNameSchema.safeParse(req.params['group']);
  if (!group.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid enum group', group.error.flatten());
  const { after, summary } = await patchEnumGroup(group.data, req.body);
  await logActivity(req.user!.sub, 'APP_CONFIG_UPDATED', {
    req,
    module: 'app-config',
    targetType: 'AppConfig',
    targetId: 'main',
    metadata: { changedKeys: ['enums'], enumGroup: group.data, entries: summary },
  });
  res.json({ success: true, data: after });
}

/* ── Platform settings (Q31) ─────────────────────────────────────────── */

export async function getPlatformSettingsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await getPlatformSettings() });
}

export async function putPlatformSettingsHandler(req: Request, res: Response): Promise<void> {
  const parsed = platformSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const { before, after } = await updatePlatformSettings(parsed.data);
  await logActivity(req.user!.sub, 'PLATFORM_SETTINGS_UPDATED', {
    req,
    module: 'app-config',
    targetType: 'AppConfig',
    targetId: 'platform',
    diff: auditDiff(flattenSettings(before), flattenSettings(after)),
  });
  res.json({ success: true, data: after });
}

import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { getIntegrationsConfig, updateIntegrationsConfig } from '../../shared/integrations';
import { toIntegrationsResponse } from './integrations.mapper';
import { patchSchemas, sectionSchema } from './integrations.schema';

// GET /integrations — current effective config (DB override, falling back to
// .env). Secrets are always masked; the raw value never leaves the server.
export async function getIntegrationsHandler(_req: Request, res: Response): Promise<void> {
  const cfg = await getIntegrationsConfig();
  res.json({ success: true, data: toIntegrationsResponse(cfg) });
}

// PUT /integrations — body: { section: 'sms'|'email'|'storage'|'kyc'|'twilio'|'googleMaps'|'razorpay'|'stripe'|'branding', patch: {...} }
// Any field omitted (or sent empty) from `patch` keeps its existing stored
// value — since secrets are never sent back to the client, the form can't
// round-trip the real value anyway, only a deliberately-entered new one.
export async function updateIntegrationsHandler(req: Request, res: Response): Promise<void> {
  const sectionParsed = sectionSchema.safeParse(req.body?.section);
  if (!sectionParsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid or missing "section"', sectionParsed.error.flatten());
  }

  const section = sectionParsed.data;
  const patchParsed = patchSchemas[section].safeParse(req.body?.patch ?? {});
  if (!patchParsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', patchParsed.error.flatten());
  }

  await updateIntegrationsConfig(section, patchParsed.data);
  await logActivity(req.user!.sub, 'INTEGRATION_CONFIG_UPDATED', req, { section, fields: Object.keys(patchParsed.data) });

  res.json({ success: true, data: { message: `${section} configuration updated` } });
}

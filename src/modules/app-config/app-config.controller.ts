import type { Request, Response } from 'express';
import { getAppConfig, saveAppConfig } from './app-config.service';

export async function getConfigHandler(_req: Request, res: Response): Promise<void> {
  const data = await getAppConfig();
  // The agent app polls this on boot and after edits; a cached copy would serve
  // a stale flow definition.
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data });
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

  const value = await saveAppConfig(body);
  res.json({ success: true, data: value });
}

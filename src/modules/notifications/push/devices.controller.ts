import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { deviceTokenParamSchema, registerDeviceSchema } from './devices.schema';
import { listDevices, registerDevice, removeDevice } from './push.service';

/** PUT /users/me/devices — 201 for a new row, 200 for a refresh or a token that moved here. */
export async function registerDeviceHandler(req: Request, res: Response): Promise<void> {
  const parsed = registerDeviceSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const result = await registerDevice({ userId: req.user!.sub, ...parsed.data }, req);
  res.status(result.created ? 201 : 200).json({ success: true, data: { ...result.device, moved: result.moved } });
}

/** DELETE /users/me/devices/:token — the caller's own token; 404 otherwise. */
export async function removeDeviceHandler(req: Request, res: Response): Promise<void> {
  const parsed = deviceTokenParamSchema.safeParse(req.params);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid device token', parsed.error.flatten());
  await removeDevice(req.user!.sub, parsed.data.token, req);
  res.json({ success: true, data: { removed: true } });
}

/** GET /users/me/devices — the caller's devices, tokens masked to their last six characters. */
export async function listDevicesHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listDevices(req.user!.sub) });
}

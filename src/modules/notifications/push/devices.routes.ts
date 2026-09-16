import { Router } from 'express';
import { authenticate } from '../../../shared/auth';
import { asyncHandler } from '../../../shared/http';
import { requireFeature } from '../../feature-flags';
import { listDevicesHandler, registerDeviceHandler, removeDeviceHandler } from './devices.controller';

/**
 * The device registry — G6 (Q103/133). Hangs off `/users/me` because that
 * is where a phone keeps the rest of its account, but the rows are this
 * module's: a token exists to be pushed to, and the dispatcher is here.
 *
 * Mounted at `/users` by bootstrap, beside `account-lifecycle`'s router and
 * ahead of `userRouter`. The guard is per route rather than
 * `router.use(authenticate)` for the same reason that router does it that
 * way: a router mounted on `/users` sees every request under it, and a
 * layer-wide authenticate would turn `POST /users/bootstrap-admin` into a 401.
 */
export const deviceRouter = Router();

/* G10: the kill switch on push — `comms.push`, declared in ../features.ts. Off, a phone cannot register and hears nothing. */
const push = requireFeature('comms.push');
deviceRouter.put('/me/devices', authenticate, push, asyncHandler(registerDeviceHandler));
deviceRouter.get('/me/devices', authenticate, push, asyncHandler(listDevicesHandler));
deviceRouter.delete('/me/devices/:token', authenticate, push, asyncHandler(removeDeviceHandler));

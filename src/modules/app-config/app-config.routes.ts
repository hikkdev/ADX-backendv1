import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  getAppLimitsHandler,
  getAppMapsHandler,
  getAppStatusHandler,
  getConfigHandler,
  getConfigSchemaHandler,
  getPlatformSettingsHandler,
  listFlowsHandler,
  patchEnumGroupHandler,
  patchFlowHandler,
  putAppStatusHandler,
  putConfigHandler,
  putPlatformSettingsHandler,
  revertConfigHandler,
} from './app-config.controller';

export const configRouter = Router();

/**
 * Mounted at /app rather than /config: both apps read it before the session
 * check, and it answers what a build must know to run at all.
 */
export const appStatusRouter = Router();
appStatusRouter.get('/status', asyncHandler(getAppStatusHandler));
appStatusRouter.put('/status', authenticate, requireRole('ADMIN'), asyncHandler(putAppStatusHandler));
// E7-2: the wizard's caps — a session, because nothing here is needed before sign-in.
appStatusRouter.get('/limits', authenticate, asyncHandler(getAppLimitsHandler));
// G7 (Q101/132): the maps vendor and its browser key — a session, never the server key.
appStatusRouter.get('/maps', authenticate, asyncHandler(getAppMapsHandler));

// GET is deliberately unauthenticated: the agent app fetches it on boot,
// before anyone has signed in. The writes are ADMIN-only: Q33 retired the
// x-admin-secret header, so the flow editor signs in like everything else.
configRouter.get('/', asyncHandler(getConfigHandler));
configRouter.put('/', authenticate, requireRole('ADMIN'), asyncHandler(putConfigHandler));
configRouter.post('/revert', authenticate, requireRole('ADMIN'), asyncHandler(revertConfigHandler));

// Q83/Q148: the console's flow editor. The vocabulary it builds from, the
// flows it may pick, and one flow or one enum group at a time — the wholesale
// PUT above stays for scripts.
configRouter.get('/schema', authenticate, requireRole('ADMIN'), asyncHandler(getConfigSchemaHandler));
configRouter.get('/flows', authenticate, requireRole('ADMIN'), asyncHandler(listFlowsHandler));
configRouter.patch('/flows/:key', authenticate, requireRole('ADMIN'), asyncHandler(patchFlowHandler));
configRouter.patch('/enums/:group', authenticate, requireRole('ADMIN'), asyncHandler(patchEnumGroupHandler));

/** Mounted at /settings: the platform row other modules read (Q31). */
export const platformSettingsRouter = Router();
platformSettingsRouter.use(authenticate, requireRole('ADMIN'));
platformSettingsRouter.get('/platform', asyncHandler(getPlatformSettingsHandler));
platformSettingsRouter.put('/platform', asyncHandler(putPlatformSettingsHandler));

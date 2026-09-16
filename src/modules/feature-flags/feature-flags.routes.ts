import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import {
  bulkRollbackFlagsHandler,
  bulkSetFlagsHandler,
  flagChangesHandler,
  listFlagsHandler,
  myFlagsEverySurfaceHandler,
  myFlagsHandler,
  registryHandler,
  rollbackFlagHandler,
  setFlagHandler,
} from './feature-flags.controller';

/** /flags — the ops surface. ADMIN-only at the router. */
export const flagRouter = Router();
flagRouter.use(authenticate, requireRole('ADMIN'));
flagRouter.get('/', asyncHandler(listFlagsHandler));
// Ahead of /:key, or "registry" would be read as a flag key.
flagRouter.get('/registry', asyncHandler(registryHandler));
// G11-2: the caller's own answers across every surface — ahead of /:key too.
flagRouter.get('/me', asyncHandler(myFlagsEverySurfaceHandler));
// L-B: the bulk write — ahead of /:key and /:key/rollback, or "bulk" would be
// read as a flag key. The same guards as the single routes: ADMIN for the
// patch, ADMIN + system.flags for the rollback.
flagRouter.post('/bulk', asyncHandler(bulkSetFlagsHandler));
flagRouter.post('/bulk/rollback', requirePermission('system.flags'), asyncHandler(bulkRollbackFlagsHandler));
// PATCH is the verb (Lot G); PUT stays for the console that ships today —
// same handler, same patch semantics, one release.
flagRouter.patch('/:key', asyncHandler(setFlagHandler));
flagRouter.put('/:key', asyncHandler(setFlagHandler));
flagRouter.post('/:key/rollback', requirePermission('system.flags'), asyncHandler(rollbackFlagHandler));
flagRouter.get('/:key/changes', asyncHandler(flagChangesHandler));

/**
 * /app/flags — what this caller's build should switch on. Beside
 * /app/status, which is the other thing an app reads before it does anything;
 * unlike status it needs a session, because a partial rollout is bucketed on
 * the caller.
 */
export const appFlagsRouter = Router();
appFlagsRouter.get('/', authenticate, asyncHandler(myFlagsHandler));

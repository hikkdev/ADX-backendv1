import { Router } from 'express';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import { csvUploadMiddleware } from '../uploads';
import * as h from './reconciliation.controller';

/**
 * `/finance/reconciliation` — Lot B (Q85). ADMIN at the router; the writes
 * that explain money (match, ignore, unmatch, auto-match) carry
 * `finance.edit`. The import takes multipart through the uploads module's
 * CSV multer, mounted as its own layer ahead of the handler so the body is
 * consumed before anything reads `req.file`.
 */
export const reconciliationRouter = Router();
reconciliationRouter.use(authenticate);
reconciliationRouter.use(requireRole('ADMIN'));

reconciliationRouter.get('/profiles', asyncHandler(h.listProfilesHandler));
reconciliationRouter.post('/profiles', requirePermission('finance.edit'), asyncHandler(h.createProfileHandler));

reconciliationRouter.get('/imports', asyncHandler(h.listImportsHandler));
reconciliationRouter.post('/imports', requirePermission('finance.edit'), csvUploadMiddleware, asyncHandler(h.importHandler));
/* Lot G (Q125): one import's lines as a streamed CSV — match state, matched record, resolver. */
reconciliationRouter.get('/imports/:id/export.csv', asyncHandler(h.exportImportHandler));

reconciliationRouter.get('/lines', asyncHandler(h.listLinesHandler));
/* Lot G (Q125): registered ahead of `/lines/:id/*` so "export.csv" is never read as an id. Do not reorder. */
reconciliationRouter.get('/lines/export.csv', asyncHandler(h.exportLinesHandler));
reconciliationRouter.post('/auto-match', requirePermission('finance.edit'), asyncHandler(h.autoMatchHandler));
reconciliationRouter.post('/lines/:id/match', requirePermission('finance.edit'), asyncHandler(h.matchLineHandler));
reconciliationRouter.post('/lines/:id/ignore', requirePermission('finance.edit'), asyncHandler(h.ignoreLineHandler));
reconciliationRouter.post('/lines/:id/unmatch', requirePermission('finance.edit'), asyncHandler(h.unmatchLineHandler));

reconciliationRouter.get('/summary', asyncHandler(h.summaryHandler));

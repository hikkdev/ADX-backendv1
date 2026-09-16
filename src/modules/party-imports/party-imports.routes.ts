import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { csvUploadMiddleware } from '../uploads';
import {
  commitImportHandler,
  formatHandler,
  formatTemplateHandler,
  formatsHandler,
  getImportHandler,
  importPartyHandler,
  importReportHandler,
  listImportsHandler,
  listingKindHandlers,
  revokeImportHandler,
} from './party-imports.controller';
import { LISTING_KINDS } from './party-imports.schema';

/**
 * Lot S: /party-imports/:party — :party is advertisers | agents |
 * print-partners | employees (400 otherwise). ADMIN at the router.
 *
 * Lot U: /party-imports/formats — the format guide, ADMIN; and
 * /party-imports/listings, /party-imports/rate-card — the publisher's two
 * kinds, ADMIN or AGENT_PUBLISHER here and the act rule an agent's own
 * listing creation uses in the service. Registered ahead of `/:party` so
 * the literal segments win.
 */
export const partyImportsRouter = Router();
partyImportsRouter.use(authenticate);

partyImportsRouter.get('/formats', requireRole('ADMIN'), asyncHandler(formatsHandler));
partyImportsRouter.get('/formats/:kind', requireRole('ADMIN'), asyncHandler(formatHandler));
partyImportsRouter.get('/formats/:kind/template.csv', requireRole('ADMIN'), asyncHandler(formatTemplateHandler));

for (const kind of LISTING_KINDS) {
  const handlers = listingKindHandlers(kind);
  const forPublisher = requireRole('ADMIN', 'AGENT_PUBLISHER');
  partyImportsRouter.post(`/${kind}`, forPublisher, csvUploadMiddleware, asyncHandler(handlers.import));
  partyImportsRouter.get(`/${kind}`, forPublisher, asyncHandler(handlers.list));
  partyImportsRouter.get(`/${kind}/:id`, forPublisher, asyncHandler(handlers.get));
  partyImportsRouter.get(`/${kind}/:id/report.csv`, forPublisher, asyncHandler(handlers.report));
  partyImportsRouter.post(`/${kind}/:id/commit`, forPublisher, asyncHandler(handlers.commit));
  partyImportsRouter.post(`/${kind}/:id/revoke`, forPublisher, asyncHandler(handlers.revoke));
}

const forAdmin = requireRole('ADMIN');
partyImportsRouter.post('/:party', forAdmin, csvUploadMiddleware, asyncHandler(importPartyHandler));
partyImportsRouter.get('/:party', forAdmin, asyncHandler(listImportsHandler));
partyImportsRouter.get('/:party/:id', forAdmin, asyncHandler(getImportHandler));
partyImportsRouter.get('/:party/:id/report.csv', forAdmin, asyncHandler(importReportHandler));
partyImportsRouter.post('/:party/:id/commit', forAdmin, asyncHandler(commitImportHandler));
partyImportsRouter.post('/:party/:id/revoke', forAdmin, asyncHandler(revokeImportHandler));

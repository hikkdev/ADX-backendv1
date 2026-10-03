import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import { csvUploadMiddleware, spreadsheetUploadMiddleware } from '../uploads';
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

partyImportsRouter.get('/formats', requireRole('ADMIN'), requirePermission('marketplace.view'), asyncHandler(formatsHandler));
/* BL-1: the guide and the template for one kind are what a publisher (or their agent) reads before a bulk upload. */
partyImportsRouter.get('/formats/:kind', requireRole('ADMIN', 'AGENT_PUBLISHER', 'PUBLISHER'), requirePermission('marketplace.view'), asyncHandler(formatHandler));
partyImportsRouter.get('/formats/:kind/template.csv', requireRole('ADMIN', 'AGENT_PUBLISHER', 'PUBLISHER'), requirePermission('marketplace.view'), asyncHandler(formatTemplateHandler));

for (const kind of LISTING_KINDS) {
  const handlers = listingKindHandlers(kind);
  /* BL-1: the publisher too, for their own account only — the act rule in the service. */
  const forPublisher = requireRole('ADMIN', 'AGENT_PUBLISHER', 'PUBLISHER');
  /* RP-3: listings are publishers & listings; rate cards are pricing. */
  const group = kind === 'rate-card' ? 'pricing' : 'supply';
  /* RP-2: listings and rate cards are supply; an agent the role guard admits passes as the agent. */
  /* 26 Sep 2026: a CSV or an .xlsx — the apps and the website promise both. */
  partyImportsRouter.post(`/${kind}`, forPublisher, requirePermission(`${group}.import`), spreadsheetUploadMiddleware, asyncHandler(handlers.import));
  partyImportsRouter.get(`/${kind}`, forPublisher, requirePermission(`${group}.view`), asyncHandler(handlers.list));
  partyImportsRouter.get(`/${kind}/:id`, forPublisher, requirePermission(`${group}.view`), asyncHandler(handlers.get));
  partyImportsRouter.get(`/${kind}/:id/report.csv`, forPublisher, requirePermission(`${group}.view`), asyncHandler(handlers.report));
  partyImportsRouter.post(`/${kind}/:id/commit`, forPublisher, requirePermission(`${group}.import`), asyncHandler(handlers.commit));
  partyImportsRouter.post(`/${kind}/:id/revoke`, forPublisher, requirePermission(`${group}.import`), asyncHandler(handlers.revoke));
}

const forAdmin = requireRole('ADMIN');
partyImportsRouter.post('/:party', forAdmin, requirePermission('marketplace.import'), csvUploadMiddleware, asyncHandler(importPartyHandler));
partyImportsRouter.get('/:party', forAdmin, requirePermission('marketplace.view'), asyncHandler(listImportsHandler));
partyImportsRouter.get('/:party/:id', forAdmin, requirePermission('marketplace.view'), asyncHandler(getImportHandler));
partyImportsRouter.get('/:party/:id/report.csv', forAdmin, requirePermission('marketplace.view'), asyncHandler(importReportHandler));
partyImportsRouter.post('/:party/:id/commit', forAdmin, requirePermission('marketplace.import'), asyncHandler(commitImportHandler));
partyImportsRouter.post('/:party/:id/revoke', forAdmin, requirePermission('marketplace.import'), asyncHandler(revokeImportHandler));

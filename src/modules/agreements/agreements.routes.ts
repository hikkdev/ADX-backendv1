import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import { publicReadLimiter } from '../../shared/security';
import {
  activateTemplateHandler,
  createTemplateHandler,
  currentTemplateHandler,
  deleteTemplateHandler,
  getTemplateHandler,
  listAcceptancesHandler,
  listTemplatesHandler,
  myAgreementsHandler,
  partyAgreementsHandler,
  publicAgreementHandler,
  searchPartiesHandler,
  staleHandler,
  updateTemplateHandler,
} from './agreements.controller';
import { signingRouter } from './esign/esign.routes';

/**
 * Agreement templates and who accepted them. Mounted at `/agreements`.
 *
 * Accepting is NOT here. A publisher accepts through `/supply/agreements/*`
 * and an advertiser through `/advertisers/:id/agreements/*`, each guarded by
 * its own module, because the click is the party's and activation hangs off
 * it. The transaction kinds (Lot D, Q123) are recorded by the module that
 * owns the transaction — campaigns, packages, orders — through
 * `recordAcceptance`. This module writes the text and reads the record.
 */
export const agreementRouter = Router();
agreementRouter.use(authenticate);

/* The live text of a kind: what a party is shown before the click. Any
   signed-in user — the apps render it, and there is nothing secret in terms
   of service. Registered ahead of the admin guard on purpose. */
agreementRouter.get('/current/:kind', asyncHandler(currentTemplateHandler));

/* 26 Sep 2026: the signed-in account's own platform agreements — which
   version it accepted, when, and whether that is still the live one. Any
   signed-in party; ahead of the admin guard. */
agreementRouter.get('/mine', asyncHandler(myAgreementsHandler));

/* DS-1: e-signatures — the party's own reads and the desk's acts, guarded
   inside (the party half needs no ADMIN). Mounted ahead of the guard. */
agreementRouter.use('/signing', signingRouter);

agreementRouter.use(requireRole('ADMIN'));

/* Templates. A version is a draft until it is activated, and only a draft
   may be edited or discarded. */
agreementRouter.get('/templates', requirePermission('content.view'), asyncHandler(listTemplatesHandler));
agreementRouter.post('/templates', requirePermission('content.edit'), asyncHandler(createTemplateHandler));
agreementRouter.get('/templates/:id', requirePermission('content.view'), asyncHandler(getTemplateHandler));
agreementRouter.patch('/templates/:id', requirePermission('content.edit'), asyncHandler(updateTemplateHandler));
agreementRouter.delete('/templates/:id', requirePermission('content.delete'), asyncHandler(deleteTemplateHandler));
/* Its own route rather than a status patch: going live is the act that
   changes what every new party signs, and it retires the previous version. */
agreementRouter.post('/templates/:id/activate', requirePermission('content.approve'), asyncHandler(activateTemplateHandler));

/* The record: who accepted what, when, from where. */
agreementRouter.get('/acceptances', requirePermission('content.view'), asyncHandler(listAcceptancesHandler));
/* Lot D (Q55): the stale-terms report — parties behind the live platform version. */
agreementRouter.get('/stale', requirePermission('content.view'), asyncHandler(staleHandler));
agreementRouter.get('/parties', requirePermission('content.view'), asyncHandler(searchPartiesHandler));
agreementRouter.get('/parties/:partyType/:partyId', requirePermission('content.view'), asyncHandler(partyAgreementsHandler));

/**
 * 26 Sep 2026: the live text of a platform agreement for a visitor — the
 * website shows the terms before anyone has an account. Mounted at
 * `/legal/agreements` beside the legal documents. No token, rate-limited by
 * IP; only the party-facing platform kinds, only the active version, only
 * `{ id, kind, version, title, body, activatedAt }`.
 */
export const publicAgreementRouter = Router();
publicAgreementRouter.get('/:kind', publicReadLimiter, asyncHandler(publicAgreementHandler));

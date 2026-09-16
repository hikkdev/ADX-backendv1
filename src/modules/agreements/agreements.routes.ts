import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  activateTemplateHandler,
  createTemplateHandler,
  currentTemplateHandler,
  deleteTemplateHandler,
  getTemplateHandler,
  listAcceptancesHandler,
  listTemplatesHandler,
  partyAgreementsHandler,
  searchPartiesHandler,
  staleHandler,
  updateTemplateHandler,
} from './agreements.controller';

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

agreementRouter.use(requireRole('ADMIN'));

/* Templates. A version is a draft until it is activated, and only a draft
   may be edited or discarded. */
agreementRouter.get('/templates', asyncHandler(listTemplatesHandler));
agreementRouter.post('/templates', asyncHandler(createTemplateHandler));
agreementRouter.get('/templates/:id', asyncHandler(getTemplateHandler));
agreementRouter.patch('/templates/:id', asyncHandler(updateTemplateHandler));
agreementRouter.delete('/templates/:id', asyncHandler(deleteTemplateHandler));
/* Its own route rather than a status patch: going live is the act that
   changes what every new party signs, and it retires the previous version. */
agreementRouter.post('/templates/:id/activate', asyncHandler(activateTemplateHandler));

/* The record: who accepted what, when, from where. */
agreementRouter.get('/acceptances', asyncHandler(listAcceptancesHandler));
/* Lot D (Q55): the stale-terms report — parties behind the live platform version. */
agreementRouter.get('/stale', asyncHandler(staleHandler));
agreementRouter.get('/parties', asyncHandler(searchPartiesHandler));
agreementRouter.get('/parties/:partyType/:partyId', asyncHandler(partyAgreementsHandler));

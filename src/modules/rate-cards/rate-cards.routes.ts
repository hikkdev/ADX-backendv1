import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import {
  approveCardHandler,
  archiveCardHandler,
  createCardHandler,
  decideApprovalHandler,
  gateHandler,
  getCardHandler,
  impactDryRunHandler,
  impactHandler,
  listApprovalsHandler,
  listCardsHandler,
  quoteHandler,
  rejectCardHandler,
  requestApprovalHandler,
  reviseCardHandler,
  setEntriesHandler,
  submitCardHandler,
  updateCardHandler,
} from './rate-cards.controller';

export const rateCardRouter = Router();
rateCardRouter.use(authenticate);

/*
 * A publisher may ask why their listing will not go live, and may ask for the
 * price to be signed off. Everything else here is ADX deciding what a spot is
 * worth, which is ops work.
 */
rateCardRouter.get(
  '/gate/:listingId',
  requireRole('ADMIN', 'PUBLISHER', 'AGENT_PUBLISHER'), requirePermission('pricing.view'),
  asyncHandler(gateHandler)
);
rateCardRouter.post(
  '/approvals',
  requireRole('ADMIN', 'PUBLISHER', 'AGENT_PUBLISHER'), requirePermission('pricing.edit'),
  asyncHandler(requestApprovalHandler)
);

rateCardRouter.use(requireRole('ADMIN'));

rateCardRouter.get('/', requirePermission('pricing.view'), asyncHandler(listCardsHandler));
rateCardRouter.post('/', requirePermission('pricing.edit'), asyncHandler(createCardHandler));
rateCardRouter.post('/quote', requirePermission('pricing.view'), asyncHandler(quoteHandler));

rateCardRouter.get('/approvals', requirePermission('pricing.view'), asyncHandler(listApprovalsHandler));
rateCardRouter.patch('/approvals/:id', requirePermission('pricing.approve'), asyncHandler(decideApprovalHandler));

rateCardRouter.get('/:id', requirePermission('pricing.view'), asyncHandler(getCardHandler));
rateCardRouter.patch('/:id', requirePermission('pricing.edit'), asyncHandler(updateCardHandler));
/* Lot E (Q97): the ACTIVE listings this card leaves under its floor, with the
 * shortfall — readable before approving, so ops see the cases they are about
 * to raise. */
rateCardRouter.get('/:id/impact', requirePermission('pricing.view'), asyncHandler(impactHandler));
/* E10-2: the same measurement over a grid the desk has typed but not saved. */
rateCardRouter.post('/:id/impact/dry-run', requirePermission('pricing.view'), asyncHandler(impactDryRunHandler));
rateCardRouter.put('/:id/entries', requirePermission('pricing.edit'), asyncHandler(setEntriesHandler));
rateCardRouter.post('/:id/submit', requirePermission('pricing.edit'), asyncHandler(submitCardHandler));
/* Approving is the act that lets a card decide whether a listing may publish,
 * so it is its own route with the approver recorded rather than a status patch. */
rateCardRouter.post('/:id/approve', requirePermission('pricing.approve'), asyncHandler(approveCardHandler));
rateCardRouter.post('/:id/reject', requirePermission('pricing.approve'), asyncHandler(rejectCardHandler));
rateCardRouter.post('/:id/archive', requirePermission('pricing.edit'), asyncHandler(archiveCardHandler));
rateCardRouter.post('/:id/revise', requirePermission('pricing.edit'), asyncHandler(reviseCardHandler));

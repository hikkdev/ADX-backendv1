import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
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
  requireRole('ADMIN', 'PUBLISHER', 'AGENT_PUBLISHER'),
  asyncHandler(gateHandler)
);
rateCardRouter.post(
  '/approvals',
  requireRole('ADMIN', 'PUBLISHER', 'AGENT_PUBLISHER'),
  asyncHandler(requestApprovalHandler)
);

rateCardRouter.use(requireRole('ADMIN'));

rateCardRouter.get('/', asyncHandler(listCardsHandler));
rateCardRouter.post('/', asyncHandler(createCardHandler));
rateCardRouter.post('/quote', asyncHandler(quoteHandler));

rateCardRouter.get('/approvals', asyncHandler(listApprovalsHandler));
rateCardRouter.patch('/approvals/:id', asyncHandler(decideApprovalHandler));

rateCardRouter.get('/:id', asyncHandler(getCardHandler));
rateCardRouter.patch('/:id', asyncHandler(updateCardHandler));
/* Lot E (Q97): the ACTIVE listings this card leaves under its floor, with the
 * shortfall — readable before approving, so ops see the cases they are about
 * to raise. */
rateCardRouter.get('/:id/impact', asyncHandler(impactHandler));
/* E10-2: the same measurement over a grid the desk has typed but not saved. */
rateCardRouter.post('/:id/impact/dry-run', asyncHandler(impactDryRunHandler));
rateCardRouter.put('/:id/entries', asyncHandler(setEntriesHandler));
rateCardRouter.post('/:id/submit', asyncHandler(submitCardHandler));
/* Approving is the act that lets a card decide whether a listing may publish,
 * so it is its own route with the approver recorded rather than a status patch. */
rateCardRouter.post('/:id/approve', asyncHandler(approveCardHandler));
rateCardRouter.post('/:id/reject', asyncHandler(rejectCardHandler));
rateCardRouter.post('/:id/archive', asyncHandler(archiveCardHandler));
rateCardRouter.post('/:id/revise', asyncHandler(reviseCardHandler));

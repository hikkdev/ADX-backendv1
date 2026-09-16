import { Router } from 'express';
import { authenticate, requirePermission, requireRole } from '../../../shared/auth';
import { asyncHandler } from '../../../shared/http';
import { requireFeature } from '../../feature-flags';
import * as h from './print-partner-kyc.controller';

/**
 * Lot N — the print partner's KYC desk, mounted at `/print-partner-kyc`
 * (ADMIN at the router, behind `print.partner-kyc`). `:id` is the KYC
 * record's id, or the partner's own id for a partner with no record yet
 * (the desk's PUT and the request make the record).
 *
 * The partner's own routes — `/print-partners/me/kyc*` — are registered on
 * `printPartnerRouter` in `print-partners.routes.ts`, ahead of its ADMIN
 * layer, so `/me` is never read as an id.
 */
export const printPartnerKycRouter = Router();
printPartnerKycRouter.use(authenticate, requireRole('ADMIN'), requireFeature('print.partner-kyc'));

printPartnerKycRouter.get('/', asyncHandler(h.listQueueHandler));
printPartnerKycRouter.get('/:id', asyncHandler(h.getCaseHandler));
/* The desk records the documents on the partner's behalf — recordedVia DESK. */
printPartnerKycRouter.put('/:id', asyncHandler(h.recordAtDeskHandler));
/* The desk asks the partner — Digio on their behalf, or by hand; KYC_REQUESTED. N3-B: the catalogue's KYC edit
   tier beside ADMIN — a role config granted `kyc.edit` may send it; the super admin and an admin with no role
   config pass under the launch rule. */
printPartnerKycRouter.post('/:id/request', requirePermission('kyc.edit'), asyncHandler(h.requestKycHandler));
printPartnerKycRouter.patch('/:id/review', asyncHandler(h.reviewHandler));
printPartnerKycRouter.patch('/:id/documents/:field', asyncHandler(h.reviewDocumentHandler));
printPartnerKycRouter.post('/:id/request-reupload', asyncHandler(h.requestReuploadHandler));
printPartnerKycRouter.patch('/:id/assign', asyncHandler(h.assignHandler));
printPartnerKycRouter.post('/:id/escalate', asyncHandler(h.escalateHandler));
printPartnerKycRouter.post('/:id/digio/restart', asyncHandler(h.restartDigioHandler));

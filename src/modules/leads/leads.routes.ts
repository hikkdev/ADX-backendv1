import { Router } from 'express';

import { authenticate, requireRole } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import {
  adminLeadsHandler,
  bookVisitHandler,
  convertLeadHandler,
  createLeadHandler,
  getLeadHandler,
  importLeadsHandler,
  leadsNearHandler,
  logContactHandler,
  patchLeadHandler,
} from './leads.controller';

export const leadRouter = Router();

leadRouter.use(authenticate);

/* The agent's own list. Not role-gated beyond a session: a publisher-side and
 * an advertiser-side agent both work leads, and `?side=` is how they differ.
 * Ops reads the same rows through /leads below. */
leadRouter.get('/near', asyncHandler(leadsNearHandler));

/* ADMIN's desk. Declared before '/:leadId' so "near" and the bare list are
 * never read as an id. */
leadRouter.get('/', requireRole('ADMIN'), asyncHandler(adminLeadsHandler));
leadRouter.post('/', requireRole('ADMIN'), asyncHandler(createLeadHandler));
leadRouter.post('/import', requireRole('ADMIN'), asyncHandler(importLeadsHandler));

leadRouter.get('/:leadId', asyncHandler(getLeadHandler));
leadRouter.post('/:leadId/contact', asyncHandler(logContactHandler));
leadRouter.post('/:leadId/visit', asyncHandler(bookVisitHandler));
leadRouter.post('/:leadId/convert', asyncHandler(convertLeadHandler));
leadRouter.patch('/:leadId', requireRole('ADMIN'), asyncHandler(patchLeadHandler));

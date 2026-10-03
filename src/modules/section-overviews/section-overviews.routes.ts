import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import { sectionOverviewHandler } from './section-overviews.controller';

export const sectionOverviewsRouter = Router();
sectionOverviewsRouter.use(authenticate, requireRole('ADMIN'));

/* O-B: one overview read per user section — publishers, advertisers, agents, print-partners, employees, users. */
sectionOverviewsRouter.get('/:section', requirePermission('marketplace.view'), asyncHandler(sectionOverviewHandler));

import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { sectionOverviewHandler } from './section-overviews.controller';

export const sectionOverviewsRouter = Router();
sectionOverviewsRouter.use(authenticate, requireRole('ADMIN'));

/* O-B: one overview read per user section — publishers, advertisers, agents, print-partners, employees, users. */
sectionOverviewsRouter.get('/:section', asyncHandler(sectionOverviewHandler));

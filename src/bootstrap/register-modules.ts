import { Router } from 'express';
import { healthHandler } from './health';
import { asyncHandler } from '../shared/http';

import { authRouter } from '../modules/auth';
import { userRouter } from '../modules/users';
import { rolesConfigRouter } from '../modules/access-control';
import { employeeRouter } from '../modules/employees';
import { qrRouter } from '../modules/qr';
import { orderRouter } from '../modules/orders';
import {
  milestoneTemplateRouter,
  milestonePlanRouter,
  orderMilestoneRouter,
  agentMilestoneRouter,
} from '../modules/order-milestones';
import { listingRouter, similarListingsHandler } from '../modules/listings';
import {
  publisherRouter,
  digioWebhookHandler,
  registerPublisherModule,
} from '../modules/publishers';
import { agentRouter, milestoneRouter, trainingRouter } from '../modules/agents';
import { earningsRouter } from '../modules/earnings';
import { bankingRouter } from '../modules/banking';
import { notificationRouter } from '../modules/notifications';
import { supportRouter } from '../modules/support';
import { onboardingRouter } from '../modules/onboarding';
import { advertiserKycRouter, userKycRouter } from '../modules/kyc';
import { advertisementRouter } from '../modules/advertisements';
import { uploadRouter } from '../modules/uploads';
import { integrationsRouter } from '../modules/integrations';
import { configRouter } from '../modules/app-config';

/**
 * The whole `/api/v1` surface, assembled from module public exports.
 *
 * Nothing here imports a module's internals — only its `index.ts`. Adding an
 * endpoint means adding it to a module's own router, not to this file; this
 * file only decides where a module's router is mounted.
 *
 * REGISTRATION ORDER IS LOAD-BEARING in three places, each marked below.
 * tests/architecture/route-inventory.test.ts compares the resulting tree,
 * in order, against docs/route-inventory.json.
 */

// Supplies the QR module's PublisherOnboardingPort. Must run before any request
// is served: scanning a publisher QR fails loudly without it.
registerPublisherModule();

export const apiRouter = Router();

apiRouter.get('/health', healthHandler);

// GET is unauthenticated (the agent app fetches it on boot); PUT accepts either
// the ADMIN_SECRET header (flow editor) or an ADMIN token — see
// modules/app-config/app-config.policy.ts.
apiRouter.use('/config', configRouter);

// ── Identity ──
apiRouter.use('/auth', authRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/qr', qrRouter);

// ORDER-SENSITIVE (1/3): this route is deliberately public, and listingRouter
// below applies authenticate() to everything under /listings. Registering it
// after that mount would turn it into a 401.
apiRouter.get('/listings/:id/similar', asyncHandler(similarListingsHandler));

// ── Supply and demand ──
apiRouter.use('/orders', orderRouter);
apiRouter.use('/publishers', publisherRouter);
apiRouter.use('/listings', listingRouter);
apiRouter.use('/earnings', earningsRouter);
apiRouter.use('/notifications', notificationRouter);
apiRouter.use('/support', supportRouter);

// ORDER-SENSITIVE (2/3): agent gamification milestones. Distinct from the
// order-milestone routers directly below — see modules/agents/README.md.
apiRouter.use('/milestones', milestoneRouter);

apiRouter.use('/milestone-templates', milestoneTemplateRouter);
apiRouter.use('/milestone-plans', milestonePlanRouter);

// ORDER-SENSITIVE (3/3): mounted AFTER '/orders', so a request here passes
// through the order router's authenticate() layer first and is authenticated
// twice. Existing behaviour, pinned by the route inventory.
apiRouter.use('/orders/:orderId/milestones', orderMilestoneRouter);

apiRouter.use('/agent/milestones', agentMilestoneRouter);
apiRouter.use('/training', trainingRouter);
apiRouter.use('/banking', bankingRouter);
apiRouter.use('/upload', uploadRouter);
apiRouter.use('/integrations', integrationsRouter);
apiRouter.use('/onboarding', onboardingRouter);

// ── Back office ──
apiRouter.use('/employees', employeeRouter);
apiRouter.use('/roles-config', rolesConfigRouter);
apiRouter.use('/advertiser-kyc', advertiserKycRouter);
apiRouter.use('/user-kyc', userKycRouter);
apiRouter.use('/advertisements', advertisementRouter);
apiRouter.use('/agents', agentRouter);

// Webhook endpoints — no authentication, called by third-party providers.
apiRouter.post('/webhooks/digio', asyncHandler(digioWebhookHandler));

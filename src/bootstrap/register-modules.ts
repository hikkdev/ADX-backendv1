import { Router } from 'express';
import { healthHandler } from './health';
import { authRouter } from '../modules/auth';
import { userRouter } from '../modules/users';
import { qrRouter } from '../routes/qr';
import { orderRouter } from '../routes/order';
import { similarListingsHandler } from '../controllers/order';
import { publisherRouter, listingRouter } from '../routes/publisher';
import { earningsRouter } from '../routes/earnings';
import { notificationRouter } from '../modules/notifications';
import { supportRouter } from '../modules/support';
import { milestoneRouter, trainingRouter } from '../routes/milestone';
import { milestoneTemplateRouter, milestonePlanRouter, orderMilestoneRouter, agentMilestoneRouter } from '../routes/orderMilestone';
import { bankingRouter } from '../modules/banking';
import { uploadRouter } from '../modules/uploads';
import { integrationsRouter } from '../modules/integrations';
import { onboardingRouter } from '../routes/onboarding';
import { digioWebhookHandler } from '../controllers/digio';
import { configRouter } from '../modules/app-config';
import { asyncHandler } from '../shared/http';
// Ported from legacy app
import { employeeRouter } from '../modules/employees';
import { rolesConfigRouter } from '../modules/access-control';
import { advertiserKycRouter, userKycRouter } from '../modules/kyc';
import { advertisementRouter } from '../modules/advertisements';
import { agentRouter } from '../routes/agent';

export const apiRouter = Router();

apiRouter.get('/health', healthHandler);

// GET is unauthenticated (the agent app fetches it on boot); PUT accepts either
// the ADMIN_SECRET header (flow editor) or an ADMIN token — see
// modules/app-config/app-config.policy.ts.
apiRouter.use('/config', configRouter);

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/qr', qrRouter);
apiRouter.get('/listings/:id/similar', asyncHandler(similarListingsHandler));
apiRouter.use('/orders', orderRouter);
apiRouter.use('/publishers', publisherRouter);
apiRouter.use('/listings', listingRouter);
apiRouter.use('/earnings', earningsRouter);
apiRouter.use('/notifications', notificationRouter);
apiRouter.use('/support', supportRouter);
apiRouter.use('/milestones', milestoneRouter);
apiRouter.use('/milestone-templates', milestoneTemplateRouter);
apiRouter.use('/milestone-plans', milestonePlanRouter);
apiRouter.use('/orders/:orderId/milestones', orderMilestoneRouter);
apiRouter.use('/agent/milestones', agentMilestoneRouter);
apiRouter.use('/training', trainingRouter);
apiRouter.use('/banking', bankingRouter);
apiRouter.use('/upload', uploadRouter);
apiRouter.use('/integrations', integrationsRouter);
apiRouter.use('/onboarding', onboardingRouter);

// Ported from legacy app
apiRouter.use('/employees', employeeRouter);
apiRouter.use('/roles-config', rolesConfigRouter);
apiRouter.use('/advertiser-kyc', advertiserKycRouter);
apiRouter.use('/user-kyc', userKycRouter);
apiRouter.use('/advertisements', advertisementRouter);
apiRouter.use('/agents', agentRouter);

// Webhook endpoints — no authentication, called by third-party providers
apiRouter.post('/webhooks/digio', asyncHandler(digioWebhookHandler));

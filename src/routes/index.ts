import { Router } from 'express';
import { env } from '../config/env';
import { authRouter } from './auth';
import { userRouter } from './user';
import { qrRouter } from './qr';
import { orderRouter } from './order';
import { similarListingsHandler } from '../controllers/order';
import { publisherRouter, listingRouter } from './publisher';
import { earningsRouter } from './earnings';
import { notificationRouter } from './notification';
import { supportRouter } from './support';
import { milestoneRouter, trainingRouter } from './milestone';
import { milestoneTemplateRouter, milestonePlanRouter, orderMilestoneRouter, agentMilestoneRouter } from './orderMilestone';
import { bankingRouter } from './banking';
import { uploadRouter } from './upload';
import { integrationsRouter } from './integrations';
import { onboardingRouter } from './onboarding';
import { digioWebhookHandler } from '../controllers/digio';
import { getConfigHandler, putConfigHandler } from '../controllers/config';
import { asyncHandler } from '../lib/errors';
import { authenticate, requireRole } from '../middleware/authenticate';
// Ported from legacy app
import { employeeRouter } from './employee';
import { rolesConfigRouter } from './rolesConfig';
import { advertiserKycRouter } from './advertiserKyc';
import { userKycRouter } from './userKyc';
import { advertisementRouter } from './advertisement';
import { agentRouter } from './agent';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  res.json({
    success: true,
    data: { status: 'ok', service: 'adx-backend', env: env.NODE_ENV, uptimeSeconds: Math.round(process.uptime()) },
  });
});

// Public config — GET is unauthenticated (agent app fetches on boot)
// PUT accepts either ADMIN_SECRET header (flow editor) or JWT ADMIN role
apiRouter.get('/config', asyncHandler(getConfigHandler));
apiRouter.put('/config', (req, res, next) => {
  if (req.headers['x-admin-secret'] === env.ADMIN_SECRET) return next();
  return authenticate(req, res, () => requireRole('ADMIN')(req, res, next));
}, asyncHandler(putConfigHandler));

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

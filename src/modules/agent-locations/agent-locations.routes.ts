import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { requireFeature } from '../feature-flags';
import { clientSettingsHandler, liveHandler, orderTimelineHandler, pingHandler, streamTokenHandler, trailHandler } from './agent-locations.controller';
import { authenticateLiveStream, liveStreamHandler } from './agent-locations.stream';

/**
 * LT-1: `/agent-locations`. The agent's ping and settings under the agent
 * roles; the live map's list, stream token, trails and order timeline
 * under ADMIN; the stream itself takes a bearer or the single-use token.
 */
export const agentLocationRouter = Router();

// The stream first: it authenticates its own way (a bearer, else `?t=`).
agentLocationRouter.get('/stream', authenticateLiveStream, requireFeature('ops.live-map'), asyncHandler(liveStreamHandler));

agentLocationRouter.use(authenticate);
agentLocationRouter.post('/me', requireRole('AGENT_PUBLISHER', 'AGENT_ADVERTISER'), requireFeature('ops.live-map'), asyncHandler(pingHandler));
agentLocationRouter.get('/me/settings', requireRole('AGENT_PUBLISHER', 'AGENT_ADVERTISER'), asyncHandler(clientSettingsHandler));

agentLocationRouter.use(requireRole('ADMIN'), requireFeature('ops.live-map'));
agentLocationRouter.get('/live', asyncHandler(liveHandler));
agentLocationRouter.post('/stream-token', asyncHandler(streamTokenHandler));
agentLocationRouter.get('/agents/:agentId/trail', asyncHandler(trailHandler));
agentLocationRouter.get('/orders/:orderId/timeline', asyncHandler(orderTimelineHandler));

import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { liveFilterSchema, pingSchema } from './agent-locations.schema';
import { agentTrail, liveAgents, orderTimeline, recordPing, trackingClientSettings } from './agent-locations.service';
import { mintLiveStreamToken } from './agent-locations.stream';

function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error?.flatten());
  return result.data as T;
}

/* The agent ---------------------------------------------------------- */

/** `POST /agent-locations/me` — the phone's fix, with the trip it is on. */
export async function pingHandler(req: Request, res: Response): Promise<void> {
  const body = parse(pingSchema, req.body);
  res.json({ success: true, data: await recordPing(req.user!.sub, body) });
}

/** `GET /agent-locations/me/settings` — the intervals, the mode, the consent line. */
export async function clientSettingsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await trackingClientSettings() });
}

/* The desk ----------------------------------------------------------- */

export async function liveHandler(req: Request, res: Response): Promise<void> {
  const filter = parse(liveFilterSchema, req.query);
  res.json({ success: true, data: await liveAgents(filter) });
}

export async function streamTokenHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await mintLiveStreamToken(req.user!.sub, req.user!.roles ?? []) });
}

export async function trailHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await agentTrail(req.params['agentId'] as string) });
}

export async function orderTimelineHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await orderTimeline(req.params['orderId'] as string) });
}

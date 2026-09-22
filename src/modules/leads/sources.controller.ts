import type { Request, Response } from 'express';
import { z } from 'zod';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { getEffectiveLeadFormsConfig } from '../../shared/integrations';
import { logger } from '../../shared/logging';
import { feedsStatus, getFeedRun, listFeedRuns, runFeed } from './feeds/feeds.service';
import { agentQrInbound, googleLeadInbound, linkedinLeadInbound, metaLeadInbound, siteQrInbound, verifyLinkedInSignature, verifyMetaSignature, webInbound } from './inbound.service';
import { LEAD_SIDES } from './leads.schema';
import { listReferrals, myReferralLink, myReferrals, refer, referralCodeInbound, type Referrer } from './referrals.service';
import { prismaLeadsRepository as repository } from './prisma-leads.repository';

/**
 * LH3: the sources' own doors — the feed runs, the inbound forms and
 * webhooks, the referrals.
 */

const parse = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  return result.data as T;
};

/* ── feeds ─────────────────────────────────────────────────────────────── */

const ring = z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(3).max(200);

export const runFeedSchema = z
  .object({
    side: z.enum(LEAD_SIDES),
    category: z.string().trim().min(1).max(60),
    city: z.string().trim().min(1).max(80).optional(),
    polygon: ring.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .refine((body) => Boolean(body.city) || Boolean(body.polygon), { message: 'Name a city or draw a polygon', path: ['city'] });

export async function feedsStatusHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await feedsStatus() });
}

export async function runFeedHandler(req: Request, res: Response): Promise<void> {
  const body = parse(runFeedSchema, req.body);
  const key = req.params['key'] as string;
  const run = await runFeed(key, body, req.user!.sub);
  await logActivity(req.user!.sub, 'LEAD_FEED_RUN', { req, module: 'leads', targetType: 'LeadFeedRun', targetId: run.id, metadata: { feed: key, side: body.side, category: body.category, city: body.city ?? null, candidates: run.candidates, imported: run.imported, skipped: run.skipped } });
  res.status(201).json({ success: true, data: run });
}

export async function listFeedRunsHandler(req: Request, res: Response): Promise<void> {
  const key = typeof req.query['feed'] === 'string' ? req.query['feed'] : undefined;
  res.json({ success: true, data: await listFeedRuns(key) });
}

export async function getFeedRunHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getFeedRun(req.params['runId'] as string) });
}

/* ── inbound ───────────────────────────────────────────────────────────── */

const phone = z.string().trim().min(6).max(20);

export const webInboundSchema = z.object({
  side: z.enum(LEAD_SIDES),
  businessName: z.string().trim().min(1).max(160),
  contactName: z.string().trim().min(1).max(120).optional(),
  phone,
  email: z.string().email().max(160).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  message: z.string().trim().min(1).max(500).optional(),
  /** A honeypot: a field no person fills. Anything in it is a bot, answered as if it worked. */
  website: z.string().max(200).optional(),
  captchaToken: z.string().optional(),
});

export async function webInboundHandler(req: Request, res: Response): Promise<void> {
  const body = parse(webInboundSchema, req.body);
  if (body.website) {
    res.status(201).json({ success: true, data: { created: false, thanks: true } });
    return;
  }
  const { website: _hp, captchaToken: _c, ...input } = body;
  const answer = await webInbound(input);
  res.status(201).json({ success: true, data: { ...answer, thanks: true } });
}

export const posterInboundSchema = z.object({
  side: z.enum(LEAD_SIDES).optional(),
  phone,
  name: z.string().trim().min(1).max(120).optional(),
  businessName: z.string().trim().min(1).max(160).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  message: z.string().trim().min(1).max(500).optional(),
  website: z.string().max(200).optional(),
});

export async function siteQrInboundHandler(req: Request, res: Response): Promise<void> {
  const body = parse(posterInboundSchema, req.body);
  if (body.website) {
    res.status(201).json({ success: true, data: { created: false, thanks: true } });
    return;
  }
  const answer = await siteQrInbound(req.params['qrId'] as string, { ...body, side: body.side ?? 'PUBLISHER' });
  res.status(201).json({ success: true, data: { ...answer, thanks: true } });
}

export async function agentQrInboundHandler(req: Request, res: Response): Promise<void> {
  const body = parse(posterInboundSchema, req.body);
  if (body.website) {
    res.status(201).json({ success: true, data: { created: false, thanks: true } });
    return;
  }
  const answer = await agentQrInbound(req.params['qrId'] as string, body);
  res.status(201).json({ success: true, data: { ...answer, thanks: true } });
}

export const referralInboundSchema = z.object({
  side: z.enum(LEAD_SIDES),
  businessName: z.string().trim().min(1).max(160),
  contactName: z.string().trim().min(1).max(120).optional(),
  phone,
  city: z.string().trim().min(1).max(80).optional(),
  message: z.string().trim().min(1).max(500).optional(),
  website: z.string().max(200).optional(),
});

export async function referralInboundHandler(req: Request, res: Response): Promise<void> {
  const body = parse(referralInboundSchema, req.body);
  if (body.website) {
    res.status(201).json({ success: true, data: { created: false, thanks: true } });
    return;
  }
  const { website: _hp, ...input } = body;
  const answer = await referralCodeInbound(req.params['code'] as string, input);
  res.status(201).json({ success: true, data: { ...answer, thanks: true } });
}

/* ── the lead-form webhooks ────────────────────────────────────────────── */

/** Meta's subscription handshake: echo the challenge when the verify token matches. */
export async function metaVerifyHandler(req: Request, res: Response): Promise<void> {
  const { meta } = await getEffectiveLeadFormsConfig();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && meta?.verifyToken && token === meta.verifyToken && typeof challenge === 'string') {
    res.status(200).send(challenge);
    return;
  }
  res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Verify token mismatch' } });
}

/** The side a form serves — `?side=` on the webhook URL ops registered; advertiser by default (lead ads sell). */
const sideOf = (req: Request): 'PUBLISHER' | 'ADVERTISER' => (req.query['side'] === 'PUBLISHER' ? 'PUBLISHER' : 'ADVERTISER');

export async function metaLeadWebhookHandler(req: Request, res: Response): Promise<void> {
  const { meta } = await getEffectiveLeadFormsConfig();
  if (!verifyMetaSignature(req.rawBody, req.get('x-hub-signature-256'), meta?.appSecret)) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: meta?.appSecret ? 'Bad signature' : 'Meta lead ads are not configured' } });
    return;
  }
  const body = req.body as { entry?: { changes?: { field?: string; value?: { leadgen_id?: string; page_id?: string; form_id?: string; ad_id?: string; created_time?: number } }[] }[] };
  let handled = 0;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'leadgen' || !change.value) continue;
      await metaLeadInbound(change.value, { side: sideOf(req) })
        .then((answer) => {
          if (answer) handled += 1;
        })
        .catch((err) => logger.warn('Meta lead not created', { err }));
    }
  }
  res.status(200).json({ success: true, data: { handled } });
}

export async function googleLeadWebhookHandler(req: Request, res: Response): Promise<void> {
  const answer = await googleLeadInbound(req.body as never, { side: sideOf(req) });
  res.status(200).json({ success: true, data: { handled: answer ? 1 : 0 } });
}

export async function linkedinLeadWebhookHandler(req: Request, res: Response): Promise<void> {
  const { linkedin } = await getEffectiveLeadFormsConfig();
  if (!verifyLinkedInSignature(req.rawBody, req.get('x-li-signature'), linkedin?.clientSecret)) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: linkedin?.clientSecret ? 'Bad signature' : 'LinkedIn lead forms are not configured' } });
    return;
  }
  const body = req.body as { elements?: unknown[] } | Record<string, unknown>;
  const items = Array.isArray((body as { elements?: unknown[] }).elements) ? ((body as { elements: unknown[] }).elements as never[]) : [body as never];
  let handled = 0;
  for (const item of items) {
    const answer = await linkedinLeadInbound(item, { side: sideOf(req) }).catch((err) => {
      logger.warn('LinkedIn lead not created', { err });
      return null;
    });
    if (answer) handled += 1;
  }
  res.status(200).json({ success: true, data: { handled } });
}

/* ── referrals ─────────────────────────────────────────────────────────── */

/** The caller's party — a publisher, an advertiser or an agent — read narrowly. */
async function referrerOf(req: Request): Promise<Referrer> {
  const userId = req.user!.sub;
  const party = await repository.partyOfUser(userId);
  if (!party) throw new ApiError(404, 'NOT_FOUND', 'No publisher, advertiser or agent account on this sign-in');
  return party;
}

export const referSchema = z.object({
  side: z.enum(LEAD_SIDES),
  businessName: z.string().trim().min(1).max(160),
  contactName: z.string().trim().min(1).max(120).optional(),
  phone,
  city: z.string().trim().min(1).max(80).optional(),
  message: z.string().trim().min(1).max(500).optional(),
});

export async function referHandler(req: Request, res: Response): Promise<void> {
  const body = parse(referSchema, req.body);
  res.status(201).json({ success: true, data: await refer(await referrerOf(req), body) });
}

export async function myReferralsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await myReferrals(await referrerOf(req)) });
}

export async function myReferralLinkHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await myReferralLink(await referrerOf(req)) });
}

export async function listReferralsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listReferrals() });
}

import type { Request, Response } from 'express';
import { z } from 'zod';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { getEffectiveLeadChannelsConfig } from '../../shared/integrations';
import { logger } from '../../shared/logging';
import { OutreachWebhookRejected, type WebhookInput } from '../../shared/outreach';
import { findAgentProfile } from '../agents';
import { answerCall, callStatus, ivrAnswer, ivrChoice, logCall, missedCall, placeCall, requestCallback } from './calls.service';
import { LEAD_CHANNELS, MANUAL_CHANNELS } from './conversations.service';
import { LEAD_SIDES, LEAD_TEMPERATURES } from './leads.schema';
import { prismaLeadsRepository as leads } from './prisma-leads.repository';
import { actorOf, channelFunnel, channelStates, inbox, logTouch, metaVerify, receiveWebhook, sendMessage, teleQueue, threadView } from './outreach.service';
import { createSequence, enrol, getSequence, listSequences, previewStep, runsFor, SEQUENCE_CHANNELS, stopFor, updateSequence } from './sequences.service';
import { prismaOutreachRepository as repository } from './prisma-outreach.repository';

/**
 * LH6: the outreach hub's doors — the thread and the composer on a lead,
 * click-to-call and the call log, the touch log, sequences and their
 * editor, the inbound queue, the tele-team queue, the funnel by channel,
 * and the providers' webhooks.
 */

const parse = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  return result.data as T;
};

const leadIdOf = (req: Request): string => req.params['leadId'] as string;
const isAdmin = (req: Request): boolean => req.user!.roles.includes('ADMIN');
const channelEnum = z.enum(LEAD_CHANNELS);
const pageSchema = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };

/** An agent may only work a lead they hold; the desk may work any. */
async function requireMayWork(req: Request, leadId: string): Promise<void> {
  if (isAdmin(req)) return;
  const lead = await leads.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  const agent = await findAgentProfile(req.user!.sub);
  const held = lead.claimedByAgentId && lead.claimExpiresAt && lead.claimExpiresAt > new Date() ? lead.claimedByAgentId : lead.assignedAgentId;
  if (!agent || (held !== agent.id && held !== null)) throw new ApiError(403, 'FORBIDDEN', 'This lead is on someone else');
}

/* ── the thread ──────────────────────────────────────────────────── */

export async function threadHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  const [thread, runs] = await Promise.all([threadView(leadId), runsFor(leadId)]);
  res.json({ success: true, data: { ...thread, run: runs[0] ?? null, runs } });
}

const sendSchema = z
  .object({
    channel: channelEnum,
    body: z.string().trim().max(4000).optional(),
    subject: z.string().trim().max(200).optional(),
    templateKey: z.string().trim().max(80).optional(),
  })
  .refine((b) => Boolean(b.body || b.templateKey), { message: 'Type a message or pick a template', path: ['body'] });

export async function sendHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  const body = parse(sendSchema, req.body);
  const outcome = await sendMessage({ leadId, channel: body.channel, body: body.body, subject: body.subject, templateKey: body.templateKey, actor: await actorOf(req.user!.sub), source: 'MANUAL' });
  if (outcome.outcome === 'SKIPPED') {
    const status = outcome.reason === 'NOT_CONFIGURED' ? 503 : outcome.reason === 'PROVIDER_ERROR' ? 502 : 409;
    throw new ApiError(status, outcome.reason === 'NOT_CONFIGURED' ? 'INTEGRATION_NOT_CONFIGURED' : 'CONFLICT', outcome.detail, { reason: outcome.reason, messageId: outcome.message?.id ?? null });
  }
  if (isAdmin(req)) await logActivity(req.user!.sub, 'LEAD_MESSAGE_SENT', { req, module: 'leads', targetType: 'Lead', targetId: leadId, metadata: { channel: body.channel, outcome: outcome.outcome, messageId: outcome.message.id, templateKey: body.templateKey ?? null } });
  res.status(201).json({ success: true, data: outcome });
}

const touchSchema = z.object({
  channel: channelEnum,
  note: z.string().trim().max(1000).optional(),
  direction: z.enum(['OUTBOUND', 'INBOUND']).optional(),
  at: z.coerce.date().optional(),
});

export async function touchHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  const body = parse(touchSchema, req.body);
  const message = await logTouch(leadId, await actorOf(req.user!.sub), body);
  if (isAdmin(req)) await logActivity(req.user!.sub, 'LEAD_TOUCH_LOGGED', { req, module: 'leads', targetType: 'Lead', targetId: leadId, metadata: { channel: body.channel, direction: body.direction ?? 'OUTBOUND', manual: MANUAL_CHANNELS.includes(body.channel) } });
  res.status(201).json({ success: true, data: message });
}

/* ── calls ───────────────────────────────────────────────────────── */

const callSchema = z.object({ record: z.boolean().optional() });

export async function callHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  const body = parse(callSchema, req.body ?? {});
  const actor = await actorOf(req.user!.sub);
  const result = await placeCall(leadId, { ...actor, userId: req.user!.sub }, body);
  if (isAdmin(req)) await logActivity(req.user!.sub, 'LEAD_CALL_PLACED', { req, module: 'leads', targetType: 'Lead', targetId: leadId, metadata: { maskedNumber: result.maskedNumber, providerCallId: result.providerCallId, recording: result.recording } });
  res.status(201).json({ success: true, data: result });
}

const callLogSchema = z.object({
  outcome: z.enum(['ANSWERED', 'NO_ANSWER', 'BUSY', 'VOICEMAIL']),
  durationSec: z.number().int().min(0).max(24 * 60 * 60).optional(),
  note: z.string().trim().max(1000).optional(),
  at: z.coerce.date().optional(),
});

export async function callLogHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  const body = parse(callLogSchema, req.body);
  const message = await logCall(leadId, await actorOf(req.user!.sub), body);
  if (isAdmin(req)) await logActivity(req.user!.sub, 'LEAD_CALL_LOGGED', { req, module: 'leads', targetType: 'Lead', targetId: leadId, metadata: { outcome: body.outcome, durationSec: body.durationSec ?? null } });
  res.status(201).json({ success: true, data: message });
}

const callbackSchema = z.object({ when: z.coerce.date().optional(), note: z.string().trim().max(500).optional() });

/** The desk (or LH7's landing) asks for a callback on the lead's behalf. */
export async function callbackHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  const body = parse(callbackSchema, req.body ?? {});
  const lead = await leads.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  const result = await requestCallback(lead, { when: body.when ?? null, note: body.note, via: 'REPLY' });
  res.status(201).json({ success: true, data: result });
}

/* ── channels, queues, funnel ────────────────────────────────────── */

export async function channelsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await channelStates() });
}

const inboxQuerySchema = z.object({
  channel: channelEnum.optional(),
  side: z.enum(LEAD_SIDES).optional(),
  city: z.string().trim().max(80).optional(),
  unanswered: z.preprocess((v) => (v === 'false' || v === '0' ? false : v === undefined ? undefined : true), z.boolean().optional()),
  mine: z.preprocess((v) => v === 'true' || v === '1', z.boolean()).optional(),
  ...pageSchema,
});

export async function inboxHandler(req: Request, res: Response): Promise<void> {
  const query = parse(inboxQuerySchema, req.query);
  let agentId: string | undefined;
  if (!isAdmin(req) || query.mine) {
    const agent = await findAgentProfile(req.user!.sub);
    if (!agent && !isAdmin(req)) throw new ApiError(403, 'FORBIDDEN', 'Agents only');
    agentId = agent?.id;
  }
  res.json({ success: true, data: await inbox({ channel: query.channel, side: query.side, city: query.city, unansweredOnly: query.unanswered ?? true, agentId }, { page: query.page, pageSize: query.pageSize }) });
}

const teleQuerySchema = z.object({
  side: z.enum(LEAD_SIDES).optional(),
  city: z.string().trim().max(80).optional(),
  temperature: z.enum(LEAD_TEMPERATURES).optional(),
  q: z.string().trim().max(80).optional(),
  ...pageSchema,
});

export async function teleQueueHandler(req: Request, res: Response): Promise<void> {
  const query = parse(teleQuerySchema, req.query);
  res.json({ success: true, data: await teleQueue({ side: query.side, city: query.city, temperature: query.temperature, q: query.q }, { page: query.page, pageSize: query.pageSize }) });
}

const funnelQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  side: z.enum(LEAD_SIDES).optional(),
});

export async function channelFunnelHandler(req: Request, res: Response): Promise<void> {
  const query = parse(funnelQuerySchema, req.query);
  const to = query.to ?? new Date();
  const from = query.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  res.json({ success: true, data: await channelFunnel(from, to, query.side) });
}

/* ── sequences ───────────────────────────────────────────────────── */

const stepSchema = z.object({
  channel: z.enum(SEQUENCE_CHANNELS as [string, ...string[]]),
  delayHours: z.number().min(0).max(24 * 90),
  templateKey: z.string().trim().max(80).nullable().optional(),
});
const sequenceBodySchema = z.object({
  side: z.enum(LEAD_SIDES),
  temperature: z.enum(LEAD_TEMPERATURES),
  name: z.string().trim().min(1).max(120),
  steps: z.array(stepSchema).min(1).max(20),
  stopOnReply: z.boolean().default(true),
  isActive: z.boolean().default(true),
});
const sequencePatchSchema = sequenceBodySchema.partial().refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
const SEQUENCE_FIELDS = ['side', 'temperature', 'name', 'steps', 'stopOnReply', 'isActive'] as const;

const sequenceView = (row: { id: string; side: string; temperature: string; name: string; steps: unknown; stopOnReply: boolean; isActive: boolean; createdAt: Date; updatedAt: Date; activeRuns?: number; totalRuns?: number }) => ({
  id: row.id,
  side: row.side,
  temperature: row.temperature,
  name: row.name,
  steps: row.steps,
  stopOnReply: row.stopOnReply,
  isActive: row.isActive,
  activeRuns: row.activeRuns ?? 0,
  totalRuns: row.totalRuns ?? 0,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function listSequencesHandler(req: Request, res: Response): Promise<void> {
  const query = parse(z.object({ side: z.enum(LEAD_SIDES).optional(), active: z.preprocess((v) => v === 'true' || v === '1', z.boolean()).optional() }), req.query);
  const rows = await listSequences({ side: query.side, activeOnly: query.active });
  res.json({ success: true, data: rows.map(sequenceView) });
}

export async function createSequenceHandler(req: Request, res: Response): Promise<void> {
  const body = parse(sequenceBodySchema, req.body);
  const steps = body.steps.map((s) => ({ channel: s.channel as (typeof SEQUENCE_CHANNELS)[number], delayHours: s.delayHours, templateKey: s.templateKey ?? null }));
  const row = await createSequence({ ...body, steps, createdById: req.user!.sub });
  await logActivity(req.user!.sub, 'LEAD_SEQUENCE_CREATED', { req, module: 'leads', targetType: 'LeadSequence', targetId: row.id, metadata: { name: row.name, side: row.side, temperature: row.temperature, steps: steps.length } });
  res.status(201).json({ success: true, data: sequenceView(row) });
}

export async function patchSequenceHandler(req: Request, res: Response): Promise<void> {
  const body = parse(sequencePatchSchema, req.body);
  const id = req.params['sequenceId'] as string;
  const steps = body.steps?.map((s) => ({ channel: s.channel as (typeof SEQUENCE_CHANNELS)[number], delayHours: s.delayHours, templateKey: s.templateKey ?? null }));
  const { steps: _steps, ...rest } = body;
  const { before, after } = await updateSequence(id, { ...rest, ...(steps ? { steps } : {}) });
  await logActivity(req.user!.sub, 'LEAD_SEQUENCE_UPDATED', { req, module: 'leads', targetType: 'LeadSequence', targetId: id, diff: auditDiff(sequenceView(before), sequenceView(after), SEQUENCE_FIELDS) });
  res.json({ success: true, data: sequenceView(after) });
}

export async function getSequenceHandler(req: Request, res: Response): Promise<void> {
  const row = await getSequence(req.params['sequenceId'] as string);
  res.json({ success: true, data: sequenceView(row) });
}

export async function previewStepHandler(req: Request, res: Response): Promise<void> {
  const query = parse(z.object({ templateKey: z.string().trim().min(1).max(80) }), req.query);
  const preview = await previewStep(query.templateKey);
  if (!preview) throw new ApiError(404, 'NOT_FOUND', `No comms template is keyed ${query.templateKey}`);
  res.json({ success: true, data: preview });
}

const enrolSchema = z.object({ sequenceId: z.string().min(1).optional(), force: z.boolean().optional() });

export async function enrolHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  const body = parse(enrolSchema, req.body ?? {});
  const result = await enrol(leadId, body);
  if (!result.run) throw new ApiError(409, 'CONFLICT', `Not enrolled: ${result.reason}`, { reason: result.reason });
  if (isAdmin(req)) await logActivity(req.user!.sub, 'LEAD_SEQUENCE_ENROLLED', { req, module: 'leads', targetType: 'Lead', targetId: leadId, metadata: { runId: result.run.id, sequenceId: result.run.sequenceId, forced: Boolean(body.force) } });
  res.status(201).json({ success: true, data: { runId: result.run.id, reason: result.reason } });
}

export async function stopSequenceHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  const stopped = await stopFor(leadId, 'MANUAL');
  if (isAdmin(req)) await logActivity(req.user!.sub, 'LEAD_SEQUENCE_STOPPED', { req, module: 'leads', targetType: 'Lead', targetId: leadId, metadata: { stopped } });
  res.json({ success: true, data: { stopped } });
}

/* ── webhooks ────────────────────────────────────────────────────── */

const webhookInput = (req: Request): WebhookInput => ({
  headers: req.headers as Record<string, string | string[] | undefined>,
  rawBody: req.rawBody,
  body: req.body,
  query: req.query as Record<string, unknown>,
  url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
});

async function guarded(res: Response, work: () => Promise<unknown>): Promise<void> {
  try {
    res.json({ success: true, data: await work() });
  } catch (err) {
    if (err instanceof OutreachWebhookRejected) {
      logger.warn('Outreach webhook rejected', { reason: err.message });
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: err.message } });
      return;
    }
    throw err;
  }
}

export async function metaVerifyHandler(req: Request, res: Response): Promise<void> {
  const challenge = await metaVerify(req.query as Record<string, unknown>);
  if (!challenge) {
    res.status(403).send('Forbidden');
    return;
  }
  res.type('text/plain').send(challenge);
}

export const metaWebhookHandler = (req: Request, res: Response) => guarded(res, () => receiveWebhook('meta', webhookInput(req)));
export const gupshupWebhookHandler = (req: Request, res: Response) => guarded(res, () => receiveWebhook('gupshup', webhookInput(req)));
export const interaktWebhookHandler = (req: Request, res: Response) => guarded(res, () => receiveWebhook('interakt', webhookInput(req)));

export async function googleBusinessWebhookHandler(req: Request, res: Response): Promise<void> {
  try {
    const result = await receiveWebhook('google-business', webhookInput(req));
    if (result.handshake) {
      res.json(result.handshake);
      return;
    }
    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof OutreachWebhookRejected) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: err.message } });
      return;
    }
    throw err;
  }
}

/** The BSPs sign nothing: their door is admitted by the card's webhook secret in the URL. */
export function requireChannelToken(section: 'whatsapp') {
  return async (req: Request, res: Response, next: () => void): Promise<void> => {
    const cfg = await getEffectiveLeadChannelsConfig();
    const expected = cfg[section]?.verifyToken;
    const presented = typeof req.query['token'] === 'string' ? req.query['token'] : req.get('x-webhook-token');
    if (!expected || presented !== expected) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Webhook token mismatch' } });
      return;
    }
    next();
  };
}

export const callStatusHandler = (req: Request, res: Response) => guarded(res, () => callStatus(webhookInput(req)));
export const missedCallHandler = (req: Request, res: Response) => guarded(res, () => missedCall(webhookInput(req)));

export async function answerCallHandler(req: Request, res: Response): Promise<void> {
  res.type('text/xml').send(await answerCall(req.query as Record<string, unknown>));
}

export async function ivrHandler(req: Request, res: Response): Promise<void> {
  const format = req.query['format'] === 'json' || (req.get('accept') ?? '').includes('application/json') ? 'json' : 'twiml';
  const answer = await ivrAnswer(format);
  res.type(answer.contentType).send(answer.body);
}

export async function ivrChoiceHandler(req: Request, res: Response): Promise<void> {
  try {
    const result = await ivrChoice(webhookInput(req));
    if (req.query['format'] === 'json') res.json({ success: true, data: { leadId: result.leadId, taskId: result.taskId, side: result.side } });
    else res.type('text/xml').send(result.twiml);
  } catch (err) {
    if (err instanceof OutreachWebhookRejected) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: err.message } });
      return;
    }
    throw err;
  }
}

/** The lead's messages as a bare list — the app's poll while a thread is open. */
export async function messagesHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  const query = parse(z.object({ take: z.coerce.number().int().min(1).max(400).default(200) }), req.query);
  const rows = await repository.listMessages(leadId, query.take);
  res.json({ success: true, data: rows.map((m) => ({ ...m, recordingUrl: m.recordingFileId ? `/api/v1/files/${m.recordingFileId}` : null })) });
}

import type { Lead, LeadMessage } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { getEffectiveLeadChannelsConfig } from '../../shared/integrations';
import { logger } from '../../shared/logging';
import { answerTwiml, e164, ivrTwiml, telephonyAdapter, type CallOutcome, type WebhookInput } from '../../shared/outreach';
import { env } from '../../config/env';
import { notify } from '../notifications';
import { purgeStoredFile, storeGeneratedFile } from '../uploads';
import { completeTaggedTasks, createSystemTask } from '../work';
import { recordInbound, recordOutbound } from './conversations.service';
import { inboundLead } from './inbound.service';
import { prismaLeadsRepository as leads } from './prisma-leads.repository';
import { prismaOutreachRepository as repository } from './prisma-outreach.repository';
import { engage, type SendInput } from './outreach.service';
import { touchLead } from './scoring.service';
import { advanceStage, stampMoment } from './stages.service';
import { isOpenStage, type LeadStageValue } from './stages.rules';

/**
 * LH6 (D5): telephony. Click-to-call from the app and the console on a
 * masked number; the operator's status callback closes the row with the
 * outcome and the duration, and keeps a consented recording as a private
 * file for 90 days; a missed call to the missed-call number and an IVR key
 * press each become a lead (or find one) and a callback task on the
 * agent's day; a call the agent dialled by hand is logged with its outcome.
 */

export const RECORDING_RETENTION_DAYS = 90;
const CALLBACK_HOURS = 4;

/** The public base the operators post back to — `BASE_URL` in production, the local port otherwise. */
function webhookBase(): string {
  return `${(env.BASE_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, '')}/api/v1/webhooks/outreach/telephony`;
}

function hookUrl(path: string, secret: string | undefined): string {
  const base = `${webhookBase()}/${path}`;
  return secret ? `${base}?token=${encodeURIComponent(secret)}` : base;
}

/** A caller id from the card — the first, or the one after the last used, so a few numbers share the load. */
let rotation = 0;
function pickCallerId(callerIds: string[] | undefined): string | null {
  if (!callerIds || callerIds.length === 0) return null;
  rotation = (rotation + 1) % callerIds.length;
  return callerIds[rotation] ?? callerIds[0] ?? null;
}

export type PlaceCallResult = { message: LeadMessage; maskedNumber: string; providerCallId: string; recording: boolean; consentLine: string | null };

/**
 * Click-to-call: rings the actor's own mobile first, then the lead on the
 * masked number. Recording is asked for only when the card says so AND a
 * consent line is set — the line plays before the lead is connected, and
 * `consentPlayed` on the row is what later admits the file.
 */
export async function placeCall(leadId: string, actor: SendInput['actor'] & { userId: string }, options: { record?: boolean | undefined } = {}, now = new Date()): Promise<PlaceCallResult> {
  const lead = await leads.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  if (!isOpenStage(lead.stage as LeadStageValue)) throw new ApiError(409, 'CONFLICT', 'This lead is closed');
  const leadNumber = lead.phoneNormalised ?? lead.phone;
  if (!leadNumber) throw new ApiError(400, 'VALIDATION_ERROR', 'No phone number on this lead');
  const desc = await telephonyAdapter.describe();
  if (!desc.configured) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', `Calling through ADX is not set up (${desc.missing.join(', ')} missing) — dial from your phone and log the call`, { missing: desc.missing });
  const caller = await repository.findCaller(actor.userId);
  if (!caller?.mobile) throw new ApiError(400, 'VALIDATION_ERROR', 'Your account has no mobile number to ring first');
  const cfg = (await getEffectiveLeadChannelsConfig()).telephony ?? {};
  const callerId = pickCallerId(cfg.callerIds);
  if (!callerId) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'No masked number is set on the telephony card', { missing: ['callerIds'] });
  const consentLine = cfg.consentLine?.trim() || null;
  const record = Boolean((options.record ?? cfg.recordCalls) && consentLine);
  const placed = await telephonyAdapter.placeCall({
    agentNumber: caller.mobile,
    leadNumber,
    callerId,
    record,
    consentLine,
    statusCallbackUrl: hookUrl('status', cfg.webhookSecret),
    answerUrl: `${hookUrl('answer', cfg.webhookSecret)}${cfg.webhookSecret ? '&' : '?'}lead=${encodeURIComponent(lead.id)}&record=${record ? '1' : '0'}`,
  });
  if (!placed.ok) {
    if (placed.code === 'NOT_CONFIGURED' || placed.code === 'NO_CALLER_ID') throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', placed.message);
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', placed.message, { code: 'PROVIDER_ERROR' });
  }
  const { message } = await recordOutbound(lead, {
    channel: 'CALL',
    body: `Call placed from ADX${record ? ' (recorded, consent line played)' : ''}`,
    status: 'QUEUED',
    at: now,
    maskedNumber: placed.maskedNumber,
    providerCallId: placed.providerCallId,
    consentPlayed: record ? true : null,
    byAgentId: actor.agentId ?? lead.assignedAgentId ?? null,
    byUserId: actor.userId,
  });
  await leads.logActivity({ leadId, actorUserId: actor.userId, kind: 'CALLED', note: `Calling through ADX on ${placed.maskedNumber}` });
  return { message, maskedNumber: placed.maskedNumber, providerCallId: placed.providerCallId, recording: record, consentLine: record ? consentLine : null };
}

/** Twilio's answer URL: the consent line (recorded calls only), then the dial. `lead` and `record` ride the query the call was placed with. */
export async function answerCall(query: Record<string, unknown>): Promise<string> {
  const cfg = (await getEffectiveLeadChannelsConfig()).telephony ?? {};
  const leadId = typeof query['lead'] === 'string' ? query['lead'] : null;
  const lead = leadId ? await leads.findById(leadId) : null;
  const leadNumber = lead?.phoneNormalised ?? lead?.phone ?? null;
  if (!leadNumber) throw new ApiError(404, 'NOT_FOUND', 'No lead to connect');
  const record = query['record'] === '1' && Boolean(cfg.consentLine);
  return answerTwiml({ consentLine: record ? (cfg.consentLine ?? null) : null, leadNumber, callerId: cfg.callerIds?.[0] ?? '', record, statusCallbackUrl: hookUrl('status', cfg.webhookSecret) });
}

/** What a finished call did to the lead: an answered call is a contact (D14: channel CALL); every call is a touch. */
async function afterCall(lead: Lead, message: LeadMessage, outcome: CallOutcome | null, actorUserId: string | null, now: Date): Promise<void> {
  await completeTaggedTasks('LEAD', lead.id, 'callback', now).catch(() => 0);
  await completeTaggedTasks('LEAD', lead.id, 'call', now).catch(() => 0);
  if (outcome === 'ANSWERED') {
    if (!lead.firstContactedAt) await leads.update(lead.id, { firstContactedAt: now, ...(lead.status === 'NEW' ? { status: 'CONTACTED' } : {}) });
    await stampMoment(lead.id, 'firstContact', 'CALL', now);
    await advanceStage(lead.id, 'CONTACTED', { actorUserId, channel: 'CALL', at: now, note: `answered a call${message.durationSec ? ` (${message.durationSec} s)` : ''}` });
  }
  await touchLead(lead.id, now);
}

/** The operator's status callback on a call we placed — outcome, duration, the recording when consent was played. */
export async function callStatus(input: WebhookInput, now = new Date()): Promise<{ matched: boolean; outcome: CallOutcome | null; recorded: boolean }> {
  const status = await telephonyAdapter.parseStatus(input);
  if (!status) return { matched: false, outcome: null, recorded: false };
  const row = await repository.findMessageByCallId(status.providerCallId);
  if (!row) return { matched: false, outcome: status.outcome, recorded: false };
  if (!status.final && status.outcome === null) return { matched: true, outcome: null, recorded: false };
  const lead = await leads.findById(row.leadId);
  const outcome = status.outcome ?? 'NO_ANSWER';
  let recordingFileId: string | null = row.recordingFileId;
  let recorded = false;
  // The consent line gates the file: a recording that arrives for a call whose line did not play is not kept.
  if (status.recordingUrl && row.consentPlayed === true && !recordingFileId) {
    try {
      const fetched = await telephonyAdapter.fetchRecording(status.recordingUrl);
      if (fetched && lead) {
        const owner = row.byUserId ?? (lead.assignedAgentId ? (await repository.findAgentUser(lead.assignedAgentId))?.userId : null);
        if (owner) {
          const file = await storeGeneratedFile(owner, { content: fetched.bytes, filename: `call-${status.providerCallId}.${fetched.mimeType.includes('wav') ? 'wav' : 'mp3'}`, mimeType: fetched.mimeType, purpose: 'CALL_RECORDING' });
          recordingFileId = file.id;
          recorded = true;
        }
      }
    } catch (err) {
      logger.warn('Call recording not kept', { providerCallId: status.providerCallId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const already = row.status !== 'QUEUED';
  const updated = await repository.updateMessage(row.id, {
    status: outcome === 'ANSWERED' ? 'DELIVERED' : 'SENT',
    outcome,
    durationSec: status.durationSec,
    recordingFileId,
    body: `Call ${outcomeLabel(outcome)}${status.durationSec ? ` · ${status.durationSec} s` : ''}${recordingFileId ? ' · recorded' : ''}`,
  });
  if (lead && !already) {
    await repository.updateConversation(row.conversationId, { lastOutboundAt: now });
    await leads.logActivity({ leadId: lead.id, actorUserId: row.byUserId, kind: 'CALLED', note: `${outcomeLabel(outcome)}${status.durationSec ? ` after ${status.durationSec} s` : ''}` });
    await afterCall(lead, updated, outcome, row.byUserId, now);
  }
  return { matched: true, outcome, recorded };
}

export function outcomeLabel(outcome: CallOutcome | null): string {
  switch (outcome) {
    case 'ANSWERED':
      return 'answered';
    case 'BUSY':
      return 'busy';
    case 'VOICEMAIL':
      return 'went to voicemail';
    case 'NO_ANSWER':
      return 'not answered';
    default:
      return 'in progress';
  }
}

/** A call the agent dialled from their own phone (telephony NOT_CONFIGURED, or by choice): logged with its outcome. */
export async function logCall(leadId: string, actor: SendInput['actor'], input: { outcome: CallOutcome; durationSec?: number | undefined; note?: string | undefined; at?: Date | undefined }): Promise<LeadMessage> {
  const lead = await leads.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  if (!isOpenStage(lead.stage as LeadStageValue)) throw new ApiError(409, 'CONFLICT', 'This lead is closed');
  const at = input.at ?? new Date();
  const { message } = await recordOutbound(lead, {
    channel: 'CALL',
    body: `Call ${outcomeLabel(input.outcome)}${input.durationSec ? ` · ${input.durationSec} s` : ''}${input.note ? ` — ${input.note.trim()}` : ''}`,
    status: input.outcome === 'ANSWERED' ? 'DELIVERED' : 'SENT',
    outcome: input.outcome,
    durationSec: input.durationSec ?? null,
    consentPlayed: null,
    at,
    byAgentId: actor.agentId ?? lead.assignedAgentId ?? null,
    byUserId: actor.userId,
  });
  await leads.logActivity({ leadId, actorUserId: actor.userId, kind: 'CALLED', note: `${outcomeLabel(input.outcome)}${input.note ? ` — ${input.note.trim()}` : ''}` });
  await afterCall(lead, message, input.outcome, actor.userId, at);
  return message;
}

/* ── callbacks ───────────────────────────────────────────────────── */

/** A callback the lead asked for — a task on the holder's day (or unassigned, for the tele queue), a push, a line on the thread. */
export async function requestCallback(lead: Lead, input: { when?: Date | null | undefined; note?: string | undefined; via: 'MISSED_CALL' | 'IVR' | 'REPLY' | 'LINK' | 'FORM'; providerCallId?: string | null | undefined }, now = new Date()): Promise<{ taskId: string; assigneeUserId: string | null }> {
  const holder = lead.claimedByAgentId && lead.claimExpiresAt && lead.claimExpiresAt > now ? lead.claimedByAgentId : lead.assignedAgentId;
  const agent = holder ? await repository.findAgentUser(holder) : null;
  const due = input.when ?? new Date(now.getTime() + CALLBACK_HOURS * 60 * 60 * 1000);
  const viaLabel = input.via === 'MISSED_CALL' ? 'a missed call' : input.via === 'IVR' ? 'the IVR' : input.via === 'REPLY' ? 'a reply' : input.via === 'LINK' ? 'their link' : 'a form';
  const task = await createSystemTask(
    { title: `Call back ${lead.businessName}`, description: `Asked through ${viaLabel}${input.note ? `: ${input.note}` : ''}${lead.phone ? ` · ${lead.phone}` : ''}`, linkedKind: 'LEAD', linkedId: lead.id, assigneeUserIds: agent ? [agent.userId] : [], deadline: due, priority: 'HIGH', tag: 'callback' },
    now,
  );
  await recordInbound(lead, { channel: 'CALL', body: `Asked for a call back through ${viaLabel}${input.note ? `: ${input.note}` : ''}`, at: now, source: 'OTHER', providerCallId: input.providerCallId ?? null, providerMessageId: input.providerCallId ? `callback:${input.providerCallId}` : null });
  if (agent) {
    await notify(
      'LEAD_CALLBACK_REQUESTED',
      agent.userId,
      { businessName: lead.businessName, when: input.when ? ` at ${input.when.toISOString()}` : '', deepLink: `adx://lead/${lead.id}` },
      { type: 'SYSTEM', inApp: { type: 'SYSTEM', title: 'Callback asked for', subtitle: lead.businessName, message: `Through ${viaLabel}. It is on your day.`, relatedType: 'LEAD', relatedId: lead.id } },
    ).catch((err) => logger.warn('Callback push not sent', { leadId: lead.id, err }));
  }
  return { taskId: task.id, assigneeUserId: agent?.userId ?? null };
}

/** A lead by the number that called, or a new one from the missed-call / IVR door. */
async function leadByCaller(from: string, side: 'PUBLISHER' | 'ADVERTISER', door: 'missed-call' | 'ivr', note: string): Promise<Lead | null> {
  try {
    const answer = await inboundLead({ side, businessName: `Caller ${from.slice(-4)}`, phone: from, channel: 'CALL', message: note }, { sourceKey: door, sourceKind: 'INBOUND', note });
    return leads.findById(answer.leadId);
  } catch (err) {
    // An account holder rang the number: not a prospect, nothing to open.
    if (err instanceof ApiError && err.statusCode === 409) return null;
    throw err;
  }
}

/**
 * The missed-call number: the caller becomes (or finds) a lead and a
 * callback task lands on the holder's day. Which side? The existing lead's;
 * for a new one, PUBLISHER — the missed-call number is what the "earn from
 * your wall" posters carry (a default; the IVR asks properly).
 */
export async function missedCall(input: WebhookInput, now = new Date()): Promise<{ leadId: string | null; taskId: string | null }> {
  const event = await telephonyAdapter.parseInbound(input, now);
  if (!event) return { leadId: null, taskId: null };
  const lead = await leadByCaller(event.from, 'PUBLISHER', 'missed-call', 'Gave a missed call');
  if (!lead) return { leadId: null, taskId: null };
  const { taskId } = await requestCallback(lead, { via: 'MISSED_CALL', providerCallId: event.providerCallId }, now);
  if (isOpenStage(lead.stage as LeadStageValue)) await engage(lead, 'CALL', 'Gave a missed call', null, now).catch((err) => logger.warn('Missed call not engaged', { leadId: lead.id, err }));
  return { leadId: lead.id, taskId };
}

/** The IVR number's answer: TwiML for Twilio; the prompts as JSON for an operator whose flow reads them (or whose flow carries its own audio). */
export async function ivrAnswer(format: 'twiml' | 'json'): Promise<{ contentType: string; body: string }> {
  const cfg = (await getEffectiveLeadChannelsConfig()).telephony ?? {};
  const prompts = { greeting: cfg.ivrGreeting ?? '', publisherPrompt: cfg.ivrPublisherPrompt ?? '', advertiserPrompt: cfg.ivrAdvertiserPrompt ?? '' };
  if (format === 'twiml') return { contentType: 'text/xml', body: ivrTwiml({ ...prompts, actionUrl: hookUrl('ivr/choice', cfg.webhookSecret) }) };
  return { contentType: 'application/json', body: JSON.stringify({ ...prompts, choices: { '1': 'PUBLISHER', '2': 'ADVERTISER' } }) };
}

/** The IVR's key press: 1 is a publisher, 2 an advertiser; the caller becomes a lead of that side with a callback on the day. */
export async function ivrChoice(input: WebhookInput, now = new Date()): Promise<{ leadId: string | null; taskId: string | null; side: 'PUBLISHER' | 'ADVERTISER' | null; twiml: string }> {
  const event = await telephonyAdapter.parseInbound(input, now);
  const side = event?.digits === '1' ? 'PUBLISHER' : event?.digits === '2' ? 'ADVERTISER' : null;
  const goodbye = (line: string) => `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${line}</Say></Response>`;
  if (!event || !side) return { leadId: null, taskId: null, side: null, twiml: goodbye('We did not get that. Goodbye.') };
  const lead = await leadByCaller(event.from, side, 'ivr', `Pressed ${event.digits} on the IVR`);
  if (!lead) return { leadId: null, taskId: null, side, twiml: goodbye('You already have an ADX account. Please use the app. Goodbye.') };
  const { taskId } = await requestCallback(lead, { via: 'IVR', providerCallId: event.providerCallId }, now);
  if (isOpenStage(lead.stage as LeadStageValue)) await engage(lead, 'CALL', `Pressed ${event.digits} on the IVR`, null, now).catch((err) => logger.warn('IVR choice not engaged', { leadId: lead.id, err }));
  return { leadId: lead.id, taskId, side, twiml: goodbye('Thank you. Someone from ADX will call you back shortly. Goodbye.') };
}

/** D5: recordings are private files kept 90 days; the tick purges the rest and clears the row's pointer. */
export async function purgeRecordings(now = new Date(), take = 200): Promise<number> {
  const cutoff = new Date(now.getTime() - RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await repository.recordingsBefore(cutoff, take);
  let purged = 0;
  for (const row of rows) {
    await purgeStoredFile(row.recordingFileId).catch((err) => logger.warn('Recording file not purged', { fileId: row.recordingFileId, err }));
    await repository.updateMessage(row.id, { recordingFileId: null });
    purged += 1;
  }
  return purged;
}

export { e164 };

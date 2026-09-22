import type { Lead, LeadConversation, LeadMessage } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { getEffectiveEmailConfig, getEffectiveLeadChannelsConfig, getEffectiveSmsConfig } from '../../shared/integrations';
import { logger } from '../../shared/logging';
import { googleBusinessAdapter, metaDmAdapter, metaHandshake, telephonyAdapter, whatsappAdapter, type AdapterDescription, type InboundEvent, type StatusEvent, type WebhookInput } from '../../shared/outreach';
import { findAgentProfile } from '../agents';
import { getPlatformSettings } from '../app-config';
import { allocateIdentifier } from '../identifiers';
import { notify, quietHoursDeferral, renderText, weekWindowIST } from '../notifications';
import { withCityKey } from '../pricing';
import { createSystemTask } from '../work';
import { normalisePhone } from './leads.phone';
import { prismaLeadsRepository as leads } from './prisma-leads.repository';
import { prismaOutreachRepository as repository } from './prisma-outreach.repository';
import type { ChannelStat, InboxFilter, TeleFilter } from './outreach.repository';
import { resolveSource } from './leads.service';
import { recomputeLead, touchLead } from './scoring.service';
import { advanceStage, stampMoment } from './stages.service';
import { isOpenStage, type LeadStageValue } from './stages.rules';
import { routeLead } from './routing.service';
import { listProposalsFor, type ProposalView } from './proposals.service';
import {
  ensureConversation,
  isLeadChannel,
  MANUAL_CHANNELS,
  recordInbound,
  recordOutbound,
  threadIdFor,
  windowOpen,
  WINDOWED_CHANNELS,
  type LeadChannelValue,
} from './conversations.service';

/**
 * LH6 (the Lead Hunt, 22 Sep 2026): THE OUTREACH HUB — decisions D5, D13, D14.
 *
 * One port, ten channels. `send` decides whether a lead may be written to
 * on a channel (the adapter is configured, the lead has the address, the
 * Meta window is open or an approved template stands in), rules quiet hours
 * and the weekly cap on every outbound, hands the text to the adapter,
 * writes the row and stamps the attribution. `receive` reads a provider's
 * webhook into the thread: any inbound on any channel stops the lead's
 * sequence, moves it to ENGAGED and lands a hand-off task on the agent
 * holding it. `reachability` is what the app's "Reach out" sheet and the
 * console's composer offer — only the channels that would actually go.
 *
 * SMS and email leave by the comms dispatcher (the `LEAD_OUTREACH` event,
 * the `lead-outreach` template, `{{body}}` the copy already rendered);
 * WhatsApp, the two DMs and Business Messages by their adapters; calls by
 * `calls.service.ts`; LinkedIn, in person and "other" are logged by hand
 * (`logTouch`) — D13, no cold DMs by API.
 */

export type ReachMode = 'FREEFORM' | 'TEMPLATE' | 'REPLY' | 'CALL' | 'MANUAL';

export type ChannelState = {
  channel: LeadChannelValue;
  configured: boolean;
  provider: string | null;
  reachable: boolean;
  /** Why not, in a sentence the sheet can print; null when reachable. */
  reason: string | null;
  /** How a send would go: free text, an approved template (WhatsApp outside the window), a reply inside the window, a call, a touch logged by hand. */
  mode: ReachMode | null;
  windowClosesAt: string | null;
  /** The address the channel would use, masked for the app — the number, the email, the handle. */
  address: string | null;
};

export type SendInput = {
  leadId: string;
  channel: LeadChannelValue;
  /** Typed text; or a template key the copy is rendered from (a sequence step, a canned opener). */
  body?: string | undefined;
  templateKey?: string | undefined;
  subject?: string | undefined;
  actor: { userId: string | null; agentId: string | null };
  source: 'MANUAL' | 'SEQUENCE';
  sequenceRunId?: string | null | undefined;
};

export type SendOutcome =
  | { outcome: 'SENT'; message: LeadMessage }
  | { outcome: 'QUEUED'; message: LeadMessage; scheduledFor: Date }
  | { outcome: 'SKIPPED'; message: LeadMessage | null; reason: 'NOT_CONFIGURED' | 'UNREACHABLE' | 'NO_WINDOW' | 'NO_TEMPLATE' | 'WEEKLY_CAP' | 'CLOSED' | 'PROVIDER_ERROR'; detail: string };

const PREVIEW_MAX = 120;
const THREAD_TAKE = 400;

/* ── adapters by channel ─────────────────────────────────────────── */

async function describeAll(): Promise<Record<LeadChannelValue, AdapterDescription>> {
  const [whatsapp, instagram, messenger, googleBusiness, telephony, smsAndEmail] = await Promise.all([
    whatsappAdapter.describe(),
    metaDmAdapter.describe('INSTAGRAM'),
    metaDmAdapter.describe('MESSENGER'),
    googleBusinessAdapter.describe(),
    telephonyAdapter.describe(),
    commsDoors(),
  ]);
  const manual: AdapterDescription = { configured: true, provider: 'manual', missing: [] };
  return { SMS: smsAndEmail.sms, EMAIL: smsAndEmail.email, WHATSAPP: whatsapp, INSTAGRAM: instagram, MESSENGER: messenger, GOOGLE_BUSINESS: googleBusiness, CALL: telephony, LINKEDIN: manual, IN_PERSON: manual, OTHER: manual };
}

/** SMS and email are "configured" when the comms doors are — the dispatcher decides at send time; the hub only says whether a door exists. */
async function commsDoors(): Promise<{ sms: AdapterDescription; email: AdapterDescription }> {
  const [sms, email] = await Promise.all([getEffectiveSmsConfig(), getEffectiveEmailConfig()]);
  const smsOk = Boolean(sms.authKey || (sms.templates && Object.keys(sms.templates).length > 0));
  const emailOk = Boolean(email.host || email.primary === 'RESEND' || email.mode === 'ETHEREAL');
  return {
    sms: { configured: smsOk, provider: sms.primaryRail ?? null, missing: smsOk ? [] : ['sms door'] },
    email: { configured: emailOk, provider: email.primary?.toLowerCase() ?? null, missing: emailOk ? [] : ['email door'] },
  };
}

/** The states every card and sheet read: configured or not, per channel, with the provider named. */
export async function channelStates(): Promise<Record<LeadChannelValue, AdapterDescription>> {
  return describeAll();
}

/* ── reachability ────────────────────────────────────────────────── */

const maskPhone = (value: string | null): string | null => (value ? value.replace(/^(\+\d{2}|\d{0,2})\d+(\d{2})$/, '$1 •••$2') : null);
const maskEmail = (value: string | null): string | null => (value ? value.replace(/^(.).*(@.*)$/, '$1***$2') : null);

/** What each channel would do for this lead right now — the app's sheet and the console's composer draw exactly this. */
export async function reachability(lead: Lead, now = new Date(), states?: Record<LeadChannelValue, AdapterDescription>): Promise<ChannelState[]> {
  const described = states ?? (await describeAll());
  const conversations = await repository.listConversations(lead.id);
  const byChannel = new Map(conversations.map((c) => [c.channel as LeadChannelValue, c]));
  const whatsappTemplates = (await getEffectiveLeadChannelsConfig()).whatsapp?.templates ?? {};
  const closed = !isOpenStage(lead.stage as LeadStageValue);
  const out: ChannelState[] = [];

  for (const channel of ['CALL', 'WHATSAPP', 'SMS', 'EMAIL', 'INSTAGRAM', 'MESSENGER', 'GOOGLE_BUSINESS', 'LINKEDIN', 'IN_PERSON', 'OTHER'] as const) {
    const desc = described[channel];
    const conversation = byChannel.get(channel) ?? null;
    const base = { channel, configured: desc.configured, provider: desc.provider, windowClosesAt: conversation?.windowClosesAt?.toISOString() ?? null };
    const no = (reason: string, address: string | null = null): ChannelState => ({ ...base, reachable: false, reason, mode: null, address });
    if (closed) {
      out.push(no('This lead is closed'));
      continue;
    }
    if (MANUAL_CHANNELS.includes(channel)) {
      out.push({ ...base, reachable: true, reason: null, mode: 'MANUAL', address: null });
      continue;
    }
    if (!desc.configured) {
      out.push(no(channel === 'CALL' ? 'Calling through ADX is not set up yet — dial from your phone and log the call' : `${channelLabel(channel)} is not set up under Settings › Integrations › Channels`, channel === 'CALL' ? maskPhone(lead.phoneNormalised ?? lead.phone) : null));
      continue;
    }
    if (channel === 'CALL' || channel === 'SMS' || channel === 'WHATSAPP') {
      const phone = lead.phoneNormalised ?? lead.phone;
      if (!phone) {
        out.push(no('No phone number on this lead'));
        continue;
      }
      if (channel === 'CALL') {
        out.push({ ...base, reachable: true, reason: null, mode: 'CALL', address: maskPhone(phone) });
        continue;
      }
      if (channel === 'SMS') {
        out.push({ ...base, reachable: true, reason: null, mode: 'FREEFORM', address: maskPhone(phone) });
        continue;
      }
      if (windowOpen(conversation, now)) out.push({ ...base, reachable: true, reason: null, mode: 'REPLY', address: maskPhone(phone) });
      else if (Object.keys(whatsappTemplates).length > 0) out.push({ ...base, reachable: true, reason: null, mode: 'TEMPLATE', address: maskPhone(phone) });
      else out.push(no('Outside the 24-hour window and no approved WhatsApp template is on the card', maskPhone(phone)));
      continue;
    }
    if (channel === 'EMAIL') {
      if (!lead.email) {
        out.push(no('No email address on this lead'));
        continue;
      }
      out.push({ ...base, reachable: true, reason: null, mode: 'FREEFORM', address: maskEmail(lead.email) });
      continue;
    }
    // Instagram, Messenger, Business Messages: replies only, inside the window (D13).
    if (!conversation?.providerThreadId) {
      out.push(no(`${channelLabel(channel)}: they have not written to us here yet — no cold DMs`));
      continue;
    }
    if (!windowOpen(conversation, now)) {
      out.push(no(`${channelLabel(channel)}: the reply window closed — wait for them to write again`, conversation.providerThreadId));
      continue;
    }
    out.push({ ...base, reachable: true, reason: null, mode: 'REPLY', address: conversation.providerThreadId });
  }
  return out;
}

/** LH7: the invite link engages and converts too — an attribution channel, not a thread. */
export type EngageChannel = LeadChannelValue | 'LINK';

export function channelLabel(channel: EngageChannel): string {
  switch (channel) {
    case 'LINK':
      return 'Invite link';
    case 'SMS':
      return 'SMS';
    case 'EMAIL':
      return 'Email';
    case 'WHATSAPP':
      return 'WhatsApp';
    case 'INSTAGRAM':
      return 'Instagram';
    case 'MESSENGER':
      return 'Messenger';
    case 'GOOGLE_BUSINESS':
      return 'Google Business Messages';
    case 'CALL':
      return 'Call';
    case 'LINKEDIN':
      return 'LinkedIn';
    case 'IN_PERSON':
      return 'In person';
    default:
      return 'Other';
  }
}

/* ── the two comms rules, per lead ───────────────────────────────── */

export type OutboundRuling = { skip: 'WEEKLY_CAP' | null; deferUntil: Date | null; sentThisWeek: number; cap: number };

/**
 * Quiet hours and the weekly cap apply to every outbound (the brief), with
 * one reading recorded as a default: a reply inside an open window — the
 * lead wrote to us in the last day — is a conversation, not outreach, and
 * leaves at once. Everything else waits for the morning and stops at the
 * week's cap, counted per lead across every channel.
 */
export async function outboundRuling(lead: Pick<Lead, 'id'>, conversation: Pick<LeadConversation, 'lastInboundAt'> | null, now: Date): Promise<OutboundRuling> {
  const { comms } = await getPlatformSettings();
  const replying = conversation?.lastInboundAt !== null && conversation?.lastInboundAt !== undefined && now.getTime() - conversation.lastInboundAt.getTime() < 24 * 60 * 60 * 1000;
  const week = weekWindowIST(now);
  const sentThisWeek = await repository.countOutboundBetween(lead.id, week.start, week.end);
  if (replying) return { skip: null, deferUntil: null, sentThisWeek, cap: comms.weeklyCapPerUser };
  if (sentThisWeek >= comms.weeklyCapPerUser) return { skip: 'WEEKLY_CAP', deferUntil: null, sentThisWeek, cap: comms.weeklyCapPerUser };
  return { skip: null, deferUntil: quietHoursDeferral(now, comms.quietHours), sentThisWeek, cap: comms.weeklyCapPerUser };
}

/* ── rendering ───────────────────────────────────────────────────── */

export type CopyVars = { contactName: string; businessName: string; agentName: string; agentPhoneLine: string; link: string; city: string };

async function copyVarsFor(lead: Lead, actor: SendInput['actor']): Promise<CopyVars> {
  let agentName = 'ADX';
  let agentPhone: string | null = null;
  if (actor.agentId) {
    const agent = await repository.findAgentUser(actor.agentId);
    agentName = agent?.name ?? agentName;
    agentPhone = agent?.mobile ?? null;
  } else if (actor.userId) {
    const caller = await repository.findCaller(actor.userId);
    agentName = caller?.name ?? agentName;
    agentPhone = caller?.mobile ?? null;
  } else if (lead.assignedAgentId) {
    const agent = await repository.findAgentUser(lead.assignedAgentId);
    agentName = agent?.name ?? agentName;
    agentPhone = agent?.mobile ?? null;
  }
  return {
    contactName: lead.contactName?.split(' ')[0] ?? 'there',
    businessName: lead.businessName,
    agentName,
    agentPhoneLine: agentPhone ? ` · ${agentPhone}` : '',
    link: await linkFor(lead),
    city: lead.city ?? '',
  };
}

/** LH7 fills this with the lead's invite link (minted on first use); until it is registered, the public site. */
let linkPort: ((lead: Lead) => Promise<string>) | null = null;
export function registerInviteLinkPort(port: (lead: Lead) => Promise<string>): void {
  linkPort = port;
}
async function linkFor(lead: Lead): Promise<string> {
  if (!linkPort) return 'https://adx.in';
  return linkPort(lead).catch(() => 'https://adx.in');
}

async function renderCopy(lead: Lead, input: SendInput, channel: LeadChannelValue): Promise<{ body: string; subject: string | null; templateKey: string | null } | null> {
  const vars = await copyVarsFor(lead, input.actor);
  if (input.templateKey) {
    const template = await leads.findCommsTemplate(input.templateKey);
    if (!template) return null;
    const short = renderText(template.smsBody ?? template.pushBody ?? '', vars);
    if (channel === 'EMAIL') return { body: renderText(template.emailBody ?? short, vars), subject: renderText(template.subject ?? `A note from ${vars.agentName} at ADX`, vars), templateKey: template.key };
    return { body: short, subject: null, templateKey: template.key };
  }
  const body = renderText(input.body ?? '', vars).trim();
  if (!body) return null;
  return { body, subject: input.subject ? renderText(input.subject, vars) : channel === 'EMAIL' ? `A note from ${vars.agentName} at ADX` : null, templateKey: null };
}

/* ── send ────────────────────────────────────────────────────────── */

function ownerFor(lead: Lead, actor: SendInput['actor']): { byAgentId: string | null; byUserId: string | null } {
  return { byAgentId: actor.agentId ?? lead.assignedAgentId ?? null, byUserId: actor.userId };
}

/** Hands a rendered message to the channel's adapter. SMS and email go through the dispatcher's one door. */
async function dispatch(lead: Lead, channel: LeadChannelValue, conversation: LeadConversation, copy: { body: string; subject: string | null; templateKey: string | null }, vars: CopyVars): Promise<{ ok: true; providerId: string | null; status: 'SENT' | 'QUEUED' } | { ok: false; code: 'NOT_CONFIGURED' | 'NO_WINDOW' | 'NO_TEMPLATE' | 'PROVIDER_ERROR'; message: string }> {
  if (channel === 'SMS' || channel === 'EMAIL') {
    const result = await notify(
      'LEAD_OUTREACH',
      null,
      { body: copy.body, subject: copy.subject ?? '', contactName: vars.contactName, businessName: vars.businessName, agentName: vars.agentName, agentPhoneLine: vars.agentPhoneLine, link: vars.link },
      { recipient: channel === 'SMS' ? { mobile: lead.phoneNormalised ?? lead.phone } : { email: lead.email }, channels: [channel], type: 'SYSTEM', immediate: true },
    );
    const delivery = result.deliveries.find((d) => d.channel === channel);
    if (!delivery) return { ok: false, code: 'PROVIDER_ERROR', message: `The ${channel.toLowerCase()} door answered nothing` };
    if (delivery.skipped) return { ok: false, code: delivery.skipped === 'NO_ADDRESS' ? 'PROVIDER_ERROR' : 'NOT_CONFIGURED', message: `The ${channel.toLowerCase()} door skipped it: ${delivery.skipped}` };
    return { ok: true, providerId: delivery.deliveryId ? `delivery:${delivery.deliveryId}` : null, status: 'SENT' };
  }
  if (channel === 'WHATSAPP') {
    const to = (lead.phoneNormalised ?? lead.phone)!;
    if (windowOpen(conversation, new Date())) {
      const outcome = await whatsappAdapter.sendText({ to, text: copy.body });
      return outcome.ok ? { ok: true, providerId: outcome.providerId, status: 'SENT' } : outcome;
    }
    const approved = copy.templateKey ? (await getEffectiveLeadChannelsConfig()).whatsapp?.templates?.[copy.templateKey] : undefined;
    if (!approved) return { ok: false, code: 'NO_TEMPLATE', message: copy.templateKey ? `No approved WhatsApp template is mapped to ${copy.templateKey}` : 'Outside the window only an approved template may go — pick one' };
    const outcome = await whatsappAdapter.sendTemplate({ to, template: approved, values: { ...vars, body: copy.body } });
    return outcome.ok ? { ok: true, providerId: outcome.providerId, status: 'SENT' } : outcome;
  }
  if (channel === 'INSTAGRAM' || channel === 'MESSENGER') {
    if (!conversation.providerThreadId || !windowOpen(conversation, new Date())) return { ok: false, code: 'NO_WINDOW', message: 'Replies only, inside the window' };
    const outcome = await metaDmAdapter.sendText(channel, { to: conversation.providerThreadId, text: copy.body });
    return outcome.ok ? { ok: true, providerId: outcome.providerId, status: 'SENT' } : outcome;
  }
  if (channel === 'GOOGLE_BUSINESS') {
    if (!conversation.providerThreadId || !windowOpen(conversation, new Date())) return { ok: false, code: 'NO_WINDOW', message: 'Replies only, inside the window' };
    const outcome = await googleBusinessAdapter.sendText({ to: conversation.providerThreadId, text: copy.body });
    return outcome.ok ? { ok: true, providerId: outcome.providerId, status: 'SENT' } : outcome;
  }
  return { ok: false, code: 'NOT_CONFIGURED', message: `${channelLabel(channel)} is logged by hand, not sent` };
}

/** The first thing said to a lead is its first contact (D14) and its move to CONTACTED; every send is a touch. */
async function afterOutbound(lead: Lead, channel: LeadChannelValue, actor: SendInput['actor'], note: string, at: Date): Promise<void> {
  await leads.logActivity({ leadId: lead.id, actorUserId: actor.userId, kind: channel === 'CALL' ? 'CALLED' : 'MESSAGED', note });
  if (!lead.firstContactedAt) await leads.update(lead.id, { firstContactedAt: at, ...(lead.status === 'NEW' ? { status: 'CONTACTED' } : {}) });
  await stampMoment(lead.id, 'firstContact', channel, at);
  await advanceStage(lead.id, 'CONTACTED', { actorUserId: actor.userId, channel, at });
  await touchLead(lead.id, at);
}

/**
 * The port's `send`. Answers rather than throws for everything a provider
 * or a rule can say no to — the controller turns a SKIPPED into the right
 * status, and a sequence step logs it and moves on.
 */
export async function sendMessage(input: SendInput, now = new Date()): Promise<SendOutcome> {
  const lead = await leads.findById(input.leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  const channel = input.channel;
  if (!isLeadChannel(channel)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown channel', { channel });
  if (MANUAL_CHANNELS.includes(channel)) throw new ApiError(400, 'VALIDATION_ERROR', `${channelLabel(channel)} is logged, not sent — use the touch log`, { channel });
  if (channel === 'CALL') throw new ApiError(400, 'VALIDATION_ERROR', 'A call is placed, not sent — use the call door', { channel });
  if (!isOpenStage(lead.stage as LeadStageValue)) return { outcome: 'SKIPPED', message: null, reason: 'CLOSED', detail: 'This lead is closed' };

  const states = await describeAll();
  const owner = ownerFor(lead, input.actor);
  const skipRow = async (reason: Extract<SendOutcome, { outcome: 'SKIPPED' }>['reason'], detail: string, copy?: { body: string; templateKey: string | null }): Promise<SendOutcome> => {
    // A sequence step that could not go leaves a SKIPPED row — the log the brief asks for; a manual send answers without one.
    if (input.source !== 'SEQUENCE') return { outcome: 'SKIPPED', message: null, reason, detail };
    const { message } = await recordOutbound(lead, { channel, body: copy?.body ?? '', templateKey: copy?.templateKey ?? input.templateKey ?? null, status: 'SKIPPED', error: reason, at: now, sequenceRunId: input.sequenceRunId ?? null, ...owner });
    return { outcome: 'SKIPPED', message, reason, detail };
  };

  const state = (await reachability(lead, now, states)).find((s) => s.channel === channel)!;
  if (!state.configured) return skipRow('NOT_CONFIGURED', state.reason ?? `${channelLabel(channel)} is not configured`);
  if (!state.reachable) return skipRow(state.mode === null && state.reason?.includes('window') ? 'NO_WINDOW' : 'UNREACHABLE', state.reason ?? 'Unreachable');

  const copy = await renderCopy(lead, input, channel);
  if (!copy) return skipRow('NO_TEMPLATE', input.templateKey ? `No comms template is keyed ${input.templateKey}` : 'Nothing to send');
  const vars = await copyVarsFor(lead, input.actor);
  const conversation = await ensureConversation(lead, channel);

  const ruling = await outboundRuling(lead, conversation, now);
  if (ruling.skip) return skipRow('WEEKLY_CAP', `${ruling.sentThisWeek} of ${ruling.cap} this week already`, copy);
  if (ruling.deferUntil) {
    const { message } = await recordOutbound(lead, { channel, body: copy.body, templateKey: copy.templateKey, status: 'QUEUED', scheduledFor: ruling.deferUntil, at: now, sequenceRunId: input.sequenceRunId ?? null, ...owner });
    return { outcome: 'QUEUED', message, scheduledFor: ruling.deferUntil };
  }

  const sent = await dispatch(lead, channel, conversation, copy, vars);
  if (!sent.ok) {
    const reason = sent.code === 'PROVIDER_ERROR' ? 'PROVIDER_ERROR' : sent.code;
    if (input.source !== 'SEQUENCE' && sent.code === 'PROVIDER_ERROR') {
      const { message } = await recordOutbound(lead, { channel, body: copy.body, templateKey: copy.templateKey, status: 'FAILED', error: sent.message.slice(0, 300), at: now, ...owner });
      return { outcome: 'SKIPPED', message, reason, detail: sent.message };
    }
    return skipRow(reason, sent.message, copy);
  }
  const { message } = await recordOutbound(lead, { channel, body: copy.body, templateKey: copy.templateKey, providerId: sent.providerId, status: 'SENT', at: now, sequenceRunId: input.sequenceRunId ?? null, ...owner });
  await afterOutbound(lead, channel, input.actor, `${channelLabel(channel)}: ${copy.body.slice(0, PREVIEW_MAX)}`, now);
  return { outcome: 'SENT', message };
}

/** The job's flush: a QUEUED row whose quiet hours passed goes now, with the copy it was queued with. */
export async function flushQueued(now = new Date(), limit = 100): Promise<{ sent: number; failed: number }> {
  const due = await repository.dueQueuedMessages(now, limit);
  let sent = 0;
  let failed = 0;
  for (const row of due) {
    const lead = await leads.findById(row.leadId);
    if (!lead || !isOpenStage(lead.stage as LeadStageValue)) {
      await repository.updateMessage(row.id, { status: 'SKIPPED', error: 'CLOSED', scheduledFor: null });
      continue;
    }
    const channel = row.channel as LeadChannelValue;
    const conversation = await ensureConversation(lead, channel);
    const vars = await copyVarsFor(lead, { userId: row.byUserId, agentId: row.byAgentId });
    const outcome = await dispatch(lead, channel, conversation, { body: row.body, subject: null, templateKey: row.templateKey }, vars);
    if (outcome.ok) {
      await repository.updateMessage(row.id, { status: 'SENT', providerId: outcome.providerId, scheduledFor: null, at: now, error: null });
      await repository.updateConversation(conversation.id, { lastOutboundAt: now });
      await afterOutbound(lead, channel, { userId: row.byUserId, agentId: row.byAgentId }, `${channelLabel(channel)}: ${row.body.slice(0, PREVIEW_MAX)}`, now);
      sent += 1;
    } else {
      await repository.updateMessage(row.id, { status: outcome.code === 'PROVIDER_ERROR' ? 'FAILED' : 'SKIPPED', error: outcome.code === 'PROVIDER_ERROR' ? outcome.message.slice(0, 300) : outcome.code, scheduledFor: null });
      failed += 1;
    }
  }
  return { sent, failed };
}

/* ── a touch logged by hand (D13) ────────────────────────────────── */

export async function logTouch(leadId: string, actor: SendInput['actor'], input: { channel: LeadChannelValue; note?: string | undefined; direction?: 'OUTBOUND' | 'INBOUND' | undefined; at?: Date | undefined }): Promise<LeadMessage> {
  const lead = await leads.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  if (!isOpenStage(lead.stage as LeadStageValue)) throw new ApiError(409, 'CONFLICT', 'This lead is closed');
  const at = input.at ?? new Date();
  const note = input.note?.trim() || `${channelLabel(input.channel)} touch`;
  if (input.direction === 'INBOUND') {
    const { message } = await recordInbound(lead, { channel: input.channel, body: note, at, source: 'OTHER' });
    await leads.logActivity({ leadId, actorUserId: actor.userId, kind: 'TOUCH_LOGGED', note: `${channelLabel(input.channel)} (they wrote): ${note}` });
    await engage(lead, input.channel, note, actor.userId, at);
    return message;
  }
  const { message } = await recordOutbound(lead, { channel: input.channel, body: note, status: 'SENT', at, ...ownerFor(lead, actor) });
  await leads.logActivity({ leadId, actorUserId: actor.userId, kind: 'TOUCH_LOGGED', note: `${channelLabel(input.channel)}: ${note}` });
  if (!lead.firstContactedAt) await leads.update(lead.id, { firstContactedAt: at, ...(lead.status === 'NEW' ? { status: 'CONTACTED' } : {}) });
  await stampMoment(lead.id, 'firstContact', input.channel, at);
  await advanceStage(lead.id, 'CONTACTED', { actorUserId: actor.userId, channel: input.channel, at });
  await touchLead(lead.id, at);
  return message;
}

/* ── inbound ─────────────────────────────────────────────────────── */

/** A sequence-stop hook the sequences service registers, so the hub never imports it (it imports the hub). */
let stopSequencesPort: ((leadId: string, reason: string, at: Date) => Promise<number>) | null = null;
export function registerSequenceStopPort(port: (leadId: string, reason: string, at: Date) => Promise<number>): void {
  stopSequencesPort = port;
}

/**
 * The lead answered — on any channel, in any form. The sequence stops, the
 * stage moves to ENGAGED with the channel stamped (D14), the agent holding
 * the lead gets a hand-off task and a push, and the score hears the touch.
 */
export async function engage(lead: Lead, channel: EngageChannel, preview: string, actorUserId: string | null, at: Date): Promise<void> {
  const stopped = stopSequencesPort ? await stopSequencesPort(lead.id, 'REPLIED', at).catch(() => 0) : 0;
  await leads.logActivity({ leadId: lead.id, actorUserId, kind: 'ENGAGED', note: `${channelLabel(channel)}: ${preview.slice(0, PREVIEW_MAX)}${stopped ? ' (sequence stopped)' : ''}` });
  await stampMoment(lead.id, 'engaged', channel, at);
  await advanceStage(lead.id, 'ENGAGED', { actorUserId, channel, at, note: `replied on ${channelLabel(channel)}` });
  await touchLead(lead.id, at);
  const holder = lead.claimedByAgentId && lead.claimExpiresAt && lead.claimExpiresAt > at ? lead.claimedByAgentId : lead.assignedAgentId;
  if (!holder) return;
  const agent = await repository.findAgentUser(holder);
  if (!agent) return;
  const due = new Date(at.getTime() + 4 * 60 * 60 * 1000);
  await createSystemTask({ title: `Reply to ${lead.businessName} on ${channelLabel(channel)}`, description: preview.slice(0, 500), linkedKind: 'LEAD', linkedId: lead.id, assigneeUserIds: [agent.userId], deadline: due, priority: 'HIGH', tag: 'reply' }, at).catch((err) => logger.warn('Hand-off task not created', { leadId: lead.id, err }));
  await notify(
    'LEAD_REPLY_RECEIVED',
    agent.userId,
    { businessName: lead.businessName, channel: channelLabel(channel), preview: preview.slice(0, PREVIEW_MAX), deepLink: `adx://lead/${lead.id}` },
    { type: 'SYSTEM', inApp: { type: 'SYSTEM', title: `${lead.businessName} replied`, subtitle: channelLabel(channel), message: preview.slice(0, PREVIEW_MAX), relatedType: 'LEAD', relatedId: lead.id } },
  ).catch((err) => logger.warn('Reply push not sent', { leadId: lead.id, err }));
}

const PUBLISHER_WORDS = /\b(wall|walls|shutter|shop|shopfront|screen|space|rent|earn|hoarding|terrace|rooftop|gate|board|my (?:building|premises))\b/i;

/** The lead behind a thread: the conversation's, else the number's (WhatsApp), else a new one from the handle — they wrote to us, that is a lead. */
async function leadForInbound(event: InboundEvent): Promise<Lead | null> {
  const known = await repository.findConversationByThread(event.channel, event.providerThreadId);
  if (known) return known.lead;
  if (event.channel === 'WHATSAPP') {
    const phone = normalisePhone(`+${event.from.replace(/[^\d]/g, '')}`);
    if (phone) {
      const [byPhone] = await leads.findByPhones([phone]);
      if (byPhone) return leads.findById(byPhone.id);
    }
    const accounts = phone ? await leads.findAccountsByPhones([phone]) : [];
    if (accounts.length > 0) {
      logger.info('WhatsApp inbound from an account holder, not a prospect', { phone: phone?.slice(-4) });
      return null;
    }
  }
  const externalKey = `${event.channel.toLowerCase()}:${event.providerThreadId}`;
  const [held] = await leads.findByExternalKeys([externalKey]);
  if (held) return leads.findById(held.id);
  const sourceKey = event.channel.toLowerCase().replace('_', '-');
  const sourceId = await resolveSource(sourceKey, 'INBOUND');
  const displayId = await allocateIdentifier('LEAD');
  const phone = event.channel === 'WHATSAPP' ? normalisePhone(`+${event.from.replace(/[^\d]/g, '')}`) : null;
  const side = PUBLISHER_WORDS.test(event.text) ? 'PUBLISHER' : 'ADVERTISER';
  try {
    const created = await leads.create(
      await withCityKey({
        side,
        businessName: (event.fromName ?? `${channelLabel(event.channel)} ${event.from}`).slice(0, 160),
        displayId,
        contactName: event.fromName?.slice(0, 120) ?? null,
        phone: phone ? `+${event.from.replace(/[^\d]/g, '')}` : null,
        phoneNormalised: phone,
        email: null,
        address: null,
        locality: null,
        city: null,
        latitude: null,
        longitude: null,
        category: null,
        interest: event.text.slice(0, 200) || null,
        source: sourceKey,
        sourceId,
        externalKey,
        assignedAgentId: null,
        lastTouchedAt: event.at,
        temperature: 'WARM',
        createdByUserId: null,
      }),
    );
    await leads.logActivity({ leadId: created.id, actorUserId: null, kind: 'IMPORTED', note: `Wrote to us on ${channelLabel(event.channel)}${event.source === 'COMMENT' ? ' (a comment)' : event.source === 'STORY_REPLY' ? ' (a story reply)' : ''}` });
    await recomputeLead(created.id).catch(() => undefined);
    await routeLead(created.id).catch((err) => logger.warn('Inbound DM lead not routed', { leadId: created.id, err }));
    return leads.findById(created.id);
  } catch (err) {
    const [raced] = await leads.findByExternalKeys([externalKey]);
    if (raced) return leads.findById(raced.id);
    throw err;
  }
}

/** Never downgrade a status: SENT < DELIVERED < READ; FAILED overrides with its reason. */
const STATUS_RANK: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

async function applyStatus(event: StatusEvent): Promise<boolean> {
  const row = await repository.findMessageByProviderId(event.channel, event.providerMessageId);
  if (!row) return false;
  if (event.status === 'FAILED') {
    await repository.updateMessage(row.id, { status: 'FAILED', error: event.error ?? 'failed' });
    return true;
  }
  if ((STATUS_RANK[event.status] ?? 0) <= (STATUS_RANK[row.status] ?? 0)) return true;
  await repository.updateMessage(row.id, { status: event.status });
  return true;
}

export type WebhookDoor = 'meta' | 'gupshup' | 'interakt' | 'google-business';

/** The GET half of Meta's subscription — the challenge to echo, or null for a 403. */
export async function metaVerify(query: Record<string, unknown>): Promise<string | null> {
  const cfg = await getEffectiveLeadChannelsConfig();
  return metaHandshake(query, [cfg.whatsapp?.verifyToken, cfg.instagram?.verifyToken, cfg.messenger?.verifyToken]);
}

/**
 * The port's `receiveWebhook`: one door per provider, every event read into
 * the thread, idempotent on the provider's message id. Answers how many
 * were new so the route can log it; a rejected signature throws
 * `OutreachWebhookRejected` and the route answers 401.
 */
export async function receiveWebhook(door: WebhookDoor, input: WebhookInput, now = new Date()): Promise<{ received: number; statuses: number; ignored: number; handshake?: { secret: string } }> {
  let events: (InboundEvent | StatusEvent)[] = [];
  if (door === 'google-business') {
    const handshake = googleBusinessAdapter.handshake(input.body);
    if (handshake) return { received: 0, statuses: 0, ignored: 0, handshake };
    events = await googleBusinessAdapter.parseWebhook(input, now);
  } else if (door === 'meta') {
    const object = (input.body as { object?: unknown } | null)?.object;
    events = object === 'whatsapp_business_account' ? await whatsappAdapter.parseWebhook(input, now) : await metaDmAdapter.parseWebhook(input, now);
  } else {
    events = await whatsappAdapter.parseWebhook(input, now);
  }
  let received = 0;
  let statuses = 0;
  let ignored = 0;
  for (const event of events) {
    if (event.kind === 'STATUS') {
      (await applyStatus(event)) ? (statuses += 1) : (ignored += 1);
      continue;
    }
    const lead = await leadForInbound(event);
    if (!lead) {
      ignored += 1;
      continue;
    }
    const { created } = await recordInbound(lead, { channel: event.channel, providerThreadId: event.providerThreadId, providerMessageId: event.providerMessageId, body: event.text, at: event.at, source: event.source });
    if (!created) {
      ignored += 1;
      continue;
    }
    received += 1;
    if (isOpenStage(lead.stage as LeadStageValue)) await engage(lead, event.channel, event.text, null, event.at);
  }
  return { received, statuses, ignored };
}

/* ── reads ───────────────────────────────────────────────────────── */

export type ThreadView = {
  conversations: (LeadConversation & { windowOpen: boolean })[];
  messages: (LeadMessage & { recordingUrl: string | null })[];
  channels: ChannelState[];
  /** LH7: the proposals sent, newest first, with their opened / accepted moments. */
  proposals: ProposalView[];
};

/** The unified conversation the lead page and the app draw. */
export async function threadView(leadId: string, now = new Date()): Promise<ThreadView> {
  const lead = await leads.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  const [conversations, messages, channels, proposals] = await Promise.all([repository.listConversations(leadId), repository.listMessages(leadId, THREAD_TAKE), reachability(lead, now), listProposalsFor(leadId)]);
  return {
    conversations: conversations.map((c) => ({ ...c, windowOpen: windowOpen(c, now) })),
    messages: messages.map((m) => ({ ...m, recordingUrl: m.recordingFileId ? `/api/v1/files/${m.recordingFileId}` : null })),
    channels,
    proposals,
  };
}

export async function inbox(filter: InboxFilter, page: { page: number; pageSize: number }) {
  const result = await repository.inbox(filter, { skip: (page.page - 1) * page.pageSize, take: page.pageSize });
  return { ...result, page: page.page, pageSize: page.pageSize };
}

export async function teleQueue(filter: TeleFilter, page: { page: number; pageSize: number }) {
  const result = await repository.teleQueue(filter, { skip: (page.page - 1) * page.pageSize, take: page.pageSize });
  return { ...result, page: page.page, pageSize: page.pageSize };
}

/** The funnel by channel: volume out and in per channel, and the attribution moments the leads themselves carry. */
export async function channelFunnel(from: Date, to: Date, side?: 'PUBLISHER' | 'ADVERTISER'): Promise<{ from: string; to: string; channels: (ChannelStat & { firstContact: number; engaged: number; converted: number })[] }> {
  const [stats, attribution] = await Promise.all([repository.channelStats(from, to, side), leads.attributionCounts(from, to, side)]);
  const byChannel = new Map<string, ChannelStat & { firstContact: number; engaged: number; converted: number }>();
  for (const stat of stats) byChannel.set(stat.channel, { ...stat, firstContact: 0, engaged: 0, converted: 0 });
  for (const row of attribution) {
    const existing = byChannel.get(row.channel) ?? { channel: row.channel as ChannelStat['channel'], outbound: 0, delivered: 0, failed: 0, inbound: 0, replies: 0, firstContact: 0, engaged: 0, converted: 0 };
    existing.firstContact += row.firstContact;
    existing.engaged += row.engaged;
    existing.converted += row.converted;
    byChannel.set(row.channel, existing);
  }
  return { from: from.toISOString(), to: to.toISOString(), channels: [...byChannel.values()].sort((a, b) => b.converted - a.converted || b.outbound + b.inbound - (a.outbound + a.inbound)) };
}

/** Who is asking: an agent's profile when the sign-in has one, so a message is "from" the agent and lands on their tally. */
export async function actorOf(userId: string): Promise<SendInput['actor']> {
  const agent = await findAgentProfile(userId);
  return { userId, agentId: agent?.id ?? null };
}

export { threadIdFor, WINDOWED_CHANNELS };

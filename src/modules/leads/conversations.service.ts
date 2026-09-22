import type { Lead, LeadChannel, LeadConversation, LeadMessage } from '../../shared/database';
import { COMMENT_REPLY_WINDOW_MS, DM_WINDOW_MS } from '../../shared/outreach';
import { prismaOutreachRepository as repository } from './prisma-outreach.repository';
import type { NewMessage } from './outreach.repository';

/**
 * LH6: the conversation writer — one lead on one channel, and what was said
 * on it. Imports nothing from the hub or the doors, so the LH3 form
 * webhooks (`inbound.service.ts`) can hand a form's message to the thread
 * and the hub can write what the adapters read, without a cycle.
 */

export const LEAD_CHANNELS = ['SMS', 'EMAIL', 'WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'GOOGLE_BUSINESS', 'CALL', 'LINKEDIN', 'IN_PERSON', 'OTHER'] as const;
export type LeadChannelValue = (typeof LEAD_CHANNELS)[number];
export const isLeadChannel = (value: unknown): value is LeadChannelValue => typeof value === 'string' && (LEAD_CHANNELS as readonly string[]).includes(value);

/** The three Meta channels: writable only inside the window after the lead's last message (D13). */
export const WINDOWED_CHANNELS: readonly LeadChannelValue[] = ['WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'GOOGLE_BUSINESS'];
/** Logged by hand, never sent by API. */
export const MANUAL_CHANNELS: readonly LeadChannelValue[] = ['LINKEDIN', 'IN_PERSON', 'OTHER'];

/** The thread id a channel addresses when the provider gave none: the number, the address. */
export function threadIdFor(lead: Pick<Lead, 'phoneNormalised' | 'phone' | 'email'>, channel: LeadChannelValue): string | null {
  switch (channel) {
    case 'SMS':
    case 'CALL':
      return lead.phoneNormalised ?? lead.phone ?? null;
    case 'WHATSAPP':
      return lead.phoneNormalised ? `wa:${lead.phoneNormalised.replace(/[^\d]/g, '')}` : null;
    case 'EMAIL':
      return lead.email?.trim().toLowerCase() ?? null;
    default:
      return null;
  }
}

/** Is the channel's window open at `now`? A channel without windows is always open. */
export function windowOpen(conversation: Pick<LeadConversation, 'channel' | 'windowClosesAt'> | null, now: Date): boolean {
  if (!conversation) return false;
  if (!WINDOWED_CHANNELS.includes(conversation.channel as LeadChannelValue)) return true;
  return conversation.windowClosesAt !== null && conversation.windowClosesAt.getTime() > now.getTime();
}

/** The window an inbound opens: a day, or seven for a comment Meta lets us answer privately. */
export function windowAfter(at: Date, source: 'DM' | 'COMMENT' | 'STORY_REPLY' | 'FORM' | 'OTHER' = 'DM'): Date {
  return new Date(at.getTime() + (source === 'COMMENT' ? COMMENT_REPLY_WINDOW_MS : DM_WINDOW_MS));
}

/** The conversation for the lead on the channel, created on first use; a provider's thread id is kept once known. */
export async function ensureConversation(lead: Pick<Lead, 'id' | 'phoneNormalised' | 'phone' | 'email'>, channel: LeadChannelValue, providerThreadId?: string | null): Promise<LeadConversation> {
  const existing = await repository.findConversation(lead.id, channel);
  const thread = providerThreadId ?? threadIdFor(lead, channel);
  if (existing) {
    if (thread && existing.providerThreadId !== thread) return repository.updateConversation(existing.id, { providerThreadId: thread });
    return existing;
  }
  return repository.createConversation({ leadId: lead.id, channel, providerThreadId: thread });
}

export type InboundRecord = {
  channel: LeadChannelValue;
  providerThreadId?: string | null;
  /** The provider's id; a replay of the same id writes nothing. Null for a note typed by hand. */
  providerMessageId?: string | null;
  body: string;
  at: Date;
  source?: 'DM' | 'COMMENT' | 'STORY_REPLY' | 'FORM' | 'OTHER';
  /** A call the lead made: the operator's id, so its status finds the row. */
  providerCallId?: string | null;
};

/**
 * What the lead said, on the thread — idempotent on the provider's id. The
 * window opens (or re-opens) from the message's own time.
 */
export async function recordInbound(lead: Pick<Lead, 'id' | 'phoneNormalised' | 'phone' | 'email'>, input: InboundRecord): Promise<{ message: LeadMessage; conversation: LeadConversation; created: boolean }> {
  if (input.providerMessageId) {
    const held = await repository.findMessageByProviderId(input.channel, input.providerMessageId);
    if (held) {
      const conversation = (await repository.findConversation(lead.id, input.channel)) ?? (await ensureConversation(lead, input.channel, input.providerThreadId));
      return { message: held, conversation, created: false };
    }
  }
  const conversation = await ensureConversation(lead, input.channel, input.providerThreadId);
  const message = await repository.createMessage({
    conversationId: conversation.id,
    leadId: lead.id,
    direction: 'INBOUND',
    channel: input.channel,
    body: input.body.slice(0, 4000),
    providerId: input.providerMessageId ?? null,
    status: 'RECEIVED',
    at: input.at,
    providerCallId: input.providerCallId ?? null,
  });
  const updated = await repository.updateConversation(conversation.id, {
    lastInboundAt: conversation.lastInboundAt && conversation.lastInboundAt > input.at ? conversation.lastInboundAt : input.at,
    windowClosesAt: windowAfter(input.at, input.source ?? 'DM'),
  });
  return { message, conversation: updated, created: true };
}

export type OutboundRecord = Omit<NewMessage, 'conversationId' | 'leadId' | 'direction'> & { providerThreadId?: string | null };

/** What we said (or tried to) — the row the log and the thread draw; `lastOutboundAt` moves only when something left. */
export async function recordOutbound(lead: Pick<Lead, 'id' | 'phoneNormalised' | 'phone' | 'email'>, input: OutboundRecord): Promise<{ message: LeadMessage; conversation: LeadConversation }> {
  const conversation = await ensureConversation(lead, input.channel as LeadChannelValue, input.providerThreadId);
  const { providerThreadId: _thread, ...data } = input;
  const message = await repository.createMessage({ ...data, conversationId: conversation.id, leadId: lead.id, direction: 'OUTBOUND' });
  const left = input.status === 'SENT' || input.status === 'DELIVERED' || input.status === 'READ';
  const updated = left ? await repository.updateConversation(conversation.id, { lastOutboundAt: input.at }) : conversation;
  return { message, conversation: updated };
}

/** The thread's channel as the attribution stamps it (D14) — the enum value itself. */
export const attributionChannel = (channel: LeadChannel | LeadChannelValue): string => channel;

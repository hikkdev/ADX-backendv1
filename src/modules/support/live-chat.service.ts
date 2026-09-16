import type { CannedReply, SupportTicket } from '../../shared/database';
import { redis } from '../../shared/cache';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { getPlatformSettings } from '../app-config';
import { isFeatureEnabled } from '../feature-flags';
import { notify } from '../notifications';
import { findUserLabels, userExists } from '../users';
import { INBOX_CHANNEL, publish, ticketChannel } from './live-chat.bus';
import { liveChatEntitlement, liveChatEntitlementsFor, planOnDesk, type Entitlement, type PlanOnDesk } from './live-chat.entitlement';
import { nextOpening, openingLabel, withinLiveHours } from './live-chat.hours';
import { publishMessage, resolveAttachment } from './live-chat.messaging';
import { onlineOperatorIds } from './live-chat.presence';
import { prismaSupportRepository as repository } from './prisma-support.repository';
import { createTicket } from './support.service';
import { firstLine } from './support.schema';
import type { Actor, CannedReplyPatch, LiveInboxOptions } from './support.types';

/**
 * Live chat — Lot I.
 *
 * A live chat is not a second messaging system: it is a `SupportTicket`
 * wearing `channel: LIVE_CHAT`, with the same number, the same thread, the
 * same queue and the same desk. What is different is the pace — the
 * requester is *waiting*, so the chat is put on somebody at once, it
 * streams, and a first response that does not come inside the target is an
 * alert rather than a report.
 *
 * The four rules the owner set on 14 Sep 2026, each a default and each
 * reversible from the console:
 *
 *  - **Paid subscribers only** (`live-chat.entitlement.ts`). Everyone else
 *    keeps the ticket thread, which is also the fallback whenever the live
 *    door cannot be opened.
 *  - **Live hours** (09:00–21:00 IST). Outside them a message still lands —
 *    as a TICKET, with a SYSTEM line naming the next opening, so nobody is
 *    left typing into a room with nobody in it.
 *  - **Nobody online is the same as out of hours.** Presence is a Redis key
 *    with a ninety-second life; a desk that crashes stops being online on
 *    its own.
 *  - **Fewest open chats wins.** The auto-assignment is a count, not a
 *    rota: the operator holding the least is the one who can answer soonest.
 *    Ops may reassign at any time.
 */

export const LIVE_CHAT_FEATURE = 'support.live-chat';

/* ── the status read ─────────────────────────────────────────────── */

export type LiveStatus = Entitlement & {
  online: boolean;
  /** The wait to a first response, from the chats already open per online operator and the target. */
  expectedWaitSec: number | null;
  withinHours: boolean;
  nextOpening: Date | null;
  /** The same instant as a person reads it — `9:00 am IST on Tue 15 Sep` — in the desk's zone; null while open. */
  nextOpeningLabel: string | null;
  firstResponseTargetSec: number;
};

/**
 * What the phone asks before it draws a chat button.
 *
 * The kill switch is read here rather than mounted as `requireFeature` on
 * this one route: a 503 would leave the phone guessing, and the point of
 * this read is to tell it exactly which screen to draw. Off, the answer is
 * `entitled: false, reason: FEATURE_OFF` and the app falls back to the
 * ticket thread — the same fallback it uses at midnight.
 */
export async function liveChatStatus(actor: Actor, now: Date = new Date()): Promise<LiveStatus> {
  const settings = await getPlatformSettings();
  const live = settings.support.liveChat;
  const on = await isFeatureEnabled(LIVE_CHAT_FEATURE, actor.sub, { roles: actor.roles });
  const entitlement: Entitlement = on
    ? await liveChatEntitlement(actor.sub, now)
    : { entitled: false, reason: 'FEATURE_OFF', plan: null, upsell: { title: 'Raise a ticket and ADX will answer', href: '/support/tickets' }, grace: null };

  const withinHours = withinLiveHours(now, live.hours);
  const operators = on ? await onlineOperatorIds(now) : [];
  const online = operators.length > 0 && withinHours;
  const opening = nextOpening(now, live.hours);
  return {
    ...entitlement,
    online,
    expectedWaitSec: online ? await expectedWaitSec(operators.length, live.firstResponseTargetSec) : null,
    withinHours,
    nextOpening: opening,
    nextOpeningLabel: opening ? openingLabel(opening, live.hours.tz) : null,
    firstResponseTargetSec: live.firstResponseTargetSec,
  };
}

/**
 * The honest estimate: the chats already open, shared out over the
 * operators on shift, each one costing about a first-response target. One
 * operator holding two chats answers a third in roughly two targets.
 */
async function expectedWaitSec(operatorCount: number, targetSec: number): Promise<number> {
  const open = await repository.countOpenLiveChats();
  const perOperator = Math.ceil(open / Math.max(1, operatorCount));
  return Math.max(0, perOperator) * targetSec;
}

/* ── presence ────────────────────────────────────────────────────── */

export type OperatorPresence = { userId: string; name: string | null; openChats: number };

/** Who is at the desk, and how much each is holding — what the console's presence rail draws. */
export async function operatorPresence(now: Date = new Date()): Promise<OperatorPresence[]> {
  const ids = await onlineOperatorIds(now);
  if (ids.length === 0) return [];
  const [labels, counts] = await Promise.all([findUserLabels(ids), repository.countOpenLiveChatsByAdmin(ids)]);
  return ids
    .map((userId) => ({ userId, name: labels.get(userId)?.name ?? null, openChats: counts.get(userId) ?? 0 }))
    .sort((a, b) => a.openChats - b.openChats || a.userId.localeCompare(b.userId));
}

/** The operator with the fewest open chats; ties broken by id so the choice is deterministic. */
async function pickOperator(now: Date): Promise<{ userId: string; name: string | null } | null> {
  const presence = await operatorPresence(now);
  const chosen = presence[0];
  return chosen ? { userId: chosen.userId, name: chosen.name } : null;
}

/* ── starting a chat ─────────────────────────────────────────────── */

export type StartResult = {
  ticket: SupportTicket;
  /** 'LIVE_CHAT' when an operator has it; 'TICKET' when the door was shut and it became a thread. */
  channel: 'LIVE_CHAT' | 'TICKET';
  fallback?: 'TICKET';
  nextOpening?: Date | null;
  assignedAdmin?: { id: string; name: string | null } | null;
  /** True when the message went onto a chat the caller already had running. */
  continued: boolean;
};

export async function startLiveChat(
  actor: Actor,
  input: { message: string; relatedOrderId?: string | undefined; attachmentFileId?: string | undefined },
  now: Date = new Date(),
): Promise<StartResult> {
  const entitlement = await liveChatEntitlement(actor.sub, now);
  if (!entitlement.entitled) {
    throw new ApiError(403, 'NOT_ENTITLED', 'Live chat is part of a paid ADX plan', {
      reason: entitlement.reason,
      plan: entitlement.plan,
      upsell: entitlement.upsell,
    });
  }

  const attachment = input.attachmentFileId ? await resolveAttachment(input.attachmentFileId, actor.sub) : null;
  const authorName = (await findUserLabels([actor.sub])).get(actor.sub)?.name ?? 'You';

  // A second start is the same conversation: a person who backgrounds the
  // app and comes back should not open a second chat with a second number.
  const running = await repository.findOpenLiveChatForUser(actor.sub);
  if (running) {
    const message = await repository.addReply({
      ticketId: running.id,
      authorId: actor.sub,
      authorName,
      message: input.message,
      internal: false,
      kind: attachment ? 'ATTACHMENT' : 'TEXT',
      attachmentFileId: attachment?.fileId ?? null,
      attachmentName: attachment?.name ?? null,
    });
    await publishMessage(running, message);
    const assigned = running.assignedAdminUserId
      ? { id: running.assignedAdminUserId, name: (await findUserLabels([running.assignedAdminUserId])).get(running.assignedAdminUserId)?.name ?? null }
      : null;
    return { ticket: running, channel: running.channel as 'LIVE_CHAT' | 'TICKET', continued: true, assignedAdmin: assigned };
  }

  const settings = await getPlatformSettings();
  const live = settings.support.liveChat;
  const withinHours = withinLiveHours(now, live.hours);
  const operator = withinHours ? await pickOperator(now) : null;

  const title = firstLine(input.message || (attachment?.name ?? 'Live chat'));
  const base = {
    userId: actor.sub,
    kind: 'ISSUE' as const,
    title,
    description: input.message || (attachment?.name ?? ''),
    category: 'OTHER',
    attachmentUrls: [],
    ...(input.relatedOrderId ? { relatedOrderId: input.relatedOrderId } : {}),
  };

  if (!operator) {
    // Out of hours, or nobody at the desk: a ticket, and a promise with a
    // time on it rather than a spinner.
    const opening = nextOpening(now, live.hours);
    const ticket = await createTicket({ ...base, channel: 'TICKET', lastMessageAt: now }, now);
    await writeMessages(ticket, actor.sub, authorName, input.message, attachment, systemLineForClosedDoor(withinHours, opening, live.hours.tz));
    return { ticket, channel: 'TICKET', fallback: 'TICKET', nextOpening: opening, continued: false };
  }

  const ticket = await createTicket(
    { ...base, channel: 'LIVE_CHAT', assignedAdminUserId: operator.userId, assignedAdminAt: now, lastMessageAt: now },
    now,
  );
  const joined = `${operator.name ?? 'ADX Support'} joined`;
  await writeMessages(ticket, actor.sub, authorName, input.message, attachment, joined);

  await publish(INBOX_CHANNEL, {
    type: 'chat',
    ticketId: ticket.id,
    displayId: ticket.displayId,
    requesterName: authorName,
    assignedAdminUserId: operator.userId,
    preview: (input.message || attachment?.name || '').slice(0, 80),
  });
  await notifyOperatorOfNewChat(ticket, operator.userId, authorName, input.message || (attachment?.name ?? ''));

  return { ticket, channel: 'LIVE_CHAT', continued: false, assignedAdmin: { id: operator.userId, name: operator.name } };
}

/**
 * The line a requester reads on the thread. The opening is printed as the
 * desk's clock would say it (`9:00 am IST on Tue 15 Sep`) at the moment it
 * is written — a SYSTEM line is prose, never an ISO instant for a phone to
 * fail to convert.
 */
const systemLineForClosedDoor = (withinHours: boolean, opening: Date | null, tz: string): string =>
  withinHours
    ? 'Nobody is on live chat right now. ADX will answer on this ticket as soon as somebody is free.'
    : `Live chat is closed. ADX opens again at ${opening ? openingLabel(opening, tz) : 'the next opening'} and will reply on this ticket.`;

/** The requester's first message, then the platform's line under it, in that order. */
async function writeMessages(
  ticket: SupportTicket,
  authorId: string,
  authorName: string,
  message: string,
  attachment: { fileId: string; name: string } | null,
  systemLine: string,
): Promise<void> {
  if (message || attachment) {
    const first = await repository.addReply({
      ticketId: ticket.id,
      authorId,
      authorName,
      message,
      internal: false,
      kind: attachment ? 'ATTACHMENT' : 'TEXT',
      attachmentFileId: attachment?.fileId ?? null,
      attachmentName: attachment?.name ?? null,
    });
    await publishMessage(ticket, first);
  }
  const line = await repository.addReply({
    ticketId: ticket.id,
    authorId,
    authorName: 'ADX',
    message: systemLine,
    internal: false,
    kind: 'SYSTEM',
  });
  await publishMessage(ticket, line);
}

async function notifyOperatorOfNewChat(ticket: SupportTicket, operatorUserId: string, requesterName: string, preview: string): Promise<void> {
  await notify(
    'LIVE_CHAT_ASSIGNED',
    operatorUserId,
    { ticketRef: ticket.displayId ?? ticket.title, requesterName, preview: preview.slice(0, 140) },
    {
      type: 'MESSAGE',
      inApp: {
        type: 'MESSAGE',
        title: 'New live chat',
        ...(ticket.displayId ? { subtitle: ticket.displayId } : {}),
        message: `${requesterName}: ${preview.slice(0, 120)}`,
        relatedId: ticket.id,
        relatedType: 'TICKET',
      },
    },
  );
}

/* ── ops moves a chat ────────────────────────────────────────────── */

/**
 * Puts the chat on somebody else. The SYSTEM line is what the requester
 * sees; the new operator is told. A ticket that is not a live chat is
 * refused the same way `convertLiveChat` refuses it — an ordinary thread
 * has `PATCH /tickets/:id { assignedAdminUserId }` for its ops owner and
 * must never grow a "joined" line.
 */
export async function reassignLiveChat(ticketId: string, adminUserId: string, actor: Actor, now: Date = new Date()) {
  const ticket = await repository.findSummaryById(ticketId);
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  if (ticket.channel !== 'LIVE_CHAT') throw new ApiError(409, 'CONFLICT', 'That ticket is not a live chat');
  if (!(await userExists(adminUserId))) throw new ApiError(404, 'NOT_FOUND', 'That admin user does not exist');

  const name = (await findUserLabels([adminUserId])).get(adminUserId)?.name ?? 'ADX Support';
  const updated = await repository.patch(ticketId, { assignedAdminUserId: adminUserId, assignedAdminAt: now });
  const line = await repository.addReply({
    ticketId,
    authorId: actor.sub,
    authorName: 'ADX',
    message: `${name} joined`,
    internal: false,
    kind: 'SYSTEM',
  });
  await publishMessage(updated, line);
  await publish(ticketChannel(ticketId), { type: 'assigned', name, adminUserId });
  const requesterName = (await findUserLabels([ticket.userId])).get(ticket.userId)?.name ?? 'The requester';
  await notifyOperatorOfNewChat(updated, adminUserId, requesterName, ticket.title);
  return { before: ticket, after: updated };
}

/**
 * The chat continues as a ticket.
 *
 * Nothing is closed and nothing is copied: the same row changes channel, the
 * thread stays whole, and the requester is told where the conversation went.
 */
export async function convertLiveChat(ticketId: string, actor: Actor, reason?: string) {
  const ticket = await repository.findSummaryById(ticketId);
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  if (ticket.channel !== 'LIVE_CHAT') throw new ApiError(409, 'CONFLICT', 'That ticket is not a live chat');

  const updated = await repository.patch(ticketId, { channel: 'TICKET' });
  const message = reason ?? 'This conversation is now a ticket. ADX will reply on the thread.';
  const line = await repository.addReply({ ticketId, authorId: actor.sub, authorName: 'ADX', message, internal: false, kind: 'SYSTEM' });
  await publishMessage(updated, line);
  await publish(ticketChannel(ticketId), { type: 'status', status: updated.status, channel: updated.channel });
  await notify(
    'LIVE_CHAT_CONVERTED',
    ticket.userId,
    { ticketRef: ticket.displayId ?? ticket.title, reason: message },
    {
      type: 'MESSAGE',
      inApp: {
        type: 'MESSAGE',
        title: 'Your chat is now a ticket',
        ...(ticket.displayId ? { subtitle: ticket.displayId } : {}),
        message,
        relatedId: ticket.id,
        relatedType: 'TICKET',
      },
    },
  );
  return { before: ticket, after: updated };
}

/* ── typing and seen ─────────────────────────────────────────────── */

const TYPING_KEY = (ticketId: string, userId: string) => `support:typing:${ticketId}:${userId}`;
export const TYPING_THROTTLE_SECONDS = 2;

/**
 * Typing is never written down. It is published at most once every two
 * seconds per person per chat — a keystroke-rate event would otherwise be
 * the busiest thing on the bus — and a `typing: false` always goes, because
 * a stuck indicator is worse than a missed one.
 */
export async function publishTyping(ticket: SupportTicket, actor: Actor, typing: boolean): Promise<boolean> {
  const who: 'requester' | 'agent' = ticket.userId === actor.sub ? 'requester' : 'agent';
  if (typing) {
    try {
      const first = await redis.set(TYPING_KEY(ticket.id, actor.sub), '1', 'EX', TYPING_THROTTLE_SECONDS, 'NX');
      if (!first) return false;
    } catch (err) {
      logger.warn('Typing throttle unreadable; publishing anyway', { reason: err instanceof Error ? err.message : String(err) });
    }
  }
  await publish(ticketChannel(ticket.id), { type: 'typing', who, typing });
  return true;
}

/** Stamps the side's mark and the messages under it, and tells the other side they were read. */
export async function markThreadSeen(ticket: SupportTicket, actor: Actor, now: Date = new Date()) {
  const who: 'requester' | 'agent' = ticket.userId === actor.sub ? 'requester' : 'agent';
  const updated = await repository.markSeen(ticket.id, who, actor.sub, now);
  await publish(ticketChannel(ticket.id), { type: 'seen', who, at: now.toISOString() });
  return updated;
}

/* ── the desk's inbox ────────────────────────────────────────────── */

export type LiveInboxRowView = {
  id: string;
  displayId: string | null;
  title: string;
  requester: { userId: string; name: string | null };
  /** The plan the requester holds right now and why it counts — what the desk prints beside the name; null with nothing paid. */
  plan: PlanOnDesk;
  assignedAdmin: { id: string; name: string | null } | null;
  lastMessageAt: Date | null;
  lastMessage: { authorName: string; kind: string; message: string; createdAt: Date } | null;
  /** When the requester's newest message is still unanswered — what the row's clock counts from. */
  waitingSince: Date | null;
  firstResponseAt: Date | null;
  firstResponseBreached: boolean;
  unread: number;
  createdAt: Date;
};

export async function liveInbox(opts: LiveInboxOptions, now: Date = new Date()) {
  const [page, settings] = await Promise.all([repository.findLiveInbox(opts), getPlatformSettings()]);
  const targetMs = settings.support.liveChat.firstResponseTargetSec * 1000;
  const ids = [...new Set(page.items.flatMap((row) => [row.userId, ...(row.assignedAdminUserId ? [row.assignedAdminUserId] : [])]))];
  // One query per source for the page, not one per row: the labels, and the
  // entitlement each requester holds at this moment.
  const [labels, entitlements] = await Promise.all([
    findUserLabels(ids),
    liveChatEntitlementsFor(
      page.items.map((row) => row.userId),
      now,
    ),
  ]);
  const items: LiveInboxRowView[] = page.items.map((row) => {
    const lastFromRequester = row.lastMessage && row.lastMessage.authorId === row.userId ? row.lastMessage.createdAt : null;
    return {
      id: row.id,
      displayId: row.displayId,
      title: row.title,
      requester: { userId: row.userId, name: labels.get(row.userId)?.name ?? null },
      plan: planOnDesk(entitlements.get(row.userId)),
      assignedAdmin: row.assignedAdminUserId
        ? { id: row.assignedAdminUserId, name: labels.get(row.assignedAdminUserId)?.name ?? null }
        : null,
      lastMessageAt: row.lastMessageAt,
      lastMessage: row.lastMessage
        ? { authorName: row.lastMessage.authorName, kind: row.lastMessage.kind, message: row.lastMessage.message, createdAt: row.lastMessage.createdAt }
        : null,
      waitingSince: lastFromRequester,
      firstResponseAt: row.firstResponseAt,
      // Judged against the same target the sweep uses: answered late counts
      // as breached for as long as the chat is open, not only while it waits.
      firstResponseBreached: row.firstResponseAt
        ? row.firstResponseAt.getTime() - row.createdAt.getTime() > targetMs
        : now.getTime() - row.createdAt.getTime() > targetMs,
      unread: row.unreadForAgent,
      createdAt: row.createdAt,
    };
  });
  return { ...page, items, firstResponseTargetSec: settings.support.liveChat.firstResponseTargetSec };
}

/* ── canned replies ──────────────────────────────────────────────── */

export function listCannedReplies(opts: { team?: string | undefined; includeInactive?: boolean | undefined }): Promise<CannedReply[]> {
  return repository.listCanned(opts);
}

export function createCannedReply(input: { title: string; body: string; team: string | null }, actor: Actor): Promise<CannedReply> {
  return repository.createCanned({ ...input, createdById: actor.sub });
}

export async function updateCannedReply(id: string, patch: CannedReplyPatch) {
  const before = await repository.findCanned(id);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Canned reply not found');
  return { before, after: await repository.updateCanned(id, patch) };
}

export async function deleteCannedReply(id: string): Promise<CannedReply> {
  const before = await repository.findCanned(id);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Canned reply not found');
  await repository.deleteCanned(id);
  return before;
}

/* ── the minute sweep ────────────────────────────────────────────── */

const BREACH_KEY = (ticketId: string) => `support:live:breached:${ticketId}`;
const BREACH_TTL_SECONDS = 24 * 60 * 60;
/** The owner's default: a chat nobody has picked up, silent for half an hour, becomes a ticket. */
export const IDLE_CONVERT_MINUTES = 30;

export type SweepSummary = { breached: string[]; converted: string[] };

/**
 * Run every minute by `jobs/live-chat-sla.job.ts`.
 *
 * Two things go wrong with a live chat and both are silent: nobody answers
 * it, and nobody ever will. The first raises a breach on the inbox and
 * pushes every operator on shift — once per chat, the Redis key is the once,
 * so a chat waiting an hour does not page the desk sixty times. The second
 * — half an hour past the last message, no operator on it and no agent
 * having ever replied — converts to a ticket and tells the requester, so
 * the chat stops pretending somebody is about to type.
 */
export async function sweepLiveChats(now: Date = new Date()): Promise<SweepSummary> {
  const settings = await getPlatformSettings();
  const targetMs = settings.support.liveChat.firstResponseTargetSec * 1000;
  const summary: SweepSummary = { breached: [], converted: [] };

  const late = await repository.findLiveChatsPastFirstResponse(new Date(now.getTime() - targetMs));
  const operators = late.length > 0 ? await onlineOperatorIds(now) : [];
  for (const ticket of late) {
    if (!(await claimBreach(ticket.id))) continue;
    const waitedSec = Math.round((now.getTime() - ticket.createdAt.getTime()) / 1000);
    const requesterName = (await findUserLabels([ticket.userId])).get(ticket.userId)?.name ?? 'A subscriber';
    await publish(INBOX_CHANNEL, {
      type: 'breach',
      ticketId: ticket.id,
      displayId: ticket.displayId,
      assignedAdminUserId: ticket.assignedAdminUserId,
      waitedSec,
    });
    for (const operatorUserId of operators) {
      await notify(
        'LIVE_CHAT_BREACH',
        operatorUserId,
        { ticketRef: ticket.displayId ?? ticket.title, requesterName, waitedSec },
        {
          type: 'MESSAGE',
          inApp: {
            type: 'MESSAGE',
            title: 'Live chat waiting',
            ...(ticket.displayId ? { subtitle: ticket.displayId } : {}),
            message: `${requesterName} has waited ${waitedSec} s with no reply.`,
            relatedId: ticket.id,
            relatedType: 'TICKET',
          },
        },
      );
    }
    summary.breached.push(ticket.id);
  }

  const idleBefore = new Date(now.getTime() - IDLE_CONVERT_MINUTES * 60 * 1000);
  for (const ticket of await repository.findIdleLiveChats(idleBefore)) {
    // Only a chat nobody is on: an operator with it open is answering at
    // their own pace and the sweep is not the judge of that.
    if (ticket.assignedAdminUserId) continue;
    // And only a chat no agent has ever answered. `firstResponseAt` is that
    // fact; the newest message's author is not — an agent who replied and
    // was replied to has a conversation going, however quiet, and the
    // sweep must not turn it into a ticket behind their back.
    if (ticket.firstResponseAt !== null) continue;
    await convertLiveChat(
      ticket.id,
      { sub: ticket.userId, roles: [] },
      'Nobody was free to chat. This is now a ticket and ADX will reply on the thread.',
    );
    summary.converted.push(ticket.id);
  }
  return summary;
}

/** One alert per chat: the key is the claim, and it outlives the chat by a day. */
async function claimBreach(ticketId: string): Promise<boolean> {
  try {
    return Boolean(await redis.set(BREACH_KEY(ticketId), '1', 'EX', BREACH_TTL_SECONDS, 'NX'));
  } catch (err) {
    logger.warn('Breach claim unreadable; alerting anyway', { ticketId, reason: err instanceof Error ? err.message : String(err) });
    return true;
  }
}

/* ── the uploads door ────────────────────────────────────────────── */

/**
 * Lot I: filled into `uploads.FileAccessPort` by bootstrap — may this
 * viewer open the SUPPORT_ATTACHMENT file? The answer is yes for the
 * requester of the ticket the file's message sits on (an ADMIN is admitted
 * by `uploads` before the port is asked, and the uploader by ownership). A
 * file on no message opens to nobody else: attaching somebody's file id to
 * a request of one's own reads nothing.
 */
export async function supportAttachmentViewer(viewerUserId: string, fileId: string): Promise<boolean> {
  // Asked for this viewer's own thread: the desk may attach one file to two
  // tickets, and an unfiltered read would answer for whichever message came
  // back first and refuse the other requester their own attachment.
  const message = await repository.findMessageByAttachment(fileId, viewerUserId);
  return message !== null && message.ticketUserId === viewerUserId;
}

/** Re-exported so the controller reads one module. */
export { liveChatEntitlement };

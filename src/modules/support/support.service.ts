import { ApiError } from '../../shared/errors';
import { agentExists } from '../agents';
import { getPlatformSettings, type SupportPriority } from '../app-config';
import { allocateIdentifier } from '../identifiers';
import { createNotification } from '../notifications';
import { listActivity } from '../../shared/audit';
import { findUserLabels, findUserSummaries, getUserDisplayName, listAdminUserIds, userExists, type UserSummary } from '../users';
import {
  notifyOperatorOfRequesterMessage,
  notifyRequesterOfReply,
  publishMessage,
  resolveAttachment,
} from './live-chat.messaging';
import { publish, ticketChannel } from './live-chat.bus';
import { liveChatEntitlement, planOnDesk, type PlanOnDesk } from './live-chat.entitlement';
import { prismaSupportRepository as repository } from './prisma-support.repository';
import {
  requesterOpenOrders,
  requesterPartiesFor,
  requesterWalletBalance,
  type RequesterParty,
} from './requester.port';
import type { PatchTicketInput } from './support.schema';
import { defaultPriorityFor, slaDueAts, slaView, type SlaFields } from './support.sla';
import type { Actor, ListTicketsOptions, NewTicket, OpsTicketOptions, TicketPatch } from './support.types';

export { slaView } from './support.sla';

/** The name every ops reply wears. The person answering is ADX, not a named colleague. */
export const SUPPORT_AUTHOR = 'ADX Support';

export async function getTickets(userId: string, opts: ListTicketsOptions = {}) {
  return repository.findManyForUser(userId, opts);
}

export async function getTicketById(ticketId: string) {
  return repository.findById(ticketId);
}

const isAdmin = (actor: Actor) => actor.roles.includes('ADMIN');

/**
 * A ticket is visible to the person who raised it and to ADX. Returns null
 * rather than throwing so the caller decides between 404 and a silent skip.
 *
 * Until DR 07's second wave, this was the raiser alone — the console could
 * list the queue but read no thread and answer nothing, which made the
 * agent's Support Chat a monologue. Widened to ADMIN on purpose; still nobody
 * else.
 */
export async function getVisibleTicket(ticketId: string, actor: Actor, now: Date = new Date()) {
  const ticket = await repository.findById(ticketId);
  if (!ticket) return null;
  const admin = isAdmin(actor);
  if (ticket.userId !== actor.sub && !admin) return null;
  // Lot D (Q53): an internal note is ops talking to ops. The requester's
  // thread never carries one; the SLA view rides on every read.
  const messages = (ticket as unknown as { messages?: { internal?: boolean }[] }).messages ?? [];
  // Lot I: the thread carries its channel, both seen marks, the live
  // first-response moment and who is on it — so the screen that draws a
  // chat needs one read, not four.
  const assignedAdmin = ticket.assignedAdminUserId
    ? { id: ticket.assignedAdminUserId, name: (await findUserLabels([ticket.assignedAdminUserId])).get(ticket.assignedAdminUserId)?.name ?? null }
    : null;
  // I4-B: a live chat carries the plan its requester holds right now — the
  // entitlement that opened the door, as the desk prints it beside the
  // name. An ordinary ticket has no door and asks nothing.
  const plan: PlanOnDesk = ticket.channel === 'LIVE_CHAT' ? planOnDesk(await liveChatEntitlement(ticket.userId, now)) : null;
  return {
    ...ticket,
    messages: admin ? messages : messages.filter((message) => !message.internal),
    sla: slaView(ticket as SlaFields, now),
    assignedAdmin,
    plan,
  };
}

/** @deprecated the owner-only read; kept for callers that predate the ADMIN widening. */
export async function getOwnedTicket(ticketId: string, userId: string) {
  const ticket = await repository.findById(ticketId);
  return ticket && ticket.userId === userId ? ticket : null;
}

/**
 * Raises a ticket — an issue, or feedback wearing a ticket's clothes.
 *
 * The number comes off the identifiers counter (TKT- or FB-) before the row
 * is written, so it is issued once and never derived. Every admin is told;
 * the queue is what they work, and a notification is how they learn there is
 * something new on it.
 */
export async function createTicket(
  data: Omit<NewTicket, 'displayId' | 'priority' | 'slaFirstResponseDueAt' | 'slaResolutionDueAt'> & { priority?: SupportPriority },
  now: Date = new Date(),
) {
  const displayId = await allocateIdentifier(data.kind === 'FEEDBACK' ? 'FEEDBACK' : 'TICKET');
  // Lot D (Q91): the priority from the category, and the two clocks from the
  // platform settings for that priority, both stamped before the row exists.
  const priority = data.priority ?? defaultPriorityFor(data.category, data.kind);
  const settings = await getPlatformSettings();
  const ticket = await repository.create({
    ...data,
    displayId,
    priority,
    ...slaDueAts(now, priority, settings.support.sla, 0),
  });

  const admins = await listAdminUserIds();
  await Promise.all(
    admins.map((userId) =>
      createNotification({
        userId,
        type: 'SYSTEM',
        title: data.kind === 'FEEDBACK' ? 'New feedback' : 'New support ticket',
        subtitle: displayId,
        message: `${data.title} — ${data.category.toLowerCase().replace(/_/g, ' ')}`,
        relatedId: ticket.id,
        relatedType: 'TICKET',
      }),
    ),
  );
  return ticket;
}

/**
 * The ACCOUNT ticket the Privacy screen raises when somebody asks for their
 * account to be closed — Lot A (Q21).
 *
 * A thin wrapper over `createTicket` rather than a second creation path: the
 * number, the admin fan-out and the thread are the ones every other ticket
 * gets, so ops works one queue. `account-lifecycle` calls it and links the id
 * onto the closure case.
 */
export async function raiseAccountTicket(input: {
  userId: string;
  title: string;
  description: string;
}): Promise<{ id: string; displayId: string | null }> {
  const ticket = await createTicket({
    userId: input.userId,
    kind: 'ISSUE',
    title: input.title,
    description: input.description,
    category: 'ACCOUNT',
    attachmentUrls: [],
  });
  return { id: ticket.id, displayId: ticket.displayId };
}

/** Lot A (Q21): the closure review's "open support tickets" line. */
export async function countOpenTicketsForUser(userId: string): Promise<number> {
  return repository.countOpenForUser(userId);
}

/**
 * Replying distinguishes "no such ticket" (404) from "not yours" (403), unlike
 * reading, which reports both as 404. Preserved from the original controller.
 *
 * ADX's replies are signed "ADX Support" rather than with a colleague's name,
 * and the raiser is told one arrived — that is the chat frame's other half.
 */
export async function addReply(
  ticketId: string,
  actor: Actor,
  message: string,
  options: { internal?: boolean; attachmentFileId?: string | undefined } = {},
  now: Date = new Date(),
) {
  const ticket = await repository.findSummaryById(ticketId);
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  const owner = ticket.userId === actor.sub;
  const admin = isAdmin(actor);
  if (!owner && !admin) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this ticket');
  }
  // Lot D (Q53): an internal note is ops-only, and it is not a response —
  // it neither stamps the first response nor tells the requester anything.
  const internal = options.internal === true;
  if (internal && !admin) throw new ApiError(403, 'FORBIDDEN', 'Only ADX writes internal notes');

  // Lot I: a file on the message. Checked before anything is written — the
  // caller's own, stored as a SUPPORT_ATTACHMENT, an image or a PDF under
  // the cap — so a rejected attachment leaves no half-message behind.
  const attachment = options.attachmentFileId ? await resolveAttachment(options.attachmentFileId, actor.sub) : null;

  // 'Agent' is the fallback when the user has neither name nor mobile.
  const authorName = owner ? (await getUserDisplayName(actor.sub)) ?? 'Agent' : SUPPORT_AUTHOR;
  const reply = await repository.addReply({
    ticketId,
    authorId: actor.sub,
    authorName,
    message,
    internal,
    kind: attachment ? 'ATTACHMENT' : 'TEXT',
    attachmentFileId: attachment?.fileId ?? null,
    attachmentName: attachment?.name ?? null,
  });

  // Lot I: the thread is a stream now. Even an internal note is published —
  // to the desk's own eyes; the stream drops it for the requester.
  await publishMessage(ticket, reply);

  if (internal) return reply;

  if (owner) {
    // The requester answered: a WAITING ticket goes back to OPEN and the
    // clocks restart with the pause banked (Q91).
    if (ticket.status === 'WAITING') await repository.patch(ticketId, resumeClock(ticket, now));
    // Lot I: on a chat somebody owns, that operator hears it.
    await notifyOperatorOfRequesterMessage(ticket, reply);
    return reply;
  }

  // ADX answered: the first one stamps the first-response clock (Q91), and
  // — Lot I — the live-chat first-response moment the inbox judges by.
  const patch: TicketPatch = {};
  if (ticket.firstRespondedAt === null) patch.firstRespondedAt = now;
  if (ticket.firstResponseAt === null) patch.firstResponseAt = now;
  if (Object.keys(patch).length > 0) await repository.patch(ticketId, patch);
  await notifyRequesterOfReply(ticket, reply);
  return reply;
}

/**
 * Open or close. The raiser may close their own; ADX may close any, and the
 * raiser hears about it.
 */
export async function setTicketStatus(ticketId: string, status: 'OPEN' | 'CLOSED', actor?: Actor) {
  const ticket = await repository.setStatus(ticketId, status);
  // Lot I: whoever is watching the thread sees it close under them.
  await publish(ticketChannel(ticketId), { type: 'status', status: ticket.status, channel: ticket.channel });
  if (actor && !isAdmin(actor)) return ticket;
  if (actor && ticket.userId !== actor.sub) {
    await createNotification({
      userId: ticket.userId,
      type: 'MESSAGE',
      title: status === 'CLOSED' ? 'Ticket closed' : 'Ticket reopened',
      subtitle: ticket.displayId ?? undefined,
      message:
        status === 'CLOSED'
          ? `${ticket.title} — ADX Support marked this resolved. Reply on the thread if it is not.`
          : `${ticket.title} — ADX Support reopened this ticket.`,
      relatedId: ticket.id,
      relatedType: 'TICKET',
    });
  }
  return ticket;
}

/** Every ticket, for the people who work the queue — each row with its SLA view and (E7-3) who raised it. */
export async function getOpsTickets(opts: OpsTicketOptions, now: Date = new Date()) {
  // E10-1: the teams facet is the whole queue's, not the page's.
  const [page, teams] = await Promise.all([repository.findManyForOps(opts, now), repository.distinctTeams()]);
  const requesters = await requestersFor(page.items.map((ticket) => ticket.userId));
  return {
    ...page,
    teams,
    items: page.items.map((ticket) => ({
      ...ticket,
      sla: slaView(ticket, now),
      requester: requesters.get(ticket.userId) ?? { userId: ticket.userId, name: null, role: null, displayId: null },
    })),
  };
}

/* ── E7-3: who raised it ─────────────────────────────────────────── */

/** The vocabulary the console prints: the party type, else the account's role folded to it. */
export type RequesterRole = 'PUBLISHER' | 'ADVERTISER' | 'AGENT' | 'PARTNER' | 'ADMIN';

export type Requester = { userId: string; name: string | null; role: RequesterRole | null; displayId: string | null };

function roleOf(user: UserSummary | undefined, party: RequesterParty | null): RequesterRole | null {
  if (party) return party.type;
  switch (user?.role) {
    case 'PUBLISHER':
    case 'ADVERTISER':
    case 'PARTNER':
    case 'ADMIN':
      return user.role;
    case 'AGENT_PUBLISHER':
    case 'AGENT_ADVERTISER':
      return 'AGENT';
    default:
      return null;
  }
}

/**
 * The record to print when a login holds more than one: the one the
 * account's primary role names (an agent who is also a publisher raises a
 * ticket as the agent when that is their role), else the first.
 */
function pickParty(records: RequesterParty[] | undefined, user: UserSummary | undefined): RequesterParty | null {
  if (!records || records.length === 0) return null;
  const preferred = roleOf(user, null);
  return records.find((record) => record.type === preferred) ?? records[0] ?? null;
}

/** `{ userId, name, role, displayId }` per requester on a page, two round trips whatever the page size. */
async function requestersFor(userIds: string[]): Promise<Map<string, Requester>> {
  const unique = [...new Set(userIds)];
  const [users, parties] = await Promise.all([findUserSummaries(unique), requesterPartiesFor(unique)]);
  return new Map(
    unique.map((userId) => {
      const user = users.get(userId);
      const party = pickParty(parties.get(userId), user);
      return [
        userId,
        {
          userId,
          name: party?.name ?? user?.name ?? user?.mobile ?? null,
          role: roleOf(user, party),
          displayId: party?.displayId ?? null,
        },
      ];
    }),
  );
}

/**
 * The requester rail beside a thread (ADMIN): the account, the party record
 * with its KYC state, the wallet balance, what they have running, how many
 * tickets they hold open, and the last ten things the audit trail says they
 * did. 404 when the ticket does not exist; the party and the numbers come
 * through `RequesterPort`, so an unregistered port still answers the account.
 */
export async function getTicketRequester(ticketId: string) {
  const ticket = await repository.findSummaryById(ticketId);
  if (!ticket) return null;
  const userId = ticket.userId;
  const [users, parties, openTickets, activity] = await Promise.all([
    findUserSummaries([userId]),
    requesterPartiesFor([userId]),
    repository.countOpenForUser(userId),
    listActivity(userId, 10),
  ]);
  const user = users.get(userId) ?? null;
  const party = pickParty(parties.get(userId), user ?? undefined);
  const [walletBalance, openOrders] = await Promise.all([requesterWalletBalance(party), requesterOpenOrders(userId, party)]);
  return {
    user,
    party,
    walletBalance,
    openOrders,
    openTickets,
    recentActivity: activity.map((row) => ({ action: row.action, at: row.createdAt })),
  };
}

/* ── Lot D (Q53/Q91): the clock, paused and resumed ──────────────── */

type ClockFields = SlaFields & { slaPausedMs: number };

/** The patch that ends a pause: the time waited is banked and both due dates move by it. */
function resumeClock(ticket: ClockFields, now: Date): TicketPatch {
  const waited = ticket.slaPausedAt ? Math.max(0, now.getTime() - ticket.slaPausedAt.getTime()) : 0;
  const shift = (at: Date | null) => (at ? new Date(at.getTime() + waited) : null);
  return {
    status: 'OPEN',
    slaPausedAt: null,
    slaPausedMs: ticket.slaPausedMs + waited,
    slaFirstResponseDueAt: shift(ticket.slaFirstResponseDueAt),
    slaResolutionDueAt: shift(ticket.slaResolutionDueAt),
  };
}

/**
 * The ops patch: WAITING pauses the clock and tells the requester; OPEN from
 * WAITING resumes it with the pause banked; CLOSED tells the requester; a
 * priority change recomputes both due dates from the creation time (never
 * from now — a re-prioritised ticket keeps the time it has already waited)
 * with any pause still banked; the ops owner and team are plain columns.
 * Returns the row before and after, so the controller can audit the diff.
 */
export async function patchTicket(
  ticketId: string,
  admin: Actor,
  input: PatchTicketInput,
  now: Date = new Date(),
) {
  if (!isAdmin(admin)) throw new ApiError(403, 'FORBIDDEN', 'Only ADX works the queue');
  const ticket = await repository.findSummaryById(ticketId);
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');

  const patch: TicketPatch = {};
  let pausedMs = ticket.slaPausedMs;
  let pausedAt: Date | null = ticket.slaPausedAt;

  if (input.status !== undefined && input.status !== ticket.status) {
    if (input.status === 'WAITING') {
      patch.status = 'WAITING';
      patch.slaPausedAt = now;
      pausedAt = now;
    } else {
      if (ticket.status === 'WAITING') {
        const resumed = resumeClock(ticket, now);
        pausedMs = resumed.slaPausedMs!;
        pausedAt = null;
        Object.assign(patch, resumed);
      }
      patch.status = input.status;
    }
  }

  if (input.priority !== undefined && input.priority !== ticket.priority) {
    const settings = await getPlatformSettings();
    // A running pause is not banked yet; the due dates are set as if it were
    // and `slaView` adds the rest as it runs.
    const running = pausedAt ? Math.max(0, now.getTime() - pausedAt.getTime()) : 0;
    const due = slaDueAts(ticket.createdAt, input.priority, settings.support.sla, pausedMs + running);
    patch.priority = input.priority;
    patch.slaFirstResponseDueAt = due.slaFirstResponseDueAt;
    patch.slaResolutionDueAt = due.slaResolutionDueAt;
    if (pausedAt) patch.slaPausedAt = now;
  }

  if (input.team !== undefined) patch.team = input.team;

  if (input.assignedAdminUserId !== undefined && input.assignedAdminUserId !== ticket.assignedAdminUserId) {
    if (input.assignedAdminUserId && !(await userExists(input.assignedAdminUserId))) {
      throw new ApiError(404, 'NOT_FOUND', 'That admin user does not exist');
    }
    patch.assignedAdminUserId = input.assignedAdminUserId;
    patch.assignedAdminAt = input.assignedAdminUserId ? now : null;
  }

  const updated = Object.keys(patch).length > 0 ? await repository.patch(ticketId, patch) : ticket;

  // Lot I: the stream carries what the desk moved.
  if (patch.status) await publish(ticketChannel(ticketId), { type: 'status', status: updated.status, channel: updated.channel });
  if (patch.assignedAdminUserId !== undefined) {
    const name = patch.assignedAdminUserId ? (await findUserLabels([patch.assignedAdminUserId])).get(patch.assignedAdminUserId)?.name ?? null : null;
    await publish(ticketChannel(ticketId), { type: 'assigned', name, adminUserId: patch.assignedAdminUserId ?? null });
  }

  const tell: Promise<unknown>[] = [];
  if (patch.status === 'WAITING') {
    tell.push(
      createNotification({
        userId: ticket.userId,
        type: 'MESSAGE',
        title: 'ADX Support needs something from you',
        subtitle: ticket.displayId ?? undefined,
        message: `${ticket.title} — reply on the thread so we can carry on.`,
        relatedId: ticket.id,
        relatedType: 'TICKET',
      }),
    );
  }
  if (patch.status === 'CLOSED') {
    tell.push(
      createNotification({
        userId: ticket.userId,
        type: 'MESSAGE',
        title: 'Ticket closed',
        subtitle: ticket.displayId ?? undefined,
        message: `${ticket.title} — ADX Support marked this resolved. Reply on the thread if it is not.`,
        relatedId: ticket.id,
        relatedType: 'TICKET',
      }),
    );
  }
  if (patch.assignedAdminUserId) {
    tell.push(
      createNotification({
        userId: patch.assignedAdminUserId,
        type: 'SYSTEM',
        title: 'Ticket assigned to you',
        subtitle: ticket.displayId ?? undefined,
        message: `${ticket.title} — ${String(updated.priority).toLowerCase()} priority.`,
        relatedId: ticket.id,
        relatedType: 'TICKET',
      }),
    );
  }
  await Promise.all(tell);

  return { before: ticket, after: { ...updated, sla: slaView(updated, now) } };
}

/**
 * Putting an agent on a request.
 *
 * More than a workflow field: this is what later authorises delegated access to
 * the publisher's account, so the agent has to exist and the decision is stamped
 * with who made it. Unassigning is allowed and is not the same as closing —
 * a request nobody owns should not look resolved.
 */
export async function assignTicket(
  ticketId: string,
  assignedAgentId: string | null,
  assignedById: string
) {
  const ticket = await repository.findSummaryById(ticketId);
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  if (assignedAgentId && !(await agentExists(assignedAgentId))) {
    throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  }
  return repository.assign(ticketId, assignedAgentId, assignedById);
}

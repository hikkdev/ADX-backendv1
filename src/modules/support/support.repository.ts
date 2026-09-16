import type { CannedReply, SupportTicket, TicketMessage } from '../../shared/database';
import type { ListPage } from '../../shared/pagination';
import type {
  CannedReplyPatch,
  ListTicketsOptions,
  LiveInboxOptions,
  NewCannedReply,
  NewReply,
  NewTicket,
  OpsTicketOptions,
  TicketPatch,
} from './support.types';

/** Lot I: an inbox row — the ticket, its newest visible message, and how many requester messages the desk has not seen. */
export type LiveInboxRow = SupportTicket & {
  lastMessage: Pick<TicketMessage, 'id' | 'authorId' | 'authorName' | 'kind' | 'message' | 'createdAt'> | null;
  unreadForAgent: number;
};

/** Lot I: an idle-sweep row — the ticket with the newest human message on it. */
export type IdleLiveChatRow = SupportTicket & { lastMessage: Pick<TicketMessage, 'authorId' | 'createdAt'> | null };

export interface SupportRepository {
  findManyForUser(userId: string, opts: ListTicketsOptions): Promise<SupportTicket[]>;
  findById(ticketId: string): Promise<SupportTicket | null>;
  /** Without the message thread — used for ownership checks before a write. */
  findSummaryById(ticketId: string): Promise<SupportTicket | null>;
  create(data: NewTicket): Promise<SupportTicket>;
  /** Creates the message and touches the ticket in one transaction. */
  addReply(data: NewReply): Promise<TicketMessage>;
  setStatus(ticketId: string, status: 'OPEN' | 'CLOSED'): Promise<SupportTicket>;
  /** Lot D (Q53/Q91): the desk's columns — status, priority, the clocks, the ops owner, the team. */
  patch(ticketId: string, patch: TicketPatch): Promise<SupportTicket>;
  /** Lot A (Q21): what the closure review reports as "open support tickets" — anything not CLOSED. */
  countOpenForUser(userId: string): Promise<number>;

  /* ── Assignment ───────────────────────────────────────────────────
   * ADX decides who handles a request, and that decision is what later
   * authorises delegated access to the publisher's account. It lives on the
   * ticket rather than being passed around, so there is one answer to "who was
   * put on this" and it is auditable after the fact. */
  /**
   * The queue on the list contract: one page, the total, and the counts by
   * status over the filter with the status facet removed. `breached` is
   * decided in the query at `now`, the same rule `slaView` applies on read.
   */
  findManyForOps(opts: OpsTicketOptions, now: Date): Promise<ListPage<SupportTicket>>;
  /** E10-1: every team a ticket has been put on, across the whole queue — the desk's team filter. */
  distinctTeams(): Promise<string[]>;
  assign(
    ticketId: string,
    assignedAgentId: string | null,
    assignedById: string
  ): Promise<SupportTicket>;

  /* ── Lot I: live chat ──────────────────────────────────────────────
   * A live chat is a SupportTicket with channel LIVE_CHAT; the stream, the
   * seen marks and the inbox read the same rows the desk's queue does. */
  /** The caller's OPEN live chat, if one is running — a second start continues it. */
  findOpenLiveChatForUser(userId: string): Promise<SupportTicket | null>;
  /** Open live chats per operator, for the fewest-open assignment and the presence read. */
  countOpenLiveChatsByAdmin(adminUserIds: readonly string[]): Promise<Map<string, number>>;
  /** Every OPEN live chat, for the expected-wait estimate. */
  countOpenLiveChats(): Promise<number>;
  /** Messages written after `after`, oldest first — the reconnect's catch-up. */
  findMessagesAfter(ticketId: string, after: Date): Promise<TicketMessage[]>;
  /**
   * The message a SUPPORT_ATTACHMENT file rides on, with the ticket's
   * requester. `ticketUserId` narrows it to that person's own thread: one
   * file can sit on two tickets (the desk reusing a screenshot), and the
   * unfiltered read would answer for whichever came back first.
   */
  findMessageByAttachment(fileId: string, ticketUserId?: string): Promise<{ ticketId: string; ticketUserId: string } | null>;
  /** Stamps the side's seen mark and every message somebody else wrote that was not yet seen. */
  markSeen(ticketId: string, side: 'requester' | 'agent', viewerUserId: string, at: Date): Promise<SupportTicket>;
  /** The live inbox: OPEN live chats on the list contract, each with its newest message and the desk's unread count. */
  findLiveInbox(opts: LiveInboxOptions): Promise<ListPage<LiveInboxRow>>;
  /** OPEN live chats opened before `before` with no operator reply yet — the breach sweep. */
  findLiveChatsPastFirstResponse(before: Date): Promise<SupportTicket[]>;
  /** OPEN live chats whose last message is older than `before`, with that message — the idle sweep (whose guard is `firstResponseAt`, I4-B; the message is the row's clock). */
  findIdleLiveChats(before: Date): Promise<IdleLiveChatRow[]>;

  /* Canned replies — the desk's shortcuts. */
  listCanned(opts: { team?: string | undefined; includeInactive?: boolean | undefined }): Promise<CannedReply[]>;
  findCanned(id: string): Promise<CannedReply | null>;
  createCanned(data: NewCannedReply): Promise<CannedReply>;
  updateCanned(id: string, patch: CannedReplyPatch): Promise<CannedReply>;
  deleteCanned(id: string): Promise<void>;
}

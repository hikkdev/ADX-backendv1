export type TicketKind = 'ISSUE' | 'FEEDBACK';

export type ListTicketsOptions = {
  limit?: number;
  offset?: number;
  status?: string;
  kind?: TicketKind;
  search?: string;
};

/** The ops queue, across every user rather than one of them — the list contract plus the desk's facets. */
export type OpsTicketOptions = {
  page: number;
  pageSize: number;
  /** OLDEST (the default), NEWEST, or DUE — the resolution clock, soonest first. */
  sort: string;
  q?: string | undefined;
  status?: readonly string[] | undefined;
  kind?: TicketKind | undefined;
  priority?: string | undefined;
  unassigned?: boolean | undefined;
  /** Resolved by the service from `mine`: the caller's own user id. */
  assignedAdminUserId?: string | undefined;
  breached?: boolean | undefined;
  team?: string | undefined;
};

/** Lot I: a ticket is worked as a thread, or live over the stream. */
export type TicketChannel = 'TICKET' | 'LIVE_CHAT';
/** Lot I: text, a private file, or a line the platform wrote ("Priya joined"). */
export type MessageKind = 'TEXT' | 'ATTACHMENT' | 'SYSTEM';

/** Lot D (Q53/Q91): the columns the desk moves — and, Lot I, the live-chat marks. */
export type TicketPatch = Partial<{
  status: 'OPEN' | 'WAITING' | 'CLOSED';
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  slaFirstResponseDueAt: Date | null;
  slaResolutionDueAt: Date | null;
  firstRespondedAt: Date | null;
  slaPausedAt: Date | null;
  slaPausedMs: number;
  assignedAdminUserId: string | null;
  assignedAdminAt: Date | null;
  team: string | null;
  channel: TicketChannel;
  requesterSeenAt: Date | null;
  agentSeenAt: Date | null;
  firstResponseAt: Date | null;
  lastMessageAt: Date | null;
}>;

export type NewTicket = {
  userId: string;
  kind: TicketKind;
  /** TKT-… or FB-…, minted by the identifiers module before the row is written. */
  displayId: string;
  title: string;
  description: string;
  category: string;
  relatedOrderId?: string;
  attachmentUrls: string[];
  /** 1–5, on a FEEDBACK ticket only. */
  rating?: number | null;
  /** What stood out, from the Rate your experience chips. */
  tags?: string[];
  /** Lot D (Q91): the priority the ticket opens at, and the two clocks it starts. */
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  slaFirstResponseDueAt: Date;
  slaResolutionDueAt: Date;
  /** Lot I: LIVE_CHAT when started from the live door; TICKET (the default) otherwise. */
  channel?: TicketChannel;
  /** Lot I: the operator a live chat was put on at start. */
  assignedAdminUserId?: string | null;
  assignedAdminAt?: Date | null;
  lastMessageAt?: Date | null;
};

export type NewReply = {
  ticketId: string;
  authorId: string;
  authorName: string;
  message: string;
  /** An ops note the requester never sees. */
  internal: boolean;
  /** Lot I: TEXT unless a file rides on it, or the platform wrote the line. */
  kind?: MessageKind;
  attachmentFileId?: string | null;
  attachmentName?: string | null;
};

/** Lot I: the live inbox — OPEN live chats, on the list contract. */
export type LiveInboxOptions = {
  page: number;
  pageSize: number;
  sort: string;
  q?: string | undefined;
  /** Only the caller's own chats. */
  assignedAdminUserId?: string | undefined;
  unassigned?: boolean | undefined;
};

export type NewCannedReply = {
  title: string;
  body: string;
  team: string | null;
  createdById: string;
};

export type CannedReplyPatch = Partial<{ title: string; body: string; team: string | null; isActive: boolean }>;

/** Who is asking: the token's subject and roles, which decide what they may see. */
export type Actor = { sub: string; roles: string[] };

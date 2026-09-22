import type { Lead, LeadCallOutcome, LeadChannel, LeadConversation, LeadInvite, LeadMessage, LeadMessageStatus, LeadProposal, LeadProposalKind, LeadSequence, LeadSequenceRun } from '../../shared/database';

/**
 * LH6 (the Lead Hunt, 22 Sep 2026): what the outreach hub reads and writes —
 * conversations and messages per channel, sequences and their runs, the
 * two queues, the stats by channel. Beside `leads.repository.ts` rather than
 * inside it so the hub's shapes stay in one place.
 */

export type NewConversation = { leadId: string; channel: LeadChannel; providerThreadId?: string | null };
export type ConversationPatch = Partial<Pick<LeadConversation, 'providerThreadId' | 'windowClosesAt' | 'lastInboundAt' | 'lastOutboundAt'>>;

export type NewMessage = {
  conversationId: string;
  leadId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  channel: LeadChannel;
  templateKey?: string | null;
  body: string;
  providerId?: string | null;
  status: LeadMessageStatus;
  error?: string | null;
  scheduledFor?: Date | null;
  sequenceRunId?: string | null;
  maskedNumber?: string | null;
  providerCallId?: string | null;
  outcome?: LeadCallOutcome | null;
  durationSec?: number | null;
  consentPlayed?: boolean | null;
  recordingFileId?: string | null;
  at: Date;
  byAgentId?: string | null;
  byUserId?: string | null;
};
export type MessagePatch = Partial<Pick<LeadMessage, 'status' | 'error' | 'providerId' | 'outcome' | 'durationSec' | 'consentPlayed' | 'recordingFileId' | 'scheduledFor' | 'at' | 'body' | 'maskedNumber' | 'providerCallId'>>;

export type SequenceStep = { channel: LeadChannel; delayHours: number; templateKey: string | null };
export type NewSequence = { side: 'PUBLISHER' | 'ADVERTISER'; temperature: 'HOT' | 'WARM' | 'COLD'; name: string; steps: SequenceStep[]; stopOnReply: boolean; isActive: boolean; createdById: string | null };
export type SequencePatch = Partial<Omit<NewSequence, 'createdById'>>;
export type SequenceWithCounts = LeadSequence & { activeRuns: number; totalRuns: number };

export type RunPatch = Partial<Pick<LeadSequenceRun, 'stepIndex' | 'nextAt' | 'stoppedAt' | 'stopReason'>>;

/** One row of the inbound queue: the thread, the lead it is on, and the last thing said. */
export type InboxRow = LeadConversation & { lead: Lead; last: LeadMessage | null; unanswered: number };
export type InboxFilter = { channel?: LeadChannel | undefined; side?: 'PUBLISHER' | 'ADVERTISER' | undefined; unansweredOnly: boolean; city?: string | undefined; agentId?: string | undefined };

/** One row of the tele-team queue: a cold lead with a number, and how the last call went. */
export type TeleRow = Lead & { lastCall: LeadMessage | null; attempts: number; callbackDue: Date | null };
export type TeleFilter = { side?: 'PUBLISHER' | 'ADVERTISER' | undefined; city?: string | undefined; temperature?: 'HOT' | 'WARM' | 'COLD' | undefined; q?: string | undefined };

export type ChannelStat = { channel: LeadChannel; outbound: number; delivered: number; failed: number; inbound: number; replies: number };

export interface OutreachRepository {
  findConversation(leadId: string, channel: LeadChannel): Promise<LeadConversation | null>;
  findConversationByThread(channel: LeadChannel, providerThreadId: string): Promise<(LeadConversation & { lead: Lead }) | null>;
  createConversation(data: NewConversation): Promise<LeadConversation>;
  updateConversation(id: string, patch: ConversationPatch): Promise<LeadConversation>;
  listConversations(leadId: string): Promise<LeadConversation[]>;
  /** The unified thread: every message on the lead, oldest first, capped. */
  listMessages(leadId: string, take: number): Promise<LeadMessage[]>;
  createMessage(data: NewMessage): Promise<LeadMessage>;
  updateMessage(id: string, patch: MessagePatch): Promise<LeadMessage>;
  findMessage(id: string): Promise<LeadMessage | null>;
  findMessageByProviderId(channel: LeadChannel, providerId: string): Promise<LeadMessage | null>;
  findMessageByCallId(providerCallId: string): Promise<LeadMessage | null>;
  /** Outbound rows that count against the lead's weekly cap — sent, delivered, read, queued or received-by-provider; skipped and failed do not. */
  countOutboundBetween(leadId: string, from: Date, to: Date): Promise<number>;
  /** QUEUED rows whose time came. */
  dueQueuedMessages(now: Date, take: number): Promise<LeadMessage[]>;
  /** The lead's last outbound on any channel, or null. */
  lastOutbound(leadId: string): Promise<LeadMessage | null>;
  /** Recorded calls older than the cutoff that still hold a file — the 90-day purge. */
  recordingsBefore(cutoff: Date, take: number): Promise<{ id: string; recordingFileId: string }[]>;
  /** The stats by channel between two instants (optionally one side): volume out and in, and the threads that answered. */
  channelStats(from: Date, to: Date, side?: 'PUBLISHER' | 'ADVERTISER'): Promise<ChannelStat[]>;

  listSequences(filter: { side?: 'PUBLISHER' | 'ADVERTISER' | undefined; activeOnly?: boolean | undefined }): Promise<SequenceWithCounts[]>;
  findSequence(id: string): Promise<LeadSequence | null>;
  createSequence(data: NewSequence): Promise<LeadSequence>;
  updateSequence(id: string, patch: SequencePatch): Promise<LeadSequence>;
  /** The active sequence for the side and temperature — the newest when several are. */
  findActiveSequence(side: string, temperature: string): Promise<LeadSequence | null>;
  countSequences(): Promise<number>;
  findActiveRun(leadId: string): Promise<(LeadSequenceRun & { sequence: LeadSequence }) | null>;
  listRuns(leadId: string): Promise<(LeadSequenceRun & { sequence: LeadSequence })[]>;
  createRun(data: { leadId: string; sequenceId: string; stepIndex: number; nextAt: Date | null; startedAt: Date }): Promise<LeadSequenceRun>;
  updateRun(id: string, patch: RunPatch): Promise<LeadSequenceRun>;
  /** Open runs whose next step is due. */
  dueRuns(now: Date, take: number): Promise<(LeadSequenceRun & { sequence: LeadSequence; lead: Lead })[]>;
  /** Stop every open run on the lead with the reason; how many stopped. */
  stopRuns(leadId: string, at: Date, reason: string): Promise<number>;

  inbox(filter: InboxFilter, page: { skip: number; take: number }): Promise<{ items: InboxRow[]; total: number; byChannel: Record<string, number> }>;
  teleQueue(filter: TeleFilter, page: { skip: number; take: number }): Promise<{ items: TeleRow[]; total: number }>;

  /* ── LH7: invites and proposals ────────────────────────────────── */

  /** The lead's live invite — not revoked, not expired at `now` — or null. */
  findActiveInvite(leadId: string, now: Date): Promise<LeadInvite | null>;
  findInviteByCode(code: string): Promise<(LeadInvite & { lead: Lead }) | null>;
  listInvites(leadId: string): Promise<LeadInvite[]>;
  createInvite(data: { leadId: string; code: string; expiresAt: Date; issuedByUserId: string | null }): Promise<LeadInvite>;
  updateInvite(id: string, patch: Partial<Pick<LeadInvite, 'opens' | 'convertedAt' | 'revokedAt' | 'expiresAt'>>): Promise<LeadInvite>;
  createProposal(data: { leadId: string; kind: LeadProposalKind; payload: unknown; note: string | null; createdByUserId: string | null; sentAt: Date }): Promise<LeadProposal>;
  listProposals(leadId: string): Promise<LeadProposal[]>;
  findProposal(id: string): Promise<LeadProposal | null>;
  updateProposal(id: string, patch: Partial<Pick<LeadProposal, 'openedAt' | 'acceptedAt'>>): Promise<LeadProposal>;
  /** Unopened proposals on the lead marked opened at `now` — the landing showed them. */
  markProposalsOpened(leadId: string, now: Date): Promise<number>;

  /** The person behind a sign-in — the name and the mobile the click-to-call rings first. */
  findCaller(userId: string): Promise<{ id: string; name: string | null; mobile: string | null } | null>;
  /** LH7: the roles an account holds, for the session the landing starts. */
  findUserRoles(userId: string): Promise<string[]>;
  /** The agent's sign-in and name, for a task on their plate and the "from" line of a message. */
  findAgentUser(agentId: string): Promise<{ userId: string; name: string | null; mobile: string | null } | null>;
}

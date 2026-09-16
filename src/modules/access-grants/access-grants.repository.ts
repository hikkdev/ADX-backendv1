import type {
  AccessGrantScope,
  AccessGrantStatus,
  DelegatedAccessGrant,
} from '../../shared/database';

/** Whose account a grant opens — exactly one of the two. */
export type GrantSubject = { publisherId: string } | { advertiserId: string };

export type NewGrant = {
  publisherId: string;
  reason: string;
  scope: AccessGrantScope;
  listingIds: string[];
  assignedAgentId: string;
  supportTicketId: string | null;
  durationMinutes: number;
};

/** A grant with the names a screen needs, so no caller re-queries for them. */
export type GrantDetail = DelegatedAccessGrant & {
  publisher: { id: string; name: string; userId: string | null } | null;
  assignedAgent: { id: string; userId: string };
};

export interface AccessGrantsRepository {
  create(data: NewGrant): Promise<DelegatedAccessGrant>;
  /** An ONBOARDING authority: active from the start, for the window given. */
  createOnboarding(data: {
    subject: GrantSubject;
    assignedAgentId: string;
    qrId: string;
    durationMinutes: number;
  }): Promise<DelegatedAccessGrant>;
  /** Closes every live ONBOARDING authority on an account. */
  expireOnboarding(subject: GrantSubject, now: Date): Promise<number>;
  /** Whether any agent holds a live ONBOARDING authority on an account. */
  findLiveOnboarding(subject: GrantSubject, now: Date): Promise<DelegatedAccessGrant | null>;
  attachQr(grantId: string, qrId: string): Promise<void>;
  findById(grantId: string): Promise<GrantDetail | null>;
  /**
   * Every grant an agent could still be acting under, expiry included.
   *
   * The expiry is filtered in SQL rather than in the service, because a window
   * that has run out is not a grant that needs closing — it is simply not a
   * grant. Leaving that to a sweep would mean access outliving its window for
   * as long as the sweep was late.
   */
  findLiveForAgent(
    agentId: string,
    subject: GrantSubject,
    scope: AccessGrantScope,
    now: Date
  ): Promise<DelegatedAccessGrant[]>;
  claim(grantId: string, expiresAt: Date): Promise<DelegatedAccessGrant>;
  setStatus(
    grantId: string,
    status: AccessGrantStatus,
    fields: { revokedAt?: Date; revokedById?: string }
  ): Promise<DelegatedAccessGrant>;
  listForPublisher(publisherId: string): Promise<DelegatedAccessGrant[]>;
  /** Every grant ever opened on a subject, either side, newest first. */
  listForSubject(subject: GrantSubject): Promise<DelegatedAccessGrant[]>;
  listForAgent(agentId: string): Promise<DelegatedAccessGrant[]>;
  /** D6: the same, with the party's name on each — ops' view of an agent. */
  listForAgentWithNames(agentId: string): Promise<GrantDetail[]>;
  /** Ops view: everything still open, newest first. */
  listOpen(): Promise<GrantDetail[]>;
  /** The listings a publisher owns, for validating a narrowed grant. */
  listingIdsFor(publisherId: string): Promise<string[]>;
  /** K-B1: `{ id, label, displayId }` per id in one query — the QR desk names the code's subject with it. */
  findLabelsByIds(ids: string[]): Promise<{ id: string; label: string; displayId: string | null }[]>;
  publisherFor(publisherId: string): Promise<{ id: string; userId: string | null } | null>;
  /**
   * The ticket, with the two things a grant is built from: who raised it, and
   * who ADX put on it.
   */
  ticketFor(ticketId: string): Promise<{
    id: string;
    userId: string;
    title: string;
    status: string;
    assignedAgentId: string | null;
  } | null>;
}

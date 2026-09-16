import type {
  PartySuspensionEvent,
  SuspendedPartyType,
  SuspensionAction,
  SuspensionScope,
} from '../../shared/database';

/**
 * The four parties ADX can suspend, and the columns that say so.
 *
 * This module owns `PartySuspensionEvent` outright and owns the five
 * suspension columns wherever they appear — on Listing, Publisher, Advertiser
 * and AgentProfile. That is deliberate and stated in the README: one
 * vocabulary, one writer. Every other module reads those columns (the booking
 * gate, the dispatch sweep, the accrual run) and none of them writes one.
 */

export type PartyType = SuspendedPartyType;

/** Everything the service needs about a party to suspend or reinstate it. */
export type PartyRow = {
  id: string;
  scopes: SuspensionScope[];
  suspendedAt: Date | null;
  suspensionReason: string | null;
  suspendedById: string | null;
  /** The person to notify, to deactivate on BLOCK_SIGNIN, and to thaw again. */
  userId: string | null;
  /** ListingStatus for a listing, AgentProfileStatus for an agent, else null. */
  status: string | null;
  /** Listing only: who owns the spot — the wallet FREEZE_WALLET would reach. */
  publisherId: string | null;
  /** Listing only: what the ACTIVE restore is decided on. */
  publishedAt: Date | null;
  verificationExpiresAt: Date | null;
  /** A label for the notification and the audit row. */
  name: string | null;
};

export type ScopePatch = {
  scopes: SuspensionScope[];
  suspendedAt: Date | null;
  suspensionReason: string | null;
  suspendedById: string | null;
};

export type NewSuspensionEvent = {
  partyType: PartyType;
  partyId: string;
  action: SuspensionAction;
  scopes: SuspensionScope[];
  reason: string;
  byUserId: string;
  at?: Date;
};

/** One of a publisher's spots, for the BLOCK_NEW / STOP_ACCRUAL cascade. */
export type PublisherListing = {
  id: string;
  title: string;
  status: string;
  scopes: SuspensionScope[];
};

export interface SuspensionRepository {
  findParty(partyType: PartyType, partyId: string): Promise<PartyRow | null>;
  /**
   * Writes the scopes and the three columns the table's CHECK ties to them:
   * a non-empty scope list must carry a reason and a date, and an empty one
   * must carry neither.
   */
  setScopes(partyType: PartyType, partyId: string, patch: ScopePatch): Promise<void>;
  setListingStatus(listingId: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<void>;
  setAgentStatus(agentId: string, status: 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED'): Promise<void>;
  setUserActive(userId: string, isActive: boolean): Promise<void>;
  listingsForPublisher(publisherId: string): Promise<PublisherListing[]>;
  createEvent(input: NewSuspensionEvent): Promise<PartySuspensionEvent>;
  listEvents(partyType: PartyType, partyId: string, limit: number): Promise<PartySuspensionEvent[]>;
}

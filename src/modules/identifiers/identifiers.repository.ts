import type { IdentifierFormat, PartyType } from '../../shared/database';

export type NewIdentifierFormat = {
  party: PartyType;
  prefix: string;
  pattern: string;
  seqPadding: number;
  timeZone: string;
  isActive: boolean;
};

export type IdentifierFormatPatch = Partial<{
  prefix: string;
  pattern: string;
  seqPadding: number;
  timeZone: string;
  isActive: boolean;
}>;

/**
 * The series a party backfill fills: the four party tables and the person.
 * PARTNER is the print partner's series (PRT-…), AGENT the agent profile's.
 */
export type IdentifiedParty = Extract<PartyType, 'PUBLISHER' | 'ADVERTISER' | 'PARTNER' | 'AGENT' | 'USER'>;

/** How many rows of one series still lack an identifier, and the span of their `createdAt`. */
export type MissingIdentifierSummary = { count: number; oldest: Date | null; newest: Date | null };

export interface IdentifiersRepository {
  findFormat(party: PartyType): Promise<IdentifierFormat | null>;
  listFormats(): Promise<IdentifierFormat[]>;
  createFormat(data: NewIdentifierFormat): Promise<IdentifierFormat>;
  updateFormat(party: PartyType, patch: IdentifierFormatPatch): Promise<IdentifierFormat>;

  /**
   * Reserves and returns the next sequence for a party on a calendar day.
   *
   * Must be atomic: two signups in the same millisecond have to receive
   * different numbers. The Prisma upsert compiles to INSERT ... ON CONFLICT DO
   * UPDATE, so the database serialises them rather than the application.
   */
  nextSequence(party: PartyType, dateKey: string): Promise<number>;

  /** Parties still without an identifier, oldest first, for the backfill. */
  publishersMissingIdentifier(limit: number): Promise<{ id: string; createdAt: Date }[]>;
  setPublisherIdentifier(publisherId: string, displayId: string): Promise<void>;
  /** QR-4: accounts still without an ADX-… id, oldest first. */
  usersMissingIdentifier(limit: number): Promise<{ id: string; createdAt: Date }[]>;
  setUserIdentifier(userId: string, displayId: string): Promise<void>;
  /** BK-1: bookings placed before the series existed. */
  ordersMissingIdentifier(limit: number): Promise<{ id: string; createdAt: Date }[]>;
  setOrderIdentifier(orderId: string, displayId: string): Promise<void>;
  /** The other three party tables, the same pair as the publisher's. */
  advertisersMissingIdentifier(limit: number): Promise<{ id: string; createdAt: Date }[]>;
  setAdvertiserIdentifier(advertiserId: string, displayId: string): Promise<void>;
  printPartnersMissingIdentifier(limit: number): Promise<{ id: string; createdAt: Date }[]>;
  setPrintPartnerIdentifier(printPartnerId: string, displayId: string): Promise<void>;
  agentsMissingIdentifier(limit: number): Promise<{ id: string; createdAt: Date }[]>;
  setAgentIdentifier(agentProfileId: string, displayId: string): Promise<void>;
  /** Counts only — what a `--check` run reports, and what a write run has left. */
  missingIdentifierSummary(party: IdentifiedParty): Promise<MissingIdentifierSummary>;
}

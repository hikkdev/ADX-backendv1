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
}

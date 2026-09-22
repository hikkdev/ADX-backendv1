import type { AgreementKind, SigningParty, SigningRequest, SigningStatus, SignMethod } from '../../../shared/database';
import type { Page, PageQuery } from '../../../shared/pagination';

/**
 * DS-1: the signing-request store and the two narrow reads the rail needs
 * from the party tables — who signs for a party, and the campaign an
 * insertion order enumerates. Read here rather than through the party
 * modules because `agreements` sits under all of them.
 */

/** One signer as the provider reports them. `role` is ours: the party first, ADX's countersign last. */
export type SignerState = {
  role: 'PARTY' | 'ADX';
  name: string;
  identifier: string;
  status: 'requested' | 'signed' | 'expired' | 'declined' | 'cancelled';
  signedAt: string | null;
};

export type SigningRow = SigningRequest & {
  template: { title: string; version: number };
};

export type NewSigningRequest = {
  kind: AgreementKind;
  templateId: string;
  templateVersion: number;
  partyType: SigningParty;
  partyId: string;
  signerUserId: string | null;
  signerName: string;
  signerIdentifier: string;
  signMethod: SignMethod;
  campaignId?: string | null;
  attemptId?: string | null;
  status: SigningStatus;
  providerRef: string | null;
  mock: boolean;
  signers: SignerState[];
  signingUrl: string | null;
  renderedDocument: string;
  documentFileId: string | null;
  stampState?: string | null;
  stampAmount?: string | null;
  stampRef?: string | null;
  countersign: boolean;
  followUp?: unknown;
  providerPayload?: unknown;
  requestedById: string | null;
  expiresAt: Date;
};

export type SigningPatch = Partial<{
  status: SigningStatus;
  signers: SignerState[];
  signingUrl: string | null;
  signedFileId: string | null;
  certificateFileId: string | null;
  stampRef: string | null;
  providerPayload: unknown;
  acceptanceId: string | null;
  lastReminderAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  failureReason: string | null;
}>;

export type SigningFilter = {
  kind?: AgreementKind | undefined;
  status?: SigningStatus | undefined;
  partyType?: SigningParty | undefined;
  partyId?: string | undefined;
  campaignId?: string | undefined;
  /** A name, display id, mobile or email fragment on the signer. */
  q?: string | undefined;
};

/** Who signs for a party: the person the link goes to, and what the document is filled with. */
export type PartySigner = {
  partyType: SigningParty;
  partyId: string;
  displayId: string | null;
  /** The party as named on the document — the shop, the company, the person. */
  partyName: string;
  /** The natural person who signs. */
  signerName: string;
  signerUserId: string | null;
  email: string | null;
  mobile: string | null;
  /** The party's state, for the stamp-duty table (ISO code where the row has one, else the name). */
  state: string | null;
  city: string | null;
  band: string | null;
  /** Kind-specific merge fields — the agent's grade and side, the employee's designation, the partner's GSTIN … */
  fields: Record<string, string>;
};

export interface EsignRepository {
  create(data: NewSigningRequest): Promise<SigningRow>;
  patch(id: string, patch: SigningPatch): Promise<SigningRow>;
  find(id: string): Promise<SigningRow | null>;
  findByProviderRef(providerRef: string): Promise<SigningRow | null>;
  /** The newest request for a party and kind (and anchor), whatever its status. */
  latestFor(partyType: SigningParty, partyId: string, kind: AgreementKind, anchor?: { campaignId?: string | null; attemptId?: string | null }): Promise<SigningRow | null>;
  list(filter: SigningFilter, page: PageQuery): Promise<Page<SigningRow>>;
  /** Every request a person may act on: the parties they belong to, newest first. */
  listForUser(userId: string): Promise<SigningRow[]>;
  /** Open requests past their expiry, for the sweep. */
  expiredOpen(now: Date, limit: number): Promise<SigningRow[]>;
  /** Who signs for the party — null when the party does not exist. */
  partySigner(partyType: SigningParty, partyId: string): Promise<PartySigner | null>;
  /** The user's parties, as (type, id) pairs, for `listForUser` and the caller check. */
  partiesOfUser(userId: string): Promise<{ partyType: SigningParty; partyId: string }[]>;
  /** The listings a publisher's licence schedules — title, city, reference. */
  publisherListings(publisherId: string): Promise<{ reference: string | null; title: string; city: string | null }[]>;
}

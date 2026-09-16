/**
 * Fraud signals — Lot G (Q118/138).
 *
 * A signal is one computed fact about a party, scored 0..1: 0 is "nothing
 * seen", 1 is "the pattern is fully present", and a fraction is how much of
 * it is. Each signal lives in its own file with a fixed `key` and `weight`;
 * the registry in `./index.ts` sums `weight × value` and caps at 1 — an
 * explainable score, never acted on alone (a case is opened, a human
 * decides; nothing here suspends).
 *
 * A signal reads through `FraudSignalIndex` — the read-only cross-party
 * index the repository fills — so a signal is a pure function of what the
 * index answers and can be tested with a hand-written index.
 */

import type { FraudSubjectType } from '../fraud.schema';

export type FraudSubject = { type: FraudSubjectType; id: string };

/** The party types a shared signal can link — a listing resolves to its publisher before evaluation. */
export type LinkedPartyType = 'PUBLISHER' | 'ADVERTISER' | 'AGENT';

export type LinkedParty = { type: LinkedPartyType; id: string; name: string | null };

export type SignalResult = {
  /** 0, 1, or a fraction; `null` when the signal cannot be computed here (a missing dependency, no data at all). */
  value: number | null;
  /** One line ops can read on the case. */
  detail: string;
  /** The other accounts this signal ties the subject to — what GET /cases/:id/linked folds. */
  links?: LinkedParty[];
  /**
   * G13-B: the parties this signal compared the subject against, matched or
   * not — the "Clean" nodes of the linked-accounts graph are the candidates
   * no signal linked. Only the signals with a bounded comparison set name
   * them (the photo comparison, the agent's onboarded publishers); a
   * handle lookup answers only its matches, which are the links already.
   */
  candidates?: LinkedParty[];
};

/**
 * What a stored signal row looks like on `FraudCase.signals` — the links
 * ride along so the case page can name them without a recompute, and
 * (G13-B) up to `CANDIDATES_PER_SIGNAL` candidates so `/linked` can draw
 * the parties the last scoring cleared.
 */
export type StoredSignal = { key: string; weight: number; value: number | null; detail: string; links?: LinkedParty[]; candidates?: LinkedParty[] };

/** One account another signal ties the subject to, and every signal that does so — what GET /cases/:id/linked answers. */
export type LinkedAccount = { party: LinkedParty; via: string[] };

export type SignalContext = {
  index: FraudSignalIndex;
  now: Date;
};

export interface FraudSignal {
  readonly key: string;
  /** The share of the score this signal can contribute when fully present. */
  readonly weight: number;
  evaluate(subject: ResolvedSubject, ctx: SignalContext): Promise<SignalResult>;
}

/** The party behind the subject, with the handles the shared signals compare. */
export type ResolvedSubject = {
  type: LinkedPartyType;
  id: string;
  /** The login behind the party; null for an agent-opened publisher who never signed in. */
  userId: string | null;
  name: string | null;
  mobile: string | null;
  /** The PAN on the party's KYC row, uppercased; null when none was recorded (or it was purged to its last four). */
  pan: string | null;
  kycStatus: string | null;
  /** For a PUBLISHER, the agent who brought them in; null otherwise. */
  agentId: string | null;
  /** LISTING subjects keep the listing they came from. */
  listingId: string | null;
};

export type PayoutHandle = {
  accountNumber: string | null;
  upiVpa: string | null;
  accountHolder: string | null;
  /** The penny-drop name match, when the rail stored one. */
  nameMatchPct: number | null;
};

export type ProofPhoto = {
  orderId: string;
  capturedAt: Date;
  latitude: number | null;
  longitude: number | null;
  listingLatitude: number | null;
  listingLongitude: number | null;
  slotStart: Date | null;
  slotEnd: Date | null;
};

export type OnboardedPublisher = { id: string; name?: string | null; kycStatus: string; createdAt: Date; bookings: number };

export type CreditEvent = { at: Date };
export type WithdrawalEvent = { requestedAt: Date };

export type ListingPhotoRef = { listingId: string; publisherId: string; publisherName?: string | null; url: string };

/**
 * The read-only index the signals evaluate over. One interface, one Prisma
 * repository behind it (`prisma-fraud-signals.repository.ts`), reading the
 * parties' tables the way `admin-overview` reads across the platform for
 * its tiles — never writing one.
 */
export interface FraudSignalIndex {
  /** The party behind a subject; null when it does not exist. A LISTING resolves to its publisher. */
  resolveSubject(subject: FraudSubject): Promise<ResolvedSubject | null>;
  /** Other parties whose KYC row carries this PAN. */
  partiesWithPan(pan: string, exclude: ResolvedSubject): Promise<LinkedParty[]>;
  /** The subject's payout methods (by their login). */
  payoutHandlesFor(userId: string): Promise<PayoutHandle[]>;
  /** Other parties whose payout method shares an account number or UPI id. */
  partiesWithPayoutHandle(handles: { accountNumbers: string[]; upiVpas: string[] }, exclude: ResolvedSubject): Promise<LinkedParty[]>;
  /** The /24 subnets the login signed in from since `since`. */
  signInSubnetsFor(userId: string, since: Date): Promise<string[]>;
  /** Other parties whose logins signed in from any of these subnets since `since`. */
  partiesOnSubnets(subnets: string[], since: Date, exclude: ResolvedSubject): Promise<LinkedParty[]>;
  /** Parties of a different type holding the same mobile number. */
  partiesWithMobile(mobile: string, exclude: ResolvedSubject): Promise<LinkedParty[]>;
  /** The device tokens registered to the login. */
  deviceTokensFor(userId: string): Promise<string[]>;
  /** Other parties whose logins registered any of these tokens. */
  partiesWithDeviceTokens(tokens: string[], exclude: ResolvedSubject): Promise<LinkedParty[]>;
  /** A publisher's listing photos and, for comparison, other publishers' — bounded. */
  listingPhotosFor(publisherId: string): Promise<ListingPhotoRef[]>;
  listingPhotosOfOthers(publisherId: string, limit: number): Promise<ListingPhotoRef[]>;
  /** Installation proofs on the publisher's orders since `since`, with the listing's coordinates and the slot window. */
  proofPhotosFor(publisherId: string, since: Date): Promise<ProofPhoto[]>;
  /** The publishers an agent onboarded, with their KYC outcome and booking count. */
  onboardedPublishersOf(agentId: string): Promise<OnboardedPublisher[]>;
  /** Bookings, refunds and disputes for the party since `since`. */
  bookingOutcomesFor(subject: ResolvedSubject, since: Date): Promise<{ bookings: number; refunds: number; disputes: number }>;
  /** Wallet credits and withdrawal requests for the party since `since`. */
  walletMovementsFor(subject: ResolvedSubject, since: Date): Promise<{ credits: CreditEvent[]; withdrawals: WithdrawalEvent[] }>;
  /** When the publisher's listings were created, since `since`, ascending. */
  listingCreatedAtFor(publisherId: string, since: Date): Promise<Date[]>;
}

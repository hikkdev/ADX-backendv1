import { allocateIdentifier } from './identifiers.service';
import { prismaIdentifiersRepository as repository } from './prisma-identifiers.repository';
import type { IdentifiedParty } from './identifiers.repository';

/**
 * One series' pair of repository doors: the rows still without an
 * identifier (oldest first), and how to give one its identifier. Lambdas
 * rather than method references so the repository is read at call time.
 */
type Series = {
  missing: (limit: number) => Promise<{ id: string; createdAt: Date }[]>;
  assign: (id: string, displayId: string) => Promise<void>;
};

const SERIES: Record<IdentifiedParty | 'ORDER', Series> = {
  PUBLISHER: { missing: (n) => repository.publishersMissingIdentifier(n), assign: (id, displayId) => repository.setPublisherIdentifier(id, displayId) },
  ADVERTISER: { missing: (n) => repository.advertisersMissingIdentifier(n), assign: (id, displayId) => repository.setAdvertiserIdentifier(id, displayId) },
  // PRT-… — the print partner's series is PARTNER.
  PARTNER: { missing: (n) => repository.printPartnersMissingIdentifier(n), assign: (id, displayId) => repository.setPrintPartnerIdentifier(id, displayId) },
  AGENT: { missing: (n) => repository.agentsMissingIdentifier(n), assign: (id, displayId) => repository.setAgentIdentifier(id, displayId) },
  USER: { missing: (n) => repository.usersMissingIdentifier(n), assign: (id, displayId) => repository.setUserIdentifier(id, displayId) },
  ORDER: { missing: (n) => repository.ordersMissingIdentifier(n), assign: (id, displayId) => repository.setOrderIdentifier(id, displayId) },
};

/**
 * Issues identifiers to up to `limit` rows of a series that lack one, oldest
 * first, each against the row's own `createdAt` — never today's date, or
 * every backfilled id would name the wrong day. Sequential on purpose: the
 * allocator is atomic, but ordering only comes out right if the oldest row
 * asks for its number first. Returns how many were issued.
 */
async function assignBatch(party: IdentifiedParty | 'ORDER', limit: number): Promise<number> {
  const series = SERIES[party];
  const pending = await series.missing(limit);
  for (const row of pending) {
    const displayId = await allocateIdentifier(party, row.createdAt);
    await series.assign(row.id, displayId);
  }
  return pending.length;
}

/**
 * Gives existing publishers the identifier they would have received.
 *
 * Processed oldest first and issued against each publisher's own `createdAt`,
 * not today, so PUB-1909-2601 genuinely means "joined 19 September 2026, first
 * that day" for rows that predate the feature. Issuing them all against today's
 * date would be quicker and would make every identifier a lie.
 *
 * Safe to run repeatedly — it only ever selects rows still missing one.
 */
export async function backfillPublisherIdentifiers(batchSize = 500): Promise<{
  assigned: number;
  remaining: number;
}> {
  const assigned = await assignBatch('PUBLISHER', batchSize);
  const remaining = (await repository.publishersMissingIdentifier(1)).length;
  return { assigned, remaining };
}

/**
 * QR-4: the same for people. Every account minted before the USER series
 * existed gets ADX-… against its own `createdAt`, oldest first, so the id
 * says when the person actually joined. Safe to run repeatedly.
 */
export async function backfillUserIdentifiers(batchSize = 500): Promise<{ assigned: number; remaining: number }> {
  const assigned = await assignBatch('USER', batchSize);
  const remaining = (await repository.usersMissingIdentifier(1)).length;
  return { assigned, remaining };
}

/**
 * BK-1: the same for bookings. Every order placed before the ORDER series
 * existed gets BKG-… against its own `createdAt`, oldest first. Safe to run
 * repeatedly.
 */
export async function backfillOrderIdentifiers(batchSize = 500): Promise<{ assigned: number; remaining: number }> {
  const assigned = await assignBatch('ORDER', batchSize);
  const remaining = (await repository.ordersMissingIdentifier(1)).length;
  return { assigned, remaining };
}

/** The party series `backfillPartyIdentifiers` fills, in the order a report lists them. */
export const IDENTIFIED_PARTIES: readonly IdentifiedParty[] = ['PUBLISHER', 'ADVERTISER', 'PARTNER', 'AGENT', 'USER'];

export type PartyBackfillReport = {
  party: IdentifiedParty;
  /** Rows without an identifier when the run began. */
  missing: number;
  /** The `createdAt` span of those rows — the days their identifiers will name. */
  oldest: Date | null;
  newest: Date | null;
  /** Identifiers issued by this run; always 0 under `check`. */
  assigned: number;
  /** Rows still without one afterwards; under `check`, the same as `missing`. */
  remaining: number;
};

/**
 * The console showed "No identifier yet" on party rows made before (or
 * around) their series: this gives every publisher, advertiser, print
 * partner, agent or person without a display id the one it would have
 * received — oldest first, dated to the row's own `createdAt`.
 *
 * `check` counts and issues nothing: `allocateIdentifier` consumes a counter
 * the moment it is called, so a dry run must never reach it.
 *
 * A write run works through the rows missing one when it began, a batch at
 * a time, and stops there — at most that many are issued, so a write that
 * did not land cannot loop. Idempotent: a second run finds nothing to do.
 */
export async function backfillPartyIdentifiers(
  party: IdentifiedParty,
  options: { check?: boolean; batchSize?: number } = {},
): Promise<PartyBackfillReport> {
  const { check = false, batchSize = 500 } = options;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError(`batchSize must be a positive integer, not ${batchSize}`);

  const before = await repository.missingIdentifierSummary(party);
  const span = { party, missing: before.count, oldest: before.oldest, newest: before.newest };
  if (check) return { ...span, assigned: 0, remaining: before.count };

  let assigned = 0;
  while (assigned < before.count) {
    const issued = await assignBatch(party, Math.min(batchSize, before.count - assigned));
    if (issued === 0) break;
    assigned += issued;
  }
  const after = await repository.missingIdentifierSummary(party);
  return { ...span, assigned, remaining: after.count };
}

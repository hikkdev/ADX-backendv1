import { ApiError } from '../../shared/errors';
import type { IdentifierFormat, PartyType } from '../../shared/database';
import { prismaIdentifiersRepository as repository } from './prisma-identifiers.repository';

/**
 * Human-readable party identifiers.
 *
 * PUB-1909-2601 reads as: a publisher, joined 19 September, in 2026, first that
 * day. The shape is configurable per party; the guarantees are not.
 *
 * Three rules hold regardless of configuration:
 *
 * 1. An identifier is issued once and stored. It is never derived on read,
 *    because it ends up on agreements, invoices and support tickets, and a
 *    format change years later must not silently rewrite what is printed on
 *    those.
 * 2. The daily sequence is allocated by an atomic increment, so two signups in
 *    the same millisecond cannot both take 01.
 * 3. Padding is cosmetic. A day busier than the padding allows simply grows
 *    past it — PUB-1909-26100 — rather than wrapping and colliding.
 */

export const DEFAULT_PATTERN = '{PREFIX}-{DD}{MM}-{YY}{SEQ}';

/** Defaults seeded for a party that has never been configured. */
const DEFAULT_PREFIXES: Record<PartyType, string> = {
  PUBLISHER: 'PUB',
  ADVERTISER: 'ADV',
  PARTNER: 'PRT',
  EMPLOYEE: 'EMP',
  AGENT: 'AGT',
  // The two support series. DR 07 prints TKT-#### on a ticket and FB-#### on
  // a piece of feedback; both come off this counter so the number is issued
  // once and never derived.
  TICKET: 'TKT',
  FEEDBACK: 'FB',
  /// DSP-#### is drawn on every dispute card.
  DISPUTE: 'DSP',
  /// SFT-#### on a safety report, so ops can call one out on the phone.
  SAFETY: 'SFT',
  /// LED-#### on a prospect. DR 06 does not print it on the card, but ops
  /// needs a way to name one lead out of a thousand on the phone.
  LEAD: 'LED',
  /// VST-#### on a field visit.
  VISIT: 'VST',
  /// ADX-CERT-… on the certificate card. The frame draws ADX-CERT-2214; the
  /// platform prints ADX-CERT-1109-2601 — the same day-and-sequence shape as
  /// every other number it issues, so a certificate is dated by its id.
  CERTIFICATE: 'ADX-CERT',
  /// FRD-#### on a fraud case (Lot E): fraud mints through this series like
  /// every other desk instead of its own per-year counter.
  FRAUD_CASE: 'FRD',
  /// Lot AA: the DR 10 work series — TSK-#### on a task, ISS-#### on an
  /// issue, PRJ-#### on a project, so people can name one on a call.
  TASK: 'TSK',
  ISSUE: 'ISS',
  PROJECT: 'PRJ',
};

/* ------------------------------------------------------------------ */
/* Date handling                                                       */
/* ------------------------------------------------------------------ */

/**
 * Calendar parts in the format's own zone.
 *
 * Which day a signup falls on is a business question, not a UTC one: someone
 * joining at 00:30 IST joined *today* in Bengaluru and yesterday in UTC, and
 * the identifier has to agree with the person reading it.
 */
export function calendarParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');

  return { year, month, day, dateKey: `${year}-${month}-${day}` };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/**
 * Fills a pattern. Unknown text passes through untouched, so a format can carry
 * literal separators or a region marker without needing a token for it.
 */
export function renderIdentifier(
  format: Pick<IdentifierFormat, 'prefix' | 'pattern' | 'seqPadding'>,
  at: Date,
  sequence: number,
  timeZone: string,
): string {
  const { year, month, day } = calendarParts(at, timeZone);
  const tokens: Record<string, string> = {
    '{PREFIX}': format.prefix,
    '{DD}': day,
    '{MM}': month,
    '{YY}': year.slice(-2),
    '{YYYY}': year,
    '{SEQ}': String(sequence).padStart(Math.max(1, format.seqPadding), '0'),
  };

  return Object.entries(tokens).reduce(
    (out, [token, value]) => out.split(token).join(value),
    format.pattern,
  );
}

/** Renders what the next identifier would look like, without consuming one. */
export function previewIdentifier(
  format: Pick<IdentifierFormat, 'prefix' | 'pattern' | 'seqPadding' | 'timeZone'>,
  at = new Date(),
  sequence = 1,
): string {
  return renderIdentifier(format, at, sequence, format.timeZone);
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export async function getFormat(party: PartyType): Promise<IdentifierFormat> {
  const existing = await repository.findFormat(party);
  if (existing) return existing;

  // A party that has never been configured still needs to issue identifiers, so
  // the default is materialised on first use rather than left implicit.
  return repository.createFormat({
    party,
    prefix: DEFAULT_PREFIXES[party],
    pattern: DEFAULT_PATTERN,
    seqPadding: 2,
    timeZone: 'Asia/Kolkata',
    isActive: true,
  });
}

export function listFormats() {
  return repository.listFormats();
}

const TOKEN = /\{(PREFIX|DD|MM|YY|YYYY|SEQ)\}/g;

export async function updateFormat(
  party: PartyType,
  patch: { prefix?: string; pattern?: string; seqPadding?: number; timeZone?: string },
) {
  if (patch.pattern !== undefined) {
    // Without a sequence the pattern cannot distinguish two parties joining on
    // the same day, which is the one thing an identifier has to do.
    if (!patch.pattern.includes('{SEQ}')) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'The pattern must include {SEQ}, or two parties joining on the same day would share an identifier',
      );
    }
    const unknown = patch.pattern.replace(TOKEN, '').match(/\{[^}]*\}/g);
    if (unknown) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Unknown token ${unknown[0]}. Available: {PREFIX} {DD} {MM} {YY} {YYYY} {SEQ}`,
      );
    }
  }

  if (patch.timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: patch.timeZone });
    } catch {
      throw new ApiError(400, 'BAD_REQUEST', `${patch.timeZone} is not a known time zone`);
    }
  }

  await getFormat(party); // materialise the default before patching it
  return repository.updateFormat(party, patch);
}

/* ------------------------------------------------------------------ */
/* Allocation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Issues the next identifier for a party.
 *
 * `at` defaults to now but is accepted so a backfill can issue the identifier a
 * party would have received on the day they actually joined.
 */
export async function allocateIdentifier(party: PartyType, at = new Date()): Promise<string> {
  const format = await getFormat(party);
  const { dateKey } = calendarParts(at, format.timeZone);
  const sequence = await repository.nextSequence(party, dateKey);
  return renderIdentifier(format, at, sequence, format.timeZone);
}

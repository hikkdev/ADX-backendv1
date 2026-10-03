import { normalizeMobile } from '../../shared/validation';

/**
 * The mobile backfill's decisions (`npm run backfill:mobiles`), kept apart
 * from the database so they can be pinned with plain rows.
 *
 * The OTP door canonicalises every number to `+91` and ten digits before it
 * looks anybody up, and every party door since QR-13 stores that form. A row
 * written before then (or by a path that skipped the rule) holds the number
 * as typed — `9507842149` — and an exact-match lookup for `+919507842149`
 * walks straight past it. Each such row is decided one of four ways:
 *
 * - `unchanged`   — already `+91` and ten digits.
 * - `fix`         — `normalizeMobile` gives the canonical form; write it.
 * - `clash`       — on a table whose mobile is unique, the canonical form is
 *                   already held by another row (or another row of this run
 *                   would take it too). Left alone: which account is the
 *                   person's is for a person to settle, never a script.
 * - `unparseable` — `normalizeMobile` cannot make it canonical (too short,
 *                   a foreign number, …). Reported, left alone.
 */

/** `+91` and ten digits — the one form a stored mobile should have. */
export const CANONICAL_MOBILE = /^\+91\d{10}$/;

export type MobileRow = { id: string; mobile: string };

/** The canonical form of a stored number, or null when `normalizeMobile` cannot make one. */
export function canonicalForm(mobile: string): string | null {
  const to = normalizeMobile(mobile);
  return CANONICAL_MOBILE.test(to) ? to : null;
}

export type MobileDecision<R extends MobileRow = MobileRow> =
  | { kind: 'unchanged'; row: R }
  | { kind: 'fix'; row: R; to: string }
  /** `heldBy`: the ids already holding `to`, or that would take it in the same run. */
  | { kind: 'clash'; row: R; to: string; heldBy: string[] }
  | { kind: 'unparseable'; row: R };

export type MobileCounts = Record<MobileDecision['kind'], number>;

export type MobilePlan<R extends MobileRow = MobileRow> = { decisions: MobileDecision<R>[]; counts: MobileCounts };

/**
 * Decides every row of one table.
 *
 * `existing` is whatever else of that table (and, for people, the contact
 * rows) already holds one of the canonical numbers the rows would move to —
 * the rows themselves count too, so passing the whole table is also fine.
 * Only consulted when `unique`: a table whose mobile is not unique takes a
 * shared number as it stands.
 */
export function planMobileFixes<R extends MobileRow>(
  rows: readonly R[],
  options: { unique: boolean; existing?: Iterable<MobileRow> },
): MobilePlan<R> {
  const holders = new Map<string, Set<string>>();
  const hold = (value: string, id: string) => {
    const ids = holders.get(value) ?? new Set<string>();
    ids.add(id);
    holders.set(value, ids);
  };
  for (const holder of options.existing ?? []) hold(holder.mobile, holder.id);
  for (const row of rows) hold(row.mobile, row.id);

  // What each row would move to, when it can move at all.
  const targets = new Map<string, string>();
  const takers = new Map<string, Set<string>>();
  for (const row of rows) {
    if (CANONICAL_MOBILE.test(row.mobile)) continue;
    const to = canonicalForm(row.mobile);
    if (to === null) continue;
    targets.set(row.id, to);
    const ids = takers.get(to) ?? new Set<string>();
    ids.add(row.id);
    takers.set(to, ids);
  }

  const decisions = rows.map((row): MobileDecision<R> => {
    if (CANONICAL_MOBILE.test(row.mobile)) return { kind: 'unchanged', row };
    const to = targets.get(row.id);
    if (to === undefined) return { kind: 'unparseable', row };
    if (options.unique) {
      const heldBy = [...new Set([...(holders.get(to) ?? []), ...(takers.get(to) ?? [])])].filter((id) => id !== row.id);
      if (heldBy.length > 0) return { kind: 'clash', row, to, heldBy };
    }
    return { kind: 'fix', row, to };
  });

  const counts: MobileCounts = { unchanged: 0, fix: 0, clash: 0, unparseable: 0 };
  for (const decision of decisions) counts[decision.kind] += 1;
  return { decisions, counts };
}

/**
 * How a report names a party: its name and its display id — never its
 * number. A party opened before it was named is known by its number (the
 * publisher door falls back to it), so a name that is, or carries, a phone
 * number has the number taken out.
 */
export function partyLabel(name: string | null | undefined, displayId: string | null | undefined): string {
  const trimmed = name?.trim() ?? '';
  const redacted = trimmed.replace(/\+?\d(?:[\s().-]*\d){6,}/g, '[number]').trim();
  const shown = trimmed === '' ? '(no name)' : redacted === '[number]' ? '(named by its number)' : redacted;
  return `${shown} (${displayId ?? 'no display id'})`;
}

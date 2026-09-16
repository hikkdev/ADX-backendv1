/**
 * The two dedup keys — Lot D (Q56/Q93).
 *
 * The phone is the hard key. A number is normalised to E.164 with +91 as the
 * default country — the platform is India-only, and the same rule
 * `auth.normalizeMobile` applies to a login — and stored on
 * `Lead.phoneNormalised`, which carries a partial unique index. Two leads on
 * one number cannot exist; a number already on a Publisher or Advertiser
 * account is an account, not a prospect.
 *
 * Business name + city is the soft key: folded to lower case with the spaces
 * removed, so "Suraj Kumar Prints, Bengaluru" and "surajkumar prints /
 * BENGALURU" read the same. A match is a warning on the row, never a refusal —
 * two cafés can share a name in one city.
 */

/** E.164, or null when the input is not a phone number at all. */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const explicit = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (explicit) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const bare = digits.replace(/^0+/, '');
  if (bare.length === 10) return `+91${bare}`;
  if (bare.length === 12 && bare.startsWith('91')) return `+${bare}`;
  return null;
}

/** `surajkumarprints|bengaluru` — lower-cased, whitespace removed, joined with the city (empty when unknown). */
export function foldNameCity(businessName: string, city: string | null | undefined): string {
  const fold = (value: string | null | undefined) => (value ?? '').toLowerCase().replace(/\s+/g, '');
  return `${fold(businessName)}|${fold(city)}`;
}

/**
 * QR-13: one rule for what a mobile number looks like once it is ours —
 * `+91XXXXXXXXXX`, whatever the caller typed. The OTP door has always
 * canonicalised this way at sign-in; the desk (Settings › Publishers ›
 * Add, the bulk import) now opens the account with the same number, so a
 * publisher onboarded at the desk and the person who later signs in with
 * that number are one row, not two.
 */
export function normalizeMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return mobile; // Already normalized or unknown format.
}

/**
 * 29 Sep 2026 (the party rosters, made uniform): what a roster search box
 * matches a phone on. The console prints every number as `+91 98765 43210`,
 * so somebody pasting what they read — spaces, the `+91`, a dash — must
 * still find the row, whether it is stored as `+919876543210` or (a row
 * older than the normaliser) as the bare ten digits. The digits typed, with
 * a leading `91` dropped once there are twelve of them, are a substring of
 * both. Null when the text is not a phone at all (a name, an email, an id),
 * or too short to mean anything — the plain `contains` still runs beside it.
 */
export function mobileSearchNeedle(q: string): string | null {
  const text = q.trim();
  if (!/^[+\d\s().-]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  if (digits.length < 3) return null;
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
}

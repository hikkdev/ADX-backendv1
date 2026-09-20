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

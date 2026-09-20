/**
 * QR-3 (17 Sep 2026) — how far along a publisher is, and what the number
 * lets them do.
 *
 * The owner's rule, in three lines: a publisher who signs up on their own
 * has an account at once; they may not START listing a spot until ADX has
 * their basics — a name, an email, an address and (QR-5) a date of birth;
 * and with the basics in they list and go live UNVERIFIED — marked so, and
 * ranked below the verified when an advertiser browses — until their
 * identity check moves them up. The home shows one figure and one checklist
 * for all of that, and the listing door and the publish gate refuse on the
 * same rule, so the app never promises what the API will not do.
 *
 * (QR-3, a day earlier, had the publish gate wait for the check. QR-5 is
 * the owner's rule since 17 Sep 2026: "they should be able to continue
 * using their account unverified and be allowed to list after name,
 * address, dob and other details have been collected".)
 *
 * Lives beside the KYC state because it is the same question asked one
 * step earlier — "is this party ready" — and because `listings` (the door)
 * and `publishers` (the home) both need it and neither may import the
 * other.
 *
 * The name is the one basic with a trap: a self-registered publisher is
 * created with their mobile number AS their name until the profile step
 * supplies one (`registerProfile`), so a name that equals the number is not
 * a name.
 */

export const PROFILE_BASICS = ['name', 'email', 'address', 'dateOfBirth'] as const;
export type ProfileBasic = (typeof PROFILE_BASICS)[number];

export type ProfileBasicsRow = {
  name: string | null;
  mobile: string;
  email: string | null;
  address: string | null;
  /** QR-5: the person's, off the User row the publisher hangs on. */
  dateOfBirth?: Date | string | null;
};

const present = (value: string | null | undefined): boolean => typeof value === 'string' && value.trim().length > 0;

/** Which of the basics are still missing, in the order the ladder asks for them. */
export function profileBasicsMissing(row: ProfileBasicsRow): ProfileBasic[] {
  const missing: ProfileBasic[] = [];
  if (!present(row.name) || row.name!.trim() === row.mobile.trim()) missing.push('name');
  if (!present(row.email)) missing.push('email');
  if (!present(row.address)) missing.push('address');
  if (row.dateOfBirth === null || row.dateOfBirth === undefined || row.dateOfBirth === '') missing.push('dateOfBirth');
  return missing;
}

/** The spoken form the refusal and the checklist use. */
export const PROFILE_BASIC_LABEL: Record<ProfileBasic, string> = {
  name: 'your name',
  email: 'an email address',
  address: 'your address',
  dateOfBirth: 'your date of birth',
};

export type PublisherReadiness = {
  profile: { complete: boolean; missing: ProfileBasic[]; percent: number };
  kyc: { verified: boolean; status: string };
  terms: { accepted: boolean };
  /** 0–100: the basics are seventy of it, the identity check thirty; the terms weigh nothing since QR-6. */
  percent: number;
  /** May start a listing: the basics are in. */
  canList: boolean;
  /**
   * A listing of theirs may go live. QR-5 (the owner, 17 Sep 2026): the
   * basics are enough — an unverified publisher lists and goes live, marked
   * unverified and ranked below the verified when an advertiser browses. The
   * identity check moves them up; it no longer holds them back.
   */
  canGoLive: boolean;
};

/**
 * QR-6 (the owner, 17 Sep 2026): the platform terms leave the figure. The
 * terms of use are agreed before any detail is asked (the consent stamp on
 * the User row) and the commercial agreement is presented when a listing
 * is submitted — neither is a setup step. `terms` stays on the view for
 * the desk and older clients; it weighs nothing.
 */
export const READINESS_WEIGHTS = { profile: 70, kyc: 30, terms: 0 } as const;

export function publisherReadiness(row: ProfileBasicsRow & { kycStatus: string; activatedAt: Date | string | null }): PublisherReadiness {
  const missing = profileBasicsMissing(row);
  const basicsIn = PROFILE_BASICS.length - missing.length;
  const profilePercent = Math.round((basicsIn / PROFILE_BASICS.length) * 100);
  const verified = row.kycStatus === 'VERIFIED';
  const accepted = row.activatedAt !== null && row.activatedAt !== undefined;
  const percent = Math.round(
    (basicsIn / PROFILE_BASICS.length) * READINESS_WEIGHTS.profile +
      (verified ? READINESS_WEIGHTS.kyc : 0) +
      (accepted ? READINESS_WEIGHTS.terms : 0),
  );
  return {
    profile: { complete: missing.length === 0, missing, percent: profilePercent },
    kyc: { verified, status: row.kycStatus },
    terms: { accepted },
    percent,
    canList: missing.length === 0,
    canGoLive: missing.length === 0,
  };
}

/** The one sentence the listing door answers with. */
export function profileIncompleteMessage(missing: ProfileBasic[]): string {
  const words = missing.map((key) => PROFILE_BASIC_LABEL[key]);
  const list = words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `Add ${list} to your profile before listing a spot. Spots you add are reviewed by ADX; verified profiles and their spots are shown first to advertisers.`;
}

/** The verified mark every external party earns the same way. */
export const isVerifiedParty = (kycStatus: string | null | undefined): boolean => kycStatus === 'VERIFIED';

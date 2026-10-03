import { describe, expect, it } from 'vitest';
import { isVerifiedParty, profileBasicsMissing, profileIncompleteMessage, publisherReadiness } from '../readiness';

/**
 * QR-3 — the readiness rule the home draws and the listing door enforces.
 *
 * Pinned: a name that is the mobile number is no name (that is how a
 * self-registered row starts); the three basics — name, email, address
 * (AGE-1, 29 Sep 2026: the date of birth QR-5 added left them; listing a
 * space asks no age) — are the whole of "may start a listing" AND of "may go live" — the
 * identity check ranks, it no longer gates; the figure is basics 70 /
 * identity check 30 (QR-6 took the terms out of it — they are agreed before
 * any detail is asked, and the commercial agreement is presented at submit)
 * so a publisher with the basics reads 70 and one verified reads 100; the
 * refusal names exactly what is missing, in the ladder's order, and says
 * what the check is now for.
 */

const row = (over: Partial<Parameters<typeof publisherReadiness>[0]> = {}) => ({
  name: 'Asha Rao',
  mobile: '+919876543210',
  email: 'asha@example.com',
  address: '12 MG Road, Bengaluru',
  dateOfBirth: new Date('1990-04-12T00:00:00Z'),
  kycStatus: 'PENDING',
  activatedAt: null,
  ...over,
});

describe('profileBasicsMissing', () => {
  it('a name that is the mobile number is no name', () => {
    expect(profileBasicsMissing(row({ name: '+919876543210' }))).toEqual(['name']);
    expect(profileBasicsMissing(row({ name: ' +919876543210 ' }))).toEqual(['name']);
    expect(profileBasicsMissing(row({ name: '' }))).toEqual(['name']);
    expect(profileBasicsMissing(row({ name: null }))).toEqual(['name']);
  });

  it('lists what is missing in the order the ladder asks', () => {
    expect(profileBasicsMissing(row({ name: '+919876543210', email: null, address: '  ', dateOfBirth: null }))).toEqual(['name', 'email', 'address']);
    expect(profileBasicsMissing(row({ email: null }))).toEqual(['email']);
    expect(profileBasicsMissing(row())).toEqual([]);
  });

  it('AGE-1: the date of birth is not a basic — with or without it, nothing is missing', () => {
    expect(profileBasicsMissing(row({ dateOfBirth: null }))).toEqual([]);
    expect(profileBasicsMissing(row({ dateOfBirth: '' }))).toEqual([]);
    expect(profileBasicsMissing(row({ dateOfBirth: '1990-04-12' }))).toEqual([]);
    /* A child's date is no bar either. */
    expect(profileBasicsMissing(row({ dateOfBirth: '2012-06-01' }))).toEqual([]);
    const { dateOfBirth: _d, ...without } = row();
    expect(profileBasicsMissing(without)).toEqual([]);
  });
});

describe('publisherReadiness', () => {
  it('a fresh self-registered row is 0 and may neither list nor go live', () => {
    const r = publisherReadiness(row({ name: '+919876543210', email: null, address: null, dateOfBirth: null }));
    expect(r).toMatchObject({
      profile: { complete: false, missing: ['name', 'email', 'address'], percent: 0 },
      kyc: { verified: false, status: 'PENDING' },
      terms: { accepted: false },
      percent: 0,
      canList: false,
      canGoLive: false,
    });
  });

  it('the basics alone are 70 and open both the listing door and the publish gate (QR-5)', () => {
    const r = publisherReadiness(row());
    expect(r.profile).toEqual({ complete: true, missing: [], percent: 100 });
    expect(r.percent).toBe(70);
    expect(r.canList).toBe(true);
    expect(r.canGoLive).toBe(true);
  });

  it('two of three basics are a third short: 47 of the 70, and neither door opens', () => {
    const r = publisherReadiness(row({ address: null }));
    expect(r.profile.percent).toBe(67);
    expect(r.percent).toBe(47);
    expect(r.canList).toBe(false);
    expect(r.canGoLive).toBe(false);
  });

  it('verified adds thirty and completes it; the terms weigh nothing (QR-6) and neither is needed to go live', () => {
    expect(publisherReadiness(row({ kycStatus: 'VERIFIED' })).percent).toBe(100);
    expect(publisherReadiness(row({ activatedAt: new Date('2026-09-17T00:00:00Z') })).percent).toBe(70);
    const done = publisherReadiness(row({ kycStatus: 'VERIFIED', activatedAt: '2026-09-17T00:00:00.000Z' }));
    expect(done.percent).toBe(100);
    expect(done.terms.accepted).toBe(true);
    expect(done.canGoLive).toBe(true);
    expect(publisherReadiness(row({ kycStatus: 'VERIFIED', address: null })).canGoLive).toBe(false);
    /* AGE-1: no date of birth holds nothing back. */
    expect(publisherReadiness(row({ dateOfBirth: null })).canGoLive).toBe(true);
  });

  it('NEEDS_INFO and REJECTED are not verified', () => {
    expect(publisherReadiness(row({ kycStatus: 'NEEDS_INFO' })).kyc.verified).toBe(false);
    expect(publisherReadiness(row({ kycStatus: 'REJECTED' })).kyc.verified).toBe(false);
  });
});

describe('profileIncompleteMessage', () => {
  it('names what is missing and says what the identity check is now for', () => {
    expect(profileIncompleteMessage(['email'])).toBe(
      'Add an email address to your profile before listing a spot. Spots you add are reviewed by ADX; verified profiles and their spots are shown first to advertisers.',
    );
    expect(profileIncompleteMessage(['name', 'email', 'address'])).toContain(
      'Add your name, an email address and your address to your profile',
    );
    expect(profileIncompleteMessage(['name', 'address'])).toContain('Add your name and your address');
  });
});

describe('isVerifiedParty', () => {
  it('is VERIFIED and nothing else', () => {
    expect(isVerifiedParty('VERIFIED')).toBe(true);
    for (const other of ['PENDING', 'NEEDS_INFO', 'REJECTED', null, undefined]) expect(isVerifiedParty(other)).toBe(false);
  });
});

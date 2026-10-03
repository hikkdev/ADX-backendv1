import { describe, expect, it } from 'vitest';
import { KYC_QUEUE_STATES, deriveKycState, kycPartyStateWhere, kycRosterStateWhere } from '..';

/**
 * 29 Sep 2026 — the party rosters' KYC cut. A roster lists every party, so
 * its six cuts must partition the roster exactly as the pills read: a legacy
 * row with no record and a VERIFIED mirror reads VERIFIED
 * (`deriveKycState`), and the roster's VERIFIED cut takes it in. The queue's
 * fragment leaves it out, because the queue never lists that row.
 */
describe('kycRosterStateWhere', () => {
  it('adds the legacy verified row to VERIFIED on a party with a mirror', () => {
    expect(deriveKycState(null, 'VERIFIED')).toBe('VERIFIED');
    expect(kycRosterStateWhere('VERIFIED', true)).toEqual({ OR: [kycPartyStateWhere('VERIFIED', true), { kyc: null, kycStatus: 'VERIFIED' }] });
  });

  it('is the queue fragment for every other state, and for a party with no mirror', () => {
    for (const state of KYC_QUEUE_STATES.filter((value) => value !== 'VERIFIED')) {
      expect(kycRosterStateWhere(state, true)).toEqual(kycPartyStateWhere(state, true));
    }
    for (const state of KYC_QUEUE_STATES) expect(kycRosterStateWhere(state, false)).toEqual(kycPartyStateWhere(state, false));
  });
});

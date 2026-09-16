import { describe, expect, it } from 'vitest';
import {
  KYC_QUEUE_STATES,
  deriveKycState,
  kycPartyStateWhere,
  kycQueueBaseWhere,
  kycQueueStateSchema,
  kycRecordStateWhere,
  kycStateCounts,
  kycStatusAliasSchema,
  kycSummaryOf,
} from '..';

/**
 * N3-B — the one derivation the five queues and the five party reads share.
 * A party is in exactly one of six states; the record decides, and with no
 * record the party's mirror decides between VERIFIED and AWAITING_DOCUMENTS.
 */

const NOW = new Date('2026-09-14T22:00:00.000Z');
const record = (over: Partial<Parameters<typeof deriveKycState>[0] & object> = {}) => ({ id: 'kyc_1', status: 'PENDING', submittedAt: null, requestedAt: null, requestedChannel: null, method: 'MANUAL', ...over });

describe('deriveKycState', () => {
  it('a party with no record is AWAITING_DOCUMENTS — the moment the account exists', () => {
    expect(deriveKycState(null)).toBe('AWAITING_DOCUMENTS');
    expect(deriveKycState(undefined, 'PENDING')).toBe('AWAITING_DOCUMENTS');
    expect(deriveKycState(null, 'REJECTED')).toBe('AWAITING_DOCUMENTS');
  });

  it('a party with no record whose mirror says VERIFIED reads VERIFIED (a legacy row)', () => {
    expect(deriveKycState(null, 'VERIFIED')).toBe('VERIFIED');
  });

  it('a PENDING record with nothing submitted and no request is still AWAITING_DOCUMENTS', () => {
    expect(deriveKycState(record())).toBe('AWAITING_DOCUMENTS');
  });

  it('the desk’s ask with nothing back is REQUESTED; a submission is PENDING whatever was requested', () => {
    expect(deriveKycState(record({ requestedAt: NOW }))).toBe('REQUESTED');
    expect(deriveKycState(record({ requestedAt: NOW, submittedAt: NOW }))).toBe('PENDING');
    expect(deriveKycState(record({ submittedAt: NOW }))).toBe('PENDING');
  });

  it('a decided record is its decision, whatever the mirror says', () => {
    expect(deriveKycState(record({ status: 'VERIFIED', submittedAt: NOW }), 'PENDING')).toBe('VERIFIED');
    expect(deriveKycState(record({ status: 'REJECTED', submittedAt: NOW }))).toBe('REJECTED');
    expect(deriveKycState(record({ status: 'NEEDS_INFO', submittedAt: NOW }))).toBe('NEEDS_INFO');
  });
});

describe('kycSummaryOf — what every party read carries as `kyc`', () => {
  it('is the six facts, nulls with no record', () => {
    expect(kycSummaryOf(null)).toEqual({ state: 'AWAITING_DOCUMENTS', kycId: null, submittedAt: null, requestedAt: null, requestedChannel: null, method: null });
    expect(kycSummaryOf(record({ requestedAt: NOW, requestedChannel: 'DIGIO', method: 'DIGIO' }))).toEqual({
      state: 'REQUESTED',
      kycId: 'kyc_1',
      submittedAt: null,
      requestedAt: NOW,
      requestedChannel: 'DIGIO',
      method: 'DIGIO',
    });
  });
});

describe('the where fragments', () => {
  it('the record half names the columns every KYC table has', () => {
    expect(kycRecordStateWhere('AWAITING_DOCUMENTS')).toEqual({ status: 'PENDING', submittedAt: null, requestedAt: null });
    expect(kycRecordStateWhere('REQUESTED')).toEqual({ status: 'PENDING', submittedAt: null, requestedAt: { not: null } });
    expect(kycRecordStateWhere('PENDING')).toEqual({ status: 'PENDING', submittedAt: { not: null } });
    expect(kycRecordStateWhere('NEEDS_INFO')).toEqual({ status: 'NEEDS_INFO' });
    expect(kycRecordStateWhere('REJECTED')).toEqual({ status: 'REJECTED' });
    expect(kycRecordStateWhere('VERIFIED')).toEqual({ status: 'VERIFIED' });
  });

  it('AWAITING_DOCUMENTS at the party level is "no record" or "an untouched record" — the mirror keeping a verified legacy row out', () => {
    expect(kycPartyStateWhere('AWAITING_DOCUMENTS', true)).toEqual({
      OR: [{ kyc: null, kycStatus: { not: 'VERIFIED' } }, { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: null } } }],
    });
    expect(kycPartyStateWhere('AWAITING_DOCUMENTS', false)).toEqual({
      OR: [{ kyc: null }, { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: null } } }],
    });
    expect(kycPartyStateWhere('PENDING', true)).toEqual({ kyc: { is: { status: 'PENDING', submittedAt: { not: null } } } });
  });

  it('the base of a queue is every party not yet verified plus every party with a record; everyone where there is no mirror', () => {
    expect(kycQueueBaseWhere(true)).toEqual({ OR: [{ kycStatus: { not: 'VERIFIED' } }, { kyc: { isNot: null } }] });
    expect(kycQueueBaseWhere(false)).toEqual({});
  });
});

describe('the facets and the counts', () => {
  it('`state` is one of the six, case-insensitive; `status` stays as the alias over the four record statuses', () => {
    expect(KYC_QUEUE_STATES).toEqual(['AWAITING_DOCUMENTS', 'REQUESTED', 'PENDING', 'NEEDS_INFO', 'REJECTED', 'VERIFIED']);
    expect(kycQueueStateSchema.parse('awaiting_documents')).toBe('AWAITING_DOCUMENTS');
    expect(kycQueueStateSchema.parse(undefined)).toBeUndefined();
    expect(kycQueueStateSchema.safeParse('MAYBE').success).toBe(false);
    expect(kycStatusAliasSchema.parse('needs_info')).toBe('NEEDS_INFO');
    expect(kycStatusAliasSchema.safeParse('REQUESTED').success).toBe(false);
  });

  it('fills every state with zero and mirrors AWAITING_DOCUMENTS as `awaitingDocuments`', () => {
    expect(kycStateCounts({ AWAITING_DOCUMENTS: 2, PENDING: 1 })).toEqual({
      AWAITING_DOCUMENTS: 2,
      REQUESTED: 0,
      PENDING: 1,
      NEEDS_INFO: 0,
      REJECTED: 0,
      VERIFIED: 0,
      awaitingDocuments: 2,
    });
  });
});

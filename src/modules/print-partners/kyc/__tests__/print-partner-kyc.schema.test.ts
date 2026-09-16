import { describe, expect, it } from 'vitest';
import {
  PRINT_PARTNER_KYC_DOCUMENT_FIELDS,
  printPartnerKycQueueQuerySchema,
  requestPrintPartnerKycSchema,
  reviewPrintPartnerKycSchema,
  submitPrintPartnerKycSchema,
} from '../print-partner-kyc.schema';

/** Lot N — the wire shapes of the print partner's KYC. */

describe('the submission body', () => {
  it('takes the ten document columns and the two facts, every one optional, but not nothing', () => {
    expect(PRINT_PARTNER_KYC_DOCUMENT_FIELDS).toEqual([
      'panFrontUrl',
      'panSignatureUrl',
      'gstUrl',
      'businessRegCertUrl',
      'businessAddressProofUrl',
      'directorIdUrl',
      'govIdFrontUrl',
      'govIdBackUrl',
      'bankProofUrl',
      'selfieUrl',
    ]);
    expect(submitPrintPartnerKycSchema.safeParse({ panNumber: 'abcde1234f', govIdType: 'aadhaar', gstUrl: 'https://adx.local/api/v1/files/f1' }).data).toEqual({
      panNumber: 'ABCDE1234F',
      govIdType: 'AADHAAR',
      gstUrl: 'https://adx.local/api/v1/files/f1',
    });
    expect(submitPrintPartnerKycSchema.safeParse({}).success).toBe(false);
    expect(submitPrintPartnerKycSchema.safeParse({ panNumber: 'nope' }).success).toBe(false);
    expect(submitPrintPartnerKycSchema.safeParse({ selfieUrl: 'not a url' }).success).toBe(false);
  });
});

describe('the decision', () => {
  it('a rejection must say why; the status is case-insensitive', () => {
    expect(reviewPrintPartnerKycSchema.safeParse({ status: 'rejected' }).success).toBe(false);
    expect(reviewPrintPartnerKycSchema.safeParse({ status: 'rejected', rejectionReason: 'PAN mismatch' }).data).toEqual({ status: 'REJECTED', rejectionReason: 'PAN mismatch' });
    expect(reviewPrintPartnerKycSchema.safeParse({ status: 'VERIFIED', reviewNote: 'ok' }).success).toBe(true);
    expect(reviewPrintPartnerKycSchema.safeParse({ status: 'PENDING' }).success).toBe(false);
  });
});

describe('the request', () => {
  it('names the channel, DIGIO or MANUAL, with an optional note; N3-B: DIGIO by default, so the one click needs no body', () => {
    expect(requestPrintPartnerKycSchema.safeParse({ channel: 'digio' }).data).toEqual({ channel: 'DIGIO' });
    expect(requestPrintPartnerKycSchema.safeParse({ channel: 'MANUAL', note: 'Bring the GST certificate' }).success).toBe(true);
    expect(requestPrintPartnerKycSchema.safeParse({ channel: 'EMAIL' }).success).toBe(false);
    expect(requestPrintPartnerKycSchema.safeParse({}).data).toEqual({ channel: 'DIGIO' });
  });
});

describe('the queue query', () => {
  it('answers the advertiser facets plus requested and q, with the list defaults', () => {
    expect(printPartnerKycQueueQuerySchema.safeParse({ status: 'needs_info', requested: 'true', escalated: 'false', assignedTo: 'me', q: 'Sharma', sort: 'newest', page: '2', pageSize: '10' }).data).toEqual({
      status: 'NEEDS_INFO',
      requested: true,
      escalated: false,
      assignedTo: 'me',
      q: 'Sharma',
      sort: 'newest',
      page: 2,
      pageSize: 10,
    });
    expect(printPartnerKycQueueQuerySchema.safeParse({}).data).toMatchObject({ page: 1 });
    expect(printPartnerKycQueueQuerySchema.safeParse({ status: 'STUCK' }).success).toBe(false);
  });
});

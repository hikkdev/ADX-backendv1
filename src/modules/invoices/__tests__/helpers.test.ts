import { describe, expect, it } from 'vitest';
import { amountInWords, integerInWords } from '../amount-in-words';
import { gstStateCode, gstStateName, placeOfSupplyLabel } from '../gst-states';
import { financialYearLabel, formatInvoiceNumber, seriesFor, sequenceKey } from '../numbering';
import {
  GSTIN_PATTERN,
  PAN_PATTERN,
  TAN_PATTERN,
  issueInvoiceSchema,
  legalEntityPatchSchema,
  listInvoicesQuerySchema,
  listPublisherInvoicesQuerySchema,
  uploadPublisherInvoiceSchema,
} from '../invoices.schema';

describe('numbering', () => {
  it('names the financial year from an April start, in IST', () => {
    expect(financialYearLabel(new Date('2026-09-12T10:00:00Z'))).toBe('2026-27');
    expect(financialYearLabel(new Date('2026-03-31T18:29:00Z'))).toBe('2025-26');
    // 23:59 UTC on 31 March is already 1 April in India.
    expect(financialYearLabel(new Date('2026-03-31T23:59:00Z'))).toBe('2026-27');
    expect(financialYearLabel(new Date('2026-02-01T00:00:00Z'), 1)).toBe('2026');
  });

  it('keeps proformas and credit notes out of the tax series', () => {
    expect(seriesFor('TAX_INVOICE', 'INV')).toBe('INV');
    expect(seriesFor('PROFORMA', 'INV')).toBe('INV-PRO');
    expect(seriesFor('CREDIT_NOTE', 'ADX')).toBe('ADX-CN');
    expect(seriesFor('TAX_INVOICE', '  ')).toBe('INV');
  });

  it('prints six consecutive digits', () => {
    expect(formatInvoiceNumber('INV', '2026-27', 18)).toBe('INV/2026-27/000018');
    expect(sequenceKey('INV-CN', '2026-27')).toBe('INV-CN/2026-27');
  });
});

describe('GST states', () => {
  it('resolves a name, an alias, a code — and nothing else', () => {
    expect(gstStateCode('Karnataka')).toBe('29');
    expect(gstStateCode('karnataka ')).toBe('29');
    expect(gstStateCode('Bengaluru')).toBe('29');
    expect(gstStateCode('Tamil Nadu')).toBe('33');
    expect(gstStateCode('Orissa')).toBe('21');
    expect(gstStateCode('27')).toBe('27');
    expect(gstStateCode('99')).toBeNull();
    expect(gstStateCode('Atlantis')).toBeNull();
    expect(gstStateCode(null)).toBeNull();
    expect(gstStateName('29')).toBe('Karnataka');
    expect(placeOfSupplyLabel('29')).toBe('29 - Karnataka');
    expect(placeOfSupplyLabel(null)).toBeNull();
  });
});

describe('amount in words', () => {
  it('groups the Indian way', () => {
    expect(integerInWords(0)).toBe('Zero');
    expect(integerInWords(45)).toBe('Forty-Five');
    expect(integerInWords(100)).toBe('One Hundred');
    expect(integerInWords(1_234_506)).toBe('Twelve Lakh Thirty-Four Thousand Five Hundred and Six');
    expect(integerInWords(20_000_000)).toBe('Two Crore');
    expect(amountInWords('1234506.50')).toBe(
      'Rupees Twelve Lakh Thirty-Four Thousand Five Hundred and Six and Paise Fifty Only',
    );
    expect(amountInWords('18.00')).toBe('Rupees Eighteen Only');
    expect(amountInWords('-500.00')).toBe('Rupees Five Hundred Only');
  });
});

describe('legal entity validation', () => {
  it('knows the shape of a GSTIN, a PAN and a TAN', () => {
    expect(GSTIN_PATTERN.test('29ABCDE1234F1Z5')).toBe(true);
    expect(GSTIN_PATTERN.test('29ABCDE1234F1Y5')).toBe(false);
    expect(PAN_PATTERN.test('ABCDE1234F')).toBe(true);
    expect(PAN_PATTERN.test('ABCD1234F')).toBe(false);
    expect(TAN_PATTERN.test('BLRA12345B')).toBe(true);
  });

  it('upper-cases, and refuses a state code or PAN that contradicts the GSTIN', () => {
    const ok = legalEntityPatchSchema.safeParse({ gstin: '29abcde1234f1z5', pan: 'abcde1234f', stateCode: '29' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.gstin).toBe('29ABCDE1234F1Z5');

    const badState = legalEntityPatchSchema.safeParse({ gstin: '29ABCDE1234F1Z5', stateCode: '27' });
    expect(badState.success).toBe(false);
    const badPan = legalEntityPatchSchema.safeParse({ gstin: '29ABCDE1234F1Z5', pan: 'ZZZZZ9999Z' });
    expect(badPan.success).toBe(false);
  });

  it('clears a field with an empty string and refuses unknown keys', () => {
    const cleared = legalEntityPatchSchema.safeParse({ tan: '' });
    expect(cleared.success).toBe(true);
    if (cleared.success) expect(cleared.data.tan).toBeNull();
    expect(legalEntityPatchSchema.safeParse({ colour: 'blue' }).success).toBe(false);
  });
});

describe('the query and body schemas', () => {
  it('parses the register query on the list contract, with the invoice facets on top', () => {
    const parsed = listInvoicesQuerySchema.safeParse({ q: 'INV', status: 'PAID,VOID', kind: 'TAX_INVOICE', from: '2026-04-01', to: '2026-09-12', page: '2' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toEqual(['PAID', 'VOID']);
      expect(parsed.data.kind).toBe('TAX_INVOICE');
      expect(parsed.data.from).toBeInstanceOf(Date);
      expect(parsed.data.page).toBe(2);
      expect(parsed.data.sort).toBe('newest');
    }
    expect(listInvoicesQuerySchema.safeParse({ status: 'NOPE' }).success).toBe(false);
    expect(listPublisherInvoicesQuerySchema.safeParse({ status: 'UPLOADED', period: '2026-08' }).success).toBe(true);
    expect(listPublisherInvoicesQuerySchema.safeParse({ period: '2026-13' }).success).toBe(false);
  });

  it('takes exactly one of a campaign or a sale to issue, and an empty GSTIN as none', () => {
    expect(issueInvoiceSchema.safeParse({ campaignId: 'c', packageSaleId: 'p' }).success).toBe(false);
    expect(issueInvoiceSchema.safeParse({}).success).toBe(false);
    expect(issueInvoiceSchema.safeParse({ campaignId: 'c' }).success).toBe(true);
    const upload = uploadPublisherInvoiceSchema.safeParse({ period: '2026-08', fileId: 'f', gstin: '', amount: '12.5' });
    expect(upload.success).toBe(true);
    if (upload.success) expect(upload.data.gstin).toBeUndefined();
    expect(uploadPublisherInvoiceSchema.safeParse({ period: '2026-8', fileId: 'f', amount: '1' }).success).toBe(false);
    expect(uploadPublisherInvoiceSchema.safeParse({ period: '2026-08', fileId: 'f', amount: '1.234' }).success).toBe(false);
  });
});

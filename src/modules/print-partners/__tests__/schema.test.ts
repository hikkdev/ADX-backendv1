import { describe, expect, it } from 'vitest';
import * as s from '../print-partners.schema';

/** The wire shapes — what the desk may type, and what it may not. */
describe('the partner schemas', () => {
  it('takes the desk form, upper-casing the tax ids and keeping money as a string', () => {
    const parsed = s.createPartnerSchema.safeParse({
      name: 'Rapid Prints',
      mobile: '9876543210',
      gstin: '29abcde1234f1z5',
      panNumber: 'abcde1234f',
      maxWidthFt: '12.50',
      capabilities: ['flex'],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ gstin: '29ABCDE1234F1Z5', panNumber: 'ABCDE1234F', maxWidthFt: '12.50' });
  });

  it('refuses a malformed GSTIN, a float amount and an empty patch', () => {
    expect(s.createPartnerSchema.safeParse({ name: 'Rapid Prints', mobile: '9876543210', gstin: 'nope' }).success).toBe(false);
    expect(s.openJobSchema.safeParse({ printPartnerId: 'prt_1', quotedCost: '100.555' }).success).toBe(false);
    expect(s.updatePartnerSchema.safeParse({}).success).toBe(false);
    expect(s.updateJobSchema.safeParse({}).success).toBe(false);
  });

  it('never lets a PATCH change the mobile — the account identity', () => {
    const parsed = s.updatePartnerSchema.safeParse({ mobile: '1', city: 'Mysuru' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ city: 'Mysuru' });
  });

  it('reads the list query — active as a boolean, the page defaults', () => {
    const parsed = s.listPartnersQuerySchema.safeParse({ active: 'false', page: '2' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ active: false, page: 2, pageSize: 20 });
    expect(s.listPartnersQuerySchema.safeParse({ active: 'yes' }).success).toBe(false);
  });

  it('only admits the ladder’s statuses on a job', () => {
    expect(s.updateJobSchema.safeParse({ status: 'READY', actualCost: '99.00' }).success).toBe(true);
    expect(s.updateJobSchema.safeParse({ status: 'DONE' }).success).toBe(false);
  });
});

/* Lot H (Q147): the floor's and the desk's quote forms. */
describe('the floor schemas', () => {
  it('lets the partner change the contact, the address, the capabilities and the quote switch — never the legal identity', () => {
    const ok = s.updateMeSchema.safeParse({ contactName: 'Meena', acceptsQuoteRequests: false, maxWidthFt: '12.50' });
    expect(ok.success).toBe(true);
    expect(s.updateMeSchema.safeParse({}).success).toBe(false);
    // Unknown keys are dropped rather than applied — the legal name stays the desk's.
    const stripped = s.updateMeSchema.safeParse({ name: 'New Name', legalName: 'X', gstin: 'Y', contactName: 'Meena' });
    expect(stripped.success).toBe(true);
    expect(stripped.success && Object.keys(stripped.data)).toEqual(['contactName']);
  });

  it('a rate card is a file, rows, or both — never nothing', () => {
    expect(s.rateCardSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(s.rateCardSchema.safeParse({ fileId: 'file_1' }).success).toBe(true);
    const rows = s.rateCardSchema.safeParse({ rows: [{ material: 'Flex', unit: 'sqft', ratePerUnit: '12.00', minQty: 10 }] });
    expect(rows.success).toBe(true);
    expect(s.rateCardSchema.safeParse({ rows: [{ material: 'Flex', unit: 'sqft', ratePerUnit: 12 }] }).success).toBe(false);
  });

  it('reads the quote request — AUTO by default, a hand-picked list, an ISO deadline', () => {
    const auto = s.quoteRequestSchema.safeParse({ specs: { size: '10x20' } });
    expect(auto.success && auto.data.invite).toBe('AUTO');
    const picked = s.quoteRequestSchema.safeParse({ specs: {}, invite: ['prt_1', 'prt_2'], deadlineAt: '2026-09-16T09:00:00+05:30' });
    expect(picked.success).toBe(true);
    expect(s.quoteRequestSchema.safeParse({ specs: {}, invite: [] }).success).toBe(false);
    expect(s.quoteRequestSchema.safeParse({ specs: {}, deadlineAt: 'tomorrow' }).success).toBe(false);
  });

  it('a quote is a money string and whole days; an award note is optional but not empty', () => {
    expect(s.quoteSchema.safeParse({ amount: '1500.00', turnaroundDays: 3 }).success).toBe(true);
    expect(s.quoteSchema.safeParse({ amount: 1500, turnaroundDays: 3 }).success).toBe(false);
    expect(s.quoteSchema.safeParse({ amount: '1500.00', turnaroundDays: 1.5 }).success).toBe(false);
    expect(s.awardSchema.safeParse({}).success).toBe(true);
    expect(s.awardSchema.safeParse({ quoteId: 'quo_1', note: 'no' }).success).toBe(false);
  });

  it('the invoice names a month as YYYY-MM; the withdrawal may leave the method to the default', () => {
    expect(s.partnerInvoiceSchema.safeParse({ fileId: 'file_1', month: '2026-08' }).success).toBe(true);
    expect(s.partnerInvoiceSchema.safeParse({ fileId: 'file_1', month: '2026-13' }).success).toBe(false);
    expect(s.partnerWithdrawalSchema.safeParse({ amount: '500.00' }).success).toBe(true);
    expect(s.declineJobSchema.safeParse({ reason: 'no' }).success).toBe(false);
    const jobs = s.myJobsQuerySchema.safeParse({ status: 'REQUESTED,READY' });
    expect(jobs.success && jobs.data.status).toEqual(['REQUESTED', 'READY']);
    expect(s.myJobsQuerySchema.safeParse({ status: 'LOST' }).success).toBe(false);
  });
});

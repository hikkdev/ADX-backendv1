import { describe, expect, it } from 'vitest';
import type { DesignRequestCandidate } from '../campaigns.repository';
import { designRequestsOf } from '../moderation.service';

/**
 * CR-1: which campaigns ADX still owes a design.
 *
 * The rule is pure and lives in the service, so it is tested here without a
 * database: a campaign on the ADX Design Agency path is owed a design when
 * no *current* ADX-designed creative is standing — delivered and not sent
 * back. The cases that matter are the ones that would otherwise be wrong:
 * a design the advertiser returned, a design ops refused, a superseded
 * delivery, and the advertiser's own upload on a campaign that also asked
 * ADX.
 */

const at = (iso: string) => new Date(iso);

const candidate = (over: Partial<DesignRequestCandidate> = {}): DesignRequestCandidate => ({
  id: 'cmp_1',
  reference: 'ADX-CMP-2026-000001',
  name: 'Diwali burst',
  status: 'SCHEDULED',
  startDate: at('2026-10-01T00:00:00Z'),
  endDate: at('2026-10-31T00:00:00Z'),
  creativeConfig: { objective: 'Footfall', keyMessage: 'Two for one', style: 'BOLD_AND_ENERGETIC' },
  createdAt: at('2026-09-20T00:00:00Z'),
  updatedAt: at('2026-09-20T00:00:00Z'),
  advertiser: { id: 'adv_1', name: 'Anita', companyName: "Anita's Coffee" },
  designQuoteAmount: null,
  designQuoteStatus: null,
  designQuoteNote: null,
  designQuotedAt: null,
  designQuoteRespondedAt: null,
  spots: [],
  creatives: [],
  ...over,
});

const design = (over: Partial<DesignRequestCandidate['creatives'][number]> = {}): DesignRequestCandidate['creatives'][number] => ({
  id: 'crt_1',
  status: 'AWAITING_ADVERTISER',
  designedByAdx: true,
  resubmissionOfId: null,
  fileUrl: '/files/f_1',
  reviewNote: null,
  reviewedAt: null,
  createdAt: at('2026-09-22T00:00:00Z'),
  ...over,
});

describe('which campaigns ADX owes a design', () => {
  it('owes one to a campaign with nothing delivered', () => {
    const [request] = designRequestsOf([candidate()]);
    expect(request?.campaign.id).toBe('cmp_1');
    expect(request?.lastDelivery).toBeNull();
    expect(request?.owedSince).toEqual(at('2026-09-20T00:00:00Z'));
  });

  it('owes nothing while a delivered design waits on the advertiser', () => {
    expect(designRequestsOf([candidate({ creatives: [design()] })])).toEqual([]);
  });

  it('owes nothing while a design is in ops review or approved', () => {
    expect(designRequestsOf([candidate({ creatives: [design({ status: 'IN_REVIEW' })] })])).toEqual([]);
    expect(designRequestsOf([candidate({ creatives: [design({ status: 'APPROVED' })] })])).toEqual([]);
  });

  it('owes one again when the advertiser sent the design back, with their note', () => {
    const sentBack = design({ status: 'CHANGES_REQUESTED', reviewNote: 'Logo too small', reviewedAt: at('2026-09-23T09:00:00Z') });
    const [request] = designRequestsOf([candidate({ creatives: [sentBack] })]);
    expect(request?.lastDelivery?.reviewNote).toBe('Logo too small');
    /* Owed since the send-back, not since the campaign was submitted. */
    expect(request?.owedSince).toEqual(at('2026-09-23T09:00:00Z'));
  });

  it('owes one again when ops rejected the design', () => {
    const rejected = design({ status: 'REJECTED', reviewedAt: at('2026-09-23T09:00:00Z') });
    expect(designRequestsOf([candidate({ creatives: [rejected] })])).toHaveLength(1);
  });

  it('reads only the current delivery, not one it superseded', () => {
    /* The first was sent back; a second replaced it and is with the advertiser. */
    const first = design({ id: 'crt_1', status: 'CHANGES_REQUESTED', reviewedAt: at('2026-09-23T09:00:00Z') });
    const second = design({ id: 'crt_2', status: 'AWAITING_ADVERTISER', resubmissionOfId: 'crt_1', createdAt: at('2026-09-24T00:00:00Z') });
    expect(designRequestsOf([candidate({ creatives: [first, second] })])).toEqual([]);
  });

  it("ignores the advertiser's own upload — that is not ADX's design", () => {
    const theirs = design({ designedByAdx: false, status: 'IN_REVIEW' });
    expect(designRequestsOf([candidate({ creatives: [theirs] })])).toHaveLength(1);
  });

  it('names the most recent delivery when several were sent back', () => {
    const older = design({ id: 'crt_1', status: 'REJECTED', reviewedAt: at('2026-09-21T00:00:00Z'), createdAt: at('2026-09-20T00:00:00Z') });
    const newer = design({ id: 'crt_2', status: 'CHANGES_REQUESTED', reviewedAt: at('2026-09-24T00:00:00Z'), createdAt: at('2026-09-23T00:00:00Z') });
    const [request] = designRequestsOf([candidate({ creatives: [older, newer] })]);
    expect(request?.lastDelivery?.id).toBe('crt_2');
    expect(request?.owedSince).toEqual(at('2026-09-24T00:00:00Z'));
  });

  it('keeps the candidates’ order, which the read made oldest flight first', () => {
    const rows = designRequestsOf([candidate({ id: 'a' }), candidate({ id: 'b' }), candidate({ id: 'c', creatives: [design()] })]);
    expect(rows.map((row) => row.campaign.id)).toEqual(['a', 'b']);
  });
});

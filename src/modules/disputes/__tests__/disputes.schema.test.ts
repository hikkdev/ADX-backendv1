import { describe, expect, it } from 'vitest';
import { moneyStringSchema, raiseDisputeSchema, resolveSchema, setStatusSchema } from '../disputes.schema';

/** The shapes the apps and the console send, and where they are refused. */

describe('money on a case', () => {
  it('is a decimal string with two places at most, above zero', () => {
    expect(moneyStringSchema.safeParse('450').success).toBe(true);
    expect(moneyStringSchema.safeParse('450.50').success).toBe(true);
    expect(moneyStringSchema.safeParse('0').success).toBe(false);
    expect(moneyStringSchema.safeParse('450.555').success).toBe(false);
    expect(moneyStringSchema.safeParse('₹450').success).toBe(false);
  });
});

describe('raising', () => {
  it('needs the order, one of the five reasons and a real description; evidence is capped at five', () => {
    const ok = raiseDisputeSchema.safeParse({ orderId: 'ord_1', reason: 'DAMAGE', detail: 'The frame is bent at the corner.' });
    expect(ok.success && ok.data).toMatchObject({ evidence: [] });
    expect(raiseDisputeSchema.safeParse({ orderId: 'ord_1', reason: 'LATE', detail: 'x'.repeat(20) }).success).toBe(false);
    expect(raiseDisputeSchema.safeParse({ orderId: 'ord_1', reason: 'OTHER', detail: 'short' }).success).toBe(false);
    const many = Array(6).fill({ url: 'https://cdn.adx.in/u/a.jpg' });
    expect(raiseDisputeSchema.safeParse({ orderId: 'ord_1', reason: 'OTHER', detail: 'x'.repeat(20), evidence: many }).success).toBe(false);
  });
});

describe('the desk', () => {
  it('moves a case only through the open states, with a note', () => {
    expect(setStatusSchema.safeParse({ status: 'AWAITING_RESPONSE', note: 'Send a wider photo.' }).success).toBe(true);
    expect(setStatusSchema.safeParse({ status: 'RESOLVED', note: 'x' }).success).toBe(false);
    expect(setStatusSchema.safeParse({ status: 'ESCALATED', note: '   ' }).success).toBe(false);
  });

  it('a partial credit needs its amount; a note is always required', () => {
    expect(resolveSchema.safeParse({ outcome: 'PARTIAL_CREDIT', note: 'Half back.' }).success).toBe(false);
    expect(resolveSchema.safeParse({ outcome: 'PARTIAL_CREDIT', note: 'Half back.', creditAmount: '600.00' }).success).toBe(true);
    expect(resolveSchema.safeParse({ outcome: 'FULL_CREDIT', note: '' }).success).toBe(false);
    expect(resolveSchema.safeParse({ outcome: 'NO_FAULT', note: 'Matches the brief.' }).success).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { entriesQuerySchema, incentivesQuerySchema } from '../payouts.schema';

/* The ledger's chips (DR 04): entries by type, incentives by event with a cursor. */
describe('ledger facets', () => {
  it('take a comma list of entry types and refuse an unknown one', () => {
    expect(entriesQuerySchema.parse({ type: 'EARNING,PAYOUT' }).type).toEqual(['EARNING', 'PAYOUT']);
    expect(entriesQuerySchema.safeParse({ type: 'SALARY' }).success).toBe(false);
  });

  it('take a comma list of incentive events and a cursor', () => {
    const q = incentivesQuerySchema.parse({ event: 'MILESTONE_BONUS,TIER_BONUS', cursor: 'inc_9', limit: '20' });
    expect(q).toEqual({ event: ['MILESTONE_BONUS', 'TIER_BONUS'], cursor: 'inc_9', limit: 20 });
    expect(incentivesQuerySchema.safeParse({ event: 'PAYOUT' }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { assertParty, assertRaiser, mayView, standingOf } from '../disputes.policy';

/**
 * Who may see a case: the raiser, the party it is against, and ADX. Nobody
 * else — and a case against ADX has no second person, so only two can see it.
 */

const dispute = { raisedByUserId: 'usr_adv', againstUserId: 'usr_pub' };
const withAdx = { raisedByUserId: 'usr_adv', againstUserId: null };
const actor = (sub: string, roles: string[] = []) => ({ sub, roles });

describe('standing on a case', () => {
  it('is the raiser, the other party, or ADX', () => {
    expect(standingOf(dispute, actor('usr_adv'))).toBe('RAISER');
    expect(standingOf(dispute, actor('usr_pub'))).toBe('AGAINST');
    expect(standingOf(dispute, actor('usr_admin', ['ADMIN']))).toBe('ADMIN');
    expect(standingOf(dispute, actor('usr_x'))).toBeNull();
  });

  it('a case against ADX has no other party', () => {
    expect(standingOf(withAdx, actor('usr_pub'))).toBeNull();
    expect(mayView(withAdx, actor('usr_adv'))).toBe(true);
    expect(mayView(withAdx, actor('usr_admin', ['ADMIN']))).toBe(true);
  });

  it('a stranger is refused on write, and only the raiser may do the raiser’s things', () => {
    expect(() => assertParty(dispute, actor('usr_x'))).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(assertParty(dispute, actor('usr_pub'))).toBe('AGAINST');
    expect(() => assertRaiser(dispute, actor('usr_pub'))).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => assertRaiser(dispute, actor('usr_admin', ['ADMIN']))).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => assertRaiser(dispute, actor('usr_adv'))).not.toThrow();
  });
});

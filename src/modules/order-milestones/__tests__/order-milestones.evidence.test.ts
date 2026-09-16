import { describe, expect, it } from 'vitest';
import { checkEvidence } from '../order-milestones.evidence';
import { parseRequirements, requirementIsOptional } from '../order-milestones.types';

/**
 * The evidence rules, on their own.
 *
 * `checkEvidence` is pure by design — no repository, no order — so the matching
 * can be pinned here without a database. The cases that matter are the ones a
 * field agent hits: a shot taken but named something else, a checklist item
 * ticked "no", and a proof the template asked for but is content to go without.
 */

const requirements = [
  { kind: 'photo', label: 'The mirror decal' },
  { kind: 'photo', label: 'Decal from an angle' },
  { kind: 'photo', label: 'Reception / locker zone', optional: true },
  { kind: 'location_checkin' },
];

const shot = (label: string) => ({ kind: 'photo', label, value: `https://cdn.adx.in/${label}.jpg` });
const checkin = { kind: 'location_checkin', value: '12.9716,77.5946' };

describe('optional requirements', () => {
  it('lets a visit complete without the shot it was content to go without', () => {
    const kept = checkEvidence(requirements, [
      shot('The mirror decal'),
      shot('Decal from an angle'),
      checkin,
    ]);
    expect(kept).toHaveLength(3);
  });

  it('still keeps the optional shot when the agent did take it', () => {
    const kept = checkEvidence(requirements, [
      shot('The mirror decal'),
      shot('Decal from an angle'),
      shot('Reception / locker zone'),
      checkin,
    ]);
    expect(kept.map((e) => e.label)).toContain('Reception / locker zone');
  });

  it('does not forgive a mandatory shot just because another one is optional', () => {
    expect(() =>
      checkEvidence(requirements, [shot('The mirror decal'), checkin]),
    ).toThrow(/Decal from an angle/);
  });

  /*
   * An optional checklist item answered "no" is an answer, not a failure. It is
   * skipped whole rather than checked-then-forgiven, so the "no" is recorded.
   */
  it('records an optional checklist item the agent answered no to', () => {
    const kept = checkEvidence([{ kind: 'checklist_item', label: 'Lighting works', optional: true }], [
      { kind: 'checklist_item', label: 'Lighting works', value: 'false' },
    ]);
    expect(kept).toEqual([{ kind: 'checklist_item', label: 'Lighting works', value: 'false' }]);
  });

  it('still demands a yes from a mandatory checklist item', () => {
    expect(() =>
      checkEvidence([{ kind: 'checklist_item', label: 'Surface is clean' }], [
        { kind: 'checklist_item', label: 'Surface is clean', value: 'false' },
      ]),
    ).toThrow(/must be confirmed/);
  });
});

describe('the flag itself', () => {
  it('survives a round trip through the loose JSON the templates store', () => {
    const parsed = parseRequirements(requirements);
    expect(parsed).toHaveLength(4);
    expect(parsed.filter(requirementIsOptional)).toEqual([
      { kind: 'photo', label: 'Reception / locker zone', optional: true },
    ]);
  });

  it('treats a requirement written before the flag existed as mandatory', () => {
    const [only] = parseRequirements([{ kind: 'photo', label: 'The mirror decal' }]);
    expect(requirementIsOptional(only!)).toBe(false);
  });

  /*
   * There is deliberately no optional check-in: a visit either rests on proof
   * that the agent was standing there or it does not, and "optionally prove it"
   * is not a thing a reviewer can act on.
   */
  it('has no notion of an optional check-in', () => {
    const [only] = parseRequirements([{ kind: 'location_checkin', optional: true }]);
    expect(requirementIsOptional(only!)).toBe(false);
  });
});

/*
 * The agent app drops a requirement whose label is blank or whitespace
 * (verification-plan.ts `readRequirements`), so a row this parser kept would be
 * a proof no screen ever asks for and no evidence can ever match: the milestone
 * would sit IN_PROGRESS for good. The two ends have to agree, and the read path
 * is where they meet, because seeds and direct writes never touch the creation
 * schema.
 */
describe('a requirement with no label', () => {
  it('is dropped rather than left demanding a proof the app never shows', () => {
    expect(parseRequirements([{ kind: 'photo', label: '   ' }])).toEqual([]);
    expect(parseRequirements([{ kind: 'checklist_item', label: '' }])).toEqual([]);
  });

  it('does not take the readable requirements down with it', () => {
    const parsed = parseRequirements([
      { kind: 'photo', label: '   ' },
      { kind: 'photo', label: 'The mirror decal' },
      { kind: 'location_checkin' },
    ]);
    expect(parsed).toEqual([
      { kind: 'photo', label: 'The mirror decal' },
      { kind: 'location_checkin' },
    ]);
  });

  it('leaves a milestone with only that row completable', () => {
    expect(() => checkEvidence([{ kind: 'photo', label: '  ' }], [])).not.toThrow();
  });

  /*
   * Padding is not blankness. The label is the join key `checkEvidence` matches
   * on, and the app sends it back verbatim, so trimming here would demand a
   * string the app never offers.
   */
  it('keeps a padded label exactly as written, so evidence still matches it', () => {
    expect(parseRequirements([{ kind: 'photo', label: ' Front face ' }])).toEqual([
      { kind: 'photo', label: ' Front face ' },
    ]);
    expect(() =>
      checkEvidence(
        [{ kind: 'photo', label: ' Front face ' }],
        [{ kind: 'photo', label: ' Front face ', value: 'https://cdn.adx.in/f.jpg' }],
      ),
    ).not.toThrow();
  });
});

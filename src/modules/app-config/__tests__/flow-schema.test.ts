import { describe, expect, it } from 'vitest';
import { buildListingFlow } from '../../../scripts/data/listing-flow';
import { enumGroupSchema, FIELD_KINDS, fieldVocabulary, summariseChanges, wizardFlowSchema, wizardScreens } from '../flow-schema';
import { APP_ENUMS } from '../app-enums';

/**
 * Q83/Q148 — the vocabulary is the apps' word.
 *
 * What is pinned: the twenty-three hyphenated kinds both apps' `fields.tsx`
 * switch on, no more and no fewer; the listing wizard the seed writes passes
 * as it is; and each of the rules the console reads back from
 * GET /config/schema refuses what it says it refuses.
 */

const APP_FIELD_KINDS = [
  'selectable-cards', 'venue-type', 'media-type', 'section', 'city', 'document-upload', 'sub-venue', 'material',
  'textarea', 'number', 'computed', 'geo-point', 'select', 'base-price', 'date', 'time-range', 'content-stance',
  'content-prohibited', 'image-upload', 'file-upload', 'checkbox', 'switch', 'text',
];

const cities = [{ id: 'Bengaluru', title: 'Bengaluru' }, { id: 'Patna', title: 'Patna' }];
const listing = () => JSON.parse(JSON.stringify(buildListingFlow(cities))) as ReturnType<typeof buildListingFlow>;

describe('the field kinds', () => {
  it('are exactly the ones the apps render, hyphenated', () => {
    expect(new Set(FIELD_KINDS.map((k) => k.kind))).toEqual(new Set(APP_FIELD_KINDS));
    expect(FIELD_KINDS.every((k) => /^[a-z]+(-[a-z]+)*$/.test(k.kind))).toBe(true);
    // Only the two that collect nothing may not be required.
    expect(FIELD_KINDS.filter((k) => !k.input).map((k) => k.kind)).toEqual(['section', 'computed']);
  });

  it('are what GET /config/schema describes', () => {
    const vocabulary = fieldVocabulary();
    expect(vocabulary.kinds.map((k) => k.kind)).toEqual(FIELD_KINDS.map((k) => k.kind));
    expect(vocabulary.flow.branches).toContain('Record<optionId, FlowBranch>');
    expect(vocabulary.rules.length).toBeGreaterThan(5);
  });
});

describe('the seeded listing wizard', () => {
  it('passes the vocabulary as the seed writes it', () => {
    const parsed = wizardFlowSchema.safeParse(listing());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(Object.keys(parsed.data.branches)).toEqual(['indoor', 'outdoor', 'transit', 'media']);
  });

  it('is named screen by screen for the audit row, branch screens under their branch', () => {
    const names = wizardScreens(listing()).map((s) => s.name);
    expect(names[0]).toBe('select-category');
    expect(names).toContain('indoor/venue');
    expect(names).toContain('media/review');
    expect(names).toHaveLength(1 + 4 * 8);
  });
});

describe('what the wizard schema refuses', () => {
  it('a kind no phone renders', () => {
    const flow = listing();
    flow.branches.indoor.screens[0]!.fields.push({ type: 'slider', id: 'price', label: 'Price' } as never);
    const parsed = wizardFlowSchema.safeParse(flow);
    expect(parsed.success).toBe(false);
  });

  it('a screen key used twice in one list, but not the same key across branches', () => {
    const flow = listing();
    flow.branches.indoor.screens[1]!.key = 'venue';
    expect(wizardFlowSchema.safeParse(flow).success).toBe(false);
    // Every branch has a `venue` screen and that is fine.
    expect(wizardFlowSchema.safeParse(listing()).success).toBe(true);
  });

  it('an option branching to a branch that does not exist, and a branch nothing targets', () => {
    const flow = listing();
    flow.screens[0]!.fields[0]!.options!.push({ id: 'digital', title: 'Digital', description: 'Screens' });
    const missing = wizardFlowSchema.safeParse(flow);
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error.issues.some((i) => i.message.includes('`digital` branches to a branch that does not exist'))).toBe(true);

    const orphan = listing();
    (orphan.branches as Record<string, unknown>)['stadium'] = { ...orphan.branches.indoor, id: 'stadium' };
    const parsed = wizardFlowSchema.safeParse(orphan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((i) => i.message.includes('`stadium` is not the target of any option'))).toBe(true);
  });

  it('`required` on a kind that collects nothing, a prop the kind does not read, and a kind missing what it needs', () => {
    const section = listing();
    const details = section.branches.indoor.screens.find((s) => s.key === 'spot-details')!;
    (details.fields[0] as { required?: boolean }).required = true; // the 'section' heading
    expect(wizardFlowSchema.safeParse(section).success).toBe(false);

    const stray = listing();
    (stray.branches.indoor.screens[0]!.fields[0] as { showIndicator?: boolean }).showIndicator = true; // on a venue-type
    expect(wizardFlowSchema.safeParse(stray).success).toBe(false);

    const bare = listing();
    delete (bare.screens[0]!.fields[0] as { options?: unknown }).options; // selectable-cards without options
    expect(wizardFlowSchema.safeParse(bare).success).toBe(false);
  });

  it('a reference to a field asked later or never', () => {
    const flow = listing();
    const details = flow.branches.indoor.screens.find((s) => s.key === 'spot-details')!;
    const computed = details.fields.find((f) => f.id === 'area_sq_ft') as { from: string[] };
    computed.from = ['width_ft', 'depth_ft'];
    const parsed = wizardFlowSchema.safeParse(flow);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((i) => i.message.includes('`depth_ft` is not a field asked before this one'))).toBe(true);
  });
});

describe('an enum group', () => {
  it('is the seeded shape and refuses a value listed twice', () => {
    for (const group of Object.values(APP_ENUMS)) expect(enumGroupSchema.safeParse(group).success).toBe(true);
    expect(enumGroupSchema.safeParse([{ value: 'A', label: 'A' }, { value: 'A', label: 'Again' }]).success).toBe(false);
    expect(enumGroupSchema.safeParse([{ value: 'A', label: 'A', colour: 'red' }]).success).toBe(false);
  });
});

describe('the change summary', () => {
  it('names what was added, removed and changed', () => {
    const before = [{ k: 'a', v: 1 }, { k: 'b', v: 1 }, { k: 'c', v: 1 }];
    const after = [{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'd', v: 1 }];
    expect(summariseChanges(before, after, (x) => x.k)).toEqual({ added: ['d'], removed: ['c'], changed: ['b'] });
  });
});

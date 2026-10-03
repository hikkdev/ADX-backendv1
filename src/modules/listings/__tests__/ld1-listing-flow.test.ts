import { describe, expect, it } from 'vitest';
import { buildListingFlow } from '../../../scripts/data/listing-flow';
import { wizardFlowSchema } from '../../app-config';
import { CLIENT_ANSWER_IDS, LISTING_FLOW_FIELD_IDS, flowFieldLabels, isMappedAnswer, stampWaivers, unmappedAnswers } from '../listing-answers';

/**
 * LD-1 (3 Oct 2026): the listing flow's new questions, and the rule that no
 * answer is dropped.
 *
 * Pinned:
 *  - every question the code's template asks is one a client binds to a
 *    column — so a question added to the template has to be added to
 *    `LISTING_FLOW_FIELD_IDS` too, or this fails; a question added only in
 *    the Flow Editor is by definition unmapped, and lands in `extraAnswers`;
 *  - the new questions: their ids, plain words, codes and which branches
 *    ask them.
 */

const flow = buildListingFlow([{ id: 'Pune', title: 'Pune' }]);
type Field = { id: string; type: string; label: string; hint?: string; options?: { id: string; title: string }[] };
const COLLECTS_NOTHING = new Set(['section', 'computed']);

function fieldsOf(branch: string): Field[] {
  const root = flow.screens.flatMap((screen) => screen.fields as Field[]);
  const own = (flow.branches as Record<string, { screens: { fields: Field[] }[] }>)[branch]!.screens.flatMap((screen) => screen.fields);
  return [...root, ...own];
}
const field = (branch: string, id: string) => fieldsOf(branch).find((f) => f.id === id);
const BRANCHES = ['indoor', 'outdoor', 'transit', 'media'] as const;

describe('every template question has a home', () => {
  it('is a valid wizard', () => {
    expect(wizardFlowSchema.safeParse(flow).success).toBe(true);
  });

  it.each(BRANCHES)('the %s branch asks nothing the clients cannot file', (branch) => {
    const unbound = fieldsOf(branch)
      .filter((f) => !COLLECTS_NOTHING.has(f.type))
      .map((f) => f.id)
      .filter((id) => !isMappedAnswer(id));
    expect(unbound).toEqual([]);
  });

  it('lists no id twice, and keeps the clients’ own answers apart from the questions', () => {
    expect(new Set(LISTING_FLOW_FIELD_IDS).size).toBe(LISTING_FLOW_FIELD_IDS.length);
    for (const id of CLIENT_ANSWER_IDS) expect(LISTING_FLOW_FIELD_IDS as readonly string[]).not.toContain(id);
  });

  it('a question added in the Flow Editor lands in extraAnswers, labelled with its words', () => {
    const edited = {
      ...flow,
      branches: {
        ...flow.branches,
        outdoor: {
          ...flow.branches.outdoor,
          screens: [
            ...flow.branches.outdoor.screens,
            { key: 'extra', title: 'Extra', step: 13, totalSteps: 10, ctaLabel: 'Save', fields: [{ id: 'nearest_landmark', type: 'text', label: 'Nearest landmark' }] },
          ],
        },
      },
    };
    const answers = { title: 'Station Road hoarding', traffic_grade: 'HIGH', nearest_landmark: 'Metro gate 2', content_rules: ['x'] };
    expect(unmappedAnswers(answers, flowFieldLabels(edited))).toEqual([{ key: 'nearest_landmark', label: 'Nearest landmark', value: 'Metro gate 2' }]);
  });

  it('never files the clients’ photo upload rows (`photo_meta`) as an extra answer', () => {
    const answers = {
      main_photo: 'https://files.example/front.jpg',
      photo_meta: { main_photo: { uploadedFileId: 'upl_front', takenAt: '2026-10-02T04:30:00.000Z' } },
      nearest_landmark: 'Metro gate 2',
    };
    expect(unmappedAnswers(answers, new Map())).toEqual([{ key: 'nearest_landmark', label: 'nearest_landmark', value: 'Metro gate 2' }]);
    expect(isMappedAnswer('photo_meta')).toBe(true);
  });

  it('keeps a Date answer as its ISO string, and skips blank ones', () => {
    expect(unmappedAnswers({ visit_on: new Date('2026-10-05T00:00:00Z'), empty: '  ', none: null, list: [] }, new Map())).toEqual([
      { key: 'visit_on', label: 'visit_on', value: '2026-10-05T00:00:00.000Z' },
    ]);
    expect(unmappedAnswers(null, new Map())).toEqual([]);
    expect(unmappedAnswers(['not', 'a', 'bag'], new Map())).toEqual([]);
  });

  it('a waiver stated twice is one waiver, the last word winning', () => {
    const now = new Date('2026-10-03T06:00:00Z');
    expect(stampWaivers([{ kind: 'OWNER_NOC', reason: 'first' }, { kind: 'OWNER_NOC', reason: 'second' }], null, now)).toEqual([
      { kind: 'OWNER_NOC', reason: 'second', at: '2026-10-03T06:00:00.000Z' },
    ]);
  });
});

describe('the new questions (LD-1)', () => {
  it('asks daily footfall, traffic and visibility of every fixed physical spot, and not of transit or media', () => {
    for (const branch of ['indoor', 'outdoor']) {
      expect(field(branch, 'estimated_daily_footfall')).toMatchObject({
        type: 'number',
        label: 'About how many people pass this spot in a day?',
        hint: 'Your best estimate — we may refine it with measured data.',
        required: false,
      });
      expect(field(branch, 'traffic_grade')).toMatchObject({ type: 'select', label: 'How busy is it?' });
      expect(field(branch, 'traffic_grade')!.options).toEqual([
        { id: 'LOW', title: 'Low' },
        { id: 'MEDIUM', title: 'Medium' },
        { id: 'HIGH', title: 'High' },
        { id: 'VERY_HIGH', title: 'Very high' },
      ]);
      expect(field(branch, 'visibility')).toMatchObject({ type: 'select', label: 'From how far can it be seen?' });
      expect(field(branch, 'visibility')!.options).toEqual([
        { id: 'UNDER_50M', title: 'Under 50 m' },
        { id: '50_150M', title: '50–150 m' },
        { id: '150_300M', title: '150–300 m' },
        { id: 'OVER_300M', title: 'Over 300 m' },
      ]);
    }
    for (const branch of ['transit', 'media']) {
      for (const id of ['estimated_daily_footfall', 'traffic_grade', 'visibility', 'elevation']) expect(field(branch, id)).toBeUndefined();
    }
  });

  it('asks how high only of an outdoor spot', () => {
    expect(field('outdoor', 'elevation')).toMatchObject({ type: 'select', label: 'How high is it?' });
    expect(field('outdoor', 'elevation')!.options).toEqual([
      { id: 'GROUND', title: 'Ground level' },
      { id: 'FIRST_FLOOR', title: 'First floor' },
      { id: 'ROOFTOP', title: 'Rooftop' },
      { id: 'ELEVATED', title: 'Elevated structure' },
    ]);
    expect(field('indoor', 'elevation')).toBeUndefined();
  });

  it('asks a screen’s resolution as a pair under one heading, never of a media outlet', () => {
    for (const branch of ['indoor', 'outdoor', 'transit']) {
      expect(field(branch, 'sec_screen')).toMatchObject({ type: 'section', label: 'Screen resolution (pixels)' });
      expect(field(branch, 'width_px')).toMatchObject({ type: 'number', label: 'Width (px)' });
      expect(field(branch, 'height_px')).toMatchObject({ type: 'number', label: 'Height (px)' });
      // Form symmetry: the pair carries no hint on one side only.
      expect(field(branch, 'width_px')!.hint).toBe(field(branch, 'height_px')!.hint);
    }
    expect(field('media', 'width_px')).toBeUndefined();
  });

  it('asks the kind of vehicle of a transit spot only, as codes', () => {
    expect(field('transit', 'vehicle_type')).toMatchObject({ type: 'select', label: 'What kind of vehicle?' });
    expect(field('transit', 'vehicle_type')!.options!.map((option) => option.id)).toEqual(['AUTO', 'CAR', 'CAB', 'BUS', 'TRUCK', 'OTHER']);
    expect(field('transit', 'vehicle_model')).toMatchObject({ type: 'text', label: 'Vehicle model' });
    for (const branch of ['indoor', 'outdoor', 'media']) expect(field(branch, 'vehicle_type')).toBeUndefined();
  });

  it('asks every spot whether it can be booked now, as a switch', () => {
    for (const branch of BRANCHES) expect(field(branch, 'available_now')).toMatchObject({ type: 'switch', label: 'Available to book now?', required: false });
  });

  it('makes none of them required', () => {
    for (const branch of BRANCHES) {
      for (const id of ['estimated_daily_footfall', 'traffic_grade', 'visibility', 'elevation', 'width_px', 'height_px', 'vehicle_type', 'available_now']) {
        const asked = field(branch, id) as { required?: boolean } | undefined;
        if (asked) expect(asked.required ?? false).toBe(false);
      }
    }
  });
});

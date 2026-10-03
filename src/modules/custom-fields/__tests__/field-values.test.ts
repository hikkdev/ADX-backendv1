import { describe, expect, it } from 'vitest';

/**
 * CF-1 — a value against its definition, pure: every kind's shape, the
 * clear, the required refusal, and the key made from a label.
 */

import { checkValue, isValidKey, keyFromLabel } from '../field-values';

const def = (kind: string, over: Record<string, unknown> = {}) => ({ key: 'k', label: 'The field', kind, options: null, required: false, ...over });

describe('keyFromLabel', () => {
  it('makes a stable, shaped key from a label', () => {
    expect(keyFromLabel('Preferred contact time')).toBe('preferred_contact_time');
    expect(keyFromLabel('  GST no. (optional) ')).toBe('gst_no_optional');
    expect(keyFromLabel('2nd phone')).toBe('f_2nd_phone');
    expect(keyFromLabel('A'.repeat(60))).toHaveLength(40);
    expect(isValidKey(keyFromLabel('Preferred contact time'))).toBe(true);
    expect(isValidKey('Bad-Key')).toBe(false);
  });
});

describe('checkValue', () => {
  it('reads empty as a clear, refused when required', () => {
    for (const empty of [null, undefined, '', '   ', []]) expect(checkValue(def('text'), empty)).toEqual({ ok: true, value: null });
    expect(checkValue(def('text', { required: true }), '')).toEqual({ ok: false, message: 'The field is required' });
  });

  it('cleans each kind', () => {
    expect(checkValue(def('text'), '  hi ')).toEqual({ ok: true, value: 'hi' });
    expect(checkValue(def('text'), 'x'.repeat(501)).ok).toBe(false);
    expect(checkValue(def('textarea'), 'x'.repeat(501))).toEqual({ ok: true, value: 'x'.repeat(501) });
    expect(checkValue(def('number'), '12.5')).toEqual({ ok: true, value: 12.5 });
    expect(checkValue(def('number'), 'twelve').ok).toBe(false);
    const options = [{ value: 'am', label: 'Morning' }, { value: 'pm', label: 'Evening' }];
    expect(checkValue(def('select', { options }), 'am')).toEqual({ ok: true, value: 'am' });
    expect(checkValue(def('select', { options }), 'noon').ok).toBe(false);
    expect(checkValue(def('multiselect', { options }), ['am', 'am', 'pm'])).toEqual({ ok: true, value: ['am', 'pm'] });
    expect(checkValue(def('multiselect', { options }), 'pm')).toEqual({ ok: true, value: ['pm'] });
    expect(checkValue(def('multiselect', { options }), ['zz']).ok).toBe(false);
    expect(checkValue(def('checkbox'), 'true')).toEqual({ ok: true, value: true });
    expect(checkValue(def('checkbox'), 'maybe').ok).toBe(false);
    expect(checkValue(def('date'), '2026-02-30').ok).toBe(true);
    expect(checkValue(def('date'), '30/02/2026').ok).toBe(false);
    expect(checkValue(def('email'), ' Asha@Example.com ')).toEqual({ ok: true, value: 'asha@example.com' });
    expect(checkValue(def('email'), 'nope').ok).toBe(false);
    expect(checkValue(def('phone'), '+91 98765 43210')).toEqual({ ok: true, value: '+919876543210' });
    expect(checkValue(def('phone'), '12').ok).toBe(false);
    expect(checkValue(def('url'), 'https://adx.in/x')).toEqual({ ok: true, value: 'https://adx.in/x' });
    expect(checkValue(def('url'), 'adx.in').ok).toBe(false);
    expect(checkValue(def('location'), { latitude: '18.5', longitude: 73.8, address: ' FC Road ', cityId: 'city_pune' })).toEqual({ ok: true, value: { latitude: 18.5, longitude: 73.8, address: 'FC Road', cityId: 'city_pune' } });
    expect(checkValue(def('location'), { latitude: 91, longitude: 0 }).ok).toBe(false);
    expect(checkValue(def('mystery'), 'x').ok).toBe(false);
  });
});

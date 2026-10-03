import { describe, expect, it } from 'vitest';

/**
 * FM-1 — the definition: what the builder may save.
 *
 * Aadhaar is refused before anything else; ids are unique; a condition
 * names an earlier field and a value it can answer; options only where a
 * choice is made; bounds fit the kind; a file only on a signed-in form; the
 * contact map points at fields of the right kind; every problem at once.
 */

import { assertPublishable, definitionIssues, emptyDefinition, fieldKinds, flattenFields, validateDefinition, type FormDefinition } from '../form-schema';

const base = (fields: Record<string, unknown>[], over: Partial<FormDefinition> = {}): unknown => ({
  screens: [{ key: 'main', title: 'Main', fields }],
  successMessage: 'Thanks',
  consentText: 'I agree',
  ...over,
});

const field = (id: string, kind: string, over: Record<string, unknown> = {}) => ({ id, kind, label: id.replace(/_/g, ' '), ...over });

describe('the field kinds', () => {
  it('names the thirteen kinds, which take options, ranges, and a token', () => {
    const kinds = fieldKinds();
    expect(kinds.map((k) => k.kind)).toEqual(['text', 'textarea', 'email', 'phone', 'number', 'select', 'multiselect', 'checkbox', 'date', 'city', 'category', 'location', 'file']);
    expect(kinds.filter((k) => k.takesOptions).map((k) => k.kind)).toEqual(['select', 'multiselect']);
    expect(kinds.filter((k) => k.signedInOnly).map((k) => k.kind)).toEqual(['file']);
    expect(kinds.find((k) => k.kind === 'number')!.takesRange).toBe(true);
  });
});

describe('validateDefinition', () => {
  it('accepts a plain form and returns it clean', () => {
    const definition = validateDefinition(base([field('name', 'text', { required: true }), field('email', 'email')], { contactMap: { name: 'name', email: 'email' } }), 'PUBLIC');
    expect(flattenFields(definition).map((f) => f.id)).toEqual(['name', 'email']);
    expect(definition.contactMap).toEqual({ name: 'name', email: 'email' });
  });

  it('refuses Aadhaar by id or label before any other check, as FORBIDDEN_FIELD', () => {
    for (const raw of [
      base([field('aadhaar_number', 'text')]),
      base([field('id_number', 'text', { label: 'Aadhar card' })]),
      base([field('uid', 'text')]),
      base([field('x', 'text', { label: 'UIDAI reference' })]),
      // Malformed otherwise: the forbidden name still wins.
      { screens: [{ key: 'main', fields: [{ id: 'aadhaar', kind: 'nope' }] }] },
    ]) {
      const err = (() => {
        try {
          validateDefinition(raw, 'SIGNED_IN');
          return null;
        } catch (e) {
          return e as { statusCode: number; code: string };
        }
      })();
      expect(err?.statusCode).toBe(400);
      expect(err?.code).toBe('FORBIDDEN_FIELD');
    }
    // "uid" inside another word is not the word.
    expect(() => validateDefinition(base([field('guide', 'text', { label: 'Guide' })]), 'PUBLIC')).not.toThrow();
  });

  it('names a shape problem with its path', () => {
    const err = (() => {
      try {
        validateDefinition(base([field('Name', 'text')]), 'PUBLIC');
      } catch (e) {
        return e as { code: string; details: { issues: { path: string; message: string }[] } };
      }
      return null;
    })();
    expect(err?.code).toBe('VALIDATION_ERROR');
    expect(err?.details.issues[0]!.path).toBe('screens.0.fields.0.id');
    expect(() => validateDefinition(base([], { successMessage: '' }), 'PUBLIC')).toThrow(/successMessage/);
    expect(() => validateDefinition(base([], { consentText: '   ' }), 'PUBLIC')).toThrow(/consentText/);
  });

  it('collects every semantic problem at once', () => {
    const raw = base([
      field('a', 'text'),
      field('a', 'number', { min: 5, max: 1 }),
      field('b', 'select'),
      field('c', 'text', { options: [{ value: 'x', label: 'X' }] }),
      field('d', 'select', { options: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Again' }] }),
      field('e', 'text', { dependsOn: { fieldId: 'zzz', equals: 'x' } }),
      field('f', 'text', { dependsOn: { fieldId: 'd', equals: 'nope' } }),
      field('g', 'checkbox'),
      field('h', 'text', { dependsOn: { fieldId: 'g', equals: 'yes' } }),
      field('i', 'date', { min: 3 }),
      field('j', 'email', { maxLength: 5 }),
      field('k', 'text', { accept: ['image/png'] }),
      field('l', 'file'),
      field('m', 'text', { dependsOn: { fieldId: 'm', equals: 'x' } }),
    ]);
    const err = (() => {
      try {
        validateDefinition(raw, 'PUBLIC');
      } catch (e) {
        return e as { code: string; details: { issues: { fieldId: string | null; path: string; message: string }[] } };
      }
      return null;
    })();
    expect(err?.code).toBe('VALIDATION_ERROR');
    const messages = err!.details.issues.map((i) => `${i.fieldId}: ${i.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^a: Field id "a" is used twice/),
        expect.stringMatching(/^a: "a" has min above max/),
        expect.stringMatching(/^b: "b" needs options/),
        expect.stringMatching(/^c: "c" is a short text and takes no options/),
        expect.stringMatching(/^d: Option "x" repeats/),
        expect.stringMatching(/^e: "e" depends on "zzz", which is not an earlier field/),
        expect.stringMatching(/^f: "f" waits for "nope", which "d" never answers/),
        expect.stringMatching(/^h: "h" depends on a tick box/),
        expect.stringMatching(/^i: "i" takes date bounds/),
        expect.stringMatching(/^j: "j" takes no maxLength/),
        expect.stringMatching(/^k: "k" takes no accept list/),
        expect.stringMatching(/^l: "l" is a file upload, which only a signed-in form/),
        expect.stringMatching(/^m: "m" cannot depend on itself/),
      ]),
    );
    expect(err!.details.issues).toHaveLength(13);
  });

  it('allows a file on a signed-in form, and a condition on an earlier choice', () => {
    const definition = validateDefinition(
      base([
        field('kind', 'select', { options: [{ value: 'shop', label: 'Shop' }, { value: 'wall', label: 'Wall' }] }),
        field('shop_name', 'text', { dependsOn: { fieldId: 'kind', equals: 'shop' } }),
        field('agree', 'checkbox'),
        field('why', 'textarea', { dependsOn: { fieldId: 'agree', equals: 'false' }, maxLength: 200 }),
        field('photo', 'file', { accept: ['image/jpeg'] }),
        field('when', 'date', { min: '2026-01-01', max: '2026-12-31' }),
        field('tags', 'multiselect', { options: [{ value: 'a', label: 'A' }], min: 0, max: 1 }),
      ]),
      'SIGNED_IN',
    );
    expect(flattenFields(definition)).toHaveLength(7);
  });

  it('checks the contact map against the fields it names', () => {
    const issues = definitionIssues(
      validateDefinition(base([field('name', 'text'), field('phone', 'phone'), field('note', 'textarea')]), 'PUBLIC'),
      'PUBLIC',
    );
    expect(issues).toEqual([]);
    expect(() => validateDefinition(base([field('name', 'text'), field('note', 'textarea')], { contactMap: { name: 'ghost', phone: 'note' } }), 'PUBLIC')).toThrow(/2 problems/);
  });

  it('bounds the form: ten screens, forty fields', () => {
    const many = Array.from({ length: 41 }, (_, i) => field(`f${i}`, 'text'));
    expect(() => validateDefinition(base(many), 'PUBLIC')).toThrow(/at most 40|screens.0.fields/);
    const screens = Array.from({ length: 11 }, (_, i) => ({ key: `s${i}`, fields: [] }));
    expect(() => validateDefinition({ screens, successMessage: 'x', consentText: 'y' }, 'PUBLIC')).toThrow(/screens/);
    // Forty across screens is fine; the same total on two screens too.
    const split = { screens: [{ key: 's1', fields: many.slice(0, 20) }, { key: 's2', fields: many.slice(20, 40) }], successMessage: 'x', consentText: 'y' };
    expect(flattenFields(validateDefinition(split, 'PUBLIC'))).toHaveLength(40);
  });

  it('refuses a repeated screen key', () => {
    const raw = { screens: [{ key: 'one', fields: [] }, { key: 'one', fields: [] }], successMessage: 'x', consentText: 'y' };
    expect(() => validateDefinition(raw, 'PUBLIC')).toThrow(/Screen key "one" is used twice/);
  });
});

describe('the empty form', () => {
  it('is valid to save and refused to publish', () => {
    const definition = validateDefinition(emptyDefinition(), 'PUBLIC');
    expect(flattenFields(definition)).toHaveLength(0);
    expect(() => assertPublishable(definition)).toThrow(/at least one field/);
  });
});

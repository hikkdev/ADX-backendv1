import { describe, expect, it, vi } from 'vitest';

/**
 * FM-1 — an answer set against its definition, pure.
 *
 * Every kind's shape, required, options, ranges; a field whose condition
 * is not met is dropped, an unknown answer is dropped; the contact and
 * place fields are lifted; the "Label: value" lines read as a person would.
 */

vi.mock('../../listings', () => ({ LISTING_CATEGORIES: ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] }));

import { answerLines, cityIdsIn, cleanPhone, fileRefsIn, liftContacts, liftPlace, validateAnswers, resolveCityAnswers } from '../form-answers';
import { validateDefinition } from '../form-schema';

const definition = validateDefinition(
  {
    screens: [
      {
        key: 'main',
        fields: [
          { id: 'name', kind: 'text', label: 'Your name', required: true, maxLength: 10 },
          { id: 'email', kind: 'email', label: 'Email' },
          { id: 'phone', kind: 'phone', label: 'Phone', required: true },
          { id: 'budget', kind: 'number', label: 'Budget', min: 1000, max: 50000 },
          { id: 'kind', kind: 'select', label: 'Kind', options: [{ value: 'shop', label: 'A shop' }, { value: 'wall', label: 'A wall' }] },
          { id: 'shop_name', kind: 'text', label: 'Shop name', required: true, dependsOn: { fieldId: 'kind', equals: 'shop' } },
          { id: 'tags', kind: 'multiselect', label: 'Tags', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }], max: 2 },
          { id: 'agree', kind: 'checkbox', label: 'Agree', required: true },
          { id: 'when', kind: 'date', label: 'When', min: '2026-01-01' },
          { id: 'city', kind: 'city', label: 'City' },
          { id: 'category', kind: 'category', label: 'Category' },
          { id: 'where', kind: 'location', label: 'Where' },
          { id: 'photo', kind: 'file', label: 'Photo' },
        ],
      },
    ],
    successMessage: 'ok',
    consentText: 'yes',
    contactMap: { name: 'name', phone: 'phone' },
  },
  'SIGNED_IN',
);

const good = {
  name: ' Asha ',
  email: 'Asha@Example.COM',
  phone: '+91 98765-43210',
  budget: '2500',
  kind: 'shop',
  shop_name: 'Corner',
  tags: ['a', 'a', 'b'],
  agree: 'true',
  when: '2026-03-04',
  city: 'city_pune',
  category: 'outdoor',
  where: { latitude: '18.52', longitude: 73.85, address: ' FC Road ', cityId: 'city_pune' },
  photo: 'https://files.example/1.jpg',
  ghost: 'dropped',
};

describe('validateAnswers', () => {
  it('cleans every kind and drops what the form does not ask', () => {
    const { answers, issues } = validateAnswers(definition, good);
    expect(issues).toEqual([]);
    expect(answers).toEqual({
      name: 'Asha',
      email: 'asha@example.com',
      phone: '+919876543210',
      budget: 2500,
      kind: 'shop',
      shop_name: 'Corner',
      tags: ['a', 'b'],
      agree: true,
      when: '2026-03-04',
      city: 'city_pune',
      category: 'OUTDOOR',
      where: { latitude: 18.52, longitude: 73.85, address: 'FC Road', cityId: 'city_pune' },
      photo: ['https://files.example/1.jpg'],
    });
  });

  it('names every problem at once', () => {
    const { issues } = validateAnswers(definition, {
      name: 'a name that is far too long',
      email: 'not-an-email',
      phone: '12',
      budget: 99,
      kind: 'castle',
      tags: ['a', 'b', 'zzz'],
      agree: false,
      when: '2025-12-31',
      category: 'SKY',
      where: { latitude: 200, longitude: 0 },
      photo: 'not a file',
    });
    expect(issues.map((i) => i.fieldId)).toEqual(['name', 'email', 'phone', 'budget', 'kind', 'tags', 'agree', 'when', 'category', 'where', 'photo']);
    expect(issues.find((i) => i.fieldId === 'agree')!.message).toMatch(/must be ticked/);
    expect(issues.find((i) => i.fieldId === 'budget')!.message).toMatch(/at least 1000/);
  });

  it('requires only what is required, and only when its condition is met', () => {
    const { answers, issues } = validateAnswers(definition, { name: 'A', phone: '9876543210', agree: true, kind: 'wall', shop_name: 'ignored' });
    expect(issues).toEqual([]);
    expect(answers).toEqual({ name: 'A', phone: '9876543210', agree: true, kind: 'wall' });
    const missing = validateAnswers(definition, { kind: 'shop' });
    expect(missing.issues.map((i) => i.fieldId)).toEqual(['name', 'phone', 'shop_name', 'agree']);
  });

  it('counts choices and files', () => {
    expect(validateAnswers(definition, { tags: ['a', 'b', 'a'] }).answers['tags']).toEqual(['a', 'b']);
    const six = Array.from({ length: 6 }, (_, i) => `https://f/${i}`);
    expect(validateAnswers(definition, { photo: six }).issues.find((i) => i.fieldId === 'photo')!.message).toMatch(/at most 5 files/);
    expect(validateAnswers(definition, { photo: '/files/abc' }).answers['photo']).toEqual(['/files/abc']);
  });

  it('reads a file as the upload record the apps and the site send, and a location with a city name', () => {
    const { answers, issues } = validateAnswers(definition, {
      photo: [{ fileId: 'f1', url: 'https://files.example/f1.jpg', name: 'wall.jpg', type: 'image/jpeg' }, { fileId: 'f2', name: 'x.pdf' }],
      where: { latitude: 18.52, longitude: 73.85, address: 'FC Road', city: 'Pune' },
    });
    expect(issues.filter((issue) => issue.fieldId === 'photo' || issue.fieldId === 'where')).toEqual([]);
    expect(answers['photo']).toEqual(['https://files.example/f1.jpg', '/files/f2']);
    expect(answers['where']).toEqual({ latitude: 18.52, longitude: 73.85, address: 'FC Road', city: 'Pune' });
    expect(validateAnswers(definition, { photo: [{ name: 'no-ref' }] }).issues.find((i) => i.fieldId === 'photo')!.message).toMatch(/uploaded file/);
  });

  it('reads a phone loosely and refuses what is not one', () => {
    expect(cleanPhone('+91 (98765) 43210')).toBe('+919876543210');
    expect(cleanPhone('98765')).toBeNull();
  });
});

describe('what the columns take', () => {
  const { answers } = validateAnswers(definition, good);

  it('lifts the mapped contact fields, and the first email when unmapped', () => {
    expect(liftContacts(definition, answers)).toEqual({ contactName: 'Asha', contactEmail: 'asha@example.com', contactPhone: '+919876543210' });
    const unmapped = validateDefinition({ screens: [{ key: 'm', fields: [{ id: 'e', kind: 'email', label: 'E' }, { id: 'p', kind: 'phone', label: 'P' }] }], successMessage: 'x', consentText: 'y' }, 'PUBLIC');
    expect(liftContacts(unmapped, { e: 'a@b.co', p: '9876543210' })).toEqual({ contactName: null, contactEmail: 'a@b.co', contactPhone: '9876543210' });
  });

  it('lifts the first location, else the first city', () => {
    expect(liftPlace(definition, answers)).toEqual({ latitude: 18.52, longitude: 73.85, address: 'FC Road', cityId: 'city_pune' });
    expect(liftPlace(definition, { city: 'city_x' })).toEqual({ latitude: null, longitude: null, address: null, cityId: 'city_x' });
    expect(liftPlace(definition, {})).toEqual({ latitude: null, longitude: null, address: null, cityId: null });
  });

  it('names the city ids and the file refs the answers carry', () => {
    expect(cityIdsIn(definition, answers)).toEqual([{ fieldId: 'city', cityId: 'city_pune' }, { fieldId: 'where', cityId: 'city_pune' }]);
    expect(fileRefsIn(definition, answers)).toEqual(['https://files.example/1.jpg']);
  });

  it('writes "Label: value" as a person reads it', () => {
    const lines = answerLines(definition, answers, new Map([['city_pune', 'Pune']]));
    expect(lines).toEqual([
      'Your name: Asha',
      'Email: asha@example.com',
      'Phone: +919876543210',
      'Budget: 2500',
      'Kind: A shop',
      'Shop name: Corner',
      'Tags: Alpha, Beta',
      'Agree: Yes',
      'When: 2026-03-04',
      'City: Pune',
      'Category: OUTDOOR',
      'Where: FC Road (18.52, 73.85)',
      'Photo: https://files.example/1.jpg',
    ]);
  });
});

describe('resolveCityAnswers', () => {
  const lookup = (value: string) => (value === 'city_pune' || value.toLowerCase() === 'pune' ? { id: 'city_pune', name: 'Pune' } : null);

  it('turns a city name into the catalogue id, on a city answer and on a location', () => {
    const answers = { city: 'pune', where: { latitude: 18.52, longitude: 73.85, city: 'Pune' } } as Record<string, unknown>;
    const { issues, cityNames } = resolveCityAnswers(definition, answers, lookup);
    expect(issues).toEqual([]);
    expect(answers['city']).toBe('city_pune');
    expect(answers['where']).toEqual({ latitude: 18.52, longitude: 73.85, city: 'Pune', cityId: 'city_pune' });
    expect(cityNames.get('city_pune')).toBe('Pune');
  });

  it('refuses an unknown city answer or id, keeps an unknown name on a location', () => {
    const answers = { city: 'Atlantis', where: { latitude: 1, longitude: 2, city: 'Atlantis' } } as Record<string, unknown>;
    expect(resolveCityAnswers(definition, answers, lookup).issues).toEqual([{ fieldId: 'city', message: 'That city is not in the catalogue' }]);
    const byId = { where: { latitude: 1, longitude: 2, cityId: 'city_nowhere' } } as Record<string, unknown>;
    expect(resolveCityAnswers(definition, byId, lookup).issues).toEqual([{ fieldId: 'where', message: 'That city is not in the catalogue' }]);
  });
});

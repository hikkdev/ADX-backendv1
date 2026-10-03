import { describe, expect, it, vi } from 'vitest';
import { comparableListingValue, isCodedListingField } from '../../../shared/listing-vocabulary';

vi.mock('../prisma-pricing.repository', () => ({ prismaPricingRepository: {} }));

import { evaluatePredicate } from '../pricing.service';

/**
 * LD-1 (3 Oct 2026): a listing's elevation, visibility and traffic grade are
 * stored as codes now (ROOFTOP, 50_150M, VERY_HIGH) — and a pricing factor's
 * `suggestWhen` may have been written against the words ("Rooftop"), while
 * older listings may still hold the words. Pinned: either spelling of a
 * coded value matches either, in `eq` and in `in`; a desk word with no code
 * ("Mid-rise") still matches only itself; every other field stays exact.
 */

const facts = (over: Record<string, unknown>) => Object.assign(Object.create(null) as Record<string, unknown>, over);

describe('factor rules on the coded listing columns', () => {
  it('a rule written in words matches a listing stored as a code', () => {
    expect(evaluatePredicate({ field: 'elevation', eq: 'Rooftop' }, facts({ elevation: 'ROOFTOP' }))).toBe(true);
    expect(evaluatePredicate({ field: 'visibility', eq: 'Over 300 m' }, facts({ visibility: 'OVER_300M' }))).toBe(true);
    expect(evaluatePredicate({ field: 'trafficGrade', in: ['High', 'Very high'] }, facts({ trafficGrade: 'VERY_HIGH' }))).toBe(true);
  });

  it('a rule written in codes matches a listing that still holds the words', () => {
    expect(evaluatePredicate({ field: 'elevation', eq: 'GROUND' }, facts({ elevation: 'Ground' }))).toBe(true);
    expect(evaluatePredicate({ field: 'trafficGrade', eq: 'VERY_HIGH' }, facts({ trafficGrade: 'Prime' }))).toBe(true);
    expect(evaluatePredicate({ field: 'visibility', in: ['50_150M', '150_300M'] }, facts({ visibility: '50–150 m' }))).toBe(true);
  });

  it('still tells different values apart', () => {
    expect(evaluatePredicate({ field: 'elevation', eq: 'ROOFTOP' }, facts({ elevation: 'GROUND' }))).toBe(false);
    expect(evaluatePredicate({ field: 'trafficGrade', in: ['LOW', 'MEDIUM'] }, facts({ trafficGrade: 'High' }))).toBe(false);
    expect(evaluatePredicate({ field: 'elevation', eq: 'Rooftop' }, facts({ elevation: null }))).toBe(false);
  });

  it('matches a desk word with no code only to itself (in any case)', () => {
    expect(evaluatePredicate({ field: 'elevation', eq: 'Mid-rise' }, facts({ elevation: 'Mid-rise' }))).toBe(true);
    expect(evaluatePredicate({ field: 'elevation', eq: 'mid-rise' }, facts({ elevation: 'Mid-rise' }))).toBe(true);
    expect(evaluatePredicate({ field: 'elevation', eq: 'Mid-rise' }, facts({ elevation: 'High-rise' }))).toBe(false);
  });

  it('leaves every other field exact', () => {
    expect(isCodedListingField('illumination')).toBe(false);
    expect(evaluatePredicate({ field: 'illumination', eq: 'backlit' }, facts({ illumination: 'BACKLIT' }))).toBe(false);
    expect(evaluatePredicate({ field: 'city', eq: 'Pune' }, facts({ city: 'Pune' }))).toBe(true);
    expect(comparableListingValue('city', 'Pune')).toBe('Pune');
  });
});

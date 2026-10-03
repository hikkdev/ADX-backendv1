import { describe, expect, it } from 'vitest';
import { mobileSearchNeedle } from '../mobile';

/**
 * 29 Sep 2026: the roster search matches a phone the way the console prints
 * it — `+91 98765 43210` — against a row stored as `+919876543210` or as the
 * bare ten digits.
 */
describe('mobileSearchNeedle', () => {
  it('reads the printed form, the stored form and a partial number as their digits', () => {
    expect(mobileSearchNeedle('+91 98765 43210')).toBe('9876543210');
    expect(mobileSearchNeedle('+919876543210')).toBe('9876543210');
    expect(mobileSearchNeedle('98765-43210')).toBe('9876543210');
    expect(mobileSearchNeedle('98765 4')).toBe('987654');
    expect(mobileSearchNeedle('(0) 98765')).toBe('098765');
  });

  it('leaves a name, an email, an id or two digits to the plain search', () => {
    expect(mobileSearchNeedle('Suraj')).toBeNull();
    expect(mobileSearchNeedle('suraj@example.com')).toBeNull();
    expect(mobileSearchNeedle('PUB-1209-2601')).toBeNull();
    expect(mobileSearchNeedle('12')).toBeNull();
  });
});

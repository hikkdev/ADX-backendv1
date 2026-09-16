import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../trust-proxy';

/**
 * The setting that decides whether per-IP rate limits mean anything behind a
 * proxy. Off is the safe default for a process reached directly; the point of
 * the parser is that every deployed environment can say, in one variable,
 * exactly what is in front of it.
 */
describe('TRUST_PROXY', () => {
  it('is off when unset, blank, false or zero hops', () => {
    for (const raw of [undefined, '', '   ', 'false', 'FALSE', '0']) {
      expect(parseTrustProxy(raw)).toBe(false);
    }
  });

  it('is a hop count when numeric', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
  });

  it('trusts the whole chain only when told so in words', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('True')).toBe(true);
  });

  it('passes address lists through for Express to resolve', () => {
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});

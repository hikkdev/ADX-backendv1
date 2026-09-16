import { describe, expect, it } from 'vitest';
import { findDeclaration } from '../../../shared/features';
import '../features';

/**
 * G12-B: the app variant of instant booking is declared server-side, so
 * `PATCH /flags/marketplace.instant-booking { variant }` accepts either
 * without waiting on a manifest sync — `ensureFeatureRegistry` unions the
 * declared variants with the committed document's.
 */
describe('marketplace.instant-booking', () => {
  it('declares the two app variants', () => {
    expect(findDeclaration('marketplace.instant-booking')?.variants).toEqual(['default', 'recommended']);
  });
});

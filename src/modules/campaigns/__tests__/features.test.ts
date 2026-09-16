import { describe, expect, it } from 'vitest';
import { findDeclaration } from '../../../shared/features';
import '../features';

/**
 * G12-B: the app variant of multi-market campaigns is declared server-side,
 * so `PATCH /flags/campaigns.multi-market { variant }` accepts either
 * without waiting on a manifest sync — `ensureFeatureRegistry` unions the
 * declared variants with the committed document's.
 */
describe('campaigns.multi-market', () => {
  it('declares the two app variants', () => {
    expect(findDeclaration('campaigns.multi-market')?.variants).toEqual(['default', 'unwarned']);
  });
});

import { describe, expect, it } from 'vitest';
import { submitDocumentSchema } from '../supply.schema';

/**
 * LF-2 (28 Sep 2026): the listing flow files the audience evidence as listing
 * documents of their own kinds — a BARC / TAM rating sheet and a footfall
 * audit — through the same door as the venue papers.
 */
describe('the documents door', () => {
  it('takes the two audience reports as their own kinds', () => {
    for (const kind of ['AUDIENCE_RATING', 'FOOTFALL_AUDIT']) {
      expect(submitDocumentSchema.safeParse({ kind, url: 'https://files.example/report.pdf' }).success).toBe(true);
    }
  });

  it('still refuses a kind it does not know', () => {
    expect(submitDocumentSchema.safeParse({ kind: 'AADHAAR', url: 'https://files.example/x.pdf' }).success).toBe(false);
  });
});

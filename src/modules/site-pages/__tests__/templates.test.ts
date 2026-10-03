import { describe, expect, it } from 'vitest';
import { validateBlocks } from '../../layouts';
import { PAGE_TEMPLATES, templateBlocks } from '../templates';

/**
 * PB-1 — a new page's first draft. Pinned: every template validates in the
 * CUSTOM scope as it stands, `blank` is empty, the ids come from the
 * injected generator, and the landing template carries no form block (a
 * form needs a key a template cannot give).
 */

describe('page templates', () => {
  it('each validate as a custom page, exactly as shipped', () => {
    for (const template of PAGE_TEMPLATES) {
      const blocks = templateBlocks(template, 'Diwali offers');
      expect(validateBlocks('CUSTOM', blocks).issues, template).toEqual([]);
    }
  });

  it('are the shapes the contract names', () => {
    expect(templateBlocks('blank', 'x')).toEqual([]);
    expect(templateBlocks('event', 'x').map((block) => block.type)).toEqual(['hero', 'columns', 'listing_grid', 'faq', 'cta_strip']);
    expect(templateBlocks('landing', 'x').map((block) => block.type)).toEqual(['hero', 'stats', 'steps', 'cta_strip']);
  });

  it('put the title in the hero and take their ids from the generator', () => {
    let n = 0;
    const blocks = templateBlocks('landing', 'Diwali offers', () => `id-${++n}`);
    expect(blocks.map((block) => block.id)).toEqual(['id-1', 'id-2', 'id-3', 'id-4']);
    expect(blocks[0]!.props['headline']).toBe('Diwali offers');
    expect(new Set(templateBlocks('event', 'x').map((block) => block.id)).size).toBe(5);
  });
});

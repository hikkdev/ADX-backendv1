import { randomUUID } from 'node:crypto';
import type { Block } from '../layouts';

/**
 * PB-1 (27 Sep 2026): what a new page starts with. Three shapes, each a
 * list of content blocks with placeholder copy the desk overwrites; every
 * one validates in the `CUSTOM` scope as it stands, so version 1 is a real
 * draft the moment the page exists. `landing` leaves the form out — a form
 * block needs a form key, and a template has none to give.
 */

export const PAGE_TEMPLATES = ['blank', 'event', 'landing'] as const;
export type PageTemplate = (typeof PAGE_TEMPLATES)[number];

export const TEMPLATE_LABEL: Record<PageTemplate, string> = {
  blank: 'Blank — start from nothing',
  event: 'Event — hero, columns, a grid of spaces, questions, a call to action',
  landing: 'Landing — hero, figures, steps, a call to action',
};

const hero = (id: string, title: string): Block => ({
  id,
  type: 'hero',
  props: {
    headline: title,
    subheadline: 'One line on what this page is for.',
    primaryCta: { label: 'Explore ad spaces', target: { kind: 'EXPLORE' } },
    align: 'LEFT',
  },
});

const ctaStrip = (id: string): Block => ({
  id,
  type: 'cta_strip',
  props: { headline: 'Ready to advertise?', body: 'Book a space in minutes.', ctaLabel: 'Start a campaign', target: { kind: 'NEW_CAMPAIGN' }, tone: 'BRAND' },
});

/** The blocks a template starts a page with. `id` is injectable so a test can pin them. */
export function templateBlocks(template: PageTemplate, title: string, id: () => string = randomUUID): Block[] {
  switch (template) {
    case 'blank':
      return [];
    case 'event':
      return [
        hero(id(), title),
        {
          id: id(),
          type: 'columns',
          props: {
            columns: [
              { title: 'What', markdown: 'What is happening, and when.' },
              { title: 'Where', markdown: 'Where it is, and how to get there.' },
            ],
          },
        },
        { id: id(), type: 'listing_grid', props: { title: 'Spaces to book', source: 'NEWEST', count: 6, columns: 3 } },
        { id: id(), type: 'faq', props: { title: 'Questions', items: [{ question: 'How do I book?', answer: 'Pick a space, choose your dates, and pay.' }] } },
        ctaStrip(id()),
      ];
    case 'landing':
      return [
        hero(id(), title),
        {
          id: id(),
          type: 'stats',
          props: {
            items: [
              { value: '1,000+', label: 'ad spaces' },
              { value: '50', label: 'cities' },
              { value: '24 h', label: 'to go live' },
            ],
          },
        },
        {
          id: id(),
          type: 'steps',
          props: {
            title: 'How it works',
            items: [
              { title: 'Find a space', body: 'Browse by city, category or venue.' },
              { title: 'Book it', body: 'Choose your dates and pay online.' },
              { title: 'Go live', body: 'Your creative goes up; you track it here.' },
            ],
          },
        },
        ctaStrip(id()),
      ];
  }
}

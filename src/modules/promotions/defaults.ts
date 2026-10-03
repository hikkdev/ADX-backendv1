/**
 * LM-1: the inventory ADX starts selling with — four ad slots and the two
 * sponsored-listing placements. These are DEFAULTS: the seed writes them once
 * (create-only, never over an edit) and ADX changes every figure in the
 * console (Growth › Promotions). Nothing reads these at request time.
 *
 * No imports on purpose: `prisma/seed.ts` and the dev script read this file.
 * The artwork size specs the slots name (`AD_SIDEBAR`, `AD_BANNER`,
 * `PROMO_WIDE`) are `media`'s — `MEDIA_SPECS` — never a copy here.
 */

export type DefaultAdSlot = {
  key: string;
  label: string;
  description: string;
  surfaces: ('WEB_HOME' | 'WEB_EXPLORE' | 'WEB_FORMATS' | 'WEB_LISTING' | 'APP_ADVERTISER_HOME' | 'APP_PUBLISHER_HOME' | 'APP_PARTNER_HOME' | 'AGENT_HOME')[];
  spec: string;
  ratePerDay: string;
  maxConcurrent: number;
  minDays: number;
};

export const DEFAULT_AD_SLOTS: readonly DefaultAdSlot[] = [
  {
    key: 'WEB_LISTING_SIDEBAR',
    label: 'Listing page sidebar',
    description: 'Below the booking card on every listing page of the website.',
    surfaces: ['WEB_LISTING'],
    spec: 'AD_SIDEBAR',
    ratePerDay: '1500.00',
    maxConcurrent: 3,
    minDays: 1,
  },
  {
    key: 'WEB_EXPLORE_BANNER',
    label: 'Explore banner',
    description: 'A full-width banner on the website\'s Explore page.',
    surfaces: ['WEB_EXPLORE'],
    spec: 'AD_BANNER',
    ratePerDay: '2500.00',
    maxConcurrent: 2,
    minDays: 1,
  },
  {
    key: 'WEB_HOME_BANNER',
    label: 'Home page banner',
    description: 'A full-width banner on the website\'s home page.',
    surfaces: ['WEB_HOME'],
    spec: 'AD_BANNER',
    ratePerDay: '3000.00',
    maxConcurrent: 2,
    minDays: 1,
  },
  {
    key: 'APP_ADVERTISER_HOME_BANNER',
    label: 'Advertiser app home banner',
    description: 'A wide banner on the home screen of the advertiser app.',
    surfaces: ['APP_ADVERTISER_HOME'],
    spec: 'PROMO_WIDE',
    ratePerDay: '2000.00',
    maxConcurrent: 3,
    minDays: 1,
  },
];

export type DefaultBoostPlacement = { placement: 'SEARCH_TOP' | 'SIMILAR_TOP'; label: string; ratePerDay: string; maxConcurrent: number; minDays: number };

export const DEFAULT_BOOST_PLACEMENTS: readonly DefaultBoostPlacement[] = [
  { placement: 'SEARCH_TOP', label: 'Top of search results', ratePerDay: '800.00', maxConcurrent: 2, minDays: 1 },
  { placement: 'SIMILAR_TOP', label: 'Top of "Similar listings"', ratePerDay: '400.00', maxConcurrent: 3, minDays: 1 },
];

import { feature } from '../../shared/features';

/**
 * Features of `promotions` — LM-1 (27 Sep 2026): the paid placements ADX
 * sells. "I will sell them to advertisers. For example: someone wants to
 * promote an event or some advertiser wants their space advertised above all
 * similar listings." (the owner)
 *
 * Two console switches for the two things sold — off, the buyer routes answer
 * 503 FEATURE_OFF and the public reads carry no ads / no sponsored listings —
 * and the desk, which stays open either way so ADX can still refund, cancel
 * and read the numbers.
 */

feature('promotions.ads', {
  surfaces: ['WEBSITE', 'APP_USER', 'CONSOLE', 'BACKEND'],
  owner: 'growth',
  kind: 'KILL_SWITCH',
  launch: 'on',
  description:
    'LM-1: display ads sold in ad slots — an advertiser books a slot for dates, uploads artwork, pays; ADX reviews it; it rotates in the slot, labelled "Ad", with impressions and clicks back to the buyer.',
  routes: ['/api/v1/promotions/slots', '/api/v1/promotions/ads'],
});

feature('promotions.boosts', {
  surfaces: ['WEBSITE', 'APP_USER', 'CONSOLE', 'BACKEND'],
  owner: 'growth',
  kind: 'KILL_SWITCH',
  launch: 'on',
  description:
    'LM-1: sponsored listings — a publisher pays to have their own listing shown first at the top of search and/or of the "Similar listing" row, labelled "Sponsored".',
  routes: ['/api/v1/promotions/boost', '/api/v1/promotions/boosts'],
});

feature('promotions.desk', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'growth',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'LM-1: the Growth desk for paid placements — slots, placements and prices, the artwork review, cancellations and refunds, the numbers — plus the impression and click counter the clients feed and the daily lifecycle sweep.',
  routes: ['/api/v1/promotions', '/api/v1/promotions/admin', '/api/v1/app/promotions'],
  jobs: ['promotions'],
});

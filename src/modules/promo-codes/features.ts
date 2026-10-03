import { feature } from '../../shared/features';

/**
 * Features of `promo-codes` — PC-1 (DR 12, 25 Sep 2026).
 *
 * The desk where ops make and switch codes, and the door where an
 * advertiser types one onto a booking (`campaigns`' `/campaigns/:id/promo`,
 * declared here so the two halves are one switch).
 */

feature('promo-codes.desk', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'PC-1: promo codes — percent or flat rupees off a booking\'s media and production, with caps, windows and limits; made and switched under Growth › Promo codes.',
  routes: ['/api/v1/promo-codes'],
});

feature('campaigns.promo-codes', {
  surfaces: ['APP_USER', 'WEBSITE', 'BACKEND'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'PC-1: "Have a promo code?" on Review & pay — a code applied to the campaign before it is paid; counted as redeemed when it is.',
  routes: ['/api/v1/campaigns/:id/promo'],
});

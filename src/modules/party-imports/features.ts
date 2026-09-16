import { feature } from '../../shared/features';

/**
 * Features of `party-imports` — Lot S.
 *
 * One key: the two-step import (validate with a per-row report, then
 * commit) for advertisers, agents, print partners and employees.
 */

feature('console.party-imports', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot S: the legacy-book import for advertisers, agents, print partners and employees — validate with a per-row report, commit through each party\'s own creation service, revoke, report.csv.',
  routes: ['/api/v1/party-imports'],
});

feature('console.listing-imports', {
  surfaces: ['CONSOLE', 'APP_AGENT'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot U: a publisher\'s spots and rate card imported on their behalf — validate with a per-row plan (geocoding, the vocabulary, the ADX floor, 25 m duplicates), commit under one supply attempt or through the listing\'s own rate door, revoke, report.csv. ADMIN, or the publisher\'s agent under the listing act rule.',
  routes: ['/api/v1/party-imports/listings', '/api/v1/party-imports/rate-card'],
});

feature('console.import-formats', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot U: the format guide — one JSON per import kind on the platform (columns, rules, sample rows) and a template.csv per kind, derived from the validators.',
  routes: ['/api/v1/party-imports/formats'],
});

import { feature } from '../../shared/features';

feature('competitors.sightings', {
  surfaces: ['APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'growth',
  kind: 'FEATURE',
  launch: 'on',
  description:
    "VA-2 (23 Sep 2026): competitors' hoardings photographed by our agents with the GPS camera — filed with the brand and the surface, listed and analysed at the desk, exported as a corpus for analysis and training.",
  routes: ['/api/v1/competitor-sightings'],
});

import { feature } from '../../shared/features';

/**
 * Features of `media` — LM-1 (27 Sep 2026).
 *
 * The picture library the layouts and the paid placements draw from.
 */

feature('content.media', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'LM-1 (27 Sep 2026): the media library — every picture a layout block, a tile or an ad draws, checked against its size spec on upload (shape within 1%, a minimum size, a byte cap), with alt text, a title and tags. Archived, never deleted; a picture a published layout draws cannot be archived.',
  routes: ['/api/v1/media'],
});

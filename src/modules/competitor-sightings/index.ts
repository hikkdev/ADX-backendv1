/**
 * VA-2 — competitors' hoardings, photographed by our agents.
 *
 * Imports `agents` (whose agent filed it) and `uploads` (the stamped photo,
 * and the picture read back for the model); nothing imports this module.
 */
export { competitorSightingRouter } from './competitor-sightings.routes';
export { logSighting, listSightings, getSighting, analyseSighting, exportSightings, sightingsToCsv, parseSightingAnalysis, toSightingView } from './competitor-sightings.service';
export type { SightingView, SightingAnalysis } from './competitor-sightings.service';
export { SIGHTING_FORMATS } from './competitor-sightings.schema';
export type { SightingFormat } from './competitor-sightings.schema';

import './features';

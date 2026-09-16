/**
 * Safety — an agent's report that a site is unsafe, and the live-location
 * share beside it. The one DR 07 screen whose control does something
 * irreversible: a blocking report takes the job off the agent and tells
 * every admin at once.
 */
export { safetyRouter } from './safety.routes';
export { BLOCKING_KINDS, KIND_LABEL as SAFETY_KIND_LABEL, SAFETY_KINDS } from './safety.types';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

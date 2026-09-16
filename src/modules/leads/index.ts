/**
 * DR 06 — leads.
 *
 * The public surface. `leadClusters` is what the agents module reads to fill
 * the map layer that has been rendering an empty array since the dashboard was
 * built; everything else is reached over HTTP.
 */
export { leadRouter } from './leads.routes';
export { leadClusters } from './leads.service';
/** Lot V: the city wind-down's duty here — every open lead in the city LOST, reason on the thread. */
export { closeOpenLeadsInCity, CITY_WITHDRAWN_LOSS } from './leads.service';
export type { LeadCard } from './leads.service';
/** W-B: the coming-soon waitlist — `geo` creates the lead through this; the phone rule dedupes, the account half of it does not apply. */
export { registerWaitlistLead, WAITLIST_SOURCE } from './leads.service';
export type { WaitlistLeadInput } from './leads.service';
export type { LeadCluster, LeadClusterScope } from './leads.repository';
export { leadPillOf, isOpenLead, LEAD_STATUSES } from './leads.schema';
/** Lot U: the row the leads importer takes, read by `party-imports`' format guide. */
export { createLeadSchema, LEAD_SIDES } from './leads.schema';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

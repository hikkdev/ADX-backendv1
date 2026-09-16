/**
 * Disputes — a case raised by any party to an order, worked by ADX.
 *
 * One domain for the agent app, the user app's two personas and the console.
 * The router is nearly the whole public surface; the projection the apps and
 * the console share is exported as a pure rule, and (Lot F) bootstrap reads
 * the parties of a case for the evidence-file door.
 */
export { disputeRouter } from './disputes.routes';
export { agentStateOf } from './disputes.types';
/** Lot F: for bootstrap's `FileAccessPort` — who is a party to the case a DISPUTE_EVIDENCE file sits on. */
export { disputePartiesForEvidenceFile } from './disputes.service';
export type { AgentDisputeState } from './disputes.types';

/**
 * E7-3: the port bootstrap fills from `publishers`, `advertisers` and `agents`
 * so the ADMIN read can name the record a case is against without this
 * module importing the three.
 */
export { registerPartyLookupPort, resetPartyLookupPort } from './party-lookup.port';
export type { PartyLookupPort, PartyRecord, PartyRecordType } from './party-lookup.port';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

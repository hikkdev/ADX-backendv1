/**
 * Party imports — Lot S: the publisher importer, generalised.
 *
 * One two-step import (validate with a per-row report, then commit) for the
 * four parties that had none: advertisers, agents, print partners and
 * employees. The module owns `PartyImport` and `PartyImportRow` and nothing
 * else — every party it creates or merges goes through that party's own
 * service, so display ids, wallets, brands, users, roles, kycStatus PENDING
 * and the creation audit rows happen exactly as a console Create.
 */
export { partyImportsRouter } from './party-imports.routes';
export { PARTY_KEYS } from './party-imports.schema';
export type { PartyKey } from './party-imports.schema';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

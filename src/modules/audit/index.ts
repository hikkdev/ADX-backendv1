/**
 * Audit — the console's window onto the trail shared/audit writes.
 *
 * Only the router leaves. Writing to the trail is `logActivity` in
 * shared/audit, which every module already imports; this module reads it.
 */
export { auditRouter } from './audit.routes';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

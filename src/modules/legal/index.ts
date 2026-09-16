/**
 * Legal — the read documents: the ten DR 07 policies, Contact info, About,
 * FAQs, Safety guidelines and the licences. Versioned like agreements and
 * edited from the console; read by both apps without a token.
 *
 * Nothing here is called by another module, so the router is the whole
 * public surface.
 */
export { legalRouter } from './legal.routes';
export { KIND_META as LEGAL_KIND_META, LEGAL_KINDS } from './legal.types';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

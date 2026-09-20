/**
 * Legal — the read documents: the ten DR 07 policies, Contact info, About,
 * FAQs, Safety guidelines and the licences. Versioned like agreements and
 * edited from the console; read by both apps without a token.
 *
 * One read is called by another module (QR-6: `users` stamps a person's
 * consent with the live terms and privacy versions); the router is the rest.
 */
export { legalRouter } from './legal.routes';
export { KIND_META as LEGAL_KIND_META, LEGAL_KINDS } from './legal.types';
/** QR-6: the live version of a document — `users` stamps the consent with the terms' and the privacy policy's. */
export { currentDocument as currentLegalDocument } from './legal.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

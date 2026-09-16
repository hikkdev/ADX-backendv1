/**
 * Integrations — the admin UI over third-party provider credentials.
 *
 * This module owns the *screen*, not the storage. Resolving effective config
 * (stored override falling back to .env, Redis-cached) lives in
 * `shared/integrations`, because shared/sms, shared/email and shared/storage
 * all read it and shared may not import a business module.
 */
export { integrationsRouter } from './integrations.routes';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

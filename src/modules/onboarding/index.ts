/**
 * Onboarding — the admin-driven intake flow for publishers, advertisers and
 * partners: versioned flow templates and the submissions captured against them.
 *
 * Distinct from publisher onboarding in `publishers`, which is the QR-claim
 * flow an agent runs on site. This module is the back-office intake form.
 */
export { onboardingRouter } from './onboarding.routes';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

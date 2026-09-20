/**
 * Branding — QR-11 (17 Sep 2026): the brand manager behind Settings › Brand
 * & theme. A draft (the integrations row's `branding` section), Publish
 * into an append-only release history, restore. The LIVE brand every
 * surface reads is `shared/integrations`' `getBrand`, served publicly by
 * app-config's `GET /app/branding`; nothing here is read by another module.
 */
export { brandingRouter } from './branding.routes';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

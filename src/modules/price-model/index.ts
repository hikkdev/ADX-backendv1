/**
 * The manual pricing model — the levers ops pulls by hand, and the quotes they
 * produce.
 *
 * Three modules now share the pricing surface, and they are separate because
 * they answer different questions:
 *
 * - `pricing` suggests from the market within 200 m and blocks nothing.
 * - `rate-cards` holds what ADX has approved, and gates publishing on it.
 * - this one holds the multipliers, sector rules and conditional rules an
 *   operator sets by hand, and builds a quote out of them.
 */
export { priceModelRouter } from './price-model.routes';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

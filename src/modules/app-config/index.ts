/**
 * App config — the single `AppConfig` row holding the enum catalogue and the
 * flow-editor definitions the agent app boots from.
 *
 * Distinct from `src/config/`, which is process environment validation, and
 * from `integrations`, which owns provider credentials in a different row.
 */
export { configRouter } from './app-config.routes';
export { APP_ENUMS } from './app-enums';

/** Used by `order-milestones` to pick a default plan for a listing category. */
export { getCategoryPlanId } from './app-config.service';

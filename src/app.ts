import { createApp } from './bootstrap/create-app';

/**
 * The wired application. Kept as a module-level singleton because supertest and
 * scripts/collect-routes.ts both import it directly; server.ts adds the
 * listener.
 */
export const app = createApp();

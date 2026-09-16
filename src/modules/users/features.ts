import { feature } from '../../shared/features';

/**
 * Features of `users` — Lot G (answer 144).
 *
 * The account behind every party: the profile a person edits, the directory
 * the console reads, and the two admin powers (invites, impersonation).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('users.directory', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The console\'s user directory: list, create, edit, delete, reset password and 2FA, bootstrap the first admin.',
  routes: ['/api/v1/users'],
});

feature('users.profile', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'A person\'s own account: profile, party choice, onboarding manifest, preferences, activity, email resubscribe.',
  routes: ['/api/v1/users/me'],
});

feature('users.sessions', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'DR 07: the devices signed in, and signing them out one by one or all at once.',
  routes: ['/api/v1/users/me/sessions', '/api/v1/users/:id/sessions'],
});

feature('users.contacts', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'K-B1: the contacts beside the primary pair — add, label, prove with a code, make one the primary; the desk does the same with a reason.',
  routes: ['/api/v1/users/me/contacts', '/api/v1/users/:id/contacts'],
});

feature('users.admin-invites', {
  surfaces: ['CONSOLE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Inviting a console user by email, resending and withdrawing the invite.',
  routes: ['/api/v1/users/invites'],
});

feature('users.impersonation', {
  surfaces: ['CONSOLE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Read the platform as a party sees it — a 15-minute read-only token, listed and ended here.',
  routes: ['/api/v1/users/impersonations', '/api/v1/users/:id/impersonate'],
});

import { feature } from '../../shared/features';

/**
 * Features of `auth` — Lot G (answer 144).
 *
 * Sign-in: the OTP door the phones use, the password door the console uses,
 * and the moves a session makes on its own credentials.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('auth.otp-sign-in', {
  surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'OTP sign-in by SMS or email for both phone apps, refresh and logout — the door everything else is behind.',
  routes: ['/api/v1/auth'],
});

feature('auth.password-sign-in', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Password sign-in, forgot / reset / change password — the console door.',
  routes: [
    '/api/v1/auth/login-password',
    '/api/v1/auth/forgot-password',
    '/api/v1/auth/reset-password',
    '/api/v1/auth/change-password',
  ],
});

feature('auth.google-sign-in', {
  surfaces: ['APP_USER', 'BACKEND'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Sign in with Google on the user app.',
  routes: ['/api/v1/auth/google'],
});

feature('auth.two-factor', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The console\'s second factor: a code sent and verified at sign-in.',
  routes: ['/api/v1/auth/2fa'],
});

feature('auth.authenticator-app', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot K2: an authenticator app (RFC 6238 TOTP) as the console second factor: enrol, confirm, disable, recovery codes, the status read; the sign-in half rides on auth.two-factor.',
  routes: ['/api/v1/auth/2fa/totp', '/api/v1/auth/2fa/recovery-codes', '/api/v1/auth/2fa/status'],
});

feature('auth.change-mobile', {
  surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot F (Q18): the sign-in number moves in two codes, the old number first.',
  routes: ['/api/v1/auth/change-mobile'],
});

feature('auth.admin-invites', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'An admin invite is opened and accepted here; it is minted under users.admin-invites.',
  routes: ['/api/v1/auth/invites', '/api/v1/auth/accept-invite'],
});

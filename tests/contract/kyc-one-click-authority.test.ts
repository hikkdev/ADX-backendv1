import { describe, expect, it } from 'vitest';
import type { Router } from 'express';

/**
 * N3-B (the owner, 14 Sep 2026): "ADX Admin/Super Admin and other people
 * who'll be granted authority should be able to send a Digio KYC request to
 * the user with click of a button."
 *
 * What is pinned: every one of the five request routes is guarded by
 * `requirePermission('kyc.edit')` — the catalogue's KYC edit tier — beside
 * `requireRole('ADMIN')`, so a role config granted `kyc.edit` may send a
 * request while the super admin and an admin with no role config pass under
 * the launch rule (`hasPermission`: a token with no `perms` and the ADMIN
 * role holds everything). And the body's channel defaults to DIGIO, so the
 * console's one click needs no body at all.
 */

import { advertiserKycRouter, agentKycRouter, employeeKycRouter, kycRequestSchema } from '../../src/modules/kyc';
import { publisherRouter } from '../../src/modules/publishers';
import { printPartnerKycRouter } from '../../src/modules/print-partners';
import { hasPermission, missingPermissions } from '../../src/shared/auth';

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { name: string }[] }; name: string };

/** The handler names on one route of a router — the guards are named after what they check. */
function guardsOf(router: Router, method: string, path: string): string[] {
  const layer = (router.stack as unknown as Layer[]).find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} is not on the router`);
  return layer.route.stack.map((h) => h.name);
}

/** The router-level guards (`router.use(...)`) — the print partner desk guards ADMIN there. */
function routerGuards(router: Router): string[] {
  return (router.stack as unknown as Layer[]).filter((l) => !l.route).map((l) => l.name);
}

describe('the one click is the KYC edit tier on every party', () => {
  it.each([
    ['advertiser', advertiserKycRouter, '/:id/request'],
    ['agent', agentKycRouter, '/:agentId/request'],
    ['employee', employeeKycRouter, '/:employeeId/request'],
    ['publisher', publisherRouter, '/kyc-queue/:publisherId/request'],
  ] as const)('%s: POST …/request is requireRole(ADMIN) + requirePermission(kyc.edit)', (_party, router, path) => {
    const guards = guardsOf(router, 'post', path);
    expect(guards).toContain('requireRole(ADMIN)');
    expect(guards).toContain('requirePermission(kyc.edit)');
  });

  it('print partner: ADMIN at the router, requirePermission(kyc.edit) on POST /:id/request', () => {
    expect(routerGuards(printPartnerKycRouter)).toContain('requireRole(ADMIN)');
    expect(guardsOf(printPartnerKycRouter, 'post', '/:id/request')).toContain('requirePermission(kyc.edit)');
  });

  it('a role config granted kyc.edit passes; one without it is refused; the super admin and an admin with no role config pass under the launch rule', () => {
    expect(hasPermission({ roles: ['ADMIN'], perms: ['kyc.view', 'kyc.edit'] }, 'kyc.edit')).toBe(true);
    expect(missingPermissions({ roles: ['ADMIN'], perms: ['kyc.view'] }, ['kyc.edit'])).toEqual(['kyc.edit']);
    // No `perms` on the token — an admin with no role config, or a token minted before perms existed — holds everything.
    expect(hasPermission({ roles: ['ADMIN'] }, 'kyc.edit')).toBe(true);
    expect(hasPermission({ roles: ['PUBLISHER'] }, 'kyc.edit')).toBe(false);
  });

  it('the body defaults the channel to DIGIO, so the click needs no body', () => {
    expect(kycRequestSchema.parse({})).toEqual({ channel: 'DIGIO' });
    expect(kycRequestSchema.parse({ note: 'Before Friday' })).toEqual({ channel: 'DIGIO', note: 'Before Friday' });
    expect(kycRequestSchema.parse({ channel: 'manual' })).toEqual({ channel: 'MANUAL' });
  });
});

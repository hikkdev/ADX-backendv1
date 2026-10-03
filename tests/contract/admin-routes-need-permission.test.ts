import { beforeAll, describe, expect, it } from 'vitest';
import { collectRoutes, type RouteEntry } from '../../scripts/collect-routes';
import { PERMISSIONS } from '../../src/shared/auth';
// The schema file alone: importing the module would register its routes ahead of the collector.
import { ENTITY_GROUP } from '../../src/modules/custom-fields/custom-fields.schema';

/**
 * RP-2 / RP-3 (24 Sep 2026) — every admin route asks for a permission, at the
 * catalogue's finer grain.
 *
 * RP-1 made the console role the only source of permissions; this pins the
 * other half: a route an ADMIN can reach carries `requirePermission(...)`,
 * so a role's list means the same thing on every desk, not only on the
 * eighty-seven routes that happened to ask before. The exceptions are the
 * routes an operator uses about themselves — their own second factor, their
 * own tasks, their own flag view — and they are listed here by pattern so a
 * new self-service route is exempted on purpose, never by omission.
 *
 * Also pinned: the permission guard sits behind the role guard. On a route a
 * party may call as well, `requirePermission` reads which role admitted the
 * token from `res.locals.matchedRoles`, which `requireRole` stamps — the
 * order is the mechanism.
 */
const SELF_SERVICE = [/^\/api\/v1\/auth\/2fa\//, /^\/api\/v1\/work\/me(\/|$)/, /^\/api\/v1\/flags\/me$/];

const rolesOf = (route: RouteEntry): string[] | null => {
  const entry = route.chain.find((c) => c.startsWith('requireRole('));
  return entry ? entry.slice('requireRole('.length, -1).split('|') : null;
};
/**
 * CF-1 (28 Sep 2026): a custom field's values are read and written under the
 * record's own group — `supply` for a publisher or listing, `demand` for an
 * advertiser, `marketplace` for a lead — so `requireEntityPermission(tier)`
 * picks one of those at request time. It reads here as the permissions it may
 * ask for, from the module's own map, so a new entity cannot slip in unguarded.
 */
const entityPermissions = (tier: string): string[] => [...new Set(Object.values(ENTITY_GROUP))].map((group) => `${group}.${tier}`);
const permissionsOf = (route: RouteEntry): string[] => [
  ...route.chain.filter((c) => c.startsWith('requirePermission(')).flatMap((c) => c.slice('requirePermission('.length, -1).split('|')),
  ...route.chain.filter((c) => c.startsWith('requireEntityPermission(')).flatMap((c) => entityPermissions(c.slice('requireEntityPermission('.length, -1))),
];

let admin: RouteEntry[] = [];

beforeAll(async () => {
  admin = (await collectRoutes()).filter((route) => rolesOf(route)?.includes('ADMIN'));
}, 60_000);

describe('every admin route asks for a permission', () => {
  it('reaches the admin surface', () => {
    expect(admin.length).toBeGreaterThan(700);
  });

  it('carries requirePermission on every route an ADMIN can reach, except the self-service ones', () => {
    const bare = admin
      .filter((route) => permissionsOf(route).length === 0)
      .filter((route) => !SELF_SERVICE.some((rx) => rx.test(route.path)))
      .map((route) => `${route.method} ${route.path}`);
    expect(bare).toEqual([]);
  });

  it('exempts exactly the self-service routes, and only them', () => {
    const exempt = admin.filter((route) => SELF_SERVICE.some((rx) => rx.test(route.path)));
    expect(exempt.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [
        'GET /api/v1/flags/me',
        'GET /api/v1/work/me/summary',
        'GET /api/v1/work/me/tasks',
        'GET /api/v1/work/me/tasks/:taskId',
        'POST /api/v1/work/me/tasks/:taskId/comments',
        'POST /api/v1/work/me/tasks/:taskId/review',
        'POST /api/v1/work/me/tasks/:taskId/status',
        'POST /api/v1/work/me/tasks/:taskId/time-logs',
      ].sort(),
    );
    for (const route of exempt) expect(permissionsOf(route)).toEqual([]);
  });

  it('asks only for ids the catalogue produces', () => {
    const known = new Set(PERMISSIONS);
    const unknown = admin.flatMap((route) => permissionsOf(route).filter((id) => !known.has(id)));
    expect(unknown).toEqual([]);
  });

  it('puts the permission guard behind the role guard, which is what lets a party pass a shared route', () => {
    const misordered = admin
      .filter((route) => permissionsOf(route).length > 0)
      .filter((route) => {
        const role = route.chain.findIndex((c) => c.startsWith('requireRole('));
        const perm = route.chain.findIndex((c) => c.startsWith('requirePermission(') || c.startsWith('requireEntityPermission('));
        return perm < role;
      })
      .map((route) => `${route.method} ${route.path}`);
    expect(misordered).toEqual([]);
  });

  it('guards the escalation paths by name: roles, role assignment, the audit export, erasure', () => {
    const by = (method: string, path: string) => permissionsOf(admin.find((r) => r.method === method && r.path === path)!);
    expect(by('POST', '/api/v1/roles-config')).toEqual(['system.roles']);
    expect(by('PUT', '/api/v1/roles-config/:id')).toEqual(['system.roles']);
    expect(by('DELETE', '/api/v1/roles-config/:id')).toEqual(['system.roles']);
    expect(by('PUT', '/api/v1/users/:id/role-config')).toEqual(['system.roles']);
    expect(by('POST', '/api/v1/users')).toEqual(['system.edit']);
    expect(by('POST', '/api/v1/users/invites')).toEqual(['system.edit']);
    expect(by('GET', '/api/v1/audit/export.csv')).toEqual(['system.audit.export']);
    expect(by('POST', '/api/v1/users/erasure/:id/execute')).toEqual(['dpo.erasure']);
  });

  it('puts the decisions on the approve tier', () => {
    const by = (method: string, path: string) => permissionsOf(admin.find((r) => r.method === method && r.path === path)!);
    expect(by('PATCH', '/api/v1/advertiser-kyc/:id/review')).toEqual(['kyc.approve']);
    expect(by('POST', '/api/v1/publishers/:publisherId/kyc/review')).toEqual(['kyc.approve']);
    expect(by('PATCH', '/api/v1/advertisers/refund-requests/:requestId/decide')).toEqual(['finance.approve']);
    expect(by('POST', '/api/v1/finance/withdrawals/:id/approve')).toEqual(['finance.approve']);
    expect(by('PATCH', '/api/v1/supply/claims/:claimId/decide')).toEqual(['supply.approve']);
    expect(by('POST', '/api/v1/content/pages/:id/publish')).toEqual(['content.approve']);
    expect(by('POST', '/api/v1/agents/:id/application/decision')).toEqual(['agents.approve']);
    expect(by('POST', '/api/v1/rate-cards/:id/approve')).toEqual(['pricing.approve']);
  });

  /* RP-3: the actions an Edit tier must not carry are named powers of their own. */
  it('names the powers an edit tier must not carry: suspending, issuing credit, jobs, imports, deletes, accounts, exports', () => {
    const by = (method: string, path: string) => permissionsOf(admin.find((r) => r.method === method && r.path === path)!);
    expect(by('POST', '/api/v1/publishers/:id/suspend')).toEqual(['supply.suspend']);
    expect(by('POST', '/api/v1/advertisers/:id/suspend')).toEqual(['demand.suspend']);
    expect(by('POST', '/api/v1/agents/:id/exit')).toEqual(['agents.suspend']);
    expect(by('POST', '/api/v1/print-partners/:id/deactivate')).toEqual(['print.suspend']);
    expect(by('POST', '/api/v1/advertisers/:id/wallet/top-up')).toEqual(['finance.issue']);
    expect(by('POST', '/api/v1/advertisers/:id/wallet/goodwill')).toEqual(['finance.issue']);
    expect(by('POST', '/api/v1/finance/accrual/run')).toEqual(['system.jobs']);
    expect(by('POST', '/api/v1/supply/enforcement/sweep')).toEqual(['system.jobs']);
    expect(by('POST', '/api/v1/geo/seed')).toEqual(['system.jobs']);
    expect(by('POST', '/api/v1/publishers/imports/:id/commit')).toEqual(['supply.import']);
    expect(by('POST', '/api/v1/party-imports/rate-card/:id/commit')).toEqual(['pricing.import']);
    expect(by('POST', '/api/v1/party-imports/:party/:id/commit')).toEqual(['marketplace.import']);
    expect(by('DELETE', '/api/v1/content/pages/:id')).toEqual(['content.delete']);
    expect(by('DELETE', '/api/v1/site/redirects/:id')).toEqual(['content.addresses', 'content.delete']);
    expect(by('PUT', '/api/v1/custom-fields/values/:entity/:entityId')).toEqual(['supply.edit', 'demand.edit', 'marketplace.edit']);
    expect(by('DELETE', '/api/v1/employees/:userId')).toEqual(['hr.delete']);
    expect(by('DELETE', '/api/v1/users/:id')).toEqual(['system.accounts']);
    expect(by('POST', '/api/v1/users/:id/2fa/reset')).toEqual(['system.accounts']);
    expect(by('GET', '/api/v1/finance/payout-batches/export.csv')).toEqual(['finance.export']);
    expect(by('GET', '/api/v1/admin/overview/export.csv')).toEqual(['marketplace.export']);
  });

  it('never lets a DELETE ride on an edit tier alone: every delete names a delete power, or the roles or accounts power', () => {
    /* The one record a person removes about themselves: the service judges the owner. */
    const ownRecord = ['/api/v1/work/tasks/:taskId/time-logs/:logId', '/api/v1/listings/:listingId/blocked-dates/:blockId', '/api/v1/listings/:listingId/photos/:photoId'];
    const deletes = admin
      .filter((route) => route.method === 'DELETE' && !ownRecord.includes(route.path))
      .filter((route) => !permissionsOf(route).some((id) => id.endsWith('.delete') || id === 'system.roles' || id === 'system.accounts'))
      .map((route) => route.path);
    expect(deletes).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MODULE_GROUPS,
  PERMISSIONS,
  PERMISSION_GROUPS,
  isPermission,
  permissionsOfGroup,
  permissionsOfTier,
  unknownPermissions,
} from '../permissions';

/** The catalogue is generated; what is pinned is its shape and the ids the rest of the code names. */
describe('the permission catalogue', () => {
  it('produces view and edit for every module group, approve only where there is an approval step', () => {
    for (const group of MODULE_GROUPS) {
      for (const tier of group.tiers) expect(isPermission(`${group.id}.${tier}`)).toBe(true);
    }
    expect(isPermission('finance.approve')).toBe(true);
    expect(isPermission('kyc.approve')).toBe(true);
    expect(isPermission('supply.approve')).toBe(true);
    expect(isPermission('content.approve')).toBe(true);
    expect(isPermission('support.approve')).toBe(false);
    expect(isPermission('marketplace.approve')).toBe(false);
  });

  it('carries the named capabilities the code checks by name', () => {
    for (const id of [
      'system.impersonate',
      'system.audit.export',
      'system.roles',
      'dpo.erasure',
      'flows.edit',
      'hr.salary.view',
      'hr.documents.view',
    ]) {
      expect(isPermission(id), id).toBe(true);
    }
  });

  it('has no duplicate ids and every id belongs to one group of the matrix', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    const fromGroups = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.id));
    expect(fromGroups).toEqual([...PERMISSIONS]);
  });

  it('reports the unknown ids in order, once each', () => {
    expect(unknownPermissions(['finance.view', 'finance.delete', 'x', 'finance.delete'])).toEqual(['finance.delete', 'x']);
    expect(unknownPermissions(['kyc.edit'])).toEqual([]);
  });

  it('answers a tier and a group', () => {
    expect(permissionsOfTier('view')).toContain('finance.view');
    expect(permissionsOfTier('view')).not.toContain('flows.edit');
    expect(permissionsOfGroup('hr')).toEqual(['hr.view', 'hr.edit', 'hr.salary.view', 'hr.documents.view']);
    expect(permissionsOfGroup('nope')).toEqual([]);
  });
});

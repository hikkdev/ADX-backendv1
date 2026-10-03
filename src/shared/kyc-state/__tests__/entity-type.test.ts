import { describe, expect, it } from 'vitest';
import {
  assertLegacyTypeChange,
  KYC_ENTITY_TYPES,
  derivedEntityType,
  entityTypeCatalogue,
  entityTypeFacts,
  entityTypeForEdit,
  entityTypeForKycStart,
  isUpgradeRequest,
  kycEntityTypeSchema,
} from '../entity-type';

/**
 * Phase D (the owner, 1 Oct 2026): the legal form a party verifies as. Null
 * means "ask at the KYC start"; the legacy `type` answers where it says one
 * unambiguously; a verified individual may verify again as a business (the
 * upgrade) and nothing else changes a verified party's form.
 */

describe('the catalogue', () => {
  it('lists each party’s allowed forms in the enum’s order, labelled the same everywhere', () => {
    const catalogue = entityTypeCatalogue();
    expect(catalogue.PUBLISHER.map((o) => o.value)).toEqual([...KYC_ENTITY_TYPES]);
    expect(catalogue.ADVERTISER.map((o) => o.value)).toEqual([...KYC_ENTITY_TYPES]);
    expect(catalogue.PRINT_PARTNER.map((o) => o.value)).toEqual(['INDIVIDUAL', 'SOLE_PROPRIETOR', 'COMPANY', 'LLP_PARTNERSHIP']);
    expect(catalogue.PUBLISHER).toEqual([
      { value: 'INDIVIDUAL', label: 'Individual' },
      { value: 'SOLE_PROPRIETOR', label: 'Sole proprietor' },
      { value: 'COMPANY', label: 'Company' },
      { value: 'LLP_PARTNERSHIP', label: 'LLP or partnership' },
      { value: 'NON_PROFIT', label: 'Non-profit (NGO, trust, society, Section 8)' },
      { value: 'GOVERNMENT_EDUCATION', label: 'Government or education' },
      { value: 'OTHER_ENTITY', label: 'Other entity (HUF, co-operative, AOP, …)' },
      { value: 'POLITICAL', label: 'Political party or candidate' },
    ]);
  });

  it('takes the body value in any casing, and refuses one that is not a form', () => {
    expect(kycEntityTypeSchema.parse('company')).toBe('COMPANY');
    expect(kycEntityTypeSchema.safeParse('TRUST').success).toBe(false);
  });
});

describe('the effective entity type', () => {
  it('reads the legacy type where it settles the form, and nothing where it does not', () => {
    expect(derivedEntityType('PUBLISHER', 'INDIVIDUAL')).toBe('INDIVIDUAL');
    expect(derivedEntityType('PUBLISHER', 'NGO')).toBe('NON_PROFIT');
    expect(derivedEntityType('PUBLISHER', 'POLITICAL')).toBe('POLITICAL');
    expect(derivedEntityType('PUBLISHER', 'BUSINESS')).toBeNull();
    expect(derivedEntityType('ADVERTISER', 'INDIVIDUAL')).toBe('INDIVIDUAL');
    expect(derivedEntityType('ADVERTISER', 'NGO')).toBe('NON_PROFIT');
    expect(derivedEntityType('ADVERTISER', 'COMMERCIAL')).toBeNull();
    expect(derivedEntityType('ADVERTISER', 'AGENCY')).toBeNull();
    expect(derivedEntityType('PRINT_PARTNER', null)).toBeNull();
  });

  it('answers the stored value first, and says whether it was stored', () => {
    expect(entityTypeFacts('PUBLISHER', { entityType: 'COMPANY', type: 'INDIVIDUAL' })).toEqual({ entityType: 'COMPANY', entityTypeStored: true });
    expect(entityTypeFacts('PUBLISHER', { entityType: null, type: 'NGO' })).toEqual({ entityType: 'NON_PROFIT', entityTypeStored: false });
    expect(entityTypeFacts('ADVERTISER', { entityType: null, type: 'COMMERCIAL' })).toEqual({ entityType: null, entityTypeStored: false });
    expect(entityTypeFacts('PRINT_PARTNER', { entityType: null })).toEqual({ entityType: null, entityTypeStored: false });
  });
});

describe('at the KYC start', () => {
  const unverified = { verified: false } as const;

  it('is 409 ENTITY_TYPE_REQUIRED with the options when nothing is known and nothing was sent', () => {
    expect(() => entityTypeForKycStart({ party: 'ADVERTISER', stored: null, legacyType: 'COMMERCIAL', ...unverified }, undefined)).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: 'ENTITY_TYPE_REQUIRED',
        details: { party: 'ADVERTISER', options: entityTypeCatalogue().ADVERTISER },
      }),
    );
    expect(() => entityTypeForKycStart({ party: 'PRINT_PARTNER', stored: null, ...unverified }, undefined)).toThrow(
      expect.objectContaining({ code: 'ENTITY_TYPE_REQUIRED', details: { party: 'PRINT_PARTNER', options: entityTypeCatalogue().PRINT_PARTNER } }),
    );
  });

  it('uses the derived form as it stands, storing nothing', () => {
    expect(entityTypeForKycStart({ party: 'PUBLISHER', stored: null, legacyType: 'INDIVIDUAL', ...unverified }, undefined)).toEqual({ change: 'KEEP', entityType: 'INDIVIDUAL' });
  });

  it('stores a sent form that differs from the stored one — derived or not', () => {
    expect(entityTypeForKycStart({ party: 'PUBLISHER', stored: null, legacyType: 'BUSINESS', ...unverified }, 'COMPANY')).toEqual({ change: 'SET', entityType: 'COMPANY', previous: null });
    expect(entityTypeForKycStart({ party: 'PUBLISHER', stored: null, legacyType: 'INDIVIDUAL', ...unverified }, 'INDIVIDUAL')).toEqual({ change: 'SET', entityType: 'INDIVIDUAL', previous: null });
    expect(entityTypeForKycStart({ party: 'PUBLISHER', stored: 'COMPANY', ...unverified }, 'LLP_PARTNERSHIP')).toEqual({ change: 'SET', entityType: 'LLP_PARTNERSHIP', previous: 'COMPANY' });
    expect(entityTypeForKycStart({ party: 'PUBLISHER', stored: 'COMPANY', ...unverified }, 'COMPANY')).toEqual({ change: 'KEEP', entityType: 'COMPANY' });
  });

  it('is 400 VALIDATION_ERROR for a form the party may not take', () => {
    expect(() => entityTypeForKycStart({ party: 'PRINT_PARTNER', stored: null, ...unverified }, 'NON_PROFIT')).toThrow(expect.objectContaining({ statusCode: 400, code: 'VALIDATION_ERROR' }));
    expect(() => entityTypeForKycStart({ party: 'PRINT_PARTNER', stored: null, ...unverified }, 'POLITICAL')).toThrow(expect.objectContaining({ statusCode: 400 }));
    // Allowed for a publisher: political verifies on the Other entities workflow.
    expect(entityTypeForKycStart({ party: 'PUBLISHER', stored: null, ...unverified }, 'POLITICAL')).toMatchObject({ change: 'SET', entityType: 'POLITICAL' });
  });

  it('on a verified party: only the individual-to-business upgrade; anything else is the caller’s 409', () => {
    const verified = { party: 'PUBLISHER' as const, stored: 'INDIVIDUAL' as const, verified: true };
    expect(entityTypeForKycStart(verified, 'SOLE_PROPRIETOR')).toEqual({ change: 'UPGRADE', entityType: 'SOLE_PROPRIETOR', previous: 'INDIVIDUAL' });
    expect(entityTypeForKycStart({ ...verified, stored: null, legacyType: 'INDIVIDUAL' }, 'COMPANY')).toEqual({ change: 'UPGRADE', entityType: 'COMPANY', previous: 'INDIVIDUAL' });
    expect(entityTypeForKycStart(verified, undefined)).toBeNull();
    expect(entityTypeForKycStart(verified, 'INDIVIDUAL')).toBeNull();
    expect(entityTypeForKycStart({ ...verified, stored: 'COMPANY' }, 'LLP_PARTNERSHIP')).toBeNull();
    expect(entityTypeForKycStart({ ...verified, stored: 'COMPANY' }, 'INDIVIDUAL')).toBeNull();
    // Unknown on a verified party is not the upgrade either.
    expect(entityTypeForKycStart({ ...verified, stored: null, legacyType: 'BUSINESS' }, 'COMPANY')).toBeNull();
  });

  it('says whether a restart on a verified party is the upgrade', () => {
    expect(isUpgradeRequest('ADVERTISER', { entityType: null, type: 'INDIVIDUAL' }, 'COMPANY')).toBe(true);
    expect(isUpgradeRequest('ADVERTISER', { entityType: 'COMPANY', type: 'INDIVIDUAL' }, 'LLP_PARTNERSHIP')).toBe(false);
    expect(isUpgradeRequest('ADVERTISER', { entityType: 'INDIVIDUAL' }, undefined)).toBe(false);
    expect(isUpgradeRequest('PRINT_PARTNER', { entityType: 'INDIVIDUAL' }, 'NON_PROFIT')).toBe(false);
  });
});

describe('in the Edit-details drawer', () => {
  it('stores, changes and clears the form while the KYC is not verified', () => {
    expect(entityTypeForEdit({ party: 'ADVERTISER', stored: null, legacyType: 'COMMERCIAL', verified: false }, 'COMPANY')).toEqual({ change: 'SET', entityType: 'COMPANY', previous: null });
    expect(entityTypeForEdit({ party: 'ADVERTISER', stored: 'COMPANY', verified: false }, 'NON_PROFIT')).toEqual({ change: 'SET', entityType: 'NON_PROFIT', previous: 'COMPANY' });
    expect(entityTypeForEdit({ party: 'ADVERTISER', stored: 'COMPANY', verified: false }, null)).toEqual({ change: 'CLEAR', previous: 'COMPANY' });
    expect(entityTypeForEdit({ party: 'ADVERTISER', stored: 'COMPANY', verified: false }, 'COMPANY')).toBeNull();
  });

  it('on a verified KYC: the upgrade, a quiet store of what is in force, and 409 KYC_LOCKED for anything else', () => {
    expect(entityTypeForEdit({ party: 'PUBLISHER', stored: null, legacyType: 'INDIVIDUAL', verified: true }, 'COMPANY')).toEqual({ change: 'UPGRADE', entityType: 'COMPANY', previous: 'INDIVIDUAL' });
    expect(entityTypeForEdit({ party: 'PUBLISHER', stored: null, legacyType: 'INDIVIDUAL', verified: true }, 'INDIVIDUAL')).toEqual({ change: 'SET', entityType: 'INDIVIDUAL', previous: null });
    expect(() => entityTypeForEdit({ party: 'PUBLISHER', stored: 'COMPANY', verified: true }, 'LLP_PARTNERSHIP')).toThrow(expect.objectContaining({ statusCode: 409, code: 'KYC_LOCKED' }));
    expect(() => entityTypeForEdit({ party: 'PUBLISHER', stored: 'COMPANY', verified: true }, 'INDIVIDUAL')).toThrow(expect.objectContaining({ code: 'KYC_LOCKED' }));
    expect(() => entityTypeForEdit({ party: 'PRINT_PARTNER', stored: 'SOLE_PROPRIETOR', verified: true }, null)).toThrow(expect.objectContaining({ code: 'KYC_LOCKED' }));
  });

  it('is 400 for a form the party may not take, verified or not', () => {
    expect(() => entityTypeForEdit({ party: 'PRINT_PARTNER', stored: null, verified: false }, 'GOVERNMENT_EDUCATION')).toThrow(expect.objectContaining({ statusCode: 400, code: 'VALIDATION_ERROR' }));
  });
});

describe('the legacy type on a verified party (1 Oct 2026)', () => {
  const verifiedIndividual = { party: 'PUBLISHER' as const, stored: null, legacyType: 'INDIVIDUAL', verified: true };

  it('refuses a move that changes what the party is verified as, unless the entity type comes with it', () => {
    expect(() => assertLegacyTypeChange(verifiedIndividual, 'BUSINESS', undefined)).toThrow(expect.objectContaining({ statusCode: 409, code: 'KYC_LOCKED' }));
    expect(() => assertLegacyTypeChange({ ...verifiedIndividual, party: 'ADVERTISER' }, 'COMMERCIAL', undefined)).toThrow(expect.objectContaining({ code: 'KYC_LOCKED' }));
    // With the entity type the entity's own rule decides (the upgrade restarts Digio).
    expect(() => assertLegacyTypeChange(verifiedIndividual, 'BUSINESS', 'COMPANY')).not.toThrow();
  });

  it('lets through a move that leaves the verified form where it was, an unverified party, and no change at all', () => {
    // A stored entity type holds whatever the legacy type says.
    expect(() => assertLegacyTypeChange({ party: 'PUBLISHER', stored: 'GOVERNMENT_EDUCATION', legacyType: 'NGO', verified: true }, 'POLITICAL', undefined)).not.toThrow();
    expect(() => assertLegacyTypeChange({ ...verifiedIndividual, verified: false }, 'BUSINESS', undefined)).not.toThrow();
    expect(() => assertLegacyTypeChange(verifiedIndividual, 'INDIVIDUAL', undefined)).not.toThrow();
    expect(() => assertLegacyTypeChange(verifiedIndividual, undefined, undefined)).not.toThrow();
  });
});

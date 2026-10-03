import { z } from 'zod';
import type { KycEntityType } from '../database';
import { ApiError } from '../errors';
import { upperEnum } from '../validation';

/**
 * Phase D (the owner, 1 Oct 2026) — the legal form a party verifies as.
 *
 * Digio holds a KYC workflow per party and legal form, so a publisher, an
 * advertiser or a print partner must say which they are before their Digio
 * check can start. The column (`entityType`) is null until they do; the
 * legacy `type` answers for them where it is unambiguous (an INDIVIDUAL is
 * an individual, an NGO a non-profit, a POLITICAL publisher political) and
 * is silent where it is not (a BUSINESS could be any of five forms). Null
 * means "ask at KYC start": the start refuses 409 `ENTITY_TYPE_REQUIRED`
 * with the options, and the client asks and sends again with `entityType`.
 *
 * KYC is never a sign-up gate (the owner, 1 Oct 2026): advertisers pay
 * first and verify before launch, publishers are asked when they list — so
 * the question is asked at the KYC start and nowhere earlier.
 *
 * One rule for changing it once verified: an individual who registers a
 * business may verify again as that business (the "upgrade") — the KYC goes
 * back to PENDING with a fresh Digio request. Any other change to a verified
 * party's legal form is refused; it is a different party, not an edit.
 *
 * Lives in `shared` because three modules ask it (`publishers`, `kyc` for
 * the advertiser, `print-partners`) and none may import the others; agents
 * and employees have no entity type — their workflow comes from who they are.
 */

/** In the enum's order — every list the API answers is in this order. */
export const KYC_ENTITY_TYPES = [
  'INDIVIDUAL',
  'SOLE_PROPRIETOR',
  'COMPANY',
  'LLP_PARTNERSHIP',
  'NON_PROFIT',
  'GOVERNMENT_EDUCATION',
  'OTHER_ENTITY',
  'POLITICAL',
] as const satisfies readonly KycEntityType[];

/** How each reads, the same words on every surface. */
export const KYC_ENTITY_TYPE_LABELS: Record<KycEntityType, string> = {
  INDIVIDUAL: 'Individual',
  SOLE_PROPRIETOR: 'Sole proprietor',
  COMPANY: 'Company',
  LLP_PARTNERSHIP: 'LLP or partnership',
  NON_PROFIT: 'Non-profit (NGO, trust, society, Section 8)',
  GOVERNMENT_EDUCATION: 'Government or education',
  OTHER_ENTITY: 'Other entity (HUF, co-operative, AOP, …)',
  POLITICAL: 'Political party or candidate',
};

/** The parties that carry an entity type. */
export const ENTITY_TYPE_PARTIES = ['PUBLISHER', 'ADVERTISER', 'PRINT_PARTNER'] as const;
export type EntityTypeParty = (typeof ENTITY_TYPE_PARTIES)[number];

/**
 * What each party may verify as. A political publisher is allowed — it
 * verifies on the publisher "Other entities" workflow (the owner, 1 Oct
 * 2026); a print shop is a person or a business, never an NGO or a party.
 */
export const ALLOWED_ENTITY_TYPES: Record<EntityTypeParty, readonly KycEntityType[]> = {
  PUBLISHER: KYC_ENTITY_TYPES,
  ADVERTISER: KYC_ENTITY_TYPES,
  PRINT_PARTNER: ['INDIVIDUAL', 'SOLE_PROPRIETOR', 'COMPANY', 'LLP_PARTNERSHIP'],
};

const PARTY_NOUN: Record<EntityTypeParty, string> = { PUBLISHER: 'publisher', ADVERTISER: 'advertiser', PRINT_PARTNER: 'print partner' };

/** The body field every KYC start and every Edit-details PATCH takes: any of the eight, any casing. */
export const kycEntityTypeSchema = upperEnum(KYC_ENTITY_TYPES);

export type EntityTypeOption = { value: KycEntityType; label: string };

export function entityTypeOptions(party: EntityTypeParty): EntityTypeOption[] {
  return ALLOWED_ENTITY_TYPES[party].map((value) => ({ value, label: KYC_ENTITY_TYPE_LABELS[value] }));
}

/** `GET /kyc/entity-types` — each party's allowed values, labelled. */
export function entityTypeCatalogue(): Record<EntityTypeParty, EntityTypeOption[]> {
  return { PUBLISHER: entityTypeOptions('PUBLISHER'), ADVERTISER: entityTypeOptions('ADVERTISER'), PRINT_PARTNER: entityTypeOptions('PRINT_PARTNER') };
}

export function isEntityTypeAllowed(party: EntityTypeParty, value: KycEntityType): boolean {
  return ALLOWED_ENTITY_TYPES[party].includes(value);
}

/** The legacy `type` read as an entity type where it says one unambiguously; null where it does not. */
export function derivedEntityType(party: EntityTypeParty, legacyType: string | null | undefined): KycEntityType | null {
  if (party === 'PUBLISHER') {
    return legacyType === 'INDIVIDUAL' ? 'INDIVIDUAL' : legacyType === 'NGO' ? 'NON_PROFIT' : legacyType === 'POLITICAL' ? 'POLITICAL' : null;
  }
  if (party === 'ADVERTISER') {
    return legacyType === 'INDIVIDUAL' ? 'INDIVIDUAL' : legacyType === 'NGO' ? 'NON_PROFIT' : null;
  }
  return null;
}

/** The stored value, else the legacy `type`'s; null means "ask". */
export function effectiveEntityType(party: EntityTypeParty, row: { entityType?: KycEntityType | null; type?: string | null }): KycEntityType | null {
  return row.entityType ?? derivedEntityType(party, row.type);
}

/**
 * What every party read answers: `entityType` is the effective value (null
 * when unknown — the client asks before the KYC start), `entityTypeStored`
 * whether the party (or the desk) chose it rather than the legacy `type`.
 */
export function entityTypeFacts(
  party: EntityTypeParty,
  row: { entityType?: KycEntityType | null; type?: string | null },
): { entityType: KycEntityType | null; entityTypeStored: boolean } {
  return { entityType: effectiveEntityType(party, row), entityTypeStored: row.entityType != null };
}

/** The one change a verified party may make: from an individual to any business form. */
export function isEntityUpgrade(from: KycEntityType | null, to: KycEntityType): boolean {
  return from === 'INDIVIDUAL' && to !== 'INDIVIDUAL';
}

/**
 * Whether a start on a verified party is the upgrade — for a desk restart,
 * which refuses a verified party before it reaches the start unless this
 * says it is an individual verifying again as a business.
 */
export function isUpgradeRequest(
  party: EntityTypeParty,
  row: { entityType?: KycEntityType | null; type?: string | null },
  requested: KycEntityType | undefined,
): boolean {
  return requested !== undefined && isEntityTypeAllowed(party, requested) && isEntityUpgrade(effectiveEntityType(party, row), requested);
}

/**
 * Cashfree Phase 1 (E-bis, 2 Oct 2026): what the calling client can draw
 * besides Digio's page — `supports: ['CASHFREE']` from an app or a website
 * build that has the Cashfree steps. Only such a client is ever handed a
 * Cashfree session when Digio cannot be asked; every other caller gets the
 * answers it always got. Values are upper-cased; one ADX does not know is
 * carried and ignored, so a newer client never fails on an older server.
 */
export const kycSupportsSchema = z
  .array(z.string().trim().min(1).max(40))
  .max(10)
  .transform((list) => list.map((value) => value.toUpperCase()))
  .optional();

/** The body every Digio start, restart and desk request of the three parties takes beside its own fields. */
export const kycStartBodySchema = z.object({ entityType: kycEntityTypeSchema.optional(), supports: kycSupportsSchema });
export type KycStartBody = z.infer<typeof kycStartBodySchema>;

function assertAllowed(party: EntityTypeParty, value: KycEntityType): void {
  if (isEntityTypeAllowed(party, value)) return;
  throw new ApiError(400, 'VALIDATION_ERROR', `A ${PARTY_NOUN[party]} cannot verify as ${KYC_ENTITY_TYPE_LABELS[value].toLowerCase()}`, {
    fieldErrors: { entityType: [`Choose one of: ${ALLOWED_ENTITY_TYPES[party].join(', ')}`] },
    formErrors: [],
    allowed: ALLOWED_ENTITY_TYPES[party],
  });
}

/** 409 `ENTITY_TYPE_REQUIRED` — the client asks with these options and sends the KYC start again. */
export function entityTypeRequired(party: EntityTypeParty): ApiError {
  return new ApiError(409, 'ENTITY_TYPE_REQUIRED', `Say what kind of ${PARTY_NOUN[party]} this is before the identity check starts`, {
    party,
    options: entityTypeOptions(party),
  });
}

export type EntityTypeChange =
  /** The effective type stands; nothing to store. */
  | { change: 'KEEP'; entityType: KycEntityType }
  /** Stored on the party row before anything else (audit `KYC_ENTITY_TYPE_SET`). */
  | { change: 'SET'; entityType: KycEntityType; previous: KycEntityType | null }
  /** A verified individual verifying again as a business — the KYC goes back to PENDING (audit `KYC_ENTITY_UPGRADED`). */
  | { change: 'UPGRADE'; entityType: KycEntityType; previous: KycEntityType };

export type EntityTypeState = {
  party: EntityTypeParty;
  /** The party row's `entityType`. */
  stored: KycEntityType | null | undefined;
  /** The party row's legacy `type`, for the derivation. */
  legacyType?: string | null | undefined;
  /** Whether the party's KYC is VERIFIED (the record, or the mirror where the party keeps one). */
  verified: boolean;
};

/**
 * The entity type a Digio KYC start goes out with, and what it changes.
 *
 * In order: a requested type the party may not take is 400; a verified
 * party gets null back unless the request is the upgrade — the caller
 * answers its own 409 (`KYC_ALREADY_VERIFIED`, or CONFLICT on a restart),
 * as it did before entity types; an unverified party with no type known and
 * none requested is 409 `ENTITY_TYPE_REQUIRED`, before anything is stamped
 * or sent.
 */
export function entityTypeForKycStart(state: EntityTypeState, requested: KycEntityType | undefined): EntityTypeChange | null {
  if (requested !== undefined) assertAllowed(state.party, requested);
  const stored = state.stored ?? null;
  const effective = effectiveEntityType(state.party, { entityType: stored, type: state.legacyType ?? null });
  if (state.verified) {
    if (requested !== undefined && requested !== effective && isEntityUpgrade(effective, requested)) {
      return { change: 'UPGRADE', entityType: requested, previous: 'INDIVIDUAL' };
    }
    return null;
  }
  if (requested !== undefined) {
    return requested === stored ? { change: 'KEEP', entityType: requested } : { change: 'SET', entityType: requested, previous: stored };
  }
  if (!effective) throw entityTypeRequired(state.party);
  return { change: 'KEEP', entityType: effective };
}

/**
 * The same question asked by an Edit-details PATCH: `requested` is the
 * body's value (null clears the stored one back to what `type` says). A
 * verified party may only take the upgrade — its KYC then goes back to
 * PENDING with no request out yet, the desk sends one; anything else that
 * would change the effective type is 409 `KYC_LOCKED`. A value equal to
 * what is in force is stored quietly (it was derived; now it is chosen).
 */
export function entityTypeForEdit(state: EntityTypeState, requested: KycEntityType | null): EntityTypeChange | { change: 'CLEAR'; previous: KycEntityType } | null {
  if (requested !== null) assertAllowed(state.party, requested);
  const stored = state.stored ?? null;
  if (requested === stored) return null;
  const effective = effectiveEntityType(state.party, { entityType: stored, type: state.legacyType ?? null });
  const next = requested ?? derivedEntityType(state.party, state.legacyType);
  if (state.verified && next !== effective) {
    if (requested !== null && isEntityUpgrade(effective, requested)) return { change: 'UPGRADE', entityType: requested, previous: 'INDIVIDUAL' };
    const as = effective ? ` as ${KYC_ENTITY_TYPE_LABELS[effective].toLowerCase()}` : '';
    throw new ApiError(409, 'KYC_LOCKED', `This ${PARTY_NOUN[state.party]} is verified${as}; only an individual who registers a business can change it, and they verify again`, {
      party: state.party,
      entityType: effective,
    });
  }
  if (requested === null) return { change: 'CLEAR', previous: stored as KycEntityType };
  return { change: 'SET', entityType: requested, previous: stored };
}

/**
 * The legacy `type` on a verified party (1 Oct 2026): it may change only
 * when the change leaves what the party is verified as where it was — a
 * party with a stored entity type, or a move the derivation reads the same.
 * Otherwise 409 KYC_LOCKED, as the entity type's own edit answers: the
 * move goes through the entity type (the upgrade, with a fresh Digio
 * request), never round it. A patch that carries the entity type is left
 * to that rule.
 */
export function assertLegacyTypeChange(state: EntityTypeState, nextLegacyType: string | null | undefined, requestedEntity: KycEntityType | null | undefined): void {
  if (nextLegacyType === undefined || nextLegacyType === state.legacyType || !state.verified || requestedEntity !== undefined) return;
  const before = effectiveEntityType(state.party, { entityType: state.stored ?? null, type: state.legacyType ?? null });
  const after = effectiveEntityType(state.party, { entityType: state.stored ?? null, type: nextLegacyType });
  if (before === after) return;
  const as = before ? ` as ${KYC_ENTITY_TYPE_LABELS[before].toLowerCase()}` : '';
  throw new ApiError(409, 'KYC_LOCKED', `This ${PARTY_NOUN[state.party]} is verified${as}; only an individual who registers a business can change it, and they verify again`, {
    party: state.party,
    entityType: before,
  });
}

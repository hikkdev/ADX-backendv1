import type { Request } from 'express';
import type { CustomFieldEntity, Prisma } from '../../shared/database';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { getAdvertiserForUser } from '../advertisers';
import { getListingById } from '../listings';
import { findPublisherForUser } from '../publishers';
import { prismaCustomFieldsRepository as repository } from './prisma-custom-fields.repository';
import type { CustomFieldDef, CustomFieldValue } from './custom-fields.repository';
import { CUSTOM_FIELD_ENTITIES, KIND_LABEL, TAKES_OPTIONS, type CustomFieldKind } from './custom-fields.schema';
import { checkValue, isValidKey, keyFromLabel, optionsOf } from './field-values';

/**
 * CF-1 (27 Sep 2026): custom fields — extra questions on a record type.
 *
 * A definition (`CustomFieldDef`) says what is asked of every publisher,
 * advertiser, listing or lead; a value (`CustomFieldValue`) is one record's
 * answer. Values live beside the record, never in its columns, so nothing
 * the platform relies on can break. The desk defines and answers; the
 * record's owner answers the fields marked `editableByOwner`, in the apps
 * or on the website, and only on their own record. A lead has no owner.
 */

type Actor = { userId: string; req?: Request | undefined };

export type DefView = {
  id: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  kind: string;
  kindLabel: string;
  options: { value: string; label: string }[] | null;
  hint: string | null;
  required: boolean;
  showOnDesk: boolean;
  showInApps: boolean;
  showOnWebsite: boolean;
  editableByOwner: boolean;
  sortOrder: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DefInput = {
  entity: CustomFieldEntity;
  key?: string | undefined;
  label: string;
  kind: CustomFieldKind;
  options?: { value: string; label: string }[] | undefined;
  hint?: string | null | undefined;
  required?: boolean | undefined;
  showOnDesk?: boolean | undefined;
  showInApps?: boolean | undefined;
  showOnWebsite?: boolean | undefined;
  editableByOwner?: boolean | undefined;
  sortOrder?: number | undefined;
};

export type DefPatchInput = Partial<Omit<DefInput, 'entity' | 'key' | 'kind'>>;

export type FieldWithValue = DefView & { value: unknown };

export type ValuesView = { entity: CustomFieldEntity; entityId: string; values: Record<string, unknown>; fields: FieldWithValue[] };

/** Who is reading or writing: the desk sees every live definition; the owner sees what is shown to them. */
export type Scope = 'DESK' | 'OWNER';

export function defView(def: CustomFieldDef): DefView {
  return {
    id: def.id,
    entity: def.entity,
    key: def.key,
    label: def.label,
    kind: def.kind,
    kindLabel: KIND_LABEL[def.kind as CustomFieldKind] ?? def.kind,
    options: TAKES_OPTIONS.has(def.kind) ? optionsOf(def) : null,
    hint: def.hint,
    required: def.required,
    showOnDesk: def.showOnDesk,
    showInApps: def.showInApps,
    showOnWebsite: def.showOnWebsite,
    editableByOwner: def.editableByOwner,
    sortOrder: def.sortOrder,
    archivedAt: def.archivedAt,
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
  };
}

/** `:entity` from a path — `PUBLISHER`, or `publisher` from a hand-typed URL. */
export function parseEntity(value: unknown): CustomFieldEntity {
  const entity = String(value ?? '')
    .trim()
    .toUpperCase();
  if (!(CUSTOM_FIELD_ENTITIES as readonly string[]).includes(entity)) {
    throw new ApiError(404, 'NOT_FOUND', `No such record type — one of ${CUSTOM_FIELD_ENTITIES.join(', ')}`);
  }
  return entity as CustomFieldEntity;
}

/** The choices a definition stores: only where the kind chooses; refused elsewhere, required there. */
function optionsFor(kind: string, options: { value: string; label: string }[] | undefined, label: string): { value: string; label: string }[] | null {
  if (TAKES_OPTIONS.has(kind)) {
    if (!options?.length) throw new ApiError(400, 'VALIDATION_ERROR', `"${label}" needs options to choose from`);
    const seen = new Set<string>();
    for (const option of options) {
      if (seen.has(option.value)) throw new ApiError(400, 'VALIDATION_ERROR', `Option "${option.value}" repeats on "${label}"`);
      seen.add(option.value);
    }
    return options;
  }
  if (options) throw new ApiError(400, 'VALIDATION_ERROR', `"${label}" is a ${KIND_LABEL[kind as CustomFieldKind]?.toLowerCase() ?? kind} and takes no options`);
  return null;
}

/* ── Definitions ───────────────────────────────────────────────────── */

/** `GET /custom-fields?entity=` — the definitions, live ones unless asked for all. */
export async function listDefs(filter: { entity?: CustomFieldEntity | undefined; includeArchived?: boolean | undefined }): Promise<DefView[]> {
  return (await repository.listDefs({ entity: filter.entity, includeArchived: filter.includeArchived ?? false })).map(defView);
}

async function defOr404(id: string): Promise<CustomFieldDef> {
  const def = await repository.defById(id);
  if (!def) throw new ApiError(404, 'NOT_FOUND', `No custom field "${id}"`);
  return def;
}

/** `POST /custom-fields` — a new question on a record type. The key is made from the label when left out and never changes. */
export async function createDef(input: DefInput, actor: Actor): Promise<DefView> {
  const key = (input.key?.trim() || keyFromLabel(input.label)).toLowerCase();
  if (!isValidKey(key)) throw new ApiError(400, 'VALIDATION_ERROR', 'A field key is lowercase letters, digits and underscores, starting with a letter, at most 40 long');
  if (await repository.defByKey(input.entity, key)) throw new ApiError(409, 'CONFLICT', `${input.entity} already has a field with the key "${key}"`);
  const def = await repository.createDef({
    entity: input.entity,
    key,
    label: input.label.trim(),
    kind: input.kind,
    options: optionsFor(input.kind, input.options, input.label),
    hint: input.hint?.trim() || null,
    required: input.required ?? false,
    showOnDesk: input.showOnDesk ?? true,
    showInApps: input.showInApps ?? false,
    showOnWebsite: input.showOnWebsite ?? false,
    editableByOwner: input.editableByOwner ?? false,
    sortOrder: input.sortOrder ?? 0,
    createdByUserId: actor.userId,
  });
  await logActivity(actor.userId, 'CUSTOM_FIELD_CREATED', {
    req: actor.req,
    targetType: 'CustomFieldDef',
    targetId: def.id,
    module: 'custom-fields',
    metadata: { entity: def.entity, key: def.key, kind: def.kind },
  });
  return defView(def);
}

/** `PATCH /custom-fields/:id` — the label, options, hint, flags and order. The entity, key and kind stay: the stored values depend on them. */
export async function updateDef(id: string, patch: DefPatchInput, actor: Actor): Promise<DefView> {
  const def = await defOr404(id);
  const label = patch.label?.trim() || def.label;
  const data = {
    ...(patch.label !== undefined ? { label } : {}),
    ...(patch.options !== undefined ? { options: optionsFor(def.kind, patch.options, label) } : {}),
    ...(patch.hint !== undefined ? { hint: patch.hint?.trim() || null } : {}),
    ...(patch.required !== undefined ? { required: patch.required } : {}),
    ...(patch.showOnDesk !== undefined ? { showOnDesk: patch.showOnDesk } : {}),
    ...(patch.showInApps !== undefined ? { showInApps: patch.showInApps } : {}),
    ...(patch.showOnWebsite !== undefined ? { showOnWebsite: patch.showOnWebsite } : {}),
    ...(patch.editableByOwner !== undefined ? { editableByOwner: patch.editableByOwner } : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
  };
  const updated = await repository.updateDef(def.id, data);
  await logActivity(actor.userId, 'CUSTOM_FIELD_UPDATED', {
    req: actor.req,
    targetType: 'CustomFieldDef',
    targetId: def.id,
    module: 'custom-fields',
    metadata: { entity: def.entity, key: def.key, changed: Object.keys(patch) },
  });
  return defView(updated);
}

/** `POST /custom-fields/:id/archive` — the question stops being asked; its answers stay. */
export async function archiveDef(id: string, actor: Actor): Promise<DefView> {
  const def = await defOr404(id);
  if (def.archivedAt) throw new ApiError(409, 'CONFLICT', `"${def.label}" is already archived`);
  const updated = await repository.updateDef(def.id, { archivedAt: new Date() });
  await logActivity(actor.userId, 'CUSTOM_FIELD_ARCHIVED', { req: actor.req, targetType: 'CustomFieldDef', targetId: def.id, module: 'custom-fields', metadata: { entity: def.entity, key: def.key } });
  return defView(updated);
}

/** `POST /custom-fields/:id/restore` — asked again. */
export async function restoreDef(id: string, actor: Actor): Promise<DefView> {
  const def = await defOr404(id);
  if (!def.archivedAt) throw new ApiError(409, 'CONFLICT', `"${def.label}" is not archived`);
  const updated = await repository.updateDef(def.id, { archivedAt: null });
  await logActivity(actor.userId, 'CUSTOM_FIELD_RESTORED', { req: actor.req, targetType: 'CustomFieldDef', targetId: def.id, module: 'custom-fields', metadata: { entity: def.entity, key: def.key } });
  return defView(updated);
}

/* ── The owner's side ───────────────────────────────────────────────── */

const ownerVisible = (def: CustomFieldDef): boolean => def.showInApps || def.showOnWebsite;

/** `GET /app/custom-fields/:entity` — what the owner is shown, and where. A lead has no owner. */
export async function ownerDefs(entity: CustomFieldEntity): Promise<DefView[]> {
  if (entity === 'LEAD') throw new ApiError(403, 'FORBIDDEN', "Lead fields are the desk's");
  return (await repository.listDefs({ entity, includeArchived: false })).filter(ownerVisible).map(defView);
}

/**
 * The record must be the caller's own: their publisher, a listing of their
 * publisher, their advertiser. Anything else is a 403 — and a lead always.
 */
export async function assertOwner(entity: CustomFieldEntity, entityId: string, userId: string): Promise<void> {
  const refuse = () => new ApiError(403, 'FORBIDDEN', 'This record is not yours');
  switch (entity) {
    case 'PUBLISHER': {
      const publisher = await findPublisherForUser(userId);
      if (!publisher || publisher.id !== entityId) throw refuse();
      return;
    }
    case 'LISTING': {
      const [publisher, listing] = await Promise.all([findPublisherForUser(userId), getListingById(entityId)]);
      if (!publisher || !listing || listing.publisherId !== publisher.id) throw refuse();
      return;
    }
    case 'ADVERTISER': {
      const advertiser = await getAdvertiserForUser(userId);
      if (!advertiser || advertiser.id !== entityId) throw refuse();
      return;
    }
    default:
      throw refuse();
  }
}

/* ── Values ────────────────────────────────────────────────────────── */

function valueMap(values: CustomFieldValue[]): Map<string, unknown> {
  return new Map(values.map((row) => [row.defId, row.value]));
}

/** `GET /custom-fields/values/:entity/:entityId` and the owner's twin — the live definitions with this record's answers beside them. */
export async function valuesFor(entity: CustomFieldEntity, entityId: string, scope: Scope): Promise<ValuesView> {
  if (scope === 'DESK' && !(await repository.entityExists(entity, entityId))) throw new ApiError(404, 'NOT_FOUND', `No ${entity.toLowerCase()} "${entityId}"`);
  const [defs, rows] = await Promise.all([repository.listDefs({ entity, includeArchived: false }), repository.valuesFor(entity, entityId)]);
  const shown = scope === 'OWNER' ? defs.filter(ownerVisible) : defs;
  const values = valueMap(rows);
  const fields = shown.map((def) => ({ ...defView(def), value: values.get(def.id) ?? null }));
  return { entity, entityId, values: Object.fromEntries(fields.map((field) => [field.key, field.value])), fields };
}

/**
 * `PUT …/values/:entity/:entityId { values: { [key]: value } }` — the keys
 * named are written, `null` clears one, keys left out stay. Every problem
 * at once (400, `details.issues[]` with `key` and `message`). The owner may
 * write only what is `editableByOwner`; a required field cannot be cleared.
 */
export async function setValues(entity: CustomFieldEntity, entityId: string, input: Record<string, unknown>, scope: Scope, actor: Actor): Promise<ValuesView> {
  if (scope === 'DESK' && !(await repository.entityExists(entity, entityId))) throw new ApiError(404, 'NOT_FOUND', `No ${entity.toLowerCase()} "${entityId}"`);
  const defs = await repository.listDefs({ entity, includeArchived: false });
  const byKey = new Map(defs.map((def) => [def.key, def]));
  const issues: { key: string; message: string }[] = [];
  const writes: { defId: string; value: Prisma.InputJsonValue }[] = [];
  const clears: string[] = [];
  for (const [key, raw] of Object.entries(input)) {
    const def = byKey.get(key);
    if (!def) {
      issues.push({ key, message: `No field "${key}" on a ${entity.toLowerCase()}` });
      continue;
    }
    if (scope === 'OWNER' && !(def.editableByOwner && ownerVisible(def))) {
      issues.push({ key, message: `"${def.label}" is not yours to change` });
      continue;
    }
    const checked = checkValue(def, raw);
    if (!checked.ok) issues.push({ key, message: checked.message });
    else if (checked.value === null) clears.push(def.id);
    else writes.push({ defId: def.id, value: checked.value as Prisma.InputJsonValue });
  }
  if (issues.length) throw new ApiError(400, 'VALIDATION_ERROR', issues.length === 1 ? issues[0]!.message : `${issues.length} fields need attention — the first: ${issues[0]!.message}`, { issues });
  if (writes.length || clears.length) await repository.writeValues(entity, entityId, writes, clears, actor.userId);
  await logActivity(actor.userId, 'CUSTOM_FIELD_VALUES_SET', {
    req: actor.req,
    targetType: entity,
    targetId: entityId,
    module: 'custom-fields',
    metadata: { entity, scope, written: writes.length, cleared: clears.length, keys: Object.keys(input) },
  });
  return valuesFor(entity, entityId, scope);
}

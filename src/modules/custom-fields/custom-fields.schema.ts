import { z } from 'zod';

/**
 * CF-1 (27 Sep 2026): custom fields — extra questions on a record, kept
 * beside it in `CustomFieldValue`, never in the record's own columns.
 */

export const CUSTOM_FIELD_ENTITIES = ['PUBLISHER', 'ADVERTISER', 'LISTING', 'LEAD'] as const;
export type CustomFieldEntityKey = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_KINDS = ['text', 'textarea', 'number', 'select', 'multiselect', 'checkbox', 'date', 'email', 'phone', 'url', 'location'] as const;
export type CustomFieldKind = (typeof CUSTOM_FIELD_KINDS)[number];

export const KIND_LABEL: Record<CustomFieldKind, string> = {
  text: 'Short text',
  textarea: 'Long text',
  number: 'Number',
  select: 'Choose one',
  multiselect: 'Choose many',
  checkbox: 'Tick box',
  date: 'Date',
  email: 'Email address',
  phone: 'Phone number',
  url: 'Web address',
  location: 'Location (pin on a map)',
};

export const TAKES_OPTIONS: ReadonlySet<string> = new Set(['select', 'multiselect']);

/** `preferred_contact_time` — what a key looks like, whether typed or made from the label. */
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export const entitySchema = z.preprocess(upper, z.enum(CUSTOM_FIELD_ENTITIES));

const optionSchema = z.object({ value: z.string().trim().min(1).max(80), label: z.string().trim().min(1).max(120) });

/** `POST /custom-fields`. The key is optional — made from the label when left out. */
export const createDefSchema = z.object({
  entity: entitySchema,
  key: z.string().trim().max(40).optional(),
  label: z.string().trim().min(1).max(80),
  kind: z.preprocess(lower, z.enum(CUSTOM_FIELD_KINDS)),
  options: z.array(optionSchema).min(1).max(50).optional(),
  hint: z.string().trim().max(200).nullable().optional(),
  required: z.boolean().optional(),
  showOnDesk: z.boolean().optional(),
  showInApps: z.boolean().optional(),
  showOnWebsite: z.boolean().optional(),
  editableByOwner: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

/** `PATCH /custom-fields/:id` — everything but the entity, the key and the kind, which the stored values depend on. */
export const patchDefSchema = createDefSchema.omit({ entity: true, key: true, kind: true }).partial();

export const listDefsQuerySchema = z.object({
  entity: entitySchema.optional(),
  includeArchived: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
});

/** `PUT /custom-fields/values/:entity/:entityId` and the owner's twin: keys named are written, `null` clears one, keys left out stay. */
export const putValuesSchema = z.object({ values: z.record(z.string(), z.unknown()) });

/** The permission group a record's values are read and written under (`requireEntityPermission`) — kept here, free of side effects, so the permission contract test can read it. */
export const ENTITY_GROUP: Record<CustomFieldEntityKey, string> = { PUBLISHER: 'supply', LISTING: 'supply', ADVERTISER: 'demand', LEAD: 'marketplace' };

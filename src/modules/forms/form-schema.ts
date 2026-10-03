import { z } from 'zod';
import type { FormAudience } from '../../shared/database';
import { ApiError } from '../../shared/errors';

/**
 * FM-1 (27 Sep 2026): what a form asks — the definition a version stores.
 *
 * The owner: forms get "their OWN builder (Content › Forms) built on the flow
 * field vocabulary but never writing into a platform record". So a form is
 * screens of fields with the flow editor's kinds of question, and its
 * answers land in `FormSubmission` — a lead, a ticket or the form's own
 * inbox — never in a publisher, a listing or an advertiser.
 *
 * Aadhaar is never a field kind, never stored, never a label: a field whose
 * id or label names it is refused outright (400 `FORBIDDEN_FIELD`) before any
 * other check runs.
 */

export const FIELD_KINDS = ['text', 'textarea', 'email', 'phone', 'number', 'select', 'multiselect', 'checkbox', 'date', 'city', 'category', 'location', 'file'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export type FieldKindMeta = { label: string; takesOptions: boolean; takesRange: boolean; signedInOnly: boolean };

/** `GET /forms/field-kinds` — what the console's builder offers, and what each kind takes. */
export const FIELD_KIND_META: Record<FieldKind, FieldKindMeta> = {
  text: { label: 'Short text', takesOptions: false, takesRange: true, signedInOnly: false },
  textarea: { label: 'Long text', takesOptions: false, takesRange: true, signedInOnly: false },
  email: { label: 'Email address', takesOptions: false, takesRange: false, signedInOnly: false },
  phone: { label: 'Phone number', takesOptions: false, takesRange: false, signedInOnly: false },
  number: { label: 'Number', takesOptions: false, takesRange: true, signedInOnly: false },
  select: { label: 'Choose one', takesOptions: true, takesRange: false, signedInOnly: false },
  multiselect: { label: 'Choose many', takesOptions: true, takesRange: true, signedInOnly: false },
  checkbox: { label: 'Tick box', takesOptions: false, takesRange: false, signedInOnly: false },
  date: { label: 'Date', takesOptions: false, takesRange: true, signedInOnly: false },
  city: { label: 'City (from the catalogue)', takesOptions: false, takesRange: false, signedInOnly: false },
  category: { label: 'Listing category', takesOptions: false, takesRange: false, signedInOnly: false },
  location: { label: 'Location (pin on a map)', takesOptions: false, takesRange: false, signedInOnly: false },
  file: { label: 'File upload', takesOptions: false, takesRange: false, signedInOnly: true },
};

export function fieldKinds(): ({ kind: FieldKind } & FieldKindMeta)[] {
  return FIELD_KINDS.map((kind) => ({ kind, ...FIELD_KIND_META[kind] }));
}

/** Aadhaar is never a field: the number, the word, the issuer. */
export const FORBIDDEN_FIELD = /aadha?ar|\buid\b|uidai/i;

export const MAX_SCREENS = 10;
export const MAX_FIELDS = 40;

const ID = /^[a-z][a-z0-9_]{0,39}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const optionSchema = z.object({ value: z.string().trim().min(1).max(80), label: z.string().trim().min(1).max(120) });

const bound = z.union([z.number(), z.string().regex(ISO_DATE, 'A date bound is YYYY-MM-DD')]);

export const fieldSchema = z.object({
  id: z.string().regex(ID, 'A field id is lowercase letters, digits and underscores, starting with a letter, at most 40 long'),
  kind: z.enum(FIELD_KINDS),
  label: z.string().trim().min(1).max(120),
  hint: z.string().trim().max(200).optional(),
  placeholder: z.string().trim().max(120).optional(),
  required: z.boolean().optional(),
  options: z.array(optionSchema).min(1).max(50).optional(),
  min: bound.optional(),
  max: bound.optional(),
  maxLength: z.number().int().min(1).max(10_000).optional(),
  accept: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  dependsOn: z.object({ fieldId: z.string().regex(ID), equals: z.string().max(80) }).optional(),
});

export const screenSchema = z.object({
  key: z.string().regex(ID, 'A screen key is lowercase letters, digits and underscores, starting with a letter'),
  title: z.string().trim().max(120).optional(),
  description: z.string().trim().max(400).optional(),
  fields: z.array(fieldSchema).max(MAX_FIELDS),
});

export const definitionSchema = z.object({
  screens: z.array(screenSchema).min(1).max(MAX_SCREENS),
  submitLabel: z.string().trim().max(40).optional(),
  successMessage: z.string().trim().min(1).max(400),
  consentText: z.string().trim().min(1).max(600),
  contactMap: z
    .object({
      name: z.string().regex(ID).optional(),
      email: z.string().regex(ID).optional(),
      phone: z.string().regex(ID).optional(),
    })
    .optional(),
});

export type FormField = z.infer<typeof fieldSchema>;
export type FormScreen = z.infer<typeof screenSchema>;
export type FormDefinition = z.infer<typeof definitionSchema>;

export type DefinitionIssue = { fieldId: string | null; path: string; message: string };

/** Every field in the order the person meets them — screen by screen. */
export function flattenFields(definition: Pick<FormDefinition, 'screens'>): FormField[] {
  return definition.screens.flatMap((screen) => screen.fields);
}

/** A form as it is born: one empty screen and the two texts every form must carry. */
export function emptyDefinition(): FormDefinition {
  return {
    screens: [{ key: 'main', fields: [] }],
    submitLabel: 'Send',
    successMessage: 'Thank you — we have your answer and will be in touch.',
    consentText: 'I agree to ADX contacting me about this and to the privacy policy.',
  };
}

const CONTACT_KIND: Record<'name' | 'email' | 'phone', FieldKind[]> = { name: ['text'], email: ['email'], phone: ['phone'] };

/**
 * The checks the shape alone cannot make: ids unique, a condition names an
 * earlier field and a value that field can take, options only where a
 * choice is made, bounds that fit the kind, a file only where somebody is
 * signed in, and a contact map that points at fields of the right kind.
 * Every problem at once.
 */
export function definitionIssues(definition: FormDefinition, audience: FormAudience): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const fields = flattenFields(definition);
  if (fields.length > MAX_FIELDS) issues.push({ fieldId: null, path: 'screens', message: `A form takes at most ${MAX_FIELDS} fields; this one has ${fields.length}` });

  const screenKeys = new Set<string>();
  definition.screens.forEach((screen, at) => {
    if (screenKeys.has(screen.key)) issues.push({ fieldId: null, path: `screens.${at}.key`, message: `Screen key "${screen.key}" is used twice` });
    screenKeys.add(screen.key);
  });

  const seen = new Map<string, FormField>();
  let at = 0;
  for (const screen of definition.screens) {
    for (const field of screen.fields) {
      const path = `fields.${at}`;
      const issue = (message: string, sub = '') => issues.push({ fieldId: field.id, path: sub ? `${path}.${sub}` : path, message });
      if (seen.has(field.id)) issue(`Field id "${field.id}" is used twice`, 'id');
      const meta = FIELD_KIND_META[field.kind];

      if (meta.takesOptions) {
        if (!field.options?.length) issue(`"${field.label}" needs options to choose from`, 'options');
        else {
          const values = new Set<string>();
          for (const option of field.options) {
            if (values.has(option.value)) issue(`Option "${option.value}" repeats on "${field.label}"`, 'options');
            values.add(option.value);
          }
        }
      } else if (field.options) issue(`"${field.label}" is a ${meta.label.toLowerCase()} and takes no options`, 'options');

      if (field.min !== undefined || field.max !== undefined) {
        if (field.kind === 'number' || field.kind === 'multiselect') {
          if (typeof field.min === 'string' || typeof field.max === 'string') issue(`"${field.label}" takes numeric bounds`, 'min');
          else if (field.min !== undefined && field.max !== undefined && field.min > field.max) issue(`"${field.label}" has min above max`, 'min');
          if (field.kind === 'multiselect' && ((typeof field.min === 'number' && field.min < 0) || (typeof field.max === 'number' && field.max < 1))) issue(`"${field.label}" counts choices: min from 0, max from 1`, 'min');
        } else if (field.kind === 'date') {
          if (typeof field.min === 'number' || typeof field.max === 'number') issue(`"${field.label}" takes date bounds (YYYY-MM-DD)`, 'min');
          else if (field.min && field.max && field.min > field.max) issue(`"${field.label}" has the earliest date after the latest`, 'min');
        } else issue(`"${field.label}" takes no min or max`, 'min');
      }
      if (field.maxLength !== undefined && field.kind !== 'text' && field.kind !== 'textarea') issue(`"${field.label}" takes no maxLength`, 'maxLength');
      if (field.accept !== undefined && field.kind !== 'file') issue(`"${field.label}" takes no accept list`, 'accept');
      if (field.kind === 'file' && audience !== 'SIGNED_IN') issue(`"${field.label}" is a file upload, which only a signed-in form may ask for`, 'kind');

      if (field.dependsOn) {
        const target = seen.get(field.dependsOn.fieldId);
        if (field.dependsOn.fieldId === field.id) issue(`"${field.label}" cannot depend on itself`, 'dependsOn');
        else if (!target) issue(`"${field.label}" depends on "${field.dependsOn.fieldId}", which is not an earlier field`, 'dependsOn');
        else if (target.kind === 'select' || target.kind === 'multiselect') {
          if (!target.options?.some((option) => option.value === field.dependsOn!.equals)) issue(`"${field.label}" waits for "${field.dependsOn.equals}", which "${target.label}" never answers`, 'dependsOn');
        } else if (target.kind === 'checkbox') {
          if (field.dependsOn.equals !== 'true' && field.dependsOn.equals !== 'false') issue(`"${field.label}" depends on a tick box — equals is "true" or "false"`, 'dependsOn');
        }
      }
      seen.set(field.id, field);
      at += 1;
    }
  }

  if (definition.contactMap) {
    for (const [slot, fieldId] of Object.entries(definition.contactMap) as ['name' | 'email' | 'phone', string | undefined][]) {
      if (!fieldId) continue;
      const target = seen.get(fieldId);
      if (!target) issues.push({ fieldId, path: `contactMap.${slot}`, message: `contactMap.${slot} names "${fieldId}", which is not a field` });
      else if (!CONTACT_KIND[slot].includes(target.kind)) issues.push({ fieldId, path: `contactMap.${slot}`, message: `contactMap.${slot} must name a ${CONTACT_KIND[slot].join('/')} field; "${target.label}" is a ${FIELD_KIND_META[target.kind].label.toLowerCase()}` });
    }
  }
  return issues;
}

/** The forbidden names, checked first — on the raw input, so a malformed field cannot hide one. */
function forbiddenFieldsIn(raw: unknown): string[] {
  const hits: string[] = [];
  const screens = (raw as { screens?: unknown })?.screens;
  if (!Array.isArray(screens)) return hits;
  for (const screen of screens) {
    const fields = (screen as { fields?: unknown })?.fields;
    if (!Array.isArray(fields)) continue;
    for (const field of fields) {
      const id = String((field as { id?: unknown })?.id ?? '');
      const label = String((field as { label?: unknown })?.label ?? '');
      if (FORBIDDEN_FIELD.test(id) || FORBIDDEN_FIELD.test(label)) hits.push(id || label);
    }
  }
  return hits;
}

/**
 * A definition, clean, or a 400 naming every problem at once —
 * `FORBIDDEN_FIELD` for a field that asks for Aadhaar, `VALIDATION_ERROR`
 * with `details.issues[]` (`fieldId`, `path`, `message`) for the rest.
 */
export function validateDefinition(raw: unknown, audience: FormAudience): FormDefinition {
  const forbidden = forbiddenFieldsIn(raw);
  if (forbidden.length) {
    throw new ApiError(400, 'FORBIDDEN_FIELD', `A form never asks for Aadhaar — remove ${forbidden.map((name) => `"${name}"`).join(', ')}`, { fields: forbidden });
  }
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ fieldId: null, path: issue.path.join('.'), message: issue.message }));
    throw new ApiError(400, 'VALIDATION_ERROR', issues.length === 1 ? `${issues[0]!.path}: ${issues[0]!.message}` : `${issues.length} problems with this form — the first: ${issues[0]!.path}: ${issues[0]!.message}`, { issues });
  }
  const issues = definitionIssues(parsed.data, audience);
  if (issues.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', issues.length === 1 ? issues[0]!.message : `${issues.length} problems with this form — the first: ${issues[0]!.message}`, { issues });
  }
  return parsed.data;
}

/** A definition may be saved empty; it may not go live empty. */
export function assertPublishable(definition: FormDefinition): void {
  if (flattenFields(definition).length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Add at least one field before publishing', { issues: [{ fieldId: null, path: 'screens', message: 'No fields' }] });
  }
}

/** Whether a definition asks for a file anywhere — what a PUBLIC audience cannot carry. */
export const asksForFile = (definition: FormDefinition): boolean => flattenFields(definition).some((field) => field.kind === 'file');

/** The stored JSON read back as a definition; a row that fails the shape reads as empty rather than crashing a desk. */
export function definitionOf(row: { definition: unknown }): FormDefinition {
  const parsed = definitionSchema.safeParse(row.definition);
  return parsed.success ? parsed.data : emptyDefinition();
}

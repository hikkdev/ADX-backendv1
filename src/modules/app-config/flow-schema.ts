import { z } from 'zod';

/**
 * The flow vocabulary — the server's word on what the apps render (Q83, Q148).
 *
 * The console builds its flow editor from `GET /config/schema`, which is this
 * file read back as a document, so the editor can only offer a field kind
 * the phones have a renderer for. The kinds are the hyphenated names in the
 * apps' `fields.tsx` switch (both apps carry the same twenty-three), the
 * branches are a Record keyed by the branching option's id, exactly as
 * `scripts/seedConfig.ts` writes `flows.listing`.
 *
 * Two shapes live under `flows`:
 *
 *   - a **wizard** (`flows.listing`, and any key the console adds later): root
 *     screens, one of which carries a branching field, and a branch per option
 *     — validated by `wizardFlowSchema` below;
 *   - the **onboarding ladder** (`flows.onboarding`): steps bound to KYC
 *     columns — validated by `onboardingTemplateSchema` in
 *     `onboarding-template.ts`.
 *
 * Campaign launch is neither: it stays coded until it has a renderer (Q83).
 */

/* ── Field kinds ─────────────────────────────────────────────────────── */

export interface FieldKindSpec {
  kind: string;
  label: string;
  /** Whether the field collects an answer. `required` is only allowed on those that do. */
  input: boolean;
  /** Properties this kind reads beyond the common ones. */
  props: readonly string[];
  /** Properties that must be present for the renderer to draw anything. */
  requires: readonly string[];
  note: string;
}

/** Every field may carry these; the kinds add to them. */
export const COMMON_FIELD_PROPS = ['id', 'type', 'label', 'required', 'placeholder', 'hint', 'description'] as const;

export const FIELD_KINDS: readonly FieldKindSpec[] = [
  { kind: 'text', label: 'Text', input: true, props: [], requires: [], note: 'A single line.' },
  { kind: 'textarea', label: 'Paragraph', input: true, props: ['aiAssist'], requires: [], note: 'Several lines; `aiAssist` draws the assist button beside it.' },
  { kind: 'number', label: 'Number', input: true, props: [], requires: [], note: 'A numeric keyboard.' },
  { kind: 'date', label: 'Date', input: true, props: [], requires: [], note: 'A date picker.' },
  { kind: 'time-range', label: 'Time range', input: true, props: [], requires: [], note: 'From–to, as text the way the placeholder shows it.' },
  { kind: 'checkbox', label: 'Checkbox', input: true, props: [], requires: [], note: 'One statement to tick; `description` is the statement.' },
  { kind: 'switch', label: 'Switch', input: true, props: [], requires: [], note: 'On or off.' },
  { kind: 'select', label: 'Select', input: true, props: ['options'], requires: ['options'], note: 'One of a closed list of options.' },
  { kind: 'selectable-cards', label: 'Cards', input: true, props: ['options', 'branching'], requires: ['options'], note: 'One of a list drawn as cards; `branching` makes each option id the key of a branch.' },
  { kind: 'city', label: 'City', input: true, props: ['options'], requires: [], note: 'A city, suggested from `options` — the City table — but not limited to them.' },
  { kind: 'geo-point', label: 'Map pin', input: true, props: [], requires: [], note: 'A dragged pin; lat/lng.' },
  { kind: 'image-upload', label: 'Photograph', input: true, props: [], requires: [], note: 'One image from the library or the camera.' },
  { kind: 'file-upload', label: 'File', input: true, props: [], requires: [], note: 'A PDF or image from the files picker.' },
  { kind: 'document-upload', label: 'Documents', input: true, props: ['options'], requires: ['options'], note: 'One file per `options` entry, each a ListingDocumentKind.' },
  { kind: 'venue-type', label: 'Venue type', input: true, props: ['filterByCategory'], requires: [], note: 'From the venue taxonomy; `filterByCategory` narrows it to the branch.' },
  { kind: 'media-type', label: 'Ad spot type', input: true, props: ['dependsOn', 'groupBy'], requires: [], note: 'From the media-type taxonomy under the venue named by `dependsOn`.' },
  { kind: 'material', label: 'Material', input: true, props: ['dependsOn'], requires: [], note: 'From the materials the media type named by `dependsOn` allows.' },
  { kind: 'sub-venue', label: 'Placement area', input: true, props: ['dependsOn'], requires: [], note: 'From the areas of the venue named by `dependsOn`.' },
  { kind: 'base-price', label: 'Base price', input: true, props: ['showIndicator'], requires: [], note: 'A rupee amount; `showIndicator` draws the comparable-price band under it.' },
  { kind: 'content-stance', label: 'Restricted categories', input: true, props: ['scope'], requires: ['scope'], note: 'Content categories needing the owner\'s approval; `scope` is RESTRICTED.' },
  { kind: 'content-prohibited', label: 'Prohibited content', input: true, props: ['scope'], requires: ['scope'], note: 'Content categories never allowed; `scope` is PROHIBITED.' },
  { kind: 'section', label: 'Section heading', input: false, props: ['from'], requires: [], note: 'A heading, not a question; `from` names an answer to print in its place.' },
  { kind: 'computed', label: 'Computed value', input: false, props: ['from', 'op', 'readOnly'], requires: ['from'], note: 'Derived from the answers in `from` with `op`; never typed.' },
] as const;

export const FIELD_KIND_NAMES = FIELD_KINDS.map((spec) => spec.kind) as [string, ...string[]];
const KIND_BY_NAME = new Map(FIELD_KINDS.map((spec) => [spec.kind, spec]));
const INPUT_KINDS = new Set(FIELD_KINDS.filter((spec) => spec.input).map((spec) => spec.kind));

export const COMPUTED_OPS = ['multiply', 'add'] as const;
export const CONTENT_SCOPES = ['RESTRICTED', 'PROHIBITED'] as const;

/* ── The wizard shape ────────────────────────────────────────────────── */

const idSchema = z.string().trim().min(1).max(64);
const labelSchema = z.string().trim().min(1).max(200);

export const flowOptionSchema = z
  .object({
    id: idSchema,
    title: labelSchema,
    description: z.string().max(500).optional(),
  })
  .strict();

export const flowFieldSchema = z
  .object({
    id: idSchema,
    type: z.enum(FIELD_KIND_NAMES),
    label: labelSchema,
    required: z.boolean().optional(),
    placeholder: z.string().max(500).optional(),
    hint: z.string().max(1000).optional(),
    description: z.string().max(1000).optional(),
    options: z.array(flowOptionSchema).min(1).max(200).optional(),
    branching: z.boolean().optional(),
    dependsOn: idSchema.optional(),
    filterByCategory: z.boolean().optional(),
    groupBy: z.string().trim().min(1).max(64).optional(),
    from: z.array(idSchema).min(1).max(8).optional(),
    op: z.enum(COMPUTED_OPS).optional(),
    readOnly: z.boolean().optional(),
    showIndicator: z.boolean().optional(),
    scope: z.enum(CONTENT_SCOPES).optional(),
    aiAssist: z.boolean().optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    const spec = KIND_BY_NAME.get(field.type);
    if (!spec) return;
    const allowed = new Set<string>([...COMMON_FIELD_PROPS, ...spec.props]);
    for (const prop of Object.keys(field)) {
      if (!allowed.has(prop)) {
        ctx.addIssue({ code: 'custom', path: [prop], message: `\`${prop}\` is not a property of a ${field.type} field` });
      }
    }
    for (const prop of spec.requires) {
      if ((field as Record<string, unknown>)[prop] === undefined) {
        ctx.addIssue({ code: 'custom', path: [prop], message: `A ${field.type} field needs \`${prop}\`` });
      }
    }
    if (field.required && !INPUT_KINDS.has(field.type)) {
      ctx.addIssue({ code: 'custom', path: ['required'], message: `A ${field.type} collects nothing, so it cannot be required` });
    }
    if (field.branching && field.type !== 'selectable-cards') {
      ctx.addIssue({ code: 'custom', path: ['branching'], message: 'Only selectable-cards may branch' });
    }
  });

export const flowScreenSchema = z
  .object({
    key: idSchema,
    title: labelSchema,
    subtitle: z.string().max(500).optional(),
    step: z.number().int().min(1).max(99),
    totalSteps: z.number().int().min(1).max(99),
    badge: z.string().max(40).optional(),
    ctaLabel: labelSchema,
    fields: z.array(flowFieldSchema).max(60),
  })
  .strict();

export const flowBranchSchema = z
  .object({
    id: idSchema,
    title: labelSchema,
    description: z.string().max(500),
    screens: z.array(flowScreenSchema).min(1).max(40),
  })
  .strict();

/** A flow as the row holds it; `version` and `updatedAt` are stamped by the PATCH, never sent. */
export const wizardFlowSchema = z
  .object({
    label: labelSchema,
    /** Lot G (Q126): the sentence the flow list prints under the key. */
    description: z.string().trim().max(500).optional(),
    /** G13-B: who climbs it — a short phrase the flow list prints beside the key. */
    audience: z.string().trim().min(1).max(80).optional(),
    screens: z.array(flowScreenSchema).min(1).max(40),
    branches: z.record(idSchema, flowBranchSchema),
    version: z.number().int().min(1).optional(),
    updatedAt: z.string().optional(),
  })
  .strict()
  .superRefine((flow, ctx) => {
    // Screen keys are unique within the root and within each branch. Every
    // branch of the listing wizard has a `venue` step, deliberately — one shape
    // per branch — so a key may repeat *across* branches.
    const checkScreens = (screens: { key: string; fields: { id: string; dependsOn?: string; from?: string[] }[] }[], path: (string | number)[], inherited: Set<string>) => {
      const seenKeys = new Set<string>();
      const fieldIds = new Set(inherited);
      screens.forEach((screen, s) => {
        if (seenKeys.has(screen.key)) {
          ctx.addIssue({ code: 'custom', path: [...path, s, 'key'], message: `Screen key \`${screen.key}\` is used twice` });
        }
        seenKeys.add(screen.key);
        screen.fields.forEach((field, f) => {
          if (fieldIds.has(field.id)) {
            ctx.addIssue({ code: 'custom', path: [...path, s, 'fields', f, 'id'], message: `Field id \`${field.id}\` is used twice` });
          }
          fieldIds.add(field.id);
        });
      });
      // References point at an answer collected earlier in the same path.
      const known = new Set(inherited);
      screens.forEach((screen, s) => {
        screen.fields.forEach((field, f) => {
          for (const ref of [field.dependsOn, ...(field.from ?? [])]) {
            if (ref !== undefined && !known.has(ref)) {
              ctx.addIssue({ code: 'custom', path: [...path, s, 'fields', f], message: `\`${ref}\` is not a field asked before this one` });
            }
          }
          known.add(field.id);
        });
      });
      return fieldIds;
    };

    const rootIds = checkScreens(flow.screens, ['screens'], new Set());
    for (const [key, branch] of Object.entries(flow.branches)) {
      if (branch.id !== key) {
        ctx.addIssue({ code: 'custom', path: ['branches', key, 'id'], message: `Branch \`${key}\` says its id is \`${branch.id}\`` });
      }
      checkScreens(branch.screens, ['branches', key, 'screens'], rootIds);
    }

    // Every branching option is a branch that exists, and nothing else branches.
    const branchKeys = new Set(Object.keys(flow.branches));
    const targeted = new Set<string>();
    flow.screens.forEach((screen, s) => {
      screen.fields.forEach((field, f) => {
        if (!field.branching) return;
        for (const option of field.options ?? []) {
          targeted.add(option.id);
          if (!branchKeys.has(option.id)) {
            ctx.addIssue({ code: 'custom', path: ['screens', s, 'fields', f, 'options'], message: `Option \`${option.id}\` branches to a branch that does not exist` });
          }
        }
      });
    });
    for (const key of branchKeys) {
      if (!targeted.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['branches', key], message: `Branch \`${key}\` is not the target of any option` });
      }
    }
  });

export type WizardFlow = z.infer<typeof wizardFlowSchema>;

/* ── Enum groups ─────────────────────────────────────────────────────── */

export const enumEntrySchema = z
  .object({
    value: z.string().trim().min(1).max(64),
    label: labelSchema,
    description: z.string().max(500).optional(),
  })
  .strict();

export const enumGroupSchema = z
  .array(enumEntrySchema)
  .min(1)
  .max(200)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    entries.forEach((entry, i) => {
      if (seen.has(entry.value)) ctx.addIssue({ code: 'custom', path: [i, 'value'], message: `\`${entry.value}\` is listed twice` });
      seen.add(entry.value);
    });
  });

export const enumGroupNameSchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/, 'An enum group is a camelCase name');
export const flowKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'A flow key is lower-case, hyphenated');

/* ── Diff summaries for the audit row ────────────────────────────────── */

export interface ChangeSummary {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * JSON with object keys sorted, so a row written by hand and the same row
 * back out of the parser — which lays keys out in schema order — compare
 * equal. Arrays keep their order: a reordered screen list is a change.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Which entries moved between two lists keyed by `keyOf`. */
export function summariseChanges<T>(before: readonly T[], after: readonly T[], keyOf: (item: T) => string): ChangeSummary {
  const left = new Map(before.map((item) => [keyOf(item), canonicalJson(item)]));
  const right = new Map(after.map((item) => [keyOf(item), canonicalJson(item)]));
  const added = [...right.keys()].filter((key) => !left.has(key));
  const removed = [...left.keys()].filter((key) => !right.has(key));
  const changed = [...right.keys()].filter((key) => left.has(key) && left.get(key) !== right.get(key));
  return { added, removed, changed };
}

/** Screens across a wizard, named `key` at the root and `branch/key` inside a branch. */
export function wizardScreens(flow: unknown): { name: string; screen: unknown }[] {
  if (!flow || typeof flow !== 'object') return [];
  const value = flow as { screens?: unknown; branches?: unknown };
  const out: { name: string; screen: unknown }[] = [];
  if (Array.isArray(value.screens)) {
    for (const screen of value.screens) out.push({ name: String((screen as { key?: unknown })?.key ?? '?'), screen });
  }
  if (value.branches && typeof value.branches === 'object') {
    for (const [branch, def] of Object.entries(value.branches as Record<string, { screens?: unknown }>)) {
      if (!Array.isArray(def?.screens)) continue;
      for (const screen of def.screens) out.push({ name: `${branch}/${String((screen as { key?: unknown })?.key ?? '?')}`, screen });
    }
  }
  return out;
}

/* ── The document GET /config/schema serves ──────────────────────────── */

export function fieldVocabulary() {
  return {
    commonProps: [...COMMON_FIELD_PROPS],
    kinds: FIELD_KINDS.map((spec) => ({ ...spec, props: [...spec.props], requires: [...spec.requires] })),
    option: { id: 'string', title: 'string', description: 'string?' },
    computedOps: [...COMPUTED_OPS],
    contentScopes: [...CONTENT_SCOPES],
    screen: {
      key: 'string — unique within its screen list',
      title: 'string',
      subtitle: 'string?',
      step: 'int — the step counter; past totalSteps for an unnumbered screen',
      totalSteps: 'int',
      badge: 'string? — printed instead of the counter on an unnumbered screen',
      ctaLabel: 'string',
      fields: 'FlowField[]',
    },
    branch: { id: 'string — equals its key under branches', title: 'string', description: 'string', screens: 'FlowScreen[]' },
    flow: {
      label: 'string',
      description: 'string? — printed under the key in the flow list',
      audience: 'string? — who climbs it, a short phrase (at most 80 characters); the code default when absent',
      screens: 'FlowScreen[] — the root; one selectable-cards field with branching: true',
      branches: 'Record<optionId, FlowBranch>',
      version: 'int — stamped by the server, bumped on every PATCH',
      updatedAt: 'ISO string — stamped by the server',
    },
    rules: [
      'every field type is one of `kinds`',
      'a field carries only the common props and the props of its kind',
      'screen keys are unique within the root and within each branch',
      'field ids are unique within the root plus any one branch',
      '`dependsOn` and `from` name a field asked earlier on the same path',
      'every option of a branching field is a key under `branches`, and every branch is targeted',
      '`required` is only allowed on kinds that collect an answer',
    ],
  };
}

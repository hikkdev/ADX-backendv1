import { z } from 'zod';
import { summariseChanges, type ChangeSummary } from './flow-schema';

/**
 * The onboarding ladder's vocabulary — `flows.onboarding` (Q83).
 *
 * The phone climbs the ladder `GET /users/me/onboarding-manifest` serves;
 * `users` composes that manifest from this template when the row holds one
 * and from its code ladder when it does not. The template is a **library of
 * step definitions** keyed by id and a **ladder per party and account type**
 * naming the ids in order, so the six ladders share one definition of each
 * KYC step rather than carrying six copies for the console to keep in step.
 *
 * Why the vocabulary is here and not beside `PublisherKyc`'s schema: both
 * `publishers` and `kyc` already import this module (for the platform
 * settings), so a list they exported could not be read from here without a
 * cycle. The column names below are the manifest's binding vocabulary — the
 * `field` a tile's upload goes to — and the required set is what a ladder
 * must cover before it may be served.
 */

export const PARTIES = ['PUBLISHER', 'ADVERTISER'] as const;
export const ACCOUNT_TYPES = ['INDIVIDUAL', 'BUSINESS', 'ORGANISATION'] as const;
export type TemplateParty = (typeof PARTIES)[number];
export type TemplateAccountType = (typeof ACCOUNT_TYPES)[number];

export const GOV_ID_TYPES = ['AADHAAR', 'PASSPORT', 'DRIVING_LICENCE'] as const;
export const ADDRESS_PROOF_TYPES = ['UTILITY_BILL', 'RENT_AGREEMENT', 'BANK_STATEMENT'] as const;

/**
 * The KYC columns a capture tile may bind to. The first six are on both the
 * publisher and the advertiser KYC rows under the same names; `selfVideoUrl`
 * is the liveness clip on `UserKyc` (Lot D, Q131).
 */
export const KYC_CAPTURE_COLUMNS = [
  'govIdFrontUrl',
  'govIdBackUrl',
  'panFrontUrl',
  'panSignatureUrl',
  'addressProofUrl',
  'selfieUrl',
  'selfVideoUrl',
] as const;
export type KycCaptureColumn = (typeof KYC_CAPTURE_COLUMNS)[number];

/**
 * What every ladder must collect before the desk can verify the record — the
 * same for the three account types today, because the business and
 * organisation forms add profile fields, not documents. `govIdBackUrl` is
 * not here: a passport has no back, so the step is skippable rather than
 * required. `panNumber` is typed beside the PAN tile, so a ladder covering
 * `panFrontUrl` has asked for it.
 */
export const REQUIRED_KYC_COLUMNS: Record<TemplateAccountType, readonly KycCaptureColumn[]> = {
  INDIVIDUAL: ['govIdFrontUrl', 'panFrontUrl', 'addressProofUrl', 'selfieUrl', 'selfVideoUrl'],
  BUSINESS: ['govIdFrontUrl', 'panFrontUrl', 'addressProofUrl', 'selfieUrl', 'selfVideoUrl'],
  ORGANISATION: ['govIdFrontUrl', 'panFrontUrl', 'addressProofUrl', 'selfieUrl', 'selfVideoUrl'],
};

export const ONBOARDING_STEP_KINDS = ['account-type', 'form', 'kyc-intro', 'capture', 'checklist', 'review', 'agreement'] as const;
export type OnboardingStepKind = (typeof ONBOARDING_STEP_KINDS)[number];

/* ── Schema ──────────────────────────────────────────────────────────── */

const key = z.string().min(1).max(64);
const text = z.string().min(1).max(300);

const govIdCondition = z.object({ field: z.literal('govIdType'), value: z.enum(GOV_ID_TYPES) }).strict();

/**
 * The property order here is load-bearing: the parser lays an object out in
 * schema order, `users` composes the manifest from the parsed template (a
 * jsonb column hands keys back in its own order, so the row cannot be
 * trusted for that), and the order below is the code ladder's — which is
 * what keeps the served manifest byte-identical to the one served before
 * the ladder became data.
 */
export const onboardingTileSchema = z
  .object({
    key,
    label: text,
    hint: z.string().max(300),
    field: z.enum(KYC_CAPTURE_COLUMNS),
    source: z.enum(['library', 'camera']),
    front: z.boolean().optional(),
    pdf: z.boolean().optional(),
    sets: z
      .union([govIdCondition, z.object({ field: z.literal('addressProofType'), value: z.enum(ADDRESS_PROOF_TYPES) }).strict()])
      .optional(),
    inert: z.boolean().optional(),
    onlyWhen: govIdCondition.optional(),
    video: z.boolean().optional(),
  })
  .strict();

export const onboardingStepSchema = z.discriminatedUnion('kind', [
  z.object({ key, kind: z.literal('account-type'), title: text }).strict(),
  z.object({ key, kind: z.literal('form'), title: text, subtitle: text }).strict(),
  z
    .object({
      key,
      kind: z.literal('kyc-intro'),
      title: text,
      subtitle: text,
      bands: z.array(z.object({ label: text, value: text }).strict()).min(1).max(8),
      cta: text,
    })
    .strict(),
  z
    .object({
      key,
      kind: z.literal('capture'),
      title: text,
      subtitle: text,
      text: z
        .object({ field: z.literal('panNumber'), label: text, hint: z.string().max(300), pattern: z.string().min(1).max(200), maxLength: z.number().int().min(1).max(64) })
        .strict()
        .optional(),
      guidance: z.array(z.object({ label: text, hint: z.string().max(300) }).strict()).max(8).optional(),
      documents: z.array(onboardingTileSchema).min(1).max(8),
      skippableWhen: govIdCondition.optional(),
      cta: text,
    })
    .strict(),
  z.object({ key, kind: z.literal('checklist'), title: text, subtitle: text, cta: text }).strict(),
  z.object({ key, kind: z.literal('review'), title: text, subtitle: text, cta: text }).strict(),
  z.object({ key, kind: z.literal('agreement'), title: text, subtitle: text, cta: text, agreementKey: key.optional() }).strict(),
]);

const ladderSchema = z.array(key).min(1).max(40);
const laddersByType = z.object({ INDIVIDUAL: ladderSchema, BUSINESS: ladderSchema, ORGANISATION: ladderSchema }).strict();

/**
 * The row's shape. `version` and `updatedAt` are stamped by the PATCH; the
 * seed writes `version: 1` so a manifest served before any edit says so.
 */
export const onboardingTemplateSchema = z
  .object({
    label: text.optional(),
    /** Lot G (Q126): the sentence the flow list prints under the key. */
    description: z.string().trim().max(500).optional(),
    /** G13-B: who climbs it — a short phrase. */
    audience: z.string().trim().min(1).max(80).optional(),
    version: z.number().int().min(1).optional(),
    updatedAt: z.string().optional(),
    steps: z.record(key, onboardingStepSchema),
    ladders: z.object({ PUBLISHER: laddersByType, ADVERTISER: laddersByType }).strict(),
  })
  .strict()
  .superRefine((template, ctx) => {
    for (const issue of templateIssues(template)) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });

export type OnboardingTile = z.infer<typeof onboardingTileSchema>;
export type OnboardingStepDef = z.infer<typeof onboardingStepSchema>;
export type OnboardingTemplate = z.infer<typeof onboardingTemplateSchema>;

export interface TemplateIssue {
  path: (string | number)[];
  message: string;
}

/**
 * What the shape alone cannot say: every ladder names steps that exist, no
 * ladder shows one step key twice, every ladder covers the KYC columns its
 * account type requires, and no tile answers a column that is not one of the
 * seven (the enum on `field` already refuses that; it is listed here so the
 * console reads one list of rules).
 */
export function templateIssues(template: { steps: Record<string, OnboardingStepDef>; ladders: OnboardingTemplate['ladders'] }): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  for (const party of PARTIES) {
    for (const accountType of ACCOUNT_TYPES) {
      const ladder = template.ladders[party][accountType];
      const path = ['ladders', party, accountType];
      const seenKeys = new Set<string>();
      const covered = new Set<string>();
      ladder.forEach((id, i) => {
        const step = template.steps[id];
        if (!step) {
          issues.push({ path: [...path, i], message: `\`${id}\` is not a step in the library` });
          return;
        }
        if (seenKeys.has(step.key)) issues.push({ path: [...path, i], message: `Step key \`${step.key}\` appears twice on this ladder` });
        seenKeys.add(step.key);
        if (step.kind === 'capture') {
          for (const tile of step.documents) if (!tile.inert) covered.add(tile.field);
        }
      });
      const missing = REQUIRED_KYC_COLUMNS[accountType].filter((column) => !covered.has(column));
      if (missing.length > 0) {
        issues.push({ path, message: `The ${party} ${accountType} ladder never captures ${missing.join(', ')}` });
      }
    }
  }
  return issues;
}

/** Steps across the template's library, for the audit row. */
export function templateSteps(template: unknown): { name: string; step: unknown }[] {
  if (!template || typeof template !== 'object') return [];
  const steps = (template as { steps?: unknown }).steps;
  if (!steps || typeof steps !== 'object') return [];
  return Object.entries(steps as Record<string, unknown>).map(([name, step]) => ({ name, step }));
}

export function templateDiff(before: unknown, after: unknown): { steps: ChangeSummary; ladders: ChangeSummary } {
  const ladders = (value: unknown) => {
    const map = (value as { ladders?: Record<string, Record<string, unknown>> } | null)?.ladders;
    if (!map || typeof map !== 'object') return [];
    return Object.entries(map).flatMap(([party, byType]) =>
      Object.entries(byType ?? {}).map(([type, ladder]) => ({ name: `${party}/${type}`, ladder })),
    );
  };
  return {
    steps: summariseChanges(templateSteps(before), templateSteps(after), (s) => s.name),
    ladders: summariseChanges(ladders(before), ladders(after), (l) => l.name),
  };
}

/** The document GET /config/schema serves for the ladder. */
export function onboardingVocabulary() {
  return {
    stepKinds: [...ONBOARDING_STEP_KINDS],
    parties: [...PARTIES],
    accountTypes: [...ACCOUNT_TYPES],
    kycColumns: [...KYC_CAPTURE_COLUMNS],
    requiredKycColumns: { ...REQUIRED_KYC_COLUMNS },
    govIdTypes: [...GOV_ID_TYPES],
    addressProofTypes: [...ADDRESS_PROOF_TYPES],
    tile: {
      key: 'string',
      label: 'string',
      hint: 'string',
      field: 'KycColumn — where the upload goes',
      source: "'library' | 'camera'",
      front: 'boolean? — the front camera',
      sets: '{ field: govIdType | addressProofType, value }? — choosing this tile answers the which-kind column',
      inert: 'boolean? — drawn, not tappable',
      onlyWhen: '{ field: govIdType, value }? — drawn only when the column already holds this value',
      pdf: 'boolean? — the OS document picker as well as the library',
      video: 'boolean? — a clip rather than a photograph',
    },
    step: {
      'account-type': { key: 'string', title: 'string' },
      form: { key: 'string', title: 'string', subtitle: 'string' },
      'kyc-intro': { key: 'string', title: 'string', subtitle: 'string', bands: '{ label, value }[]', cta: 'string' },
      capture: {
        key: 'string',
        title: 'string',
        subtitle: 'string',
        documents: 'Tile[] — more than one means "one of these"',
        text: '{ field: panNumber, label, hint, pattern, maxLength }?',
        guidance: '{ label, hint }[]?',
        skippableWhen: '{ field: govIdType, value }?',
        cta: 'string',
      },
      checklist: { key: 'string', title: 'string', subtitle: 'string', cta: 'string' },
      review: { key: 'string', title: 'string', subtitle: 'string', cta: 'string' },
      agreement: { key: 'string', title: 'string', subtitle: 'string', cta: 'string', agreementKey: 'string?' },
    },
    template: {
      label: 'string?',
      description: 'string? — printed under the key in the flow list',
      audience: 'string? — who climbs it, a short phrase (at most 80 characters); the code default when absent',
      version: 'int — stamped by the server, bumped on every PATCH',
      updatedAt: 'ISO string — stamped by the server',
      steps: 'Record<stepId, Step> — the library',
      ladders: 'Record<PUBLISHER | ADVERTISER, Record<INDIVIDUAL | BUSINESS | ORGANISATION, stepId[]>>',
    },
    rules: [
      'every ladder entry is a step id in the library',
      'no step key appears twice on one ladder',
      'every ladder captures each of `requiredKycColumns` for its account type on a tile that is not inert',
      'every tile binds to one of `kycColumns`',
    ],
  };
}

import { z } from 'zod';

/**
 * What a milestone template demands before it can be completed.
 *
 * `optional` on the two labelled kinds is what lets a template ask for a shot
 * without blocking on it — the guided capture sequence in the agent app marks
 * each proof Mandatory or Optional from this flag, and the wide context shot at
 * the end of a site visit is the case it exists for. Absent means mandatory, so
 * every requirement written before the flag existed keeps its meaning.
 */
export type MilestoneRequirement =
  | { kind: 'photo'; label: string; optional?: boolean }
  | { kind: 'checklist_item'; label: string; optional?: boolean }
  | { kind: 'qr_scan' }
  | { kind: 'location_checkin' }
  | { kind: 'contact_details_visible' };

export type EvidenceInput = {
  kind: string;
  label?: string;
  value: string;
};

/**
 * `contact_details_visible` is informational only — it can be required by a
 * template but never submitted as evidence.
 */
export const VALID_EVIDENCE_KINDS = [
  'photo',
  'checklist_item',
  'qr_scan',
  'location_checkin',
] as const;

/**
 * A label with something in it.
 *
 * `.refine` rather than `.trim().min(1)` because the label is also the join key:
 * `checkEvidence` matches submitted evidence on `e.label === req.label`, and the
 * agent app sends back the label exactly as it read it. A schema that silently
 * trimmed would make `'  Front face '` unsatisfiable — the server would demand
 * the trimmed string and the app would offer the untrimmed one. So the value is
 * left alone and only the blank case is rejected.
 */
export const requirementLabelSchema = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'Label must not be blank' });

const requirementRowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('photo'), label: requirementLabelSchema, optional: z.boolean().optional() }),
  z.object({
    kind: z.literal('checklist_item'),
    label: requirementLabelSchema,
    optional: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('qr_scan') }),
  z.object({ kind: z.literal('location_checkin') }),
  z.object({ kind: z.literal('contact_details_visible') }),
]);

/**
 * Requirements are stored as loose JSON, so rows that no longer parse are
 * dropped rather than throwing — an unreadable requirement must not make an
 * existing milestone impossible to complete.
 *
 * A blank or whitespace-only label is one of those unreadable rows. The agent
 * app's `readRequirements` (verification-plan.ts) drops it, so the guided
 * capture never asks for it; if this kept it, `checkEvidence` would demand a
 * proof no screen offers and the milestone could never be completed —
 * IN_PROGRESS for good, with the ticks resetting on every refresh.
 *
 * Enforced here rather than only at creation because creation is not the only
 * way a template is written: seeds and direct writes never see that schema, and
 * this is the read path all of them share. The creation schema now shares this
 * exact rule too — its `.min(1)` admitted `'   '`, which is the same defect one
 * layer up.
 */
export function parseRequirements(raw: unknown): MilestoneRequirement[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const parsed = requirementRowSchema.safeParse(r);
    return parsed.success ? [parsed.data as MilestoneRequirement] : [];
  });
}

/**
 * Whether a requirement may be left unsatisfied.
 *
 * Only the labelled kinds carry the flag: a check-in or a QR scan is either the
 * proof the visit rests on or it is not in the template at all, and there is no
 * useful "optionally prove you were there".
 */
export function requirementIsOptional(req: MilestoneRequirement): boolean {
  return (req.kind === 'photo' || req.kind === 'checklist_item') && req.optional === true;
}

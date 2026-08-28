import { z } from 'zod';

/** What a milestone template demands before it can be completed. */
export type MilestoneRequirement =
  | { kind: 'photo'; label: string }
  | { kind: 'checklist_item'; label: string }
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

const requirementRowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('photo'), label: z.string() }),
  z.object({ kind: z.literal('checklist_item'), label: z.string() }),
  z.object({ kind: z.literal('qr_scan') }),
  z.object({ kind: z.literal('location_checkin') }),
  z.object({ kind: z.literal('contact_details_visible') }),
]);

/**
 * Requirements are stored as loose JSON, so rows that no longer parse are
 * dropped rather than throwing — an unreadable requirement must not make an
 * existing milestone impossible to complete.
 */
export function parseRequirements(raw: unknown): MilestoneRequirement[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const parsed = requirementRowSchema.safeParse(r);
    return parsed.success ? [parsed.data as MilestoneRequirement] : [];
  });
}

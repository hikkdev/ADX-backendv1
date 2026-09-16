import { ApiError } from '../../shared/errors';
import {
  VALID_EVIDENCE_KINDS,
  parseRequirements,
  requirementIsOptional,
  type EvidenceInput,
  type MilestoneRequirement,
} from './order-milestones.types';

/**
 * Validates submitted evidence against a template's requirements.
 *
 * Returns the deduplicated evidence to persist, or throws. Pure — no I/O — so
 * the matching rules are testable on their own.
 */
export function checkEvidence(rawRequirements: unknown, evidence: EvidenceInput[]): EvidenceInput[] {
  const invalidKinds = evidence.filter(
    (e) => !(VALID_EVIDENCE_KINDS as readonly string[]).includes(e.kind),
  );
  if (invalidKinds.length > 0) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `Invalid evidence kind(s): ${invalidKinds.map((e) => e.kind).join(', ')}`,
    );
  }

  // Dedupe by (kind, label); the last entry wins, so a re-submitted photo
  // replaces the earlier one instead of creating two evidence rows.
  const evidenceMap = new Map<string, EvidenceInput>();
  for (const e of evidence) {
    evidenceMap.set(`${e.kind}::${e.label ?? ''}`, e);
  }
  const deduped = Array.from(evidenceMap.values());

  const missing: string[] = [];
  for (const req of parseRequirements(rawRequirements)) {
    if (req.kind === 'contact_details_visible') continue; // informational only

    // An optional requirement is never missing. Skipped whole rather than
    // checked-then-forgiven, so an optional checklist item the agent answered
    // "no" to is recorded as the answer it is instead of failing the visit.
    if (requirementIsOptional(req)) continue;

    const submitted = deduped.find((e) => {
      if (e.kind !== req.kind) return false;
      // Labelled kinds must match label too; unlabelled kinds match on kind.
      if (req.kind === 'photo' || req.kind === 'checklist_item') return e.label === req.label;
      return true;
    });

    if (!submitted) {
      missing.push(describeRequirement(req));
      continue;
    }

    // Checklist items must be affirmatively confirmed. Normalised before
    // comparison so " True " counts.
    if (req.kind === 'checklist_item' && submitted.value.trim().toLowerCase() !== 'true') {
      missing.push(`checklist_item: ${req.label} (must be confirmed)`);
    }
  }

  if (missing.length > 0) {
    throw new ApiError(
      400,
      'EVIDENCE_INCOMPLETE',
      `Missing required evidence: ${missing.join(', ')}`,
    );
  }

  return deduped;
}

function describeRequirement(req: MilestoneRequirement): string {
  return req.kind === 'photo' || req.kind === 'checklist_item'
    ? `${req.kind}: ${req.label}`
    : req.kind;
}

/**
 * The five reasons an agent may hand an offer back — DR 01's "Reason for
 * cancellation" sheet (3424:26884; the advertiser-side request sheet
 * 3458:28301 draws the same five).
 *
 * A closed list rather than free text, because the sheet says so ("You must
 * provide a reason. Frequent rejections affect ratings.") and because a reason
 * ops can count is the only kind that can feed a rating or a territory
 * decision. OTHER is the one that carries the agent's own words, and it must
 * carry them — "Other" alone is no reason.
 */

export const AGENT_REJECTION_REASONS = [
  'TOO_FAR',
  'NOT_AVAILABLE',
  'NO_EXPERTISE',
  'AT_CAPACITY',
  'OTHER',
] as const;

export type AgentRejectionReason = (typeof AGENT_REJECTION_REASONS)[number];

/** The sheet's wording, verbatim, keyed by reason. */
export const AGENT_REJECTION_LABELS: Record<AgentRejectionReason, { title: string; hint: string }> = {
  TOO_FAR: { title: 'Too far from my location', hint: 'Beyond service radius / travel limit' },
  NOT_AVAILABLE: { title: 'Not available during required time', hint: 'Schedule conflict with the order window' },
  NO_EXPERTISE: { title: "Don't have expertise for this type", hint: 'Out of my specialization' },
  AT_CAPACITY: { title: 'Too many active orders', hint: 'At capacity right now' },
  OTHER: { title: 'Other (specify)', hint: 'Write your own reason' },
};

/** What an offer that nobody answered is recorded as. Not one of the five. */
export const OFFER_EXPIRED_REASON = 'EXPIRED';

/**
 * What goes into `OrderAgentAssignment.rejectionReason`.
 *
 * One column holds both the code and, for OTHER, the words: `OTHER: <note>`.
 * The code leads so a report can group on the prefix; the note follows so a
 * person reading the row still sees what was said.
 */
export function rejectionText(reason: AgentRejectionReason, note?: string): string {
  const words = note?.trim();
  return words ? `${reason}: ${words}` : reason;
}

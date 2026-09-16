import { z } from 'zod';

/**
 * How long a window may run.
 *
 * Fifteen minutes is enough to fix a price with someone on the phone; a working
 * day is the outside case where an agent is walking a publisher through several
 * listings. Nothing here is open-ended, because the whole point of the
 * mechanism is that access ends by itself rather than by anyone remembering.
 */
export const MIN_DURATION_MINUTES = 15;
export const MAX_DURATION_MINUTES = 8 * 60;
export const DEFAULT_DURATION_MINUTES = 60;

export const issueGrantSchema = z.object({
  publisherId: z.string().min(1),
  /**
   * What the publisher wants changed, in their own words.
   *
   * DR asks this at generation time, and it is not paperwork: it is the only
   * record of what the publisher thought they were agreeing to. The agent sees
   * it on the scan, and it is what an argument three months later is settled
   * against. A minimum length, because "help" describes nothing.
   */
  reason: z.string().min(10).max(500),
  scope: z.enum(['PROFILE', 'LISTINGS']),
  /**
   * Specific listings, when the publisher narrows it.
   *
   * Empty means every listing they own. That is a bigger grant than naming
   * three, so the API distinguishes them rather than treating an empty array as
   * an unset field.
   */
  listingIds: z.array(z.string().min(1)).max(200).default([]),
  /**
   * The request ADX has already put someone on.
   *
   * Required, and the only way an agent is named. The publisher used to send an
   * `assignedAgentId` — which meant the app had to show them an id, and the
   * assignment became something they could mistype or be talked into changing.
   * ADX decides who handles a ticket; the code is bound to whoever that is.
   */
  supportTicketId: z.string().min(1),
  durationMinutes: z
    .number()
    .int()
    .min(MIN_DURATION_MINUTES)
    .max(MAX_DURATION_MINUTES)
    .default(DEFAULT_DURATION_MINUTES),
});

export type IssueGrantInput = z.infer<typeof issueGrantSchema>;

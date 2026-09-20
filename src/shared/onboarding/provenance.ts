import type { OnboardingSource } from '../database';

/**
 * QR-14 (17 Sep 2026): who onboarded whom.
 *
 * Every party carries the door it came through (`onboardedVia`), the person
 * who opened it (`onboardedById`, null for a self-signup), that person's
 * console role or kind at the time (`onboardedByRole` — a snapshot, because
 * roles move) and when. Stamped once, at the door; a later claim, adoption
 * or edit never moves it. The team board (reports) counts on these.
 */
export type { OnboardingSource };

export const ONBOARDING_SOURCES = ['SELF', 'AGENT', 'QR', 'DESK', 'IMPORT'] as const;

export const ONBOARDING_SOURCE_LABEL: Record<OnboardingSource, string> = {
  SELF: 'Self-serve',
  AGENT: 'Agent',
  QR: 'Agent (QR scan)',
  DESK: 'Desk',
  IMPORT: 'Import',
};

/** What a door writes on the row it opens. */
export interface Provenance {
  onboardedVia: OnboardingSource;
  onboardedById: string | null;
  onboardedByRole: string | null;
  onboardedAt: Date;
}

export const selfProvenance = (at = new Date()): Provenance => ({ onboardedVia: 'SELF', onboardedById: null, onboardedByRole: null, onboardedAt: at });

export const doorProvenance = (via: Exclude<OnboardingSource, 'SELF'>, byUserId: string, role: string, at = new Date()): Provenance => ({
  onboardedVia: via,
  onboardedById: byUserId,
  onboardedByRole: role,
  onboardedAt: at,
});

/** The block a detail read answers — the stamp, with the person named. */
export interface OnboardingFacts {
  via: OnboardingSource | null;
  viaLabel: string | null;
  byId: string | null;
  byName: string | null;
  byRole: string | null;
  at: Date | null;
}

export function onboardingFactsOf(
  row: { onboardedVia: OnboardingSource | null; onboardedById: string | null; onboardedByRole: string | null; onboardedAt: Date | null },
  byName: string | null,
): OnboardingFacts {
  return {
    via: row.onboardedVia,
    viaLabel: row.onboardedVia ? ONBOARDING_SOURCE_LABEL[row.onboardedVia] : null,
    byId: row.onboardedById,
    byName,
    byRole: row.onboardedByRole,
    at: row.onboardedAt,
  };
}

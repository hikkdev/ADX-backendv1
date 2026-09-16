/**
 * E7-3: what every KYC case read carries beside its row, whichever party
 * type it is — how long it has waited against the review SLA, and the
 * people on it by name.
 *
 * `ageHours` / `slaBreached` are the queue's own rule (`shared/time.slaAge`
 * over `getPlatformSettings().kyc.reviewSlaHours`), so a case and its queue
 * row never disagree; the clock runs only while the case is PENDING, as the
 * advertiser queue already has it. The names come through `UserLabelPort`:
 * `users` sits above this module (it reaches `publishers`, which reaches
 * here for the desk), so the lookup is inverted the way `payouts` and
 * `feature-flags` take theirs — this declares what the reads need,
 * `users.findUserLabels` supplies it, `bootstrap/register-modules` connects
 * the two. Unregistered, every person is `{ id, name: null }`; a missing
 * column is null.
 */
import type { KycStatus } from '../../shared/database';
import { slaAge } from '../../shared/time';
import { getPlatformSettings } from '../app-config';

export type UserLabel = { id: string; name: string | null };
export type UserLabelPort = (ids: readonly string[]) => Promise<Map<string, UserLabel>>;

let registered: UserLabelPort | null = null;

export function registerKycUserLabelPort(port: UserLabelPort): void {
  registered = port;
}

/** Tests only. */
export function resetKycUserLabelPort(): void {
  registered = null;
}

export async function kycUserLabels(ids: readonly (string | null | undefined)[]): Promise<Map<string, UserLabel>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const fallback = new Map<string, UserLabel>(unique.map((id) => [id, { id, name: null }]));
  if (!registered || unique.length === 0) return fallback;
  try {
    const found = await registered(unique);
    for (const [id, label] of found) fallback.set(id, label);
  } catch {
    // A name is decoration on the case; the case still answers.
  }
  return fallback;
}

export type KycCaseRow = {
  status: KycStatus;
  submittedAt: Date | null;
  reviewedById?: string | null;
  assignedToId?: string | null;
  recordedById?: string | null;
  /** Lot N: who asked for the KYC from the desk. */
  requestedById?: string | null;
  /** G11-1: the escalation's two people (Lot G, Q127/142) — named the same way. */
  escalatedToUserId?: string | null;
  escalatedById?: string | null;
};

export type KycCaseExtras = {
  ageHours: number | null;
  slaBreached: boolean;
  slaHours: number;
  reviewedBy: UserLabel | null;
  assignedTo: UserLabel | null;
  recordedBy: UserLabel | null;
  /** Lot N: who requested the KYC from the desk; null when nobody did. */
  requestedBy: UserLabel | null;
  /** G11-1: who the case was escalated to, and who escalated it; null while it is not. */
  escalatedTo: UserLabel | null;
  escalatedBy: UserLabel | null;
};

/** The people a case row names — the three of E7-3 and (G11-1) the escalation's two — for one lookup. */
export const kycCasePeopleIds = (row: KycCaseRow | null | undefined): (string | null | undefined)[] =>
  row ? [row.reviewedById, row.assignedToId, row.recordedById, row.requestedById, row.escalatedToUserId, row.escalatedById] : [];

/** `{ id, name }` for an id out of a lookup, or null for no id. */
export const kycLabelFor = (labels: Map<string, UserLabel>, id: string | null | undefined): UserLabel | null =>
  id ? labels.get(id) ?? { id, name: null } : null;

/** The age against the SLA and the people on it, for one case read; a party with no KYC row yet has no age and nobody on it. */
export async function kycCaseExtras(row: KycCaseRow | null | undefined, now: Date = new Date()): Promise<KycCaseExtras> {
  const [{ kyc }, labels] = await Promise.all([getPlatformSettings(), kycUserLabels(kycCasePeopleIds(row))]);
  const label = (id: string | null | undefined): UserLabel | null => kycLabelFor(labels, id);
  return {
    ...slaAge(row?.status === 'PENDING' ? row.submittedAt : null, kyc.reviewSlaHours, now),
    slaHours: kyc.reviewSlaHours,
    reviewedBy: label(row?.reviewedById),
    assignedTo: label(row?.assignedToId),
    recordedBy: label(row?.recordedById),
    requestedBy: label(row?.requestedById),
    escalatedTo: label(row?.escalatedToUserId),
    escalatedBy: label(row?.escalatedById),
  };
}

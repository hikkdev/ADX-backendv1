import type { SafetyAlert, SafetyAlertKind, SafetyAlertStatus } from '../../shared/database';

export type { SafetyAlert, SafetyAlertKind, SafetyAlertStatus };

export type Actor = { sub: string; roles: string[] };

export const SAFETY_KINDS = ['UNSAFE_SITE', 'HARASSMENT', 'ACCIDENT', 'LOCATION_SHARE', 'OTHER'] as const;
export const SAFETY_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'CLOSED'] as const;

export const KIND_LABEL: Record<SafetyAlertKind, string> = {
  UNSAFE_SITE: 'unsafe site reported',
  HARASSMENT: 'harassment reported',
  ACCIDENT: 'accident reported',
  LOCATION_SHARE: 'live location shared',
  OTHER: 'safety concern',
};

/**
 * Which kinds take the job off the agent. DR 07's promise is that reporting
 * an unsafe site blocks the job; sharing a location does not, because the
 * agent is asking to be watched, not to be pulled off.
 */
export const BLOCKING_KINDS: SafetyAlertKind[] = ['UNSAFE_SITE', 'HARASSMENT', 'ACCIDENT'];

export type NewAlert = {
  displayId: string;
  raisedByUserId: string;
  kind: SafetyAlertKind;
  orderId: string | null;
  milestoneId: string | null;
  note: string | null;
  latitude: number | null;
  longitude: number | null;
  blockedOrder: boolean;
};

export type SafetyPatch = {
  status?: SafetyAlertStatus;
  opsNote?: string | null;
  acknowledgedAt?: Date;
  acknowledgedById?: string;
  closedAt?: Date;
  closedById?: string;
};

export type SafetyAlertRow = SafetyAlert & {
  raisedBy: { id: string; name: string | null; mobile: string };
  order: { id: string; status: string; listing: { title: string; address: string; city: string | null } | null } | null;
};

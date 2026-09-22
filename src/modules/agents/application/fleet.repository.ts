import type { FleetInvite, FleetInviteStatus, FleetPartner } from '../../../shared/database';

/**
 * AG-5: fleet partners — a delivery or ride fleet whose riders ADX invites
 * to apply — and the invites sent from their lists. The number on an invite
 * is what ties a later application back to the partner.
 */

export type NewFleetPartner = {
  name: string;
  platform: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  notes: string | null;
  createdById: string;
};

export type FleetPartnerPatch = Partial<Omit<NewFleetPartner, 'createdById'>> & { isActive?: boolean };

export type FleetPartnerRow = FleetPartner & {
  /** How the invites stand: sent, applied, activated. */
  invites: { sent: number; applied: number; activated: number };
};

export type FleetInviteRow = FleetInvite & { agent: { id: string; displayId: string | null; stage: string; user: { name: string | null } } | null };

export interface FleetRepository {
  createPartner(input: NewFleetPartner): Promise<FleetPartner>;
  updatePartner(partnerId: string, patch: FleetPartnerPatch): Promise<FleetPartner>;
  findPartner(partnerId: string): Promise<FleetPartner | null>;
  listPartners(): Promise<FleetPartnerRow[]>;
  listInvites(partnerId: string): Promise<FleetInviteRow[]>;
  /** One row per number; a number already on the partner's list is left as it stands. Returns the rows created. */
  addInvites(partnerId: string, rows: { mobile: string; name: string | null }[], sentById: string): Promise<FleetInvite[]>;
  /** The most recent invite to this number that has not been taken up. */
  findOpenInviteByMobile(mobile: string): Promise<(FleetInvite & { partner: { id: string; name: string } }) | null>;
  setInviteStatus(inviteId: string, status: FleetInviteStatus, agentId: string | null, appliedAt?: Date): Promise<void>;
  /** The invite an activated agent applied through, if any. */
  findInviteByAgent(agentId: string): Promise<FleetInvite | null>;
  userMobile(userId: string): Promise<string | null>;
}

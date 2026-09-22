import type { Request } from 'express';
import { z } from 'zod';
import { ApiError } from '../../../shared/errors';
import { logActivity } from '../../../shared/audit';
import { env } from '../../../config/env';
import { sendSms } from '../../../shared/sms';
import { normalizeMobile } from '../../../shared/validation';
import { prismaFleetRepository as repository } from './prisma-fleet.repository';
import type { FleetInviteRow, FleetPartnerRow } from './fleet.repository';

/**
 * AG-5 (the owner, 20 Sep 2026): "we will be using existing network of
 * delivery agents as our publisher agent." A fleet partner is the
 * delivery or ride fleet ops signed up; its riders are invited by SMS from
 * a pasted list, apply in the ADX Agent app with the number the SMS went
 * to, and the application carries the partner as its provenance
 * (`sourceKind: FLEET`, the partner named, `fleetPartnerId`). No partner
 * fee — decision 9.
 */

export const FLEET_PLATFORMS = ['ZOMATO', 'SWIGGY', 'RAPIDO', 'UBER', 'OLA', 'DUNZO', 'AMAZON_FLEX', 'DELHIVERY', 'PORTER', 'OTHER'] as const;

export const fleetPartnerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  platform: z.enum(FLEET_PLATFORMS).default('OTHER'),
  contactName: z.string().trim().max(120).optional(),
  phone: z.string().trim().min(10).max(16).optional(),
  email: z.string().trim().email().optional(),
  city: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(600).optional(),
});
export type FleetPartnerInput = z.infer<typeof fleetPartnerSchema>;

export const fleetPartnerPatchSchema = fleetPartnerSchema.partial().extend({ isActive: z.boolean().optional() });

/** `POST /agents/fleet-partners/:id/invites` — the pasted list: a number per row, a name beside it when the partner gave one. */
export const fleetInvitesSchema = z.object({
  rows: z.array(z.object({ mobile: z.string().trim().min(1).max(24), name: z.string().trim().max(120).optional() })).min(1).max(500),
});
export type FleetInvitesInput = z.infer<typeof fleetInvitesSchema>;

export async function listFleetPartners(): Promise<FleetPartnerRow[]> {
  return repository.listPartners();
}

export async function getFleetPartner(partnerId: string): Promise<{ partner: FleetPartnerRow; invites: FleetInviteRow[] }> {
  const partners = await repository.listPartners();
  const partner = partners.find((p) => p.id === partnerId);
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Fleet partner not found');
  return { partner, invites: await repository.listInvites(partnerId) };
}

export async function createFleetPartner(input: FleetPartnerInput, byUserId: string, req?: Request) {
  const partner = await repository.createPartner({
    name: input.name,
    platform: input.platform,
    contactName: input.contactName ?? null,
    phone: input.phone ? normalizeMobile(input.phone) : null,
    email: input.email ?? null,
    city: input.city ?? null,
    notes: input.notes ?? null,
    createdById: byUserId,
  });
  await logActivity(byUserId, 'FLEET_PARTNER_CREATED', { req, targetType: 'FleetPartner', targetId: partner.id, module: 'agents', metadata: { name: partner.name, platform: partner.platform } });
  return partner;
}

export async function updateFleetPartner(partnerId: string, input: z.infer<typeof fleetPartnerPatchSchema>, byUserId: string, req?: Request) {
  const existing = await repository.findPartner(partnerId);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Fleet partner not found');
  const partner = await repository.updatePartner(partnerId, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(input.contactName !== undefined ? { contactName: input.contactName } : {}),
    ...(input.phone !== undefined ? { phone: normalizeMobile(input.phone) } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.city !== undefined ? { city: input.city } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
  });
  await logActivity(byUserId, 'FLEET_PARTNER_UPDATED', { req, targetType: 'FleetPartner', targetId: partnerId, module: 'agents', metadata: { fields: Object.keys(input) } });
  return partner;
}

/** Where the SMS sends them: the Play Store listing when one is set, the website otherwise. */
export function agentAppLink(): string {
  return env.PLAY_STORE_URL ?? (env.PUBLIC_WEB_URL ? `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/agents` : 'https://adx.in/agents');
}

/**
 * The bulk invite: every number normalised, the duplicates on this partner's
 * list skipped, an SMS to each fresh one. The rows that could not be read
 * as a number come back so ops can fix the paste; nothing is sent to them.
 */
export async function inviteFleet(partnerId: string, input: FleetInvitesInput, byUserId: string, req?: Request) {
  const partner = await repository.findPartner(partnerId);
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Fleet partner not found');
  if (!partner.isActive) throw new ApiError(409, 'CONFLICT', 'This fleet partner is switched off');
  const rejected: { mobile: string; reason: string }[] = [];
  const seen = new Set<string>();
  const rows: { mobile: string; name: string | null }[] = [];
  for (const row of input.rows) {
    const mobile = normalizeMobile(row.mobile);
    // Ten Indian digits, with or without the country code — anything else is not a number ADX can text.
    if (!/^\+91[6-9]\d{9}$/.test(mobile)) {
      rejected.push({ mobile: row.mobile, reason: 'Not an Indian mobile number' });
      continue;
    }
    if (seen.has(mobile)) continue;
    seen.add(mobile);
    rows.push({ mobile, name: row.name?.trim() || null });
  }
  const created = await repository.addInvites(partnerId, rows, byUserId);
  const link = agentAppLink();
  let sent = 0;
  for (const invite of created) {
    const result = await sendSms({
      to: invite.mobile,
      kind: 'AGENT_FLEET_INVITE',
      vars: { partner: partner.name, link },
      body: `${partner.name} and ADX invite you to earn as an ADX field agent — flexible hours, paid per job. Apply with this number in the ADX Agent app: ${link}`,
    }).catch(() => null);
    // In dev the rail logs and skips; a skip is not a failure, so it still counts as sent from the desk's side.
    if (result && (!result.skipped || result.reason === 'DEV')) sent += 1;
  }
  await logActivity(byUserId, 'FLEET_INVITES_SENT', { req, targetType: 'FleetPartner', targetId: partnerId, module: 'agents', metadata: { pasted: input.rows.length, invited: created.length, duplicates: rows.length - created.length, rejected: rejected.length, sent } });
  return { invited: created.length, duplicates: rows.length - created.length, rejected, sent, invites: await repository.listInvites(partnerId) };
}

/**
 * The provenance: an applicant whose number was invited by a fleet partner
 * applies as FLEET, the partner named, and the invite is marked applied.
 * Called by `apply()` before the profile is written; null when nobody
 * invited this number.
 */
export async function fleetProvenanceFor(userId: string): Promise<{ partnerId: string; partnerName: string; inviteId: string } | null> {
  const mobile = await repository.userMobile(userId);
  if (!mobile) return null;
  const invite = await repository.findOpenInviteByMobile(mobile);
  return invite ? { partnerId: invite.partner.id, partnerName: invite.partner.name, inviteId: invite.id } : null;
}

export async function markFleetInviteApplied(inviteId: string, agentId: string): Promise<void> {
  await repository.setInviteStatus(inviteId, 'APPLIED', agentId, new Date());
}

/** On activation: the invite this agent applied through, if any, reads ACTIVATED. */
export async function markFleetInviteActivated(agentId: string): Promise<void> {
  const invite = await repository.findInviteByAgent(agentId);
  if (invite && invite.status !== 'ACTIVATED') await repository.setInviteStatus(invite.id, 'ACTIVATED', agentId);
}

import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { reverseGeocode } from '../../shared/maps';
import { requireAgentProfile } from '../agents';
import { allocateIdentifier } from '../identifiers';
import { withCityKey } from '../pricing';
import { findUploadedFile } from '../uploads';
import { prismaLeadsRepository as repository } from './prisma-leads.repository';
import { distanceM } from './prisma-leads.repository';
import { getLead, resolveSource } from './leads.service';
import { normalisePhone } from './leads.phone';
import { LEAD_SIDES } from './leads.schema';
import { recomputeLead } from './scoring.service';
import { advanceStage } from './stages.service';

/**
 * LH4 (the Lead Hunt, 22 Sep 2026): street capture. An agent sees an
 * empty wall or a busy shop, photographs it, names the side and the
 * category, adds a number if they got one, and the app hands ADX the fix.
 * The lead lands on the agent's own list (CLAIMED), on the `capture`
 * source, with the address read back from the point when the agent typed
 * none; the photos stay on the row as private files for the listing draft
 * when it converts. A lead of the same side within 30 m is the same wall
 * — 409, naming it — and a phone already on a lead or an account is
 * refused the way every door refuses it.
 */

export const CAPTURE_RADIUS_M = 30;
export const MAX_CAPTURE_PHOTOS = 6;

export const captureLeadSchema = z.object({
  side: z.enum(LEAD_SIDES),
  category: z.string().trim().min(1).max(60),
  businessName: z.string().trim().min(1).max(160).optional(),
  contactName: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(6).max(20).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Metres, from the phone — a wide fix is still a fix, but the note says so. */
  accuracy: z.number().min(0).max(5000).optional(),
  address: z.string().trim().min(1).max(300).optional(),
  locality: z.string().trim().min(1).max(120).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  note: z.string().trim().min(1).max(500).optional(),
  /** Uploaded first under purpose LEAD_CAPTURE, by the same agent. */
  photoFileIds: z.array(z.string().trim().min(1).max(64)).max(MAX_CAPTURE_PHOTOS).default([]),
});
export type CaptureLeadInput = z.infer<typeof captureLeadSchema>;

/** The words on the row when the agent typed no name — "Wall near MG Road" / "Shop on 5th Cross". */
export function placeholderName(input: { side: string; category: string; locality?: string | null | undefined; address?: string | null | undefined }): string {
  const where = input.locality ?? input.address?.split(',')[0]?.trim() ?? null;
  const what = input.side === 'PUBLISHER' ? `${input.category} surface` : input.category;
  return where ? `${what} near ${where}` : `${what} (spotted)`;
}

export async function captureLead(userId: string, input: CaptureLeadInput) {
  const agent = await requireAgentProfile(userId);
  const point = { latitude: input.latitude, longitude: input.longitude };

  // The same wall twice: a lead of the side within thirty metres.
  const nearby = await repository.findOpenNear(point, CAPTURE_RADIUS_M, input.side);
  const same = nearby.map((lead) => ({ lead, metres: distanceM(point, lead) })).filter((row) => row.metres !== null && row.metres <= CAPTURE_RADIUS_M).sort((a, b) => a.metres! - b.metres!)[0];
  if (same) {
    throw new ApiError(409, 'CONFLICT', `That looks like ${same.lead.displayId ?? 'a lead'} already — ${same.lead.businessName}, ${same.metres} m away`, {
      reason: 'DUPLICATE_NEARBY',
      leadId: same.lead.id,
      displayId: same.lead.displayId,
      businessName: same.lead.businessName,
      distanceM: same.metres,
      mine: same.lead.assignedAgentId === agent.id,
    });
  }

  const phoneNormalised = normalisePhone(input.phone);
  if (input.phone && !phoneNormalised) throw new ApiError(400, 'VALIDATION_ERROR', 'That does not look like a phone number', { phone: input.phone });
  if (phoneNormalised) {
    const [leads, accounts] = await Promise.all([repository.findByPhones([phoneNormalised]), repository.findAccountsByPhones([phoneNormalised])]);
    if (leads[0]) throw new ApiError(409, 'CONFLICT', `That number is already on lead ${leads[0].displayId ?? leads[0].id}`, { reason: 'DUPLICATE_LEAD', leadId: leads[0].id, displayId: leads[0].displayId });
    if (accounts[0]) throw new ApiError(409, 'CONFLICT', `That number belongs to a ${accounts[0].kind.toLowerCase()} account already`, { reason: 'EXISTING_ACCOUNT', kind: accounts[0].kind, id: accounts[0].id });
  }

  // The photos must be the agent's own captures.
  const photos: string[] = [];
  for (const fileId of input.photoFileIds) {
    const file = await findUploadedFile(fileId);
    if (!file || file.purpose !== 'LEAD_CAPTURE' || file.userId !== userId) throw new ApiError(400, 'VALIDATION_ERROR', 'A photo is not one you uploaded for a capture', { fileId });
    photos.push(file.id);
  }

  // The address from the point when the agent typed none — best effort; a seam that cannot answer never stops a capture.
  let address = input.address ?? null;
  let locality = input.locality ?? null;
  let city = input.city ?? null;
  if (!address || !city) {
    try {
      const place = await reverseGeocode(point);
      if (place) {
        address = address ?? place.formattedAddress;
        city = city ?? place.city;
        locality = locality ?? place.formattedAddress.split(',')[0]?.trim() ?? null;
      }
    } catch (err) {
      logger.warn('Capture not reverse-geocoded', { err });
    }
  }

  const displayId = await allocateIdentifier('LEAD');
  const sourceId = await resolveSource('capture', 'CAPTURE');
  const now = new Date();
  const lead = await repository.create(
    await withCityKey({
      side: input.side,
      businessName: input.businessName?.trim() || placeholderName({ side: input.side, category: input.category, locality, address }),
      displayId,
      category: input.category,
      contactName: input.contactName ?? null,
      phone: input.phone ?? null,
      phoneNormalised,
      address,
      locality,
      city,
      latitude: input.latitude,
      longitude: input.longitude,
      interest: input.note ?? null,
      source: 'capture',
      sourceId,
      assignedAgentId: agent.id,
      capturedByAgentId: agent.id,
      capturedAt: now,
      photoFileIds: photos,
      lastTouchedAt: now,
      createdByUserId: userId,
    } as never),
  );
  await repository.logActivity({
    leadId: lead.id,
    actorUserId: userId,
    kind: 'IMPORTED',
    note: `Spotted in the street${input.accuracy !== undefined && input.accuracy > 50 ? ` (fix ±${Math.round(input.accuracy)} m)` : ''}${photos.length ? ` · ${photos.length} photo${photos.length === 1 ? '' : 's'}` : ''}${input.note ? ` — ${input.note}` : ''}`,
  });
  await recomputeLead(lead.id, now).catch((err) => logger.warn('Captured lead not scored', { leadId: lead.id, err }));
  // The capture is the agent's first touch on it — it counts toward the contact target as a logged touch.
  await repository.logActivity({ leadId: lead.id, actorUserId: userId, kind: 'TOUCH_LOGGED', note: 'Spotted in the street' });
  await advanceStage(lead.id, 'CLAIMED', { actorUserId: userId, note: 'captured in the street' });
  return getLead(lead.id);
}

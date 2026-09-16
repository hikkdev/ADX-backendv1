import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { allocateIdentifier } from '../identifiers';
import { createNotification } from '../notifications';
import { getUserDisplayName, listAdminUserIds } from '../users';
import { prismaSafetyRepository as repository } from './prisma-safety.repository';
import type { Actor, SafetyAlertKind, SafetyPatch } from './safety.types';
import { BLOCKING_KINDS, KIND_LABEL } from './safety.types';

/**
 * Safety and emergency — the one place in DR 07 where a screen does something
 * irreversible.
 *
 * DR 07's own words are that reporting an unsafe site *blocks the job and
 * alerts ops*, so this does both: the alert is a row ops work from the
 * console, every admin is told at once, and for a blocking kind the agent is
 * taken off the order rather than left standing on it. Taken off, not
 * cancelled — the order goes back to needing an agent, which is a state the
 * dispatcher already knows how to work.
 *
 * A live-location share is the same record with `kind: LOCATION_SHARE` and a
 * position on it, so ops see one queue rather than two.
 */

export async function raiseAlert(
  actor: Actor,
  input: {
    kind: SafetyAlertKind;
    orderId?: string;
    milestoneId?: string;
    note?: string;
    latitude?: number;
    longitude?: number;
  },
  req?: Parameters<typeof logActivity>[2],
) {
  const order = input.orderId ? await repository.findOrderForActor(input.orderId) : null;
  if (input.orderId && !order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  const displayId = await allocateIdentifier('SAFETY');
  const blocks = BLOCKING_KINDS.includes(input.kind) && !!order;
  const alert = await repository.create({
    displayId,
    raisedByUserId: actor.sub,
    kind: input.kind,
    orderId: input.orderId ?? null,
    milestoneId: input.milestoneId ?? null,
    note: input.note ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    blockedOrder: blocks,
  });

  // The job leaves the agent's hands before anybody is told, so an ops
  // notification never points at a job the agent is still holding.
  if (blocks) await repository.releaseOrderFromAgent(order!.id);

  const who = (await getUserDisplayName(actor.sub)) ?? 'An agent';
  const admins = await listAdminUserIds();
  await Promise.all(
    admins.map((userId) =>
      createNotification({
        userId,
        type: 'SYSTEM',
        title: `Safety: ${KIND_LABEL[input.kind]}`,
        subtitle: displayId,
        message: `${who}${order ? ` — order ${order.id.slice(-4).toUpperCase()}` : ''}${input.note ? `: ${input.note}` : ''}${blocks ? ' (the job has been taken off them)' : ''}`,
        relatedId: alert.id,
      }),
    ),
  );
  await logActivity(actor.sub, 'SAFETY_ALERT_RAISED', req, { alertId: alert.id, kind: input.kind, orderId: input.orderId ?? null, blockedOrder: blocks });
  return alert;
}

export const listMine = (actor: Actor) => repository.findManyForUser(actor.sub);

export const listQueue = (filter: { status?: 'OPEN' | 'ACKNOWLEDGED' | 'CLOSED'; limit: number; offset: number }) =>
  repository.findQueue(filter);

/** Ops picking one up, and closing it with what was done. */
export async function updateAlert(alertId: string, admin: Actor, patch: SafetyPatch, req?: Parameters<typeof logActivity>[2]) {
  const alert = await repository.findById(alertId);
  if (!alert) throw new ApiError(404, 'NOT_FOUND', 'Alert not found');
  const now = new Date();
  const updated = await repository.update(alertId, {
    ...patch,
    ...(patch.status === 'ACKNOWLEDGED' && !alert.acknowledgedAt ? { acknowledgedAt: now, acknowledgedById: admin.sub } : {}),
    ...(patch.status === 'CLOSED' ? { closedAt: now, closedById: admin.sub } : {}),
  });
  await createNotification({
    userId: alert.raisedByUserId,
    type: 'SYSTEM',
    title: patch.status === 'CLOSED' ? 'Safety report closed' : 'ADX is on your safety report',
    subtitle: alert.displayId,
    message: patch.opsNote ?? (patch.status === 'CLOSED' ? 'ADX has closed this report.' : 'Somebody at ADX is looking at this now.'),
    relatedId: alert.id,
  });
  await logActivity(admin.sub, 'SAFETY_ALERT_UPDATED', req, { alertId, status: updated.status });
  return updated;
}

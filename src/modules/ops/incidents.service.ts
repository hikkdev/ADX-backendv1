import type { Request } from 'express';
import type { HealthService, IncidentSeverity, IncidentStatus } from '../../shared/database';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import type { ListQuery } from '../../shared/pagination';
import { notify } from '../notifications';
import { notifyAdmins } from './ops.notify';
import type { IncidentFilter, IncidentWithUpdates } from './ops.repository';
import { prismaOpsRepository as repository } from './prisma-ops.repository';
import { unsubscribeUrlFor } from './status.links';

/**
 * Incidents — Lot G (Q130): the log ops keep by hand beside the probes.
 *
 * An incident opens with a title, a severity, the services it touches and
 * a first update; every later update carries a status and a body and moves
 * the incident's status with it (RESOLVED stamps `resolvedAt`; a later
 * non-RESOLVED update clears it — an incident can be reopened). Every
 * change is audited `INCIDENT_*`, every admin is told in-app, and every
 * confirmed status subscriber is mailed through the dispatcher (`INCIDENT_UPDATE`)
 * with their own unsubscribe link in the footer.
 */

const MODULE = 'ops';
const AUDITED_FIELDS = ['title', 'severity', 'status', 'services', 'startedAt', 'resolvedAt'] as const;

export interface NewIncidentInput {
  title: string;
  severity: IncidentSeverity;
  services: HealthService[];
  body: string;
  startedAt?: Date | undefined;
}

export interface IncidentUpdateInput {
  status: IncidentStatus;
  body: string;
}

export interface IncidentPatchInput {
  title?: string | undefined;
  severity?: IncidentSeverity | undefined;
  services?: HealthService[] | undefined;
  /** Only RESOLVED is a status a PATCH may set — "resolve" — with an optional closing note. */
  status?: 'RESOLVED' | undefined;
  body?: string | undefined;
}

export function listIncidents(filter: IncidentFilter, page: ListQuery) {
  return repository.listIncidents(filter, page);
}

export async function getIncident(id: string): Promise<IncidentWithUpdates> {
  const incident = await repository.findIncident(id);
  if (!incident) throw new ApiError(404, 'NOT_FOUND', 'Incident not found');
  return incident;
}

export async function createIncident(input: NewIncidentInput, actorId: string, req?: Request, now = new Date()): Promise<IncidentWithUpdates> {
  const incident = await repository.createIncident(
    { title: input.title, severity: input.severity, services: input.services, body: input.body, createdById: actorId, startedAt: input.startedAt ?? now },
    { status: 'OPEN', body: input.body, byUserId: actorId, at: now },
  );
  await logActivity(actorId, 'INCIDENT_CREATED', {
    req,
    module: MODULE,
    targetType: 'Incident',
    targetId: incident.id,
    diff: auditDiff(null, incident, AUDITED_FIELDS),
  });
  await broadcast(incident, 'OPEN', input.body);
  return incident;
}

export async function addIncidentUpdate(id: string, input: IncidentUpdateInput, actorId: string, req?: Request, now = new Date()): Promise<IncidentWithUpdates> {
  const before = await getIncident(id);
  const resolvedAt = input.status === 'RESOLVED' ? (before.resolvedAt ?? now) : null;
  const after = await repository.addUpdate(id, { status: input.status, body: input.body, byUserId: actorId, at: now }, { status: input.status, resolvedAt });
  await logActivity(actorId, input.status === 'RESOLVED' ? 'INCIDENT_RESOLVED' : 'INCIDENT_UPDATED', {
    req,
    module: MODULE,
    targetType: 'Incident',
    targetId: id,
    diff: auditDiff(before, after, AUDITED_FIELDS),
    metadata: { update: input.status },
  });
  await broadcast(after, input.status, input.body);
  return after;
}

/** PATCH: edit the title, severity or services, or resolve with a closing note. */
export async function patchIncident(id: string, input: IncidentPatchInput, actorId: string, req?: Request, now = new Date()): Promise<IncidentWithUpdates> {
  const before = await getIncident(id);
  const resolving = input.status === 'RESOLVED' && before.status !== 'RESOLVED';
  const patch = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(input.services !== undefined ? { services: input.services } : {}),
    ...(input.body !== undefined && !resolving ? { body: input.body } : {}),
    ...(resolving ? { status: 'RESOLVED' as const, resolvedAt: now } : {}),
  };
  if (Object.keys(patch).length === 0) throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to change');

  const closingNote = input.body ?? 'Resolved.';
  const after = resolving
    ? await repository.addUpdate(id, { status: 'RESOLVED', body: closingNote, byUserId: actorId, at: now }, patch)
    : await repository.patchIncident(id, patch);

  await logActivity(actorId, resolving ? 'INCIDENT_RESOLVED' : 'INCIDENT_EDITED', {
    req,
    module: MODULE,
    targetType: 'Incident',
    targetId: id,
    diff: auditDiff(before, after, AUDITED_FIELDS),
  });
  if (resolving) await broadcast(after, 'RESOLVED', closingNote);
  else if (input.severity !== undefined && input.severity !== before.severity) await broadcast(after, after.status, `Severity changed to ${after.severity}.`);
  return after;
}

/* ── who hears ───────────────────────────────────────────────────── */

/** Every admin in-app, every confirmed subscriber by mail. Never throws: a mail that fails is logged, the change stands. */
async function broadcast(incident: IncidentWithUpdates, status: IncidentStatus, body: string): Promise<void> {
  const services = incident.services.length ? incident.services.join(', ') : 'platform';
  try {
    await notifyAdmins({
      title: `Incident ${status.toLowerCase()}: ${incident.title}`,
      subtitle: `${incident.severity} · ${services}`,
      message: body,
      suggestedAction: 'Open Settings → System health → Incidents',
      relatedId: incident.id,
    });
  } catch (err) {
    logger.warn('Incident change: admins not notified', { incidentId: incident.id, err });
  }

  let subscribers: { email: string; token: string }[] = [];
  try {
    subscribers = await repository.confirmedSubscribers();
  } catch (err) {
    logger.warn('Incident change: subscribers not read', { incidentId: incident.id, err });
    return;
  }
  for (const subscriber of subscribers) {
    try {
      await notify(
        'INCIDENT_UPDATE',
        null,
        {
          title: incident.title,
          status,
          severity: incident.severity,
          services,
          body,
          unsubscribeUrl: unsubscribeUrlFor(subscriber.token),
        },
        { recipient: { email: subscriber.email }, type: 'SYSTEM' },
      );
    } catch (err) {
      logger.warn('Incident change: a subscriber was not mailed', { incidentId: incident.id, err });
    }
  }
}

import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';
import { HEALTH_SERVICES, INCIDENT_SEVERITIES, INCIDENT_SORTS, INCIDENT_STATUSES } from './ops.repository';

export const listIncidentsQuerySchema = listQuerySchema(INCIDENT_STATUSES, INCIDENT_SORTS).extend({
  service: z.enum(HEALTH_SERVICES).optional(),
});

export const createIncidentSchema = z.object({
  title: z.string().trim().min(3).max(140),
  severity: z.enum(INCIDENT_SEVERITIES).default('MINOR'),
  services: z.array(z.enum(HEALTH_SERVICES)).max(HEALTH_SERVICES.length).default([]),
  body: z.string().trim().min(3).max(4_000),
  startedAt: z.coerce.date().optional(),
});

export const incidentUpdateSchema = z.object({
  status: z.enum(INCIDENT_STATUSES),
  body: z.string().trim().min(3).max(4_000),
});

export const patchIncidentSchema = z
  .object({
    title: z.string().trim().min(3).max(140),
    severity: z.enum(INCIDENT_SEVERITIES),
    services: z.array(z.enum(HEALTH_SERVICES)).max(HEALTH_SERVICES.length),
    status: z.literal('RESOLVED'),
    body: z.string().trim().min(3).max(4_000),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to change' });

export const incidentIdParamSchema = z.object({ id: z.string().trim().min(1).max(64) });

export const subscribeSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200) });
export const subscriberTokenParamSchema = z.object({ token: z.string().trim().min(8).max(128) });

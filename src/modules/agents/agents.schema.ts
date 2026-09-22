import { z } from 'zod';
import { upperEnum } from '../../shared/validation';
import { AGENT_TIERS } from './tier-ladder';

export const listAgentsQuerySchema = z.object({
  city: z.string().optional(),
  tier: upperEnum(AGENT_TIERS).optional(),
  search: z.string().optional(), // matches against user name or mobile
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

/**
 * Creating an agent, from the admin panel.
 *
 * There is no self-signup for agents. Ops creates them here, in person: the
 * number the person will sign in with, their name, and which side of the
 * marketplace they sell for. Everything else on the profile is filled in
 * afterwards.
 */
export const createAgentSchema = z.object({
  mobile: z.string().trim().min(10).max(16),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().optional(),
  /** Which side they work; becomes AGENT_PUBLISHER or AGENT_ADVERTISER. */
  side: z.enum(['PUBLISHER', 'ADVERTISER']),
  city: z.string().trim().min(1).max(80).optional(),
  state: z.string().trim().min(1).max(80).optional(),
  /** AG-1: start an application (stage PROFILE, source DESK) rather than an ACTIVE agent. */
  asApplication: z.boolean().optional(),
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

/* ── D5: status, territory and the DR 07 work preferences ──────────────── */

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export const AGENT_ORDER_TYPES = ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] as const;
export const AGENT_PROFILE_STATUSES = ['ACTIVE', 'ON_LEAVE', 'SUSPENDED'] as const;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour');
const hoursInOrder = (v: { hoursFrom?: string | null; hoursTo?: string | null }) =>
  !v.hoursFrom || !v.hoursTo || v.hoursFrom < v.hoursTo;

/**
 * The DR 07 "Work preferences" screen, field for field: service area (radius,
 * home zone), availability (working days, hours, auto-accept in my zone) and
 * orders (order types, max active orders). The agent may write these about
 * themselves; nothing here touches the status or the territory.
 */
const preferenceFields = {
  homeZone: z.string().trim().min(1).max(80).nullable().optional(),
  radiusKm: z.coerce.number().int().min(1).max(100).nullable().optional(),
  workingDays: z.array(z.enum(WEEKDAYS)).max(7).optional(),
  hoursFrom: clock.nullable().optional(),
  hoursTo: clock.nullable().optional(),
  autoAcceptInZone: z.boolean().optional(),
  orderTypes: z.array(z.enum(AGENT_ORDER_TYPES)).max(4).optional(),
  maxActiveOrders: z.coerce.number().int().min(1).max(20).nullable().optional(),
};

export const agentPreferencesSchema = z.object(preferenceFields).refine(hoursInOrder, {
  message: 'Hours must start before they end',
  path: ['hoursTo'],
});
export type AgentPreferencesInput = z.infer<typeof agentPreferencesSchema>;

/**
 * What ops may write from the console: the preferences above, plus the
 * facts only the desk decides — the territory, the business or organisation
 * the agent works under, where they are based, and whether they are offered
 * work at all.
 */
export const updateAgentSchema = z
  .object({
    ...preferenceFields,
    city: z.string().trim().min(1).max(80).nullable().optional(),
    state: z.string().trim().min(1).max(80).nullable().optional(),
    businessName: z.string().trim().min(1).max(120).nullable().optional(),
    territory: z.string().trim().min(1).max(120).nullable().optional(),
    status: z.enum(AGENT_PROFILE_STATUSES).optional(),
  })
  .refine(hoursInOrder, { message: 'Hours must start before they end', path: ['hoursTo'] });
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../../shared/errors';
import { compensationDefaults, compensationFor, setCompensation, standingFor } from './compensation.service';

/**
 * CP-1: the desk's doors on agent pay. ADMIN only — a salary is not a figure
 * an agent edits, or reads here.
 *
 * The agent's own view of the quota is CP-5's tracker on their milestone
 * board (`GET /milestones`): how many of today's are done, how many the
 * salary still covers, and what the next one past it earns. That is the part
 * that is theirs to see; the salary it is priced from is the desk's.
 */

const parse = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  return result.data as T;
};

/** Money on the wire is a decimal string, the way every other amount is. */
const rupees = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Expected an amount like "12000" or "12000.00"');

const setSchema = z.object({
  monthlySalary: rupees,
  dailyQuota: z.number().int().min(1).max(100),
  workingDaysPerMonth: z.number().int().min(1).max(31).optional(),
  commissionUpliftPct: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).optional(),
  effectiveFrom: z.coerce.date().optional(),
  note: z.string().trim().max(500).optional(),
});

export async function getCompensationHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await compensationFor(req.params['id'] as string) });
}

export async function setCompensationHandler(req: Request, res: Response): Promise<void> {
  const input = parse(setSchema, req.body ?? {});
  res.json({ success: true, data: await setCompensation(req.params['id'] as string, input, req.user!.sub) });
}

export async function compensationDefaultsHandler(req: Request, res: Response): Promise<void> {
  const grade = typeof req.query['grade'] === 'string' ? req.query['grade'] : null;
  res.json({ success: true, data: await compensationDefaults(grade) });
}

export async function agentStandingHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await standingFor(req.params['id'] as string) });
}

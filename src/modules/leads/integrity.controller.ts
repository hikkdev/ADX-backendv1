import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { decideFlag, LEAD_FLAG_KINDS, LEAD_FLAG_STATUSES, listFlags, scanIntegrity } from './integrity.service';
import { listQaSamples, qualityFor, reviewQaSample, sampleQa } from './qa.service';
import { watchClawbacks } from './clawback.service';

/**
 * LH10: the integrity desk's doors — the flags with their decisions, the QA
 * samples with their reviews, an agent's quality score, and the three
 * sweeps by hand for ops who would rather not wait for the job.
 */

const parse = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  return result.data as T;
};

const flagQuerySchema = z.object({
  status: z.enum(LEAD_FLAG_STATUSES).optional(),
  kind: z.enum(LEAD_FLAG_KINDS).optional(),
  agentId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const decideSchema = z.object({
  status: z.enum(['CONFIRMED', 'DISMISSED']),
  note: z.string().trim().max(500).optional(),
});

const qaQuerySchema = z.object({
  agentId: z.string().min(1).optional(),
  kind: z.enum(['VISIT', 'CALL']).optional(),
  reviewed: z
    .union([z.literal('true'), z.literal('false')])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const reviewSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL']),
  note: z.string().trim().max(500).optional(),
});

export async function listFlagsHandler(req: Request, res: Response): Promise<void> {
  const query = parse(flagQuerySchema, req.query);
  res.json({ success: true, data: await listFlags(query) });
}

export async function decideFlagHandler(req: Request, res: Response): Promise<void> {
  const input = parse(decideSchema, req.body);
  res.json({ success: true, data: await decideFlag(req.params['flagId'] as string, input, req.user!.sub) });
}

export async function scanIntegrityHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await scanIntegrity() });
}

export async function listQaHandler(req: Request, res: Response): Promise<void> {
  const query = parse(qaQuerySchema, req.query);
  res.json({ success: true, data: await listQaSamples(query) });
}

export async function reviewQaHandler(req: Request, res: Response): Promise<void> {
  const input = parse(reviewSchema, req.body);
  res.json({ success: true, data: await reviewQaSample(req.params['sampleId'] as string, input, req.user!.sub) });
}

export async function sampleQaHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await sampleQa() });
}

export async function agentQualityHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await qualityFor(req.params['agentId'] as string) });
}

export async function runClawbacksHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await watchClawbacks() });
}

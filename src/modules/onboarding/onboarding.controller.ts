import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import type { OnboardingSubmissionStatus } from '../../shared/database';
import {
  flowTemplateSchema,
  statusUpdateSchema,
  submissionSchema,
  submissionUpdateSchema,
  listSubmissionsQuerySchema,
  userTypeSchema,
} from './onboarding.schema';
import * as service from './onboarding.service';

/** Query filters are upper-cased before validation, so `?status=draft` works. */
function upperQuery(value: unknown): string | undefined {
  return typeof value === 'string' ? value.toUpperCase() : undefined;
}

export async function listFlowTemplates(req: Request, res: Response): Promise<void> {
  const userType = upperQuery(req.query['userType']);
  // `active` defaults to true unless the literal string 'false' is sent.
  const active = typeof req.query['active'] === 'string' ? req.query['active'] !== 'false' : undefined;
  if (userType && !userTypeSchema.safeParse(userType).success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid userType');
  }

  const templates = await service.listFlowTemplates({ userType, isActive: active });
  res.json({ success: true, data: templates });
}

export async function getFlowTemplate(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await service.getFlowTemplate(req.params['key'] as string) });
}

export async function upsertFlowTemplate(req: Request, res: Response): Promise<void> {
  const parsed = flowTemplateSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const key = req.params['key'] as string;
  const template = await service.upsertFlowTemplate(key, parsed.data);

  await logActivity(req.user!.sub, 'ONBOARDING_FLOW_TEMPLATE_SAVED', req, {
    key,
    userType: template.userType,
  });
  res.json({ success: true, data: template });
}

export async function createOnboardingSubmission(req: Request, res: Response): Promise<void> {
  const parsed = submissionSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const submission = (await service.createSubmission(parsed.data, req.user!.sub)) as {
    id: string;
    userId: string | null;
  };

  await logActivity(req.user!.sub, 'ONBOARDING_SUBMISSION_CREATED', req, {
    submissionId: submission.id,
    userId: submission.userId,
    userType: parsed.data.userType,
    accountType: parsed.data.accountType,
  });

  res.status(201).json({ success: true, data: submission });
}

/**
 * E7-3: the list contract — `?q=&status=a,b&userType=&page=&pageSize=` →
 * `{ items, total, page, pageSize, counts }` — when a page is asked for;
 * the bare array it always answered otherwise, one release.
 */
export async function listOnboardingSubmissions(req: Request, res: Response): Promise<void> {
  const parsed = listSubmissionsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  const { page, pageSize, ...filter } = parsed.data;

  if (page !== undefined || pageSize !== undefined) {
    res.json({ success: true, data: await service.listSubmissionsPage(filter, page ?? 1, pageSize ?? 20) });
    return;
  }
  res.json({ success: true, data: await service.listSubmissions(filter) });
}

export async function getOnboardingSubmission(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await service.getSubmission(req.params['id'] as string) });
}

export async function updateOnboardingSubmission(req: Request, res: Response): Promise<void> {
  const parsed = submissionUpdateSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const submission = (await service.updateSubmission(req.params['id'] as string, parsed.data)) as {
    id: string;
    userType: string;
    accountType: string | null;
  };

  await logActivity(req.user!.sub, 'ONBOARDING_SUBMISSION_UPDATED', req, {
    submissionId: submission.id,
    userType: submission.userType,
    accountType: submission.accountType,
  });

  res.json({ success: true, data: submission });
}

export async function deleteOnboardingSubmission(req: Request, res: Response): Promise<void> {
  const existing = await service.deleteSubmission(req.params['id'] as string);

  await logActivity(req.user!.sub, 'ONBOARDING_SUBMISSION_DELETED', req, {
    submissionId: existing.id,
    userType: existing.userType,
  });

  res.json({ success: true, data: { message: 'Onboarding submission deleted' } });
}

export async function updateOnboardingSubmissionStatus(req: Request, res: Response): Promise<void> {
  const parsed = statusUpdateSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const submission = (await service.updateSubmissionStatus(
    req.params['id'] as string,
    parsed.data.status,
    req.user!.sub,
    parsed.data.rejectionReason,
  )) as { id: string; status: string };

  await logActivity(req.user!.sub, 'ONBOARDING_SUBMISSION_STATUS_UPDATED', req, {
    submissionId: submission.id,
    status: submission.status,
  });

  res.json({ success: true, data: submission });
}

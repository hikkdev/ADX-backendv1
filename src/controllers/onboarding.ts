import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { normalizeMobile } from '../services/otp.service';
import { logActivity } from '../services/activityLog.service';
import { Prisma, type OnboardingSubmissionStatus, type Role } from '../generated/prisma';

const userTypeSchema = z.enum(['PUBLISHER', 'ADVERTISER', 'PARTNER']);
const submissionStatusSchema = z.enum(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED']);

const defaultFlowTemplates = [
  {
    key: 'publisher-onboarding',
    userType: 'PUBLISHER',
    name: 'Publisher Onboarding',
    description: 'Publisher account setup and KYC capture flow.',
    version: 2,
    steps: [
      { label: 'User Type' },
      { label: 'Account Type' },
      { label: 'Publisher Info' },
      { label: 'Contact Person' },
      { label: 'E-KYC Documents' },
      { label: 'KYC Capture' },
      { label: 'Review' },
    ],
    schema: {
      accountTypes: ['INDIVIDUAL', 'BUSINESS', 'NGO'],
      requiredIdentityFields: ['name', 'businessName', 'mobile', 'contactPersonMobile'],
    },
  },
  {
    key: 'advertiser-onboarding',
    userType: 'ADVERTISER',
    name: 'Advertiser Onboarding',
    description: 'Advertiser brand setup and KYC capture flow.',
    version: 2,
    steps: [
      { label: 'User Type' },
      { label: 'Brand Type' },
      { label: 'Brand Info' },
      { label: 'Contact Person' },
      { label: 'E-KYC Documents' },
      { label: 'KYC Capture' },
      { label: 'Review' },
    ],
    schema: {
      accountTypes: ['SOLO', 'REGISTERED', 'NGO'],
      requiredIdentityFields: ['brandLegalIdentity', 'brandName', 'mobile', 'primaryContactMobile'],
    },
  },
  {
    key: 'partner-onboarding',
    userType: 'PARTNER',
    name: 'Partner Onboarding',
    description: 'External partner onboarding flow.',
    version: 2,
    steps: [
      { label: 'User Type' },
      { label: 'Partner Type' },
      { label: 'Partner Info' },
      { label: 'Contact Person' },
      { label: 'Agreement Docs' },
      { label: 'Commercials' },
      { label: 'Review' },
    ],
    schema: {
      accountTypes: ['CHANNEL', 'TECHNOLOGY', 'STRATEGIC'],
      requiredIdentityFields: ['partnerLegalName', 'partnerDisplayName', 'mobile'],
    },
  },
] as const;

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function ensureDefaultFlowTemplates(): Promise<void> {
  await Promise.all(
    defaultFlowTemplates.map(async (template) => {
      const existing = await prisma.onboardingFlowTemplate.findUnique({ where: { key: template.key } });
      if (existing && existing.version >= template.version) return;

      const data = {
        userType: template.userType,
        name: template.name,
        description: template.description,
        version: template.version,
        steps: asJson(template.steps),
        schema: asJson(template.schema),
      };

      if (existing) {
        await prisma.onboardingFlowTemplate.update({ where: { key: template.key }, data });
        return;
      }

      await prisma.onboardingFlowTemplate.create({ data: { key: template.key, ...data } });
    }),
  );
}

const flowTemplateSchema = z.object({
  userType: userTypeSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.number().int().positive().optional(),
  steps: z.array(z.record(z.string(), z.unknown())).min(1),
  schema: z.record(z.string(), z.unknown()),
  isActive: z.boolean().optional(),
});

export async function listFlowTemplates(req: Request, res: Response): Promise<void> {
  await ensureDefaultFlowTemplates();

  const userType = typeof req.query.userType === 'string' ? req.query.userType.toUpperCase() : undefined;
  const active = typeof req.query.active === 'string' ? req.query.active !== 'false' : undefined;
  if (userType && !userTypeSchema.safeParse(userType).success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid userType');
  }

  const templates = await prisma.onboardingFlowTemplate.findMany({
    where: {
      ...(userType ? { userType } : {}),
      ...(active !== undefined ? { isActive: active } : {}),
    },
    orderBy: [{ userType: 'asc' }, { version: 'desc' }],
  });

  res.json({ success: true, data: templates });
}

export async function getFlowTemplate(req: Request, res: Response): Promise<void> {
  await ensureDefaultFlowTemplates();

  const template = await prisma.onboardingFlowTemplate.findUnique({ where: { key: req.params.key as string } });
  if (!template) throw new ApiError(404, 'NOT_FOUND', 'Onboarding flow template not found');

  res.json({ success: true, data: template });
}

export async function upsertFlowTemplate(req: Request, res: Response): Promise<void> {
  const parsed = flowTemplateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const key = req.params.key as string;
  const template = await prisma.onboardingFlowTemplate.upsert({
    where: { key },
    update: {
      ...parsed.data,
      steps: asJson(parsed.data.steps),
      schema: asJson(parsed.data.schema),
    },
    create: {
      key,
      ...parsed.data,
      steps: asJson(parsed.data.steps),
      schema: asJson(parsed.data.schema),
    },
  });

  await logActivity(req.user!.sub, 'ONBOARDING_FLOW_TEMPLATE_SAVED', req, { key, userType: template.userType });
  res.json({ success: true, data: template });
}

const submissionSchema = z.object({
  flowTemplateId: z.string().min(1).optional(),
  flowTemplateKey: z.string().min(1).optional(),
  userType: userTypeSchema,
  accountType: z.string().min(1).optional(),
  status: submissionStatusSchema.optional(),
  data: z.record(z.string(), z.unknown()),
  userId: z.string().min(1).optional(),
  user: z.object({
    mobile: z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid mobile number'),
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    roles: z.array(z.enum(['PUBLISHER', 'ADVERTISER', 'PARTNER'])).optional(),
  }).optional(),
});

function defaultRolesForUserType(userType: string): Role[] {
  if (userType === 'PUBLISHER') return ['PUBLISHER'];
  if (userType === 'ADVERTISER') return ['ADVERTISER'];
  if (userType === 'PARTNER') return ['PARTNER'];
  return [];
}

export async function createOnboardingSubmission(req: Request, res: Response): Promise<void> {
  await ensureDefaultFlowTemplates();

  const parsed = submissionSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { flowTemplateId, flowTemplateKey, userType, accountType, status = 'SUBMITTED', data, userId, user } = parsed.data;

  const template = flowTemplateId
    ? await prisma.onboardingFlowTemplate.findUnique({ where: { id: flowTemplateId } })
    : await prisma.onboardingFlowTemplate.findUnique({ where: { key: flowTemplateKey ?? `${userType.toLowerCase()}-onboarding` } });

  if (!template) throw new ApiError(404, 'NOT_FOUND', 'Onboarding flow template not found');
  if (template.userType !== userType) {
    throw new ApiError(400, 'BAD_REQUEST', 'Flow template does not match submission user type');
  }

  const result = await prisma.$transaction(async (tx) => {
    let subjectUserId = userId;
    let createdUser = null;

    if (user) {
      const mobile = normalizeMobile(user.mobile);
      const existingMobile = await tx.user.findUnique({ where: { mobile } });
      if (existingMobile) throw new ApiError(409, 'CONFLICT', 'A user with this mobile number already exists');
      if (user.email) {
        const existingEmail = await tx.user.findUnique({ where: { email: user.email } });
        if (existingEmail) throw new ApiError(409, 'CONFLICT', 'A user with this email already exists');
      }

      const roles = user.roles?.length ? user.roles : defaultRolesForUserType(userType);
      createdUser = await tx.user.create({ data: { mobile, name: user.name, email: user.email } });
      subjectUserId = createdUser.id;

      if (roles.length) {
        await tx.userRole.createMany({
          data: roles.map((role) => ({ userId: createdUser!.id, role })),
        });
      }
    } else if (subjectUserId) {
      const existingUser = await tx.user.findUnique({ where: { id: subjectUserId } });
      if (!existingUser) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    }

    const submission = await tx.onboardingSubmission.create({
      data: {
        flowTemplateId: template.id,
        userId: subjectUserId,
        userType,
        accountType,
        status: status as OnboardingSubmissionStatus,
        data: asJson(data),
        submittedById: req.user!.sub,
      },
      include: {
        flowTemplate: true,
        user: { include: { roles: true } },
      },
    });

    return { createdUser, submission };
  });

  await logActivity(req.user!.sub, 'ONBOARDING_SUBMISSION_CREATED', req, {
    submissionId: result.submission.id,
    userId: result.submission.userId,
    userType,
    accountType,
  });

  res.status(201).json({ success: true, data: result.submission });
}

export async function listOnboardingSubmissions(req: Request, res: Response): Promise<void> {
  const userType = typeof req.query.userType === 'string' ? req.query.userType.toUpperCase() : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
  if (userType && !userTypeSchema.safeParse(userType).success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid userType');
  }
  if (status && !submissionStatusSchema.safeParse(status).success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid status');
  }

  const submissions = await prisma.onboardingSubmission.findMany({
    where: {
      ...(userType ? { userType } : {}),
      ...(status ? { status: status as OnboardingSubmissionStatus } : {}),
    },
    include: {
      flowTemplate: true,
      user: { include: { roles: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: submissions });
}

export async function getOnboardingSubmission(req: Request, res: Response): Promise<void> {
  const submission = await prisma.onboardingSubmission.findUnique({
    where: { id: req.params.id as string },
    include: {
      flowTemplate: true,
      user: { include: { roles: true } },
    },
  });
  if (!submission) throw new ApiError(404, 'NOT_FOUND', 'Onboarding submission not found');

  res.json({ success: true, data: submission });
}

const submissionUpdateSchema = z.object({
  userType: userTypeSchema.optional(),
  accountType: z.string().min(1).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

// PATCH /onboarding/submissions/:id — edit a DRAFT submission's contents.
// Drafts are the admin panel's server-side "save & resume" slots; submitted
// or reviewed submissions are immutable outside the status endpoint.
export async function updateOnboardingSubmission(req: Request, res: Response): Promise<void> {
  const parsed = submissionUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const existing = await prisma.onboardingSubmission.findUnique({ where: { id: req.params.id as string } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Onboarding submission not found');
  if (existing.status !== 'DRAFT') {
    throw new ApiError(409, 'CONFLICT', 'Only DRAFT submissions can be edited');
  }

  const { userType, accountType, data } = parsed.data;

  // A draft's user type can change mid-flow; keep the linked template in sync
  let flowTemplateId = existing.flowTemplateId;
  if (userType && userType !== existing.userType) {
    await ensureDefaultFlowTemplates();
    const template = await prisma.onboardingFlowTemplate.findUnique({ where: { key: `${userType.toLowerCase()}-onboarding` } });
    if (!template) throw new ApiError(404, 'NOT_FOUND', 'Onboarding flow template not found');
    flowTemplateId = template.id;
  }

  const submission = await prisma.onboardingSubmission.update({
    where: { id: existing.id },
    data: {
      ...(userType ? { userType, flowTemplateId } : {}),
      ...(accountType !== undefined ? { accountType } : {}),
      ...(data !== undefined ? { data: asJson(data) } : {}),
    },
    include: {
      flowTemplate: true,
      user: { include: { roles: true } },
    },
  });

  await logActivity(req.user!.sub, 'ONBOARDING_SUBMISSION_UPDATED', req, {
    submissionId: submission.id,
    userType: submission.userType,
    accountType: submission.accountType,
  });

  res.json({ success: true, data: submission });
}

// DELETE /onboarding/submissions/:id — discard a DRAFT submission. Submitted
// or reviewed submissions are audit history and can only be CANCELLED via the
// status endpoint, never removed.
export async function deleteOnboardingSubmission(req: Request, res: Response): Promise<void> {
  const existing = await prisma.onboardingSubmission.findUnique({ where: { id: req.params.id as string } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Onboarding submission not found');
  if (existing.status !== 'DRAFT') {
    throw new ApiError(409, 'CONFLICT', 'Only DRAFT submissions can be deleted');
  }

  await prisma.onboardingSubmission.delete({ where: { id: existing.id } });

  await logActivity(req.user!.sub, 'ONBOARDING_SUBMISSION_DELETED', req, {
    submissionId: existing.id,
    userType: existing.userType,
  });

  res.json({ success: true, data: { message: 'Onboarding submission deleted' } });
}

const statusUpdateSchema = z.object({
  status: submissionStatusSchema,
  rejectionReason: z.string().optional(),
});

export async function updateOnboardingSubmissionStatus(req: Request, res: Response): Promise<void> {
  const parsed = statusUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const submission = await prisma.onboardingSubmission.update({
    where: { id: req.params.id as string },
    data: {
      status: parsed.data.status,
      rejectionReason: parsed.data.rejectionReason,
      reviewedById: req.user!.sub,
      reviewedAt: new Date(),
    },
    include: {
      flowTemplate: true,
      user: { include: { roles: true } },
    },
  });

  await logActivity(req.user!.sub, 'ONBOARDING_SUBMISSION_STATUS_UPDATED', req, {
    submissionId: submission.id,
    status: submission.status,
  });

  res.json({ success: true, data: submission });
}

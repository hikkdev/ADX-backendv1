import { ApiError } from '../../shared/errors';
import { normalizeMobile } from '../auth';
import type { OnboardingSubmissionStatus, Role } from '../../shared/database';
import { defaultFlowTemplates } from './onboarding.flow-defaults';
import { prismaOnboardingRepository as repository } from './prisma-onboarding.repository';
import type { InlineUser } from './onboarding.repository';

/**
 * Seeds or upgrades the shipped flow templates.
 *
 * Runs lazily on every read rather than as a migration, so a fresh install and
 * an upgrade converge without a deploy step. A stored template is only
 * overwritten when its `version` is behind — an operator's hand-edits to the
 * current version survive.
 */
export async function ensureDefaultFlowTemplates(): Promise<void> {
  await Promise.all(
    defaultFlowTemplates.map(async (template) => {
      const existing = await repository.findTemplateByKey(template.key);
      if (existing && existing.version >= template.version) return;

      const data = {
        userType: template.userType,
        name: template.name,
        description: template.description,
        version: template.version,
        steps: template.steps,
        schema: template.schema,
      };

      if (existing) {
        await repository.updateTemplate(template.key, data);
        return;
      }
      await repository.createTemplate(template.key, data);
    }),
  );
}

export async function listFlowTemplates(filter: { userType?: string; isActive?: boolean }) {
  await ensureDefaultFlowTemplates();
  return repository.listTemplates(filter);
}

export async function getFlowTemplate(key: string) {
  await ensureDefaultFlowTemplates();
  const template = await repository.findTemplateByKey(key);
  if (!template) throw new ApiError(404, 'NOT_FOUND', 'Onboarding flow template not found');
  return template;
}

export async function upsertFlowTemplate(
  key: string,
  data: Parameters<typeof repository.upsertTemplate>[1],
) {
  return repository.upsertTemplate(key, data);
}

/** Roles a newly provisioned user gets when the caller does not say. */
function defaultRolesForUserType(userType: string): Role[] {
  if (userType === 'PUBLISHER') return ['PUBLISHER'];
  if (userType === 'ADVERTISER') return ['ADVERTISER'];
  if (userType === 'PARTNER') return ['PARTNER'];
  return [];
}

export async function createSubmission(
  input: {
    flowTemplateId?: string;
    flowTemplateKey?: string;
    userType: string;
    accountType?: string;
    status?: OnboardingSubmissionStatus;
    data: unknown;
    userId?: string;
    user?: { mobile: string; name?: string; email?: string; roles?: string[] };
  },
  submittedById: string,
) {
  await ensureDefaultFlowTemplates();

  // An explicit id wins; otherwise the key, falling back to the convention
  // `<usertype>-onboarding`.
  const template = input.flowTemplateId
    ? await repository.findTemplateById(input.flowTemplateId)
    : await repository.findTemplateByKey(
        input.flowTemplateKey ?? `${input.userType.toLowerCase()}-onboarding`,
      );

  if (!template) throw new ApiError(404, 'NOT_FOUND', 'Onboarding flow template not found');
  if (template.userType !== input.userType) {
    throw new ApiError(400, 'BAD_REQUEST', 'Flow template does not match submission user type');
  }

  const inlineUser: InlineUser | undefined = input.user
    ? {
        mobile: normalizeMobile(input.user.mobile),
        name: input.user.name,
        email: input.user.email,
        roles: (input.user.roles?.length
          ? input.user.roles
          : defaultRolesForUserType(input.userType)) as Role[],
      }
    : undefined;

  return repository.createSubmission(
    {
      flowTemplateId: template.id,
      userType: input.userType,
      accountType: input.accountType,
      status: input.status ?? 'SUBMITTED',
      data: input.data,
      submittedById,
    },
    inlineUser,
    input.userId,
  );
}

export async function listSubmissions(filter: {
  userType?: string;
  status?: OnboardingSubmissionStatus;
}) {
  return repository.listSubmissions(filter);
}

export async function getSubmission(id: string) {
  const submission = await repository.findSubmission(id);
  if (!submission) throw new ApiError(404, 'NOT_FOUND', 'Onboarding submission not found');
  return submission;
}

/**
 * Edits a DRAFT submission's contents.
 *
 * Drafts are the admin panel's server-side "save & resume" slots; submitted or
 * reviewed submissions are immutable outside the status endpoint.
 */
export async function updateSubmission(
  id: string,
  patch: { userType?: string; accountType?: string; data?: unknown },
) {
  const existing = await repository.findSubmissionSummary(id);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Onboarding submission not found');
  if (existing.status !== 'DRAFT') {
    throw new ApiError(409, 'CONFLICT', 'Only DRAFT submissions can be edited');
  }

  // A draft's user type can change mid-flow; keep the linked template in sync.
  let flowTemplateId = existing.flowTemplateId;
  if (patch.userType && patch.userType !== existing.userType) {
    await ensureDefaultFlowTemplates();
    const template = await repository.findTemplateByKey(
      `${patch.userType.toLowerCase()}-onboarding`,
    );
    if (!template) throw new ApiError(404, 'NOT_FOUND', 'Onboarding flow template not found');
    flowTemplateId = template.id;
  }

  return repository.updateSubmission(id, { ...patch, flowTemplateId });
}

/**
 * Discards a DRAFT submission. Submitted or reviewed submissions are audit
 * history and can only be CANCELLED via the status endpoint, never removed.
 */
export async function deleteSubmission(id: string) {
  const existing = await repository.findSubmissionSummary(id);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Onboarding submission not found');
  if (existing.status !== 'DRAFT') {
    throw new ApiError(409, 'CONFLICT', 'Only DRAFT submissions can be deleted');
  }

  await repository.deleteSubmission(id);
  return existing;
}

export async function updateSubmissionStatus(
  id: string,
  status: OnboardingSubmissionStatus,
  reviewedById: string,
  rejectionReason?: string,
) {
  return repository.updateSubmissionStatus(id, { status, rejectionReason, reviewedById });
}

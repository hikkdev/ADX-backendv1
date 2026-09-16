import { ApiError } from '../../shared/errors';
import { normalizeMobile } from '../auth';
import { createAgent } from '../agents';
import { createEmployee, findEmployeeByUserId, inviteEmployeeToConsole } from '../employees';
import type { OnboardingSubmissionStatus, Role } from '../../shared/database';
import { defaultFlowTemplates } from './onboarding.flow-defaults';
import { agentIntakeSchema, employeeIntakeSchema } from './onboarding.schema';
import { prismaOnboardingRepository as repository } from './prisma-onboarding.repository';
import type { InlineUser, SubmissionFilter } from './onboarding.repository';

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
  // AGENT gets its role from `createAgent` at approval (the side decides
  // which); EMPLOYEE gets console access from the invitation, not a role.
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

export async function listSubmissions(filter: SubmissionFilter) {
  return repository.listSubmissions(filter);
}

/**
 * E7-3: the same list on the list contract — `{ items, total, page,
 * pageSize, counts }`, the chips counted with the status facet removed.
 * `listSubmissions` above is the bare array the console read before, kept
 * one release for a caller that sends no page.
 */
export async function listSubmissionsPage(filter: SubmissionFilter, page: number, pageSize: number) {
  return repository.findSubmissionsPage(filter, page, pageSize);
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

/** What an approval created, reported beside the submission. */
export type Provisioned =
  | { agentId: string; userId: string }
  | { employeeId: string; userId: string; inviteId: string | null; inviteSkipped?: 'NO_EMAIL' };

/**
 * Lot D (Q131): an APPROVED intake for an AGENT provisions the User and the
 * AgentProfile through `agents` — the same door the direct create screen
 * uses, so an agent has one way of coming into being whichever screen ops
 * chose; a submission with an inline user is attached, not duplicated,
 * because `createAgent` finds the mobile first. An EMPLOYEE approval creates
 * the HR row for the user the submission holds and, when the data asks,
 * the console invitation. Publisher, advertiser and partner approvals
 * provision nothing, as before.
 */
async function provisionOnApproval(id: string, reviewedById: string): Promise<Provisioned | undefined> {
  const full = (await repository.findSubmission(id)) as {
    userType: string;
    userId: string | null;
    data: Record<string, unknown> | null;
    user: { mobile?: string | null; name?: string | null; email?: string | null } | null;
  } | null;
  if (!full) throw new ApiError(404, 'NOT_FOUND', 'Onboarding submission not found');
  const data = full.data ?? {};

  if (full.userType === 'AGENT') {
    const parsed = agentIntakeSchema.safeParse({
      ...data,
      mobile: data['mobile'] ?? full.user?.mobile ?? undefined,
      name: data['name'] ?? full.user?.name ?? undefined,
      email: data['email'] ?? full.user?.email ?? undefined,
    });
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'The intake needs a mobile, a name and the side the agent works', parsed.error.flatten());
    }
    const agent = await createAgent(parsed.data);
    if (!full.userId) await repository.linkSubmissionUser(id, agent.userId);
    return { agentId: agent.id, userId: agent.userId };
  }

  if (full.userType === 'EMPLOYEE') {
    if (!full.userId) {
      throw new ApiError(409, 'CONFLICT', 'Link or provision the user before approving an employee intake');
    }
    const parsed = employeeIntakeSchema.safeParse(data);
    if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid employee intake', parsed.error.flatten());
    const { inviteToConsole, ...record } = parsed.data;

    const existing = await findEmployeeByUserId(full.userId);
    const employee = existing
      ? { id: existing.id, email: full.user?.email ?? null }
      : await (async () => {
          const created = await createEmployee({ userId: full.userId!, ...(record as object) } as Parameters<typeof createEmployee>[0]);
          return { id: created.employee.id, email: created.employee.user.email };
        })();

    if (!inviteToConsole) return { employeeId: employee.id, userId: full.userId, inviteId: null };
    if (!employee.email) return { employeeId: employee.id, userId: full.userId, inviteId: null, inviteSkipped: 'NO_EMAIL' };
    const invite = await inviteEmployeeToConsole(employee.email, inviteToConsole, reviewedById);
    return { employeeId: employee.id, userId: full.userId, inviteId: invite.id };
  }

  return undefined;
}

export async function updateSubmissionStatus(
  id: string,
  status: OnboardingSubmissionStatus,
  reviewedById: string,
  rejectionReason?: string,
) {
  const existing = await repository.findSubmissionSummary(id);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Onboarding submission not found');

  // Provision before the status moves, so a failed provisioning leaves the
  // submission where it was; and only on the first approval, so a second
  // press creates nothing twice.
  const provisioned = status === 'APPROVED' && existing.status !== 'APPROVED' ? await provisionOnApproval(id, reviewedById) : undefined;

  const updated = (await repository.updateSubmissionStatus(id, { status, rejectionReason, reviewedById })) as object;
  return provisioned ? { ...updated, provisioned } : updated;
}

import { Prisma, prisma } from '../../shared/database';
import type { OnboardingSubmissionStatus } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { countsFrom, listArgs, toListPage } from '../../shared/pagination';
import type {
  FlowTemplateData,
  InlineUser,
  NewSubmission,
  OnboardingRepository,
  SubmissionFilter,
} from './onboarding.repository';

/** Steps and schema are free-form JSON columns. */
function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function templateData(data: FlowTemplateData) {
  return { ...data, steps: asJson(data.steps), schema: asJson(data.schema) };
}

const SUBMISSION_STATUSES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;

/** E7-3: the filter as a where clause; `q` over the intake's own name / mobile and the linked user's. */
function submissionWhere(filter: SubmissionFilter): Prisma.OnboardingSubmissionWhereInput {
  const statuses = filter.status === undefined ? [] : Array.isArray(filter.status) ? filter.status : [filter.status];
  return {
    ...(filter.userType ? { userType: filter.userType } : {}),
    ...(statuses.length ? { status: { in: statuses } } : {}),
    ...(filter.q
      ? {
          OR: [
            { data: { path: ['name'], string_contains: filter.q } },
            { data: { path: ['mobile'], string_contains: filter.q } },
            { user: { name: { contains: filter.q, mode: 'insensitive' } } },
            { user: { mobile: { contains: filter.q } } },
          ],
        }
      : {}),
  };
}

const submissionInclude = {
  flowTemplate: true,
  user: { include: { roles: true } },
} as const;

export const prismaOnboardingRepository: OnboardingRepository = {
  findTemplateByKey(key: string) {
    return prisma.onboardingFlowTemplate.findUnique({ where: { key } });
  },

  findTemplateById(id: string) {
    return prisma.onboardingFlowTemplate.findUnique({ where: { id } });
  },

  listTemplates({ userType, isActive }) {
    return prisma.onboardingFlowTemplate.findMany({
      where: {
        ...(userType ? { userType } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
      orderBy: [{ userType: 'asc' }, { version: 'desc' }],
    });
  },

  createTemplate(key: string, data: FlowTemplateData) {
    return prisma.onboardingFlowTemplate.create({ data: { key, ...templateData(data) } });
  },

  updateTemplate(key: string, data: FlowTemplateData) {
    return prisma.onboardingFlowTemplate.update({ where: { key }, data: templateData(data) });
  },

  upsertTemplate(key: string, data: FlowTemplateData) {
    return prisma.onboardingFlowTemplate.upsert({
      where: { key },
      update: templateData(data),
      create: { key, ...templateData(data) },
    });
  },

  listSubmissions(filter) {
    return prisma.onboardingSubmission.findMany({
      where: submissionWhere(filter),
      include: submissionInclude,
      orderBy: { createdAt: 'desc' },
    });
  },

  async findSubmissionsPage(filter, page, pageSize) {
    const where = submissionWhere(filter);
    const [items, total, groups] = await Promise.all([
      prisma.onboardingSubmission.findMany({
        where,
        include: submissionInclude,
        orderBy: { createdAt: 'desc' },
        ...listArgs({ page, pageSize }),
      }),
      prisma.onboardingSubmission.count({ where }),
      prisma.onboardingSubmission.groupBy({ by: ['status'], where: submissionWhere({ ...filter, status: undefined }), _count: { _all: true } }),
    ]);
    return toListPage(items, total, countsFrom(groups, SUBMISSION_STATUSES), { page, pageSize });
  },

  findSubmission(id: string) {
    return prisma.onboardingSubmission.findUnique({ where: { id }, include: submissionInclude });
  },

  findSubmissionSummary(id: string) {
    return prisma.onboardingSubmission.findUnique({ where: { id } });
  },

  createSubmission(submission: NewSubmission, inlineUser?: InlineUser, linkedUserId?: string) {
    // One transaction: a provisioned user without its submission would be an
    // orphaned account nobody is tracking.
    return prisma.$transaction(async (tx) => {
      let subjectUserId = linkedUserId;

      if (inlineUser) {
        const existingMobile = await tx.user.findUnique({ where: { mobile: inlineUser.mobile } });
        if (existingMobile) {
          throw new ApiError(409, 'CONFLICT', 'A user with this mobile number already exists');
        }
        if (inlineUser.email) {
          const existingEmail = await tx.user.findUnique({ where: { email: inlineUser.email } });
          if (existingEmail) {
            throw new ApiError(409, 'CONFLICT', 'A user with this email already exists');
          }
        }

        const createdUser = await tx.user.create({
          data: { mobile: inlineUser.mobile, name: inlineUser.name, email: inlineUser.email },
        });
        subjectUserId = createdUser.id;

        if (inlineUser.roles.length) {
          await tx.userRole.createMany({
            data: inlineUser.roles.map((role) => ({ userId: createdUser.id, role })),
          });
        }
      } else if (subjectUserId) {
        const existingUser = await tx.user.findUnique({ where: { id: subjectUserId } });
        if (!existingUser) throw new ApiError(404, 'NOT_FOUND', 'User not found');
      }

      return tx.onboardingSubmission.create({
        data: { ...submission, userId: subjectUserId, data: asJson(submission.data) },
        include: submissionInclude,
      });
    });
  },

  updateSubmission(id: string, data) {
    return prisma.onboardingSubmission.update({
      where: { id },
      data: {
        ...(data.userType ? { userType: data.userType, flowTemplateId: data.flowTemplateId } : {}),
        ...(data.accountType !== undefined ? { accountType: data.accountType } : {}),
        ...(data.data !== undefined ? { data: asJson(data.data) } : {}),
      },
      include: submissionInclude,
    });
  },

  deleteSubmission(id: string) {
    return prisma.onboardingSubmission.delete({ where: { id } });
  },

  linkSubmissionUser(id: string, userId: string) {
    return prisma.onboardingSubmission.update({ where: { id }, data: { userId } });
  },

  updateSubmissionStatus(
    id: string,
    data: { status: OnboardingSubmissionStatus; rejectionReason?: string; reviewedById: string },
  ) {
    return prisma.onboardingSubmission.update({
      where: { id },
      data: { ...data, reviewedAt: new Date() },
      include: submissionInclude,
    });
  },
};

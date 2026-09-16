import type { ListPage } from '../../shared/pagination';
import type {
  OnboardingFlowTemplate,
  OnboardingSubmission,
  OnboardingSubmissionStatus,
  Role,
} from '../../shared/database';

/**
 * E7-3: `q` is a contains over the intake's own `name` / `mobile` (the form
 * data) and the linked user's name / mobile; `status` one or several.
 */
export type SubmissionFilter = {
  userType?: string | undefined;
  status?: OnboardingSubmissionStatus | OnboardingSubmissionStatus[] | undefined;
  q?: string | undefined;
};

export type FlowTemplateData = {
  userType: string;
  name: string;
  description?: string;
  version?: number;
  steps: unknown;
  schema: unknown;
  isActive?: boolean;
};

export type NewSubmission = {
  flowTemplateId: string;
  userId?: string;
  userType: string;
  accountType?: string;
  status: OnboardingSubmissionStatus;
  data: unknown;
  submittedById: string;
};

/** A user provisioned inline while creating a submission. */
export type InlineUser = {
  mobile: string;
  name?: string;
  email?: string;
  roles: Role[];
};

export interface OnboardingRepository {
  findTemplateByKey(key: string): Promise<OnboardingFlowTemplate | null>;
  findTemplateById(id: string): Promise<OnboardingFlowTemplate | null>;
  listTemplates(filter: {
    userType?: string;
    isActive?: boolean;
  }): Promise<OnboardingFlowTemplate[]>;
  createTemplate(key: string, data: FlowTemplateData): Promise<OnboardingFlowTemplate>;
  updateTemplate(key: string, data: FlowTemplateData): Promise<OnboardingFlowTemplate>;
  upsertTemplate(key: string, data: FlowTemplateData): Promise<OnboardingFlowTemplate>;

  listSubmissions(filter: SubmissionFilter): Promise<unknown[]>;
  /** E7-3: the same list on the list contract — one page, the total, the chips by status minus the status facet. */
  findSubmissionsPage(filter: SubmissionFilter, page: number, pageSize: number): Promise<ListPage<unknown>>;
  findSubmission(id: string): Promise<unknown | null>;
  findSubmissionSummary(id: string): Promise<OnboardingSubmission | null>;
  /**
   * Creates the submission, provisioning the subject user in the same
   * transaction when one is supplied inline.
   */
  createSubmission(
    submission: NewSubmission,
    inlineUser?: InlineUser,
    linkedUserId?: string,
  ): Promise<unknown>;
  updateSubmission(
    id: string,
    data: {
      userType?: string;
      flowTemplateId?: string | null;
      accountType?: string;
      data?: unknown;
    },
  ): Promise<unknown>;
  deleteSubmission(id: string): Promise<unknown>;
  /** Lot D: the user an approval provisioned, written back onto the submission. */
  linkSubmissionUser(id: string, userId: string): Promise<unknown>;
  updateSubmissionStatus(
    id: string,
    data: {
      status: OnboardingSubmissionStatus;
      rejectionReason?: string;
      reviewedById: string;
    },
  ): Promise<unknown>;
}

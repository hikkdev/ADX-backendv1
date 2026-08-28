import type {
  OnboardingFlowTemplate,
  OnboardingSubmission,
  OnboardingSubmissionStatus,
  Role,
} from '../../shared/database';

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

  listSubmissions(filter: {
    userType?: string;
    status?: OnboardingSubmissionStatus;
  }): Promise<unknown[]>;
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
  updateSubmissionStatus(
    id: string,
    data: {
      status: OnboardingSubmissionStatus;
      rejectionReason?: string;
      reviewedById: string;
    },
  ): Promise<unknown>;
}

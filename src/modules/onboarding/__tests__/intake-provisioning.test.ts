import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q131) — the intake form as the onboarding record for agents and
 * employees.
 *
 * What is pinned: the two user types parse and ship a default template; an
 * APPROVED submission for AGENT provisions the User + AgentProfile through
 * `agents.createAgent` and links the user back to the submission; for
 * EMPLOYEE it creates the Employee row and, when asked, the console invite;
 * a second approval provisions nothing twice; an employee submission with no
 * user is 409; publisher and advertiser approvals provision nothing.
 */

const { repository, agents, employees, auth } = vi.hoisted(() => ({
  repository: {
    findTemplateByKey: vi.fn(),
    findSubmission: vi.fn(),
    findSubmissionSummary: vi.fn(),
    updateSubmissionStatus: vi.fn(),
    linkSubmissionUser: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
  },
  agents: { createAgent: vi.fn() },
  employees: { createEmployee: vi.fn(), findEmployeeByUserId: vi.fn(), inviteEmployeeToConsole: vi.fn() },
  auth: { normalizeMobile: (m: string) => m },
}));

vi.mock('../prisma-onboarding.repository', () => ({ prismaOnboardingRepository: repository }));
vi.mock('../../agents', () => agents);
vi.mock('../../employees', () => employees);
vi.mock('../../auth', () => auth);

import { updateSubmissionStatus } from '../onboarding.service';
import { submissionSchema, userTypeSchema } from '../onboarding.schema';
import { defaultFlowTemplates } from '../onboarding.flow-defaults';

const submission = (over: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  userType: 'AGENT',
  status: 'SUBMITTED',
  userId: null,
  data: { mobile: '+919876543210', name: 'Ravi K', side: 'PUBLISHER', city: 'Pune' },
  user: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findSubmissionSummary.mockImplementation(async () => submission());
  repository.findSubmission.mockImplementation(async () => submission());
  repository.updateSubmissionStatus.mockImplementation(async (id: string, data: { status: string }) => ({ id, ...data }));
  repository.linkSubmissionUser.mockResolvedValue(undefined);
  agents.createAgent.mockResolvedValue({ id: 'agt_1', userId: 'usr_agt', displayId: 'AGT-1' });
  employees.findEmployeeByUserId.mockResolvedValue(null);
  employees.createEmployee.mockResolvedValue({ employee: { id: 'emp_1', userId: 'usr_emp', user: { email: 'r@adx.in' } }, inviteToConsole: undefined });
  employees.inviteEmployeeToConsole.mockResolvedValue({ id: 'inv_1' });
});

describe('the user types', () => {
  it('take AGENT and EMPLOYEE beside the three that were there, each with a shipped template', () => {
    expect(userTypeSchema.options).toEqual(['PUBLISHER', 'ADVERTISER', 'PARTNER', 'AGENT', 'EMPLOYEE']);
    expect(defaultFlowTemplates.map((t) => t.key)).toEqual(expect.arrayContaining(['agent-onboarding', 'employee-onboarding']));
    expect(submissionSchema.safeParse({ userType: 'AGENT', data: { mobile: '+919876543210', name: 'Ravi K', side: 'PUBLISHER' } }).success).toBe(true);
  });
});

describe('approving an agent intake', () => {
  it('provisions the user and profile through agents.createAgent and links the user back', async () => {
    const result = await updateSubmissionStatus('sub_1', 'APPROVED', 'usr_admin');
    expect(agents.createAgent).toHaveBeenCalledWith({ mobile: '+919876543210', name: 'Ravi K', side: 'PUBLISHER', city: 'Pune' });
    expect(repository.linkSubmissionUser).toHaveBeenCalledWith('sub_1', 'usr_agt');
    expect(repository.updateSubmissionStatus).toHaveBeenCalledWith('sub_1', { status: 'APPROVED', rejectionReason: undefined, reviewedById: 'usr_admin' });
    expect(result).toMatchObject({ status: 'APPROVED', provisioned: { agentId: 'agt_1', userId: 'usr_agt' } });
  });

  it('takes the mobile from the linked user when the data has none, and refuses an intake that names no side', async () => {
    repository.findSubmission.mockResolvedValue(submission({ userId: 'usr_x', user: { mobile: '+919000000001', name: 'From User' }, data: { side: 'ADVERTISER' } }));
    await updateSubmissionStatus('sub_1', 'APPROVED', 'usr_admin');
    expect(agents.createAgent).toHaveBeenCalledWith({ mobile: '+919000000001', name: 'From User', side: 'ADVERTISER' });

    repository.findSubmission.mockResolvedValue(submission({ data: { mobile: '+919876543210', name: 'No Side' } }));
    await expect(updateSubmissionStatus('sub_1', 'APPROVED', 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.updateSubmissionStatus).toHaveBeenCalledTimes(1);
  });

  it('provisions nothing twice: an already-approved submission just keeps its status', async () => {
    repository.findSubmissionSummary.mockResolvedValue(submission({ status: 'APPROVED' }));
    await updateSubmissionStatus('sub_1', 'APPROVED', 'usr_admin');
    expect(agents.createAgent).not.toHaveBeenCalled();
  });
});

describe('approving an employee intake', () => {
  it('creates the Employee row for the provisioned user and sends the console invite when asked', async () => {
    repository.findSubmissionSummary.mockResolvedValue(submission({ userType: 'EMPLOYEE', userId: 'usr_emp' }));
    repository.findSubmission.mockResolvedValue(
      submission({
        userType: 'EMPLOYEE',
        userId: 'usr_emp',
        user: { mobile: '+919000000002', email: 'r@adx.in' },
        data: { department: 'Ops', designation: 'Analyst', inviteToConsole: { method: 'PASSWORD' }, passportPhotoUrl: 'https://x/p.png' },
      }),
    );
    const result = await updateSubmissionStatus('sub_1', 'APPROVED', 'usr_admin');
    expect(employees.createEmployee).toHaveBeenCalledWith({ userId: 'usr_emp', department: 'Ops', designation: 'Analyst', passportPhotoUrl: 'https://x/p.png' });
    expect(employees.inviteEmployeeToConsole).toHaveBeenCalledWith('r@adx.in', { method: 'PASSWORD' }, 'usr_admin');
    expect(result).toMatchObject({ provisioned: { employeeId: 'emp_1', userId: 'usr_emp', inviteId: 'inv_1' } });
  });

  it('skips the row when one already exists, skips the invite when there is no email, and is 409 with no user at all', async () => {
    repository.findSubmissionSummary.mockResolvedValue(submission({ userType: 'EMPLOYEE', userId: 'usr_emp' }));
    repository.findSubmission.mockResolvedValue(submission({ userType: 'EMPLOYEE', userId: 'usr_emp', user: { email: null }, data: { inviteToConsole: { method: 'PASSWORD' } } }));
    employees.findEmployeeByUserId.mockResolvedValue({ id: 'emp_existing', userId: 'usr_emp' });
    const result = await updateSubmissionStatus('sub_1', 'APPROVED', 'usr_admin');
    expect(employees.createEmployee).not.toHaveBeenCalled();
    expect(employees.inviteEmployeeToConsole).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provisioned: { employeeId: 'emp_existing', inviteId: null, inviteSkipped: 'NO_EMAIL' } });

    repository.findSubmissionSummary.mockResolvedValue(submission({ userType: 'EMPLOYEE', userId: null }));
    repository.findSubmission.mockResolvedValue(submission({ userType: 'EMPLOYEE', userId: null }));
    await expect(updateSubmissionStatus('sub_1', 'APPROVED', 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the other user types', () => {
  it('stay as they were: a publisher approval provisions nothing', async () => {
    repository.findSubmissionSummary.mockResolvedValue(submission({ userType: 'PUBLISHER' }));
    repository.findSubmission.mockResolvedValue(submission({ userType: 'PUBLISHER' }));
    const result = await updateSubmissionStatus('sub_1', 'APPROVED', 'usr_admin');
    expect(agents.createAgent).not.toHaveBeenCalled();
    expect(employees.createEmployee).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'APPROVED' });
    expect((result as { provisioned?: unknown }).provisioned).toBeUndefined();
  });

  it('a rejection touches nothing but the status', async () => {
    await updateSubmissionStatus('sub_1', 'REJECTED', 'usr_admin', 'Not a fit');
    expect(agents.createAgent).not.toHaveBeenCalled();
    expect(repository.updateSubmissionStatus).toHaveBeenCalledWith('sub_1', { status: 'REJECTED', rejectionReason: 'Not a fit', reviewedById: 'usr_admin' });
  });
});

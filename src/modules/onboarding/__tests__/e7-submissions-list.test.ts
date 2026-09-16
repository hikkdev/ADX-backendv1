import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E7-3: `GET /onboarding/submissions` on the list contract — `q` over the
 * intake's name / mobile, `status` one or several, and the page shape only
 * when a page is asked for; the bare array otherwise, one release.
 */

const { repository } = vi.hoisted(() => ({
  repository: { listSubmissions: vi.fn(), findSubmissionsPage: vi.fn() },
}));

vi.mock('../prisma-onboarding.repository', () => ({ prismaOnboardingRepository: repository }));
vi.mock('../../agents', () => ({ createAgent: vi.fn() }));
vi.mock('../../employees', () => ({ createEmployee: vi.fn(), findEmployeeByUserId: vi.fn(), inviteEmployeeToConsole: vi.fn() }));
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => m }));
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn() }));

import { listOnboardingSubmissions } from '../onboarding.controller';
import { listSubmissionsQuerySchema } from '../onboarding.schema';

const res = () => {
  const out = { body: undefined as unknown, status: vi.fn() };
  out.status.mockReturnValue(out);
  return Object.assign(out, { json: vi.fn((body: unknown) => (out.body = body)) });
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.listSubmissions.mockResolvedValue([{ id: 'sub_1' }]);
  repository.findSubmissionsPage.mockResolvedValue({ items: [{ id: 'sub_1' }], total: 1, page: 1, pageSize: 20, counts: { SUBMITTED: 1 } });
});

describe('the query', () => {
  it('upper-cases the type and the statuses, splits a comma list, trims q', () => {
    expect(listSubmissionsQuerySchema.parse({ userType: 'agent', status: 'submitted,under_review', q: ' ravi ', page: '2', pageSize: '10' })).toEqual({
      userType: 'AGENT',
      status: ['SUBMITTED', 'UNDER_REVIEW'],
      q: 'ravi',
      page: 2,
      pageSize: 10,
    });
    expect(listSubmissionsQuerySchema.safeParse({ status: 'MAYBE' }).success).toBe(false);
    expect(listSubmissionsQuerySchema.safeParse({ userType: 'ALIEN' }).success).toBe(false);
  });
});

describe('the handler', () => {
  it('answers the bare array with no page asked, filtered as before', async () => {
    const response = res();
    await listOnboardingSubmissions({ query: { status: 'draft', userType: 'employee', q: 'ravi' } } as never, response as never);
    expect(repository.listSubmissions).toHaveBeenCalledWith({ status: ['DRAFT'], userType: 'EMPLOYEE', q: 'ravi' });
    expect(response.body).toEqual({ success: true, data: [{ id: 'sub_1' }] });
    expect(repository.findSubmissionsPage).not.toHaveBeenCalled();
  });

  it('answers the list contract when a page is asked for', async () => {
    const response = res();
    await listOnboardingSubmissions({ query: { page: '1', q: '98765' } } as never, response as never);
    expect(repository.findSubmissionsPage).toHaveBeenCalledWith({ q: '98765' }, 1, 20);
    expect(response.body).toEqual({
      success: true,
      data: { items: [{ id: 'sub_1' }], total: 1, page: 1, pageSize: 20, counts: { SUBMITTED: 1 } },
    });
  });

  it('400s a bad status', async () => {
    await expect(listOnboardingSubmissions({ query: { status: 'nope' } } as never, res() as never)).rejects.toMatchObject({ statusCode: 400 });
  });
});

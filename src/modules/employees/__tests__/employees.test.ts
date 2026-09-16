import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Q71 — employees hygiene.
 *
 * What is pinned: every record is minted an EMP- identifier from the
 * identifiers counter; the document URLs are masked for a caller without
 * `hr.documents.view` (since Q143 the record is admin-only, so there is no
 * self exception); `hrmsLink` is built from the HR tool's template; and the optional
 * console invitation is the `auth` flow, refused when there is no address to
 * send it to.
 */
const { repository, users, auth, identifiers, integrations } = vi.hoisted(() => ({
  repository: {
    findPage: vi.fn(),
    findByUserId: vi.fn(),
    findSummaryByUserId: vi.fn(),
    findByExternalHrmsId: vi.fn(),
    departmentExists: vi.fn(),
    findDirectory: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  users: { userExists: vi.fn() },
  auth: { createInvite: vi.fn() },
  identifiers: { allocateIdentifier: vi.fn() },
  integrations: { getEffectiveHrmsConfig: vi.fn() },
}));

vi.mock('../prisma-employees.repository', () => ({ prismaEmployeeRepository: repository }));
vi.mock('../../users', () => users);
vi.mock('../../auth', () => auth);
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../../shared/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations')>();
  return { ...actual, ...integrations };
});

import {
  createEmployee,
  deleteEmployee,
  getEmployeeByUserId,
  hrmsLinkFor,
  inviteEmployeeToConsole,
  listEmployees,
  listActiveEmployeesForDirectory,
  updateEmployee,
} from '../employees.service';
import { maskDocuments } from '../employees.policy';
import { listEmployeesQuerySchema, updateEmployeeSchema } from '../employees.schema';

const record = (over: Record<string, unknown> = {}) => ({
  id: 'emp_1',
  userId: 'usr_1',
  displayId: 'EMP-1209-2601',
  department: 'Ops',
  designation: 'Coordinator',
  isActive: true,
  passportPhotoUrl: 'https://files.adx.co/passport.png',
  ndaAgreementUrl: null,
  salarySlipUrls: ['https://files.adx.co/slip-1.pdf'],
  complianceFormUrls: [],
  epfFormUrls: [],
  gratuityFormUrls: [],
  user: { id: 'usr_1', name: 'Asha', mobile: '+919845012210', email: 'asha@adx.co' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  users.userExists.mockResolvedValue(true);
  identifiers.allocateIdentifier.mockResolvedValue('EMP-1209-2601');
  repository.findSummaryByUserId.mockResolvedValue(null);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => record(data));
  repository.findByUserId.mockResolvedValue(record());
  repository.update.mockImplementation(async (_id: string, data: Record<string, unknown>) => record(data));
  repository.findByExternalHrmsId.mockResolvedValue(null);
  repository.departmentExists.mockImplementation(async (id: string) => (id === 'dep_ops' ? { id: 'dep_ops', name: 'Operations', code: 'OPS' } : null));
  integrations.getEffectiveHrmsConfig.mockResolvedValue({ provider: 'ZOHO_PEOPLE' });
});

describe('creating a record', () => {
  it('mints the EMP identifier from the counter and stores it', async () => {
    const { employee } = await createEmployee({ userId: 'usr_1', department: 'Ops' });
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('EMPLOYEE');
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ displayId: 'EMP-1209-2601' }));
    expect(employee.displayId).toBe('EMP-1209-2601');
  });

  it('never sends the console invitation into the Employee row', async () => {
    await createEmployee({ userId: 'usr_1', inviteToConsole: { method: 'PASSWORD', roleConfigId: 'rc_1' } });
    const [data] = repository.create.mock.calls[0] as [Record<string, unknown>];
    expect(data).not.toHaveProperty('inviteToConsole');
  });

  it('still refuses an unknown user and a second record', async () => {
    users.userExists.mockResolvedValue(false);
    await expect(createEmployee({ userId: 'nobody' })).rejects.toMatchObject({ statusCode: 404 });
    users.userExists.mockResolvedValue(true);
    repository.findSummaryByUserId.mockResolvedValue(record());
    await expect(createEmployee({ userId: 'usr_1' })).rejects.toMatchObject({ statusCode: 409 });
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
  });

  it('sends the console invitation through auth, carrying the role it was given', async () => {
    auth.createInvite.mockResolvedValue({ id: 'inv_1' });
    await inviteEmployeeToConsole('asha@adx.co', { method: 'GOOGLE', roleConfigId: 'rc_1' }, 'adm_1');
    expect(auth.createInvite).toHaveBeenCalledWith({ email: 'asha@adx.co', method: 'GOOGLE', roleConfigId: 'rc_1' }, 'adm_1');
  });
});

describe('reading one back', () => {
  it('masks the document URLs for a caller without hr.documents.view, keeping what is on file visible', async () => {
    const masked = await getEmployeeByUserId('usr_1', { sub: 'adm_1', roles: ['ADMIN'], perms: ['hr.view'] });
    expect(masked).toMatchObject({ documentsMasked: true, passportPhotoUrl: null, salarySlipUrls: [] });
    expect((masked as unknown as { documentsOnFile: string[] }).documentsOnFile).toEqual(['passportPhotoUrl', 'salarySlipUrls']);
  });

  it('hands the URLs over to a caller who holds the permission', async () => {
    const full = await getEmployeeByUserId('usr_1', { sub: 'adm_1', roles: ['ADMIN'], perms: ['hr.documents.view'] });
    expect(full).toMatchObject({ passportPhotoUrl: 'https://files.adx.co/passport.png' });
    expect(full).not.toHaveProperty('documentsMasked');
  });

  it('no longer makes an exception for the person themselves (Q143: the record is admin-only)', async () => {
    const own = await getEmployeeByUserId('usr_1', { sub: 'usr_1', roles: ['ADMIN'], perms: ['hr.view'] });
    expect(own).toMatchObject({ documentsMasked: true, passportPhotoUrl: null });
  });

  it('carries hrmsLink built from the template when both halves exist (Q98)', async () => {
    integrations.getEffectiveHrmsConfig.mockResolvedValue({
      provider: 'ZOHO_PEOPLE',
      employeeLinkTemplate: 'https://people.zoho.in/adx/employees/{externalId}',
    });
    repository.findByUserId.mockResolvedValue(record({ externalHrmsId: 'ZP 42/1' }));
    const row = await getEmployeeByUserId('usr_1', { sub: 'adm_1', roles: ['ADMIN'] });
    expect(row.hrmsLink).toBe('https://people.zoho.in/adx/employees/ZP%2042%2F1');
  });

  it('carries hrmsLink: null when either half is missing', async () => {
    integrations.getEffectiveHrmsConfig.mockResolvedValue({ provider: 'ZOHO_PEOPLE', employeeLinkTemplate: 'https://x/{externalId}' });
    repository.findByUserId.mockResolvedValue(record({ externalHrmsId: null }));
    expect((await getEmployeeByUserId('usr_1', { sub: 'adm_1', roles: ['ADMIN'] })).hrmsLink).toBeNull();

    integrations.getEffectiveHrmsConfig.mockResolvedValue({ provider: 'NONE' });
    repository.findByUserId.mockResolvedValue(record({ externalHrmsId: 'E-1' }));
    expect((await getEmployeeByUserId('usr_1', { sub: 'adm_1', roles: ['ADMIN'] })).hrmsLink).toBeNull();
    expect(hrmsLinkFor('E-1', { provider: 'NONE', employeeLinkTemplate: 'https://x/{externalId}' })).toBeNull();
  });

  it('applies the launch rule: an admin with no role config holds everything', async () => {
    const full = await getEmployeeByUserId('usr_1', { sub: 'adm_1', roles: ['ADMIN'] });
    expect(full).not.toHaveProperty('documentsMasked');
  });

  it('is a 404 when there is no record', async () => {
    repository.findByUserId.mockResolvedValue(null);
    await expect(getEmployeeByUserId('usr_1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('masks a bare row without inventing fields', () => {
    expect(maskDocuments({ id: 'emp_1', passportPhotoUrl: null, salarySlipUrls: [] })).toEqual({
      id: 'emp_1',
      passportPhotoUrl: null,
      salarySlipUrls: [],
      documentsMasked: true,
      documentsOnFile: [],
    });
  });
});

describe('updating and deleting', () => {
  it('hands the caller both sides, so the audit row can carry a diff', async () => {
    repository.findSummaryByUserId.mockResolvedValue(record({ department: 'Ops' }));
    const { before, after } = await updateEmployee('usr_1', { department: 'Finance' });
    expect(before.department).toBe('Ops');
    expect(after.department).toBe('Finance');
  });

  it('returns the row it deleted, so the audit row can name it', async () => {
    repository.findSummaryByUserId.mockResolvedValue(record());
    const deleted = await deleteEmployee('usr_1');
    expect(repository.remove).toHaveBeenCalledWith('usr_1');
    expect(deleted.displayId).toBe('EMP-1209-2601');
  });

  it('accepts externalHrmsId, cleared with null, and refuses one another record already holds', async () => {
    expect(updateEmployeeSchema.safeParse({ externalHrmsId: ' ZP-42 ' }).data).toEqual({ externalHrmsId: 'ZP-42' });
    expect(updateEmployeeSchema.safeParse({ externalHrmsId: null }).success).toBe(true);
    expect(updateEmployeeSchema.safeParse({ externalHrmsId: '' }).success).toBe(false);

    repository.findSummaryByUserId.mockResolvedValue(record({ id: 'emp_1' }));
    repository.findByExternalHrmsId.mockResolvedValue({ id: 'emp_2', userId: 'usr_2' });
    await expect(updateEmployee('usr_1', { externalHrmsId: 'ZP-42' })).rejects.toMatchObject({ statusCode: 409 });

    repository.findByExternalHrmsId.mockResolvedValue({ id: 'emp_1', userId: 'usr_1' });
    await expect(updateEmployee('usr_1', { externalHrmsId: 'ZP-42' })).resolves.toBeDefined();
    expect(repository.update).toHaveBeenCalledWith('usr_1', { externalHrmsId: 'ZP-42' });
  });

  it('404s when there is nothing to change', async () => {
    repository.findSummaryByUserId.mockResolvedValue(null);
    await expect(updateEmployee('usr_1', { department: 'X' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteEmployee('usr_1')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the list and the directory', () => {
  it('parses q, department and active off the query, with the page defaults', () => {
    expect(listEmployeesQuerySchema.parse({ q: ' asha ', department: 'Ops', active: 'true' })).toEqual({
      q: 'asha',
      department: 'Ops',
      active: true,
      page: 1,
      pageSize: 20,
    });
    expect(listEmployeesQuerySchema.parse({ active: 'false', pageSize: '500' }).pageSize).toBe(100);
    expect(listEmployeesQuerySchema.parse({}).active).toBeUndefined();
  });

  it('keeps meta beside the items and hands the filter to the repository', async () => {
    repository.findPage.mockResolvedValue({ items: [record()], total: 41 });
    const { items, meta } = await listEmployees({ q: 'asha', department: 'Ops', active: true, page: 2, pageSize: 20 });
    expect(repository.findPage).toHaveBeenCalledWith({ q: 'asha', department: 'Ops', active: true }, 2, 20, { sort: 'JOINED', dir: 'desc' });
    expect(items).toHaveLength(1);
    expect(meta).toEqual({ page: 2, pageSize: 20, total: 41, totalPages: 3 });
  });

  it('lists active staff for the people registry as flat rows', async () => {
    repository.findDirectory.mockResolvedValue([
      { userId: 'usr_1', department: 'Ops', designation: 'Coordinator', isActive: true, user: { name: 'Asha' } },
    ]);
    const people = await listActiveEmployeesForDirectory('as');
    // E10-1: the switch for the inactive is off by default, and each row says it is active.
    expect(repository.findDirectory).toHaveBeenCalledWith('as', false);
    expect(people).toEqual([{ userId: 'usr_1', name: 'Asha', designation: 'Coordinator', department: 'Ops', active: true }]);
  });
});

describe('Lot G (Q122/Q140): the department record and the work fields', () => {
  it('PUT accepts departmentId, region, workMode and employmentType; the record must exist and the free string follows its name', async () => {
    repository.findSummaryByUserId.mockResolvedValue(record());
    const patch = updateEmployeeSchema.parse({ departmentId: 'dep_ops', region: 'Bengaluru', workMode: 'hybrid', employmentType: 'FULL_TIME' });
    expect(patch).toMatchObject({ departmentId: 'dep_ops', region: 'Bengaluru', workMode: 'HYBRID', employmentType: 'FULL_TIME' });
    await updateEmployee('usr_1', patch);
    expect(repository.update).toHaveBeenCalledWith('usr_1', expect.objectContaining({ departmentId: 'dep_ops', department: 'Operations', region: 'Bengaluru', workMode: 'HYBRID', employmentType: 'FULL_TIME' }));

    await expect(updateEmployee('usr_1', { departmentId: 'dep_ghost' })).rejects.toMatchObject({ statusCode: 404 });

    // Unlinking clears the string too.
    await updateEmployee('usr_1', { departmentId: null });
    expect(repository.update).toHaveBeenLastCalledWith('usr_1', { departmentId: null, department: null });
    expect(() => updateEmployeeSchema.parse({ workMode: 'BOAT' })).toThrow();
  });

  it('create takes the same fields, and the reads print the record\'s name under department', async () => {
    repository.findByUserId.mockResolvedValue(record({ department: 'ops (old string)', departmentRecord: { id: 'dep_ops', name: 'Operations', code: 'OPS' }, region: 'Chennai', workMode: 'FIELD', employmentType: 'CONTRACT' }));
    const { employee } = await createEmployee({ userId: 'usr_1', departmentId: 'dep_ops', region: 'Chennai', workMode: 'FIELD', employmentType: 'CONTRACT' });
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ departmentId: 'dep_ops', department: 'Operations', region: 'Chennai', workMode: 'FIELD', employmentType: 'CONTRACT' }));
    expect(employee).toMatchObject({ department: 'Operations', departmentRecord: { id: 'dep_ops', name: 'Operations' }, region: 'Chennai', workMode: 'FIELD', employmentType: 'CONTRACT' });

    const read = await getEmployeeByUserId('usr_1', { sub: 'adm_1', roles: ['ADMIN'], permissions: [] } as never);
    expect(read).toMatchObject({ department: 'Operations', region: 'Chennai' });

    repository.findDirectory.mockResolvedValue([{ userId: 'usr_1', department: 'ops (old string)', designation: 'Coordinator', isActive: true, user: { name: 'Asha' }, departmentRecord: { name: 'Operations' } }]);
    const people = await listActiveEmployeesForDirectory();
    expect(people[0]).toMatchObject({ department: 'Operations' });
  });
});

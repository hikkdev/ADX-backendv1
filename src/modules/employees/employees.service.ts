import { ApiError } from '../../shared/errors';
import { toListPage } from '../../shared/pagination';
import { kycSummaryOf } from '../../shared/kyc-state';
import { hasPermission } from '../../shared/auth';
import type { AccessTokenPayload } from '../../shared/auth';
import { getEffectiveHrmsConfig, type HrmsConfig } from '../../shared/integrations';
import { userExists } from '../users';
import { createInvite, type InviteView } from '../auth';
import { allocateIdentifier } from '../identifiers';
import { prismaEmployeeRepository as repository } from './prisma-employees.repository';
import type { DepartmentMemberRow, EmployeeWithUser } from './employees.repository';
import { employeeOrderBy, type CreateEmployeeInput, type ListEmployeesQuery, type UpdateEmployeeInput } from './employees.schema';
import { maskDocuments } from './employees.policy';

/**
 * Lot G (Q122): every read prints the department record's name under
 * `department` when the row is linked, the free string otherwise — one
 * release of both, so a console reading the string keeps working while the
 * record takes over.
 */
export function withDepartmentName<T extends { department: string | null; departmentRecord: { name: string } | null }>(row: T): T {
  return { ...row, department: row.departmentRecord?.name ?? row.department };
}

export async function listEmployees(query: ListEmployeesQuery) {
  const { page, pageSize, sort, dir, ...filter } = query;
  const { items, total } = await repository.findPage(filter, page, pageSize, employeeOrderBy({ sort, dir }));
  return { items: items.map(withDepartmentName), meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}

/**
 * E10-1: the same read on the list contract — `{ items, total, page,
 * pageSize, counts }`, the chips ACTIVE / INACTIVE counted over the filter
 * with the `active` facet removed so the row of chips stays a way back out.
 */
export async function listEmployeesPage(query: ListEmployeesQuery) {
  // Lot G (Q113): the sort is the page's, never the chip count's.
  const { page, pageSize, sort, dir, ...filter } = query;
  const [{ items, total }, counts] = await Promise.all([
    repository.findPage(filter, page, pageSize, employeeOrderBy({ sort, dir })),
    repository.countByActive({ ...filter, active: undefined }),
  ]);
  return toListPage(items.map(withDepartmentName), total, counts, { page, pageSize });
}

/**
 * G13-B: GET /employees/overview — the directory's header figures. The
 * headcount is the chip count with no filter; `openPositions` is the sum of
 * `Department.openRoles` over the active departments (hiring itself stays
 * in the HR tool, Q98 — the number is what the console prints).
 */
export type EmployeesOverview = { headcount: { total: number; active: number; inactive: number }; openPositions: number };

export async function employeesOverview(): Promise<EmployeesOverview> {
  const [counts, openPositions] = await Promise.all([
    repository.countByActive({ q: undefined, department: undefined, departmentId: undefined, active: undefined }),
    repository.sumOpenRoles(),
  ]);
  const active = counts['ACTIVE'] ?? 0;
  const inactive = counts['INACTIVE'] ?? 0;
  return { headcount: { total: active + inactive, active, inactive }, openPositions };
}

/**
 * Lot E (Q98): the deep link into the HR tool for one person, or null.
 *
 * Both halves have to exist — a template on the integrations row and an id
 * on the record — and the provider has to be one: NONE is the switch off,
 * whatever template is left behind. The id is URL-encoded, because an HR
 * tool's own id is its own business and may carry a slash.
 */
export function hrmsLinkFor(externalHrmsId: string | null | undefined, hrms: HrmsConfig): string | null {
  const template = hrms.employeeLinkTemplate;
  if (!externalHrmsId || !template || hrms.provider === 'NONE') return null;
  if (!template.includes('{externalId}')) return null;
  return template.replace('{externalId}', encodeURIComponent(externalHrmsId));
}

/**
 * GET /employees/:userId.
 *
 * The document URLs are the sensitive half of an HR record — marksheets, an
 * NDA, a salary account letter — and they are public-ish links once handed
 * out. So they are masked unless the caller holds `hr.documents.view`. Q143
 * made the record admin-only, so the old "the person sees their own"
 * exception is gone with the self-service route it served; the documents
 * themselves now live in the HR tool (Q98), which `hrmsLink` opens.
 */
export async function getEmployeeByUserId(userId: string, viewer?: AccessTokenPayload) {
  const employee = await repository.findByUserId(userId);
  if (!employee) throw new ApiError(404, 'NOT_FOUND', 'Employee not found');

  const hrmsLink = hrmsLinkFor(employee.externalHrmsId, await getEffectiveHrmsConfig());
  // N3-B: `kyc: { state, kycId, submittedAt, requestedAt, requestedChannel, method }`, derived the way the
  // employee KYC queue derives it — AWAITING_DOCUMENTS from the moment the row exists.
  const row = { ...withDepartmentName(employee), hrmsLink, kyc: kycSummaryOf(employee.kyc ?? null) };
  if (hasPermission(viewer, 'hr.documents.view')) return row;
  return maskDocuments(row);
}

export type CreatedEmployee = {
  employee: EmployeeWithUser;
  inviteToConsole: CreateEmployeeInput['inviteToConsole'];
};

export async function createEmployee(data: CreateEmployeeInput): Promise<CreatedEmployee> {
  // The user must exist before it can be given an employee record, and a user
  // may hold at most one.
  if (!(await userExists(data.userId))) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }
  if (await repository.findSummaryByUserId(data.userId)) {
    throw new ApiError(409, 'CONFLICT', 'Employee record already exists for this user');
  }

  const { inviteToConsole, ...record } = data;
  const department = await resolveDepartment(record);

  // EMP-1209-2601. Issued once, from the identifiers counter, never derived:
  // it ends up on a letter and an ID card, and a format change years later
  // must not rewrite what was printed.
  const displayId = await allocateIdentifier('EMPLOYEE');
  const created = await repository.create({ ...record, ...department, displayId });
  // Re-read with the user joined: the response shape matches the other reads,
  // and the console invitation below needs the address on the user record.
  const employee = await repository.findByUserId(created.userId);
  if (!employee) throw new ApiError(404, 'NOT_FOUND', 'Employee not found');

  return { employee: withDepartmentName(employee), inviteToConsole };
}

/**
 * Lot G (Q122): a write naming `departmentId` must name a record that
 * exists — 404 here rather than a foreign-key 500 — and the free
 * `department` string follows the record's name, so a console still reading
 * the string sees the same department the record says. `null` unlinks and
 * clears the string too.
 */
async function resolveDepartment(data: { departmentId?: string | null | undefined }): Promise<{ departmentId?: string | null; department?: string | null }> {
  if (data.departmentId === undefined) return {};
  if (data.departmentId === null) return { departmentId: null, department: null };
  const record = await repository.departmentExists(data.departmentId);
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Department not found');
  return { departmentId: record.id, department: record.name };
}

/**
 * The optional second half of POST /employees: a new joiner who also needs a
 * console login. The invitation is the `auth` flow, unchanged — this only
 * saves the admin from opening a second screen.
 */
export async function inviteEmployeeToConsole(
  employeeEmail: string,
  invite: NonNullable<CreateEmployeeInput['inviteToConsole']>,
  invitedByUserId: string,
): Promise<InviteView> {
  return createInvite(
    { email: employeeEmail, method: invite.method, ...(invite.roleConfigId ? { roleConfigId: invite.roleConfigId } : {}) },
    invitedByUserId,
  );
}

export async function updateEmployee(userId: string, data: UpdateEmployeeInput) {
  const before = await requireEmployee(userId);
  // The HR-tool id is unique: two records pointing at one person in the tool
  // is the drift the link exists to prevent, so it is a 409 here rather than
  // a constraint error from Postgres.
  if (data.externalHrmsId) {
    const holder = await repository.findByExternalHrmsId(data.externalHrmsId);
    if (holder && holder.userId !== userId) {
      throw new ApiError(409, 'CONFLICT', 'Another employee record already carries that HR-tool id');
    }
  }
  const department = await resolveDepartment(data);
  const after = await repository.update(userId, { ...data, ...department });
  return { before, after };
}

export async function deleteEmployee(userId: string) {
  const employee = await requireEmployee(userId);
  await repository.remove(userId);
  return employee;
}

async function requireEmployee(userId: string) {
  const existing = await repository.findSummaryByUserId(userId);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Employee not found');
  return existing;
}

/* ── Lot D: narrow reads for `kyc/employee` and `onboarding` ─────────────── */

/** The employee row behind a user, or null — the employee's own KYC read starts here. */
export const findEmployeeByUserId = (userId: string) => repository.findSummaryByUserId(userId);

/** Does this employee id exist? Checked before a KYC record is written on their behalf. */
export async function employeeExists(employeeId: string): Promise<boolean> {
  return (await repository.findSummaryById(employeeId)) !== null;
}

/* ── Lot E (Q99): the people registry ─────────────────────────────────── */

export type StaffDirectoryRow = {
  /** G11-1: the Employee row's own id, beside the login. */
  employeeId: string;
  userId: string;
  name: string | null;
  designation: string | null;
  department: string | null;
  /** E10-1: false only when `includeInactive` was asked for — the registry lists the active by default. */
  active: boolean;
};

/** Active staff, by name — `hr` unions this with the active agents. E10-1: `includeInactive` lists the rest, flagged. */
export async function listActiveEmployeesForDirectory(q?: string, opts: { includeInactive?: boolean } = {}): Promise<StaffDirectoryRow[]> {
  const rows = await repository.findDirectory(q, opts.includeInactive ?? false);
  return rows.map((row) => ({
    employeeId: row.id,
    userId: row.userId,
    name: row.user.name,
    designation: row.designation,
    department: row.departmentRecord?.name ?? row.department,
    active: row.isActive,
  }));
}

/* ── Lot G (Q122/Q140): what `hr`'s departments read ─────────────────── */

export type DepartmentMember = {
  id: string;
  userId: string;
  displayId: string | null;
  name: string | null;
  email: string | null;
  designation: string | null;
  region: string | null;
  workMode: DepartmentMemberRow['workMode'];
  employmentType: DepartmentMemberRow['employmentType'];
  active: boolean;
  /** G11-1: the Employee row's createdAt — "on record since". The joining date proper lives in the HR tool (Q98). */
  joinedAt: Date;
};

const toMember = (row: DepartmentMemberRow): DepartmentMember => ({
  id: row.id,
  userId: row.userId,
  displayId: row.displayId,
  name: row.user.name,
  email: row.user.email,
  designation: row.designation,
  region: row.region,
  workMode: row.workMode,
  employmentType: row.employmentType,
  active: row.isActive,
  joinedAt: row.createdAt,
});

/** The members of one department — `hr`'s detail read. */
export async function listDepartmentMembers(departmentId: string): Promise<DepartmentMember[]> {
  return (await repository.findByDepartment(departmentId)).map(toMember);
}

/** Members per department id — `hr`'s list prints the count. */
export const countEmployeesByDepartment = (): Promise<Record<string, number>> => repository.countByDepartment();

/** One employee by the row's own id, as a card — `hr` names a department's head with it. */
export async function findEmployeeCard(employeeId: string): Promise<{ id: string; userId: string; name: string | null; designation: string | null } | null> {
  const row = await repository.findSummaryById(employeeId);
  if (!row) return null;
  const withUser = await repository.findByUserId(row.userId);
  return { id: row.id, userId: row.userId, name: withUser?.user.name ?? null, designation: row.designation };
}

/** The free `department` strings not yet linked to a record — `hr.ensureDepartments` turns each into one. */
export const listUnlinkedDepartmentNames = (): Promise<string[]> => repository.findUnlinkedDepartmentNames();

/** Link every unlinked row carrying the name to the record. */
export const linkEmployeesToDepartment = (name: string, departmentId: string): Promise<number> => repository.linkDepartmentByName(name, departmentId);

import type { Employee, KycStatus } from '../../shared/database';
import type { CreateEmployeeInput, EmployeeFilter, EmployeeOrder, UpdateEmployeeInput } from './employees.schema';

/** The create input minus the console invitation, which is not an Employee column; Lot G: `department` may be cleared with the record. */
export type EmployeeRecordInput = Omit<CreateEmployeeInput, 'inviteToConsole' | 'department'> & { department?: string | null };
/** Lot G (Q122): the free string follows the record on every write, so it may be set to null here. */
export type EmployeePatch = Omit<UpdateEmployeeInput, 'department'> & { department?: string | null };

/** Lot G (Q122): the department record an employee belongs to, joined on every read. */
export type DepartmentSlice = { id: string; name: string; code: string };

/** Employee rows joined to the small slice of the user record clients render, and (Lot G) the department record. */
export type EmployeeWithUser = Employee & {
  user: { id: string; name: string | null; mobile: string | null; email: string | null };
  departmentRecord: DepartmentSlice | null;
  /** N3-B: the KYC record's six summary columns on the by-user read, so `GET /employees/:userId` derives `kyc.state` the way the queue does; null before any record. */
  kyc?: KycRecordSummary | null;
};

/** N3-B: what the party read needs of the KYC record (`shared/kyc-state`'s `KycStateRecord`). */
export type KycRecordSummary = {
  id: string;
  status: KycStatus;
  submittedAt: Date | null;
  requestedAt: Date | null;
  requestedChannel: string | null;
  method: string;
};

/** Lot E: one row of the people registry — the staff half; E10-1: `isActive` rides it so the inactive can be listed and flagged; G11-1: the row's own `id` too. */
export type EmployeeDirectoryRow = {
  id: string;
  userId: string;
  department: string | null;
  designation: string | null;
  isActive: boolean;
  user: { name: string | null };
  departmentRecord: { name: string } | null;
};

/** Lot G (Q122): one member of a department, for `hr`'s department detail. */
export type DepartmentMemberRow = {
  id: string;
  userId: string;
  displayId: string | null;
  designation: string | null;
  region: string | null;
  workMode: Employee['workMode'];
  employmentType: Employee['employmentType'];
  isActive: boolean;
  /** G11-1: when the row was made — "on record since"; the joining date proper is the HR tool's (Q98). */
  createdAt: Date;
  user: { name: string | null; email: string | null };
};

/** E10-1: the chips on the list contract — by the active flag. */
export const EMPLOYEE_ACTIVITY_CHIPS = ['ACTIVE', 'INACTIVE'] as const;

export interface EmployeeRepository {
  /** Lot G (Q113): `order` is the directory's sort — NAME on the person, ROLE on the designation, JOINED on `createdAt`; G13-B: REGION on the region column. */
  findPage(filter: EmployeeFilter, page: number, pageSize: number, order: EmployeeOrder): Promise<{ items: EmployeeWithUser[]; total: number }>;
  /** E10-1: the chips — active and inactive over the filter (the caller removes the active facet). */
  countByActive(filter: EmployeeFilter): Promise<Record<string, number>>;
  findByUserId(userId: string): Promise<EmployeeWithUser | null>;
  /** Lot E (Q98): who already holds an HR-tool id — the unique column, checked before a write. */
  findByExternalHrmsId(externalHrmsId: string): Promise<Pick<Employee, 'id' | 'userId'> | null>;
  /** Lot E (Q99): active staff by name, for `hr`'s people registry; E10-1: `includeInactive` lists the rest too. */
  findDirectory(q?: string, includeInactive?: boolean): Promise<EmployeeDirectoryRow[]>;
  /** Without the user join — used for existence checks before a write. */
  findSummaryByUserId(userId: string): Promise<Employee | null>;
  /** Lot D: by the employee row's own id, for `kyc/employee`. */
  findSummaryById(id: string): Promise<Employee | null>;
  /** Lot G (Q122): does the department record exist? Checked before a write names one — the FK would only answer 500. */
  departmentExists(departmentId: string): Promise<DepartmentSlice | null>;
  /** Lot G (Q122): members per department id, for `hr`'s list; rows with no record are not counted. */
  countByDepartment(): Promise<Record<string, number>>;
  /** G13-B: Σ `Department.openRoles` over the active departments — the overview's open positions. A read of `hr`'s table, like `departmentExists`. */
  sumOpenRoles(): Promise<number>;
  /** Lot G (Q122): the members of one department, active first then by name. */
  findByDepartment(departmentId: string): Promise<DepartmentMemberRow[]>;
  /** Lot G (Q122): the free `department` strings still unlinked — what `ensureDepartments` turns into records. */
  findUnlinkedDepartmentNames(): Promise<string[]>;
  /** Lot G (Q122): link every unlinked row carrying this name (case-insensitively) to the record. Returns how many moved. */
  linkDepartmentByName(name: string, departmentId: string): Promise<number>;
  /** `inviteToConsole` never reaches here — it is not a column. */
  create(data: EmployeeRecordInput & { displayId: string }): Promise<Employee>;
  update(userId: string, data: EmployeePatch): Promise<Employee>;
  remove(userId: string): Promise<unknown>;
}

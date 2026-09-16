/**
 * Employees — HR records for internal staff: department, designation and the
 * document set collected during onboarding.
 *
 * Unrelated to `agents`, who are field workers with an AgentProfile, and to
 * `users`, which owns identity and roles.
 */
export { employeeRouter } from './employees.routes';

/** Lot D: `kyc/employee` reads the row behind a session and checks an id; `onboarding` provisions the row on approval. */
export { findEmployeeByUserId, employeeExists, createEmployee, inviteEmployeeToConsole } from './employees.service';
export type { CreateEmployeeInput } from './employees.schema';
/** Lot S: `party-imports` fills a matched employee's empty HR columns through the console's PATCH door. */
export { updateEmployee } from './employees.service';
export type { UpdateEmployeeInput } from './employees.schema';

/** Lot E (Q99): active staff for `hr`'s people registry — the other half is `agents`. */
export { listActiveEmployeesForDirectory } from './employees.service';
export type { StaffDirectoryRow } from './employees.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

/**
 * Lot G (Q122/Q140): what `hr`'s departments read and write — the members
 * of a department with their region / work mode / employment type, the
 * count per department, the head's card, and the two halves of
 * `ensureDepartments` (the free strings still unlinked, and the link).
 * `hr` imports this module, never the other way, so the reads live here.
 */
export {
  listDepartmentMembers,
  countEmployeesByDepartment,
  findEmployeeCard,
  listUnlinkedDepartmentNames,
  linkEmployeesToDepartment,
} from './employees.service';
export type { DepartmentMember } from './employees.service';
export { WORK_MODES, EMPLOYMENT_TYPES } from './employees.schema';

/** O-B: what `GET /employees/overview` and `GET /employees/workload` answer, for `section-overviews` to carry rather than re-derive. */
export { employeesOverview } from './employees.service';
export type { EmployeesOverview } from './employees.service';
export { workloadReport } from './workload.service';
export type { WorkloadReport } from './workload.service';

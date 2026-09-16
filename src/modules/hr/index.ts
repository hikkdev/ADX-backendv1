/**
 * HR — Lot E (Q98/Q99): the holiday calendar (the one HR record kept
 * in-house) and the people registry (active staff from `employees` and
 * ACTIVE agents from `agents`, in one list). Everything else about a person
 * lives in the HR tool the `integrations` row links to.
 *
 * Not to be confused with `employees`, which owns the Employee row itself.
 */
export { hrRouter } from './hr.routes';

/** `schedule` shades its grid with these, and checks an assignee is a person. */
export { holidaysInRange } from './holidays.service';
export type { HolidayView } from './holidays.service';
export { findPerson } from './people.service';
export type { Person } from './people.service';
export type { PersonKind } from './hr.schema';

/** Bootstrap: seed the year's list once, idempotently, beside `ensureSystemRoles`. */
export { ensureHolidays } from './holidays.service';

/** Lot G (Q122): departments — the free strings on Employee rows become records at boot, once. */
export { ensureDepartments } from './departments/departments.service';
export type { DepartmentView, DepartmentDetail } from './departments/departments.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

/**
 * What the workload measure reads — Lot G (Q120/Q139).
 *
 * Four reads, none of them this module's own table except the staff list:
 * the open items assigned to a person on the KYC, support and fraud desks,
 * the diary entries against them in the window, and the audit rows they
 * left. They are read here rather than through four module indexes because
 * `kyc`, `support` and `schedule` all sit above `employees` in the graph
 * (`schedule` → `hr` → `employees`, `kyc` reaches it through a port), so an
 * import from here would close a ring; a count over a column is the
 * smallest coupling on offer.
 */
export type WorkloadStaffRow = {
  userId: string;
  employeeId: string;
  name: string | null;
  designation: string | null;
  department: string | null;
};

export type OpenAssignedRow = { userId: string; kyc: number; tickets: number; fraud: number };

export type ScheduleEntryRow = { assigneeUserId: string; date: Date };

export type ActionCountRow = { userId: string; action: string; count: number };

export interface WorkloadRepository {
  /** Active staff, with the department record's name. */
  findStaff(): Promise<WorkloadStaffRow[]>;
  /** Open KYC cases (both rows, PENDING / NEEDS_INFO), open tickets, and open fraud cases assigned to each user. */
  countOpenAssigned(userIds: string[]): Promise<OpenAssignedRow[]>;
  /** Diary entries against these users dated in `[from, to)`. */
  findScheduleEntries(userIds: string[], from: Date, to: Date): Promise<ScheduleEntryRow[]>;
  /** Audit rows by these users in `[from, to)`, counted per action. */
  countActions(userIds: string[], from: Date, to: Date): Promise<ActionCountRow[]>;
}

import type { Employee } from '../../shared/database';
import type { CreateEmployeeInput, UpdateEmployeeInput } from './employees.schema';

/** Employee rows joined to the small slice of the user record clients render. */
export type EmployeeWithUser = Employee & {
  user: { id: string; name: string | null; mobile: string | null; email: string | null };
};

export interface EmployeeRepository {
  findPage(page: number, pageSize: number): Promise<{ items: EmployeeWithUser[]; total: number }>;
  findByUserId(userId: string): Promise<EmployeeWithUser | null>;
  /** Without the user join — used for existence checks before a write. */
  findSummaryByUserId(userId: string): Promise<Employee | null>;
  create(data: CreateEmployeeInput): Promise<Employee>;
  update(userId: string, data: UpdateEmployeeInput): Promise<Employee>;
  remove(userId: string): Promise<unknown>;
}

import type { Department } from '../../../shared/database';

export type DepartmentFilter = { q?: string | undefined; status?: readonly string[] | undefined };
export type DepartmentSort = 'name' | 'newest';

export type NewDepartment = {
  name: string;
  code: string;
  description: string | null;
  headId: string | null;
  parentId: string | null;
  regions: string[];
  openRoles: number;
  isActive: boolean;
};
export type DepartmentPatch = Partial<NewDepartment>;

/** A department with the two rows a list line names beside it. */
export type DepartmentRow = Department & {
  parent: { id: string; name: string; code: string } | null;
  children: { id: string; name: string; code: string; isActive: boolean }[];
};

export interface DepartmentsRepository {
  findAll(filter: DepartmentFilter, sort: DepartmentSort): Promise<DepartmentRow[]>;
  countByActive(filter: DepartmentFilter): Promise<Record<string, number>>;
  findById(id: string): Promise<DepartmentRow | null>;
  /** Case-insensitive, for the 409 and for `ensureDepartments`. */
  findByName(name: string): Promise<Department | null>;
  findByCode(code: string): Promise<Department | null>;
  create(data: NewDepartment): Promise<Department>;
  update(id: string, data: DepartmentPatch): Promise<Department>;
  remove(id: string): Promise<Department>;
}

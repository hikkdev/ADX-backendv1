import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { toListPage, type ListPage } from '../../../shared/pagination';
import type { Department } from '../../../shared/database';
import {
  countEmployeesByDepartment,
  findEmployeeByUserId,
  findEmployeeCard,
  linkEmployeesToDepartment,
  listDepartmentMembers,
  listUnlinkedDepartmentNames,
  type DepartmentMember,
} from '../../employees';
import { prismaDepartmentsRepository as repository } from './prisma-departments.repository';
import type { DepartmentRow, NewDepartment } from './departments.repository';
import { codeFromName, type CreateDepartmentInput, type DepartmentsQuery, type PatchDepartmentInput } from './departments.schema';

/**
 * Departments — Lot G (Q122/Q140).
 *
 * The `Department` row is this module's; the people in it are `employees`',
 * read through that module's index (member counts, the members of one
 * department, the head's card) and never its table — the same rule the
 * people registry follows.
 */

export type DepartmentHead = { id: string; userId: string; name: string | null; designation: string | null };

export interface DepartmentView {
  id: string;
  name: string;
  code: string;
  description: string | null;
  headId: string | null;
  head: DepartmentHead | null;
  parentId: string | null;
  parent: { id: string; name: string; code: string } | null;
  regions: string[];
  openRoles: number;
  isActive: boolean;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DepartmentDetail extends DepartmentView {
  children: { id: string; name: string; code: string; isActive: boolean; memberCount: number }[];
  members: DepartmentMember[];
}

const AUDITED = ['name', 'code', 'description', 'headId', 'parentId', 'regions', 'openRoles', 'isActive'] as const;
export const DEPARTMENT_AUDIT_FIELDS = AUDITED;

async function toView(row: DepartmentRow, counts: Record<string, number>): Promise<DepartmentView> {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    headId: row.headId,
    head: row.headId ? await findEmployeeCard(row.headId) : null,
    parentId: row.parentId,
    parent: row.parent,
    regions: row.regions,
    openRoles: row.openRoles,
    isActive: row.isActive,
    memberCount: counts[row.id] ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** GET /hr/departments — the list contract, member counts on every row; `sort=members` is by that count. */
export async function listDepartments(query: DepartmentsQuery): Promise<ListPage<DepartmentView>> {
  const filter = { q: query.q, status: query.status };
  const [rows, counts, chips] = await Promise.all([
    repository.findAll(filter, query.sort === 'newest' ? 'newest' : 'name'),
    countEmployeesByDepartment(),
    repository.countByActive(filter),
  ]);
  const sorted = query.sort === 'members' ? [...rows].sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0) || a.name.localeCompare(b.name)) : rows;
  const start = (query.page - 1) * query.pageSize;
  const items = await Promise.all(sorted.slice(start, start + query.pageSize).map((row) => toView(row, counts)));
  return toListPage(items, sorted.length, chips, query);
}

/** GET /hr/departments/:id — head, parent, children (with counts), regions, open roles, and the members. */
export async function getDepartment(id: string): Promise<DepartmentDetail> {
  const row = await requireDepartment(id);
  const [counts, members] = await Promise.all([countEmployeesByDepartment(), listDepartmentMembers(id)]);
  const view = await toView(row, counts);
  return {
    ...view,
    children: row.children.map((child) => ({ ...child, memberCount: counts[child.id] ?? 0 })),
    members,
  };
}

export async function createDepartment(input: CreateDepartmentInput): Promise<DepartmentView> {
  const code = input.code ?? codeFromName(input.name);
  await assertNameFree(input.name);
  await assertCodeFree(code);
  const data: NewDepartment = {
    name: input.name,
    code,
    description: input.description ?? null,
    headId: await resolveHeadOf(input),
    parentId: await resolveParent(input.parentId ?? null, null),
    regions: dedupe(input.regions ?? []),
    openRoles: input.openRoles ?? 0,
    isActive: input.isActive ?? true,
  };
  const created = await repository.create(data);
  return toView({ ...created, parent: null, children: [] }, {});
}

export async function patchDepartment(id: string, patch: PatchDepartmentInput): Promise<{ before: DepartmentView; after: DepartmentView }> {
  const existing = await requireDepartment(id);
  const counts = await countEmployeesByDepartment();
  const before = await toView(existing, counts);
  if (patch.name !== undefined && patch.name.toLowerCase() !== existing.name.toLowerCase()) await assertNameFree(patch.name, id);
  if (patch.code !== undefined && patch.code.toLowerCase() !== existing.code.toLowerCase()) await assertCodeFree(patch.code, id);
  const data = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.code !== undefined ? { code: patch.code } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.headId !== undefined || patch.headUserId !== undefined ? { headId: await resolveHeadOf(patch) } : {}),
    ...(patch.parentId !== undefined ? { parentId: await resolveParent(patch.parentId, id) } : {}),
    ...(patch.regions !== undefined ? { regions: dedupe(patch.regions) } : {}),
    ...(patch.openRoles !== undefined ? { openRoles: patch.openRoles } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
  };
  await repository.update(id, data);
  const after = await toView((await repository.findById(id))!, counts);
  return { before, after };
}

/** Refused while people are still in it, or departments still under it — nothing is re-rooted or orphaned by a delete. */
export async function deleteDepartment(id: string): Promise<DepartmentView> {
  const row = await requireDepartment(id);
  const counts = await countEmployeesByDepartment();
  const members = counts[id] ?? 0;
  if (members > 0) {
    throw new ApiError(409, 'CONFLICT', `${members} ${members === 1 ? 'person is' : 'people are'} still in this department; move them first`, { reason: 'DEPARTMENT_HAS_MEMBERS', members });
  }
  if (row.children.length > 0) {
    throw new ApiError(409, 'CONFLICT', 'Departments still sit under this one; move or delete them first', { reason: 'DEPARTMENT_HAS_CHILDREN', children: row.children.map((child) => child.id) });
  }
  const view = await toView(row, counts);
  await repository.remove(id);
  return view;
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

const dedupe = (values: string[]): string[] => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

async function requireDepartment(id: string): Promise<DepartmentRow> {
  const row = await repository.findById(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Department not found');
  return row;
}

async function assertNameFree(name: string, exceptId?: string): Promise<void> {
  const holder = await repository.findByName(name);
  if (holder && holder.id !== exceptId) throw new ApiError(409, 'CONFLICT', 'A department with that name already exists');
}

async function assertCodeFree(code: string, exceptId?: string): Promise<void> {
  const holder = await repository.findByCode(code);
  if (holder && holder.id !== exceptId) throw new ApiError(409, 'CONFLICT', 'A department with that code already exists');
}

/** The head is an Employee row's id, and must exist. */
async function resolveHead(headId: string | null): Promise<string | null> {
  if (!headId) return null;
  const card = await findEmployeeCard(headId);
  if (!card) throw new ApiError(404, 'NOT_FOUND', 'The head must be an employee record');
  return card.id;
}

/**
 * G11-1: the head as the body names it — `headId` (the record) or
 * `headUserId` (the login, resolved to the record; the row stores the
 * record's id either way). The schema refuses both at once; null clears.
 */
async function resolveHeadOf(body: { headId?: string | null | undefined; headUserId?: string | null | undefined }): Promise<string | null> {
  if (body.headUserId === undefined) return resolveHead(body.headId ?? null);
  if (body.headUserId === null) return null;
  const employee = await findEmployeeByUserId(body.headUserId);
  if (!employee) throw new ApiError(404, 'NOT_FOUND', 'The head must be an employee record');
  return employee.id;
}

/** The parent must exist, and may not be the department itself or anything under it. */
async function resolveParent(parentId: string | null, selfId: string | null): Promise<string | null> {
  if (!parentId) return null;
  if (selfId && parentId === selfId) throw new ApiError(400, 'VALIDATION_ERROR', 'A department cannot be its own parent');
  const parent = await repository.findById(parentId);
  if (!parent) throw new ApiError(404, 'NOT_FOUND', 'Parent department not found');
  if (selfId) {
    // Walk up from the proposed parent; meeting ourselves would make a ring.
    let cursor: Department | null = parent;
    const seen = new Set<string>();
    while (cursor?.parentId) {
      if (cursor.parentId === selfId) throw new ApiError(400, 'VALIDATION_ERROR', 'That department sits under this one; it cannot also be its parent');
      if (seen.has(cursor.parentId)) break;
      seen.add(cursor.parentId);
      cursor = await repository.findById(cursor.parentId);
    }
  }
  return parent.id;
}

/* ── The boot seed ───────────────────────────────────────────────────── */

/**
 * `ensureDepartments()` — Lot G (Q122): the free `department` strings on
 * Employee rows become records once. Every distinct unlinked name gets a
 * Department (matched case-insensitively to one that already exists, or
 * created with a code derived from the name), and the rows carrying it are
 * linked. Idempotent: a second run finds nothing unlinked and writes
 * nothing; a department ops renamed is not touched. Runs from bootstrap,
 * not awaited, like the holidays. Returns what it did, for the log line.
 */
export async function ensureDepartments(): Promise<{ created: number; linked: number }> {
  const names = await listUnlinkedDepartmentNames();
  let created = 0;
  let linked = 0;
  for (const name of names) {
    let department = await repository.findByName(name);
    if (!department) {
      let code = codeFromName(name);
      if (await repository.findByCode(code)) code = `${code.slice(0, 12)}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      department = await repository.create({ name, code, description: null, headId: null, parentId: null, regions: [], openRoles: 0, isActive: true });
      created += 1;
    }
    linked += await linkEmployeesToDepartment(name, department.id);
  }
  if (created > 0 || linked > 0) logger.info('Seeded departments from employee rows', { created, linked });
  return { created, linked };
}

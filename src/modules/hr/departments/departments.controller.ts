import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { auditDiff, logActivity } from '../../../shared/audit';
import { createDepartmentSchema, departmentsQuerySchema, patchDepartmentSchema } from './departments.schema';
import { DEPARTMENT_AUDIT_FIELDS, createDepartment, deleteDepartment, getDepartment, listDepartments, patchDepartment } from './departments.service';

const parse = <T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } },
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  return result.data as T;
};

const departmentId = (req: Request) => req.params['departmentId'] as string;

export async function listDepartmentsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listDepartments(parse(departmentsQuerySchema, req.query)) });
}

export async function getDepartmentHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getDepartment(departmentId(req)) });
}

export async function createDepartmentHandler(req: Request, res: Response): Promise<void> {
  const department = await createDepartment(parse(createDepartmentSchema, req.body));
  await logActivity(req.user!.sub, 'DEPARTMENT_CREATED', {
    req,
    module: 'hr',
    targetType: 'Department',
    targetId: department.id,
    metadata: { name: department.name, code: department.code, parentId: department.parentId },
  });
  res.status(201).json({ success: true, data: department });
}

export async function patchDepartmentHandler(req: Request, res: Response): Promise<void> {
  const patch = parse(patchDepartmentSchema, req.body);
  const { before, after } = await patchDepartment(departmentId(req), patch);
  await logActivity(req.user!.sub, 'DEPARTMENT_UPDATED', {
    req,
    module: 'hr',
    targetType: 'Department',
    targetId: after.id,
    diff: auditDiff(before, after, DEPARTMENT_AUDIT_FIELDS),
    metadata: { name: after.name, code: after.code },
  });
  res.json({ success: true, data: after });
}

export async function deleteDepartmentHandler(req: Request, res: Response): Promise<void> {
  const department = await deleteDepartment(departmentId(req));
  await logActivity(req.user!.sub, 'DEPARTMENT_DELETED', {
    req,
    module: 'hr',
    targetType: 'Department',
    targetId: department.id,
    metadata: { name: department.name, code: department.code },
  });
  res.json({ success: true, data: { message: 'Department deleted' } });
}

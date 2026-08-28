import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { createEmployeeSchema, updateEmployeeSchema } from './employees.schema';
import {
  createEmployee,
  deleteEmployee,
  getEmployeeByUserId,
  listEmployees,
  updateEmployee,
} from './employees.service';

export async function createEmployeeHandler(req: Request, res: Response): Promise<void> {
  const parsed = createEmployeeSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const employee = await createEmployee(parsed.data);
  res.status(201).json({ success: true, data: employee });
}

export async function getAllEmployeesHandler(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, Number(req.query['page'] ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query['pageSize'] ?? 20)));

  const { items, meta } = await listEmployees(page, pageSize);

  // `meta` is a sibling of `data`, not nested inside it. Clients depend on this.
  res.json({ success: true, data: items, meta });
}

export async function getEmployeeByUserIdHandler(req: Request, res: Response): Promise<void> {
  const employee = await getEmployeeByUserId(req.params['userId'] as string);
  res.json({ success: true, data: employee });
}

export async function updateEmployeeHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateEmployeeSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  // Validation precedes the existence check, matching the original controller.
  const employee = await updateEmployee(req.params['userId'] as string, parsed.data);
  res.json({ success: true, data: employee });
}

export async function deleteEmployeeHandler(req: Request, res: Response): Promise<void> {
  await deleteEmployee(req.params['userId'] as string);
  res.json({ success: true, data: { message: 'Employee deleted' } });
}

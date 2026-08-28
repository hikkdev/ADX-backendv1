import { ApiError } from '../../shared/errors';
import { userExists } from '../users';
import { prismaEmployeeRepository as repository } from './prisma-employees.repository';
import type { CreateEmployeeInput, UpdateEmployeeInput } from './employees.schema';

export async function listEmployees(page: number, pageSize: number) {
  const { items, total } = await repository.findPage(page, pageSize);
  return { items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}

export async function getEmployeeByUserId(userId: string) {
  const employee = await repository.findByUserId(userId);
  if (!employee) throw new ApiError(404, 'NOT_FOUND', 'Employee not found');
  return employee;
}

export async function createEmployee(data: CreateEmployeeInput) {
  // The user must exist before it can be given an employee record, and a user
  // may hold at most one.
  if (!(await userExists(data.userId))) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }
  if (await repository.findSummaryByUserId(data.userId)) {
    throw new ApiError(409, 'CONFLICT', 'Employee record already exists for this user');
  }
  return repository.create(data);
}

export async function updateEmployee(userId: string, data: UpdateEmployeeInput) {
  await requireEmployee(userId);
  return repository.update(userId, data);
}

export async function deleteEmployee(userId: string) {
  await requireEmployee(userId);
  await repository.remove(userId);
}

async function requireEmployee(userId: string) {
  const existing = await repository.findSummaryByUserId(userId);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Employee not found');
  return existing;
}

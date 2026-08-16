import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { prisma } from '../lib/prisma';

// Document fields accepted on employee create/update. Clients first POST the file to
// /upload (purpose=KYC) to get a URL, then send that URL here — mirrors how PublisherKyc works.
const documentFields = {
  passportPhotoUrl: z.string().url().optional(),
  referenceLetterUrl: z.string().url().optional(),
  ndaAgreementUrl: z.string().url().optional(),
  nonCompeteAgreementUrl: z.string().url().optional(),
  class10MarksheetUrl: z.string().url().optional(),
  class12MarksheetUrl: z.string().url().optional(),
  graduationMarksheetUrl: z.string().url().optional(),
  postGraduationMarksheetUrl: z.string().url().optional(),
  form2NominationUrl: z.string().url().optional(),
  form6aUrl: z.string().url().optional(),
  esiFormUrl: z.string().url().optional(),
  form2FamilyDeclarationUrl: z.string().url().optional(),
  form6EmployeeRegistrationUrl: z.string().url().optional(),
  salaryAccountLetterUrl: z.string().url().optional(),
  salarySlipUrls: z.array(z.string().url()).optional(),
  complianceFormUrls: z.array(z.string().url()).optional(),
  epfFormUrls: z.array(z.string().url()).optional(),
  gratuityFormUrls: z.array(z.string().url()).optional(),
};

const createEmployeeSchema = z.object({
  userId: z.string().min(1),
  department: z.string().optional(),
  designation: z.string().optional(),
  ...documentFields,
});

const updateEmployeeSchema = z.object({
  department: z.string().optional(),
  designation: z.string().optional(),
  isActive: z.boolean().optional(),
  ...documentFields,
});

export async function createEmployeeHandler(req: Request, res: Response): Promise<void> {
  const parsed = createEmployeeSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const existing = await prisma.employee.findUnique({ where: { userId: parsed.data.userId } });
  if (existing) throw new ApiError(409, 'CONFLICT', 'Employee record already exists for this user');

  const employee = await prisma.employee.create({ data: parsed.data });
  res.status(201).json({ success: true, data: employee });
}

export async function getAllEmployeesHandler(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, Number(req.query['page'] ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query['pageSize'] ?? 20)));

  const [items, total] = await Promise.all([
    prisma.employee.findMany({
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, mobile: true, email: true } } },
    }),
    prisma.employee.count(),
  ]);

  res.json({ success: true, data: items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

export async function getEmployeeByUserIdHandler(req: Request, res: Response): Promise<void> {
  const userId = req.params['userId'] as string;
  const employee = await prisma.employee.findUnique({
    where: { userId },
    include: { user: { select: { id: true, name: true, mobile: true, email: true } } },
  });
  if (!employee) throw new ApiError(404, 'NOT_FOUND', 'Employee not found');
  res.json({ success: true, data: employee });
}

export async function updateEmployeeHandler(req: Request, res: Response): Promise<void> {
  const userId = req.params['userId'] as string;
  const parsed = updateEmployeeSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const existing = await prisma.employee.findUnique({ where: { userId } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Employee not found');

  const employee = await prisma.employee.update({ where: { userId }, data: parsed.data });
  res.json({ success: true, data: employee });
}

export async function deleteEmployeeHandler(req: Request, res: Response): Promise<void> {
  const userId = req.params['userId'] as string;
  const existing = await prisma.employee.findUnique({ where: { userId } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Employee not found');

  await prisma.employee.delete({ where: { userId } });
  res.json({ success: true, data: { message: 'Employee deleted' } });
}

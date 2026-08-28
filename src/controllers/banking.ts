import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../shared/errors';
import { prisma } from '../shared/database';

const bankAccountSchema = z.object({
  accountHolder: z.string().min(1),
  bankName: z.string().min(1),
  accountNumber: z.string().min(8),
  ifscCode: z.string().min(11).max(11).toUpperCase(),
});

export async function getBankAccountsHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const accounts = await prisma.bankAccount.findMany({
    where: { userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  res.json({ success: true, data: accounts });
}

export async function createBankAccountHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const parsed = bankAccountSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const existingCount = await prisma.bankAccount.count({ where: { userId } });

  const account = await prisma.bankAccount.create({
    data: {
      userId,
      ...parsed.data,
      isDefault: existingCount === 0, // first account is default
    },
  });
  res.status(201).json({ success: true, data: account });
}

export async function updateBankAccountHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const accountId = req.params['accountId'] as string;

  const account = await prisma.bankAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId) throw new ApiError(404, 'NOT_FOUND', 'Bank account not found');

  const parsed = z.object({
    accountHolder: z.string().min(1).optional(),
    bankName: z.string().min(1).optional(),
    accountNumber: z.string().min(8).optional(),
    ifscCode: z.string().min(11).max(11).optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const updated = await prisma.bankAccount.update({
    where: { id: accountId },
    data: {
      ...parsed.data,
      ifscCode: parsed.data.ifscCode?.toUpperCase(),
      isVerified: false, // reset verification on edit
    },
  });
  res.json({ success: true, data: updated });
}

export async function deleteBankAccountHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const accountId = req.params['accountId'] as string;

  const account = await prisma.bankAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId) throw new ApiError(404, 'NOT_FOUND', 'Bank account not found');
  if (account.isDefault) throw new ApiError(400, 'BAD_REQUEST', 'Cannot delete the default account. Set another account as default first.');

  await prisma.bankAccount.delete({ where: { id: accountId } });
  res.json({ success: true, data: { message: 'Bank account deleted' } });
}

export async function setDefaultBankAccountHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const accountId = req.params['accountId'] as string;

  const account = await prisma.bankAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId) throw new ApiError(404, 'NOT_FOUND', 'Bank account not found');

  // Unset existing default, then set new one atomically
  await prisma.$transaction([
    prisma.bankAccount.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } }),
    prisma.bankAccount.update({ where: { id: accountId }, data: { isDefault: true } }),
  ]);

  const updated = await prisma.bankAccount.findUnique({ where: { id: accountId } });
  res.json({ success: true, data: updated });
}

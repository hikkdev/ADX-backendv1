import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { createBankAccountSchema, updateBankAccountSchema } from './banking.schema';
import {
  assertAccountOwned,
  createBankAccount,
  deleteBankAccount,
  listBankAccounts,
  setDefaultBankAccount,
  updateBankAccount,
} from './banking.service';

export async function getBankAccountsHandler(req: Request, res: Response): Promise<void> {
  const accounts = await listBankAccounts(req.user!.sub);
  res.json({ success: true, data: accounts });
}

export async function createBankAccountHandler(req: Request, res: Response): Promise<void> {
  const parsed = createBankAccountSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const account = await createBankAccount(req.user!.sub, parsed.data);
  res.status(201).json({ success: true, data: account });
}

export async function updateBankAccountHandler(req: Request, res: Response): Promise<void> {
  const accountId = req.params['accountId'] as string;
  const userId = req.user!.sub;

  // Ownership is checked before the body is validated, so an unknown or
  // someone else's id answers 404 even when the body is also malformed. That
  // ordering is the original behaviour and the contract tests rely on it.
  await assertAccountOwned(accountId, userId);

  const parsed = updateBankAccountSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const updated = await updateBankAccount(accountId, parsed.data);
  res.json({ success: true, data: updated });
}

export async function deleteBankAccountHandler(req: Request, res: Response): Promise<void> {
  await deleteBankAccount(req.params['accountId'] as string, req.user!.sub);
  res.json({ success: true, data: { message: 'Bank account deleted' } });
}

export async function setDefaultBankAccountHandler(req: Request, res: Response): Promise<void> {
  const updated = await setDefaultBankAccount(req.params['accountId'] as string, req.user!.sub);
  res.json({ success: true, data: updated });
}

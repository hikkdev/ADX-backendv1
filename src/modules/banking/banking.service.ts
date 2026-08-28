import { ApiError } from '../../shared/errors';
import { prismaBankingRepository as repository } from './prisma-banking.repository';
import type { CreateBankAccountInput, UpdateBankAccountInput } from './banking.schema';

export async function listBankAccounts(userId: string) {
  return repository.findManyForUser(userId);
}

/**
 * Gate for every account-scoped write.
 *
 * An account the caller does not own is reported as missing rather than
 * forbidden, so the endpoint never confirms that an id exists.
 */
export async function assertAccountOwned(accountId: string, userId: string) {
  const account = await repository.findById(accountId);
  if (!account || account.userId !== userId) {
    throw new ApiError(404, 'NOT_FOUND', 'Bank account not found');
  }
  return account;
}

export async function createBankAccount(userId: string, data: CreateBankAccountInput) {
  const existingCount = await repository.countForUser(userId);
  // The first account a user adds becomes their default.
  return repository.create(userId, data, existingCount === 0);
}

/** Caller must have passed assertAccountOwned first. */
export async function updateBankAccount(accountId: string, data: UpdateBankAccountInput) {
  return repository.update(accountId, data);
}

export async function deleteBankAccount(accountId: string, userId: string) {
  const account = await assertAccountOwned(accountId, userId);
  if (account.isDefault) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Cannot delete the default account. Set another account as default first.',
    );
  }
  await repository.remove(accountId);
}

export async function setDefaultBankAccount(accountId: string, userId: string) {
  await assertAccountOwned(accountId, userId);
  return repository.setDefault(userId, accountId);
}

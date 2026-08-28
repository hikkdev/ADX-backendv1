import type { BankAccount } from '../../shared/database';
import type { CreateBankAccountInput, UpdateBankAccountInput } from './banking.schema';

export interface BankingRepository {
  findManyForUser(userId: string): Promise<BankAccount[]>;
  findById(accountId: string): Promise<BankAccount | null>;
  countForUser(userId: string): Promise<number>;
  create(userId: string, data: CreateBankAccountInput, isDefault: boolean): Promise<BankAccount>;
  update(accountId: string, data: UpdateBankAccountInput): Promise<BankAccount>;
  remove(accountId: string): Promise<unknown>;
  /** Unsets the current default and sets the new one in one transaction. */
  setDefault(userId: string, accountId: string): Promise<BankAccount | null>;
}

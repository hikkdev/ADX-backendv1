import { prisma } from '../../shared/database';
import type { BankingRepository } from './banking.repository';
import type { CreateBankAccountInput, UpdateBankAccountInput } from './banking.schema';

export const prismaBankingRepository: BankingRepository = {
  findManyForUser(userId: string) {
    return prisma.bankAccount.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  },

  findById(accountId: string) {
    return prisma.bankAccount.findUnique({ where: { id: accountId } });
  },

  countForUser(userId: string) {
    return prisma.bankAccount.count({ where: { userId } });
  },

  create(userId: string, data: CreateBankAccountInput, isDefault: boolean) {
    return prisma.bankAccount.create({ data: { userId, ...data, isDefault } });
  },

  update(accountId: string, data: UpdateBankAccountInput) {
    return prisma.bankAccount.update({
      where: { id: accountId },
      data: {
        ...data,
        ifscCode: data.ifscCode?.toUpperCase(),
        isVerified: false, // reset verification on edit
      },
    });
  },

  remove(accountId: string) {
    return prisma.bankAccount.delete({ where: { id: accountId } });
  },

  async setDefault(userId: string, accountId: string) {
    // Atomic so a failure can never leave the user with two defaults or none.
    await prisma.$transaction([
      prisma.bankAccount.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } }),
      prisma.bankAccount.update({ where: { id: accountId }, data: { isDefault: true } }),
    ]);
    return prisma.bankAccount.findUnique({ where: { id: accountId } });
  },
};

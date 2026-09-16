import { prisma } from '../../../shared/database';
import type { User, WithdrawalStatus } from '../../../shared/database';

/**
 * The reads the mobile change needs before it moves the identity.
 *
 * The withdrawal count reaches into the payouts tables on purpose: the
 * question "is money in flight for this person" has no owner elsewhere, and
 * asking it is a read, not a decision. See the service for why it is asked.
 */
export interface MobileChangeRepository {
  findUser(userId: string): Promise<User | null>;
  findUserByMobile(mobile: string): Promise<User | null>;
  countWithdrawalsInFlight(userId: string, statuses: WithdrawalStatus[]): Promise<number>;
  changeMobile(userId: string, mobile: string): Promise<User>;
}

export const prismaMobileChangeRepository: MobileChangeRepository = {
  findUser(userId) {
    return prisma.user.findUnique({ where: { id: userId } });
  },

  findUserByMobile(mobile) {
    return prisma.user.findUnique({ where: { mobile } });
  },

  countWithdrawalsInFlight(userId, statuses) {
    return prisma.withdrawalRequest.count({
      where: {
        status: { in: statuses },
        wallet: {
          OR: [
            { publisher: { userId } },
            { agent: { userId } },
            { advertiser: { userId } },
          ],
        },
      },
    });
  },

  changeMobile(userId, mobile) {
    // mobileVerifiedAt moves with the number: the OTP that just landed is the
    // proof, and leaving the old stamp would claim a verification of a number
    // this account no longer has.
    return prisma.user.update({
      where: { id: userId },
      data: { mobile, mobileVerifiedAt: new Date() },
    });
  },
};

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026): what the delete guard counts and what the
 * cascade removes, at the query. A blank KYC row is not history (so a
 * publisher, born with one, can be deleted); a KYC row with anything in it
 * is, on every party, the print shop's and the HR record's included;
 * invoices, campaigns, package purchases, claimed grants, a print shop's
 * jobs and quotes and an employee's desk work count. The cascade takes the
 * advertiser profile and the print shop with the account, in the one
 * transaction, and the unclaimed grants offered to the agent.
 */

type AnyFn = (...args: any[]) => any;
const count = () => vi.fn<AnyFn>(async () => 0);

const { prisma, tx } = vi.hoisted(() => {
  const tx = {
    order: { findMany: vi.fn(async () => []), deleteMany: vi.fn(), updateMany: vi.fn() },
    listing: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
    orderMilestone: { findMany: vi.fn(async () => []), deleteMany: vi.fn(), updateMany: vi.fn() },
    site: { deleteMany: vi.fn() },
    publisher: { delete: vi.fn(), updateMany: vi.fn() },
    advertiser: { delete: vi.fn() },
    printPartner: { delete: vi.fn() },
    delegatedAccessGrant: { deleteMany: vi.fn() },
    orderAgentAssignment: { deleteMany: vi.fn() },
    transaction: { deleteMany: vi.fn() },
    agentMilestone: { deleteMany: vi.fn() },
    agentProfile: { delete: vi.fn() },
    qrScan: { deleteMany: vi.fn() },
    ticketMessage: { deleteMany: vi.fn() },
    supportTicket: { deleteMany: vi.fn() },
    user: { delete: vi.fn() },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      user: { findUnique: vi.fn() },
      printPartner: { findUnique: vi.fn() },
      wallet: { findMany: vi.fn(async () => []) },
      walletEntry: { count: vi.fn() },
      ledgerLeg: { count: vi.fn() },
      listing: { findMany: vi.fn(async () => []) },
      order: { count: vi.fn() },
      agreementAcceptance: { count: vi.fn() },
      userKyc: { count: vi.fn() },
      publisherKyc: { count: vi.fn() },
      advertiserKyc: { count: vi.fn() },
      agentKyc: { count: vi.fn() },
      printPartnerKyc: { count: vi.fn() },
      employeeKyc: { count: vi.fn() },
      invoice: { count: vi.fn() },
      publisherInvoice: { count: vi.fn() },
      campaign: { count: vi.fn() },
      packageSale: { count: vi.fn() },
      delegatedAccessGrant: { count: vi.fn() },
      printJob: { count: vi.fn() },
      printQuote: { count: vi.fn() },
      agentInterview: { count: vi.fn() },
      agentProfile: { count: vi.fn() },
      department: { count: vi.fn() },
      activityLog: { count: vi.fn() },
    },
  };
});

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaUsersRepository as repository } from '../prisma-users.repository';
import type { DeletionTarget } from '../users.repository';

const target = (over: Partial<DeletionTarget> = {}) =>
  ({
    id: 'usr_1',
    roles: [],
    publisherProfile: { id: 'pub_1' },
    advertiserProfile: { id: 'adv_1' },
    agentProfile: { id: 'agt_1' },
    printPartner: { id: 'prt_1' },
    employeeProfile: { id: 'emp_1' },
    ...over,
  }) as unknown as DeletionTarget;

const WITH_HISTORY = { OR: [{ submittedAt: { not: null } }, { requestedAt: { not: null } }, { digioRequestId: { not: null } }, { status: { not: 'PENDING' } }] };

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(prisma)) {
    if (typeof model === 'object' && model && 'count' in model) (model as { count: ReturnType<typeof count> }).count = count();
  }
});

describe('the history behind an account', () => {
  it('counts only KYC rows with something in them, on every party', async () => {
    await repository.findDeletionHistory(target());
    expect(prisma.publisherKyc.count).toHaveBeenCalledWith({ where: { publisherId: 'pub_1', ...WITH_HISTORY } });
    expect(prisma.printPartnerKyc.count).toHaveBeenCalledWith({ where: { printPartnerId: 'prt_1', ...WITH_HISTORY } });
    expect(prisma.employeeKyc.count).toHaveBeenCalledWith({ where: { employeeId: 'emp_1', ...WITH_HISTORY } });
    expect(prisma.advertiserKyc.count.mock.calls[0]![0].where.AND[0]).toEqual({ OR: [{ advertiserId: 'usr_1' }, { advertiserProfileId: 'adv_1' }] });
  });

  it('counts invoices, campaigns, package purchases, claimed grants, print work and staff work', async () => {
    prisma.invoice.count.mockResolvedValue(1);
    prisma.publisherInvoice.count.mockResolvedValue(2);
    prisma.campaign.count.mockResolvedValue(3);
    prisma.packageSale.count.mockResolvedValue(4);
    prisma.delegatedAccessGrant.count.mockResolvedValue(5);
    prisma.printJob.count.mockResolvedValue(6);
    prisma.printQuote.count.mockResolvedValue(1);
    prisma.agentInterview.count.mockResolvedValue(1);
    prisma.activityLog.count.mockResolvedValue(2);
    const history = await repository.findDeletionHistory(target());
    expect(history).toMatchObject({ invoices: 3, campaigns: 3, packageSales: 4, accessGrantsUsed: 5, printWork: 7, staffWork: 3 });
    expect(prisma.delegatedAccessGrant.count).toHaveBeenCalledWith({
      where: { claimedAt: { not: null }, OR: [{ publisherId: 'pub_1' }, { advertiserId: 'adv_1' }, { assignedAgentId: 'agt_1' }] },
    });
    expect(prisma.invoice.count).toHaveBeenCalledWith({ where: { advertiserId: { in: ['usr_1', 'adv_1'] } } });
  });

  it('a person with no parties has nothing to count beyond themselves', async () => {
    const history = await repository.findDeletionHistory(target({ publisherProfile: null, advertiserProfile: null, agentProfile: null, printPartner: null, employeeProfile: null }));
    expect(history).toMatchObject({ invoices: 0, campaigns: 0, printWork: 0, staffWork: 0, accessGrantsUsed: 0 });
    expect(prisma.campaign.count).not.toHaveBeenCalled();
    expect(prisma.delegatedAccessGrant.count).not.toHaveBeenCalled();
  });
});

describe('the cascade', () => {
  it('removes the advertiser profile and the print shop with the account, in one transaction', async () => {
    await repository.deleteUserCascade(target());
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.advertiser.delete).toHaveBeenCalledWith({ where: { id: 'adv_1' } });
    expect(tx.printPartner.delete).toHaveBeenCalledWith({ where: { id: 'prt_1' } });
    expect(tx.delegatedAccessGrant.deleteMany).toHaveBeenCalledWith({ where: { assignedAgentId: 'agt_1', claimedAt: null } });
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'usr_1' } });
  });

  it('the deletion target looks the print shop up beside the account', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'usr_1', roles: [] });
    prisma.printPartner.findUnique.mockResolvedValue({ id: 'prt_1' });
    expect(await repository.findDeletionTarget('usr_1')).toMatchObject({ id: 'usr_1', printPartner: { id: 'prt_1' } });
    expect(prisma.user.findUnique.mock.calls[0]![0].include).toMatchObject({ employeeProfile: { select: { id: true } } });
  });
});

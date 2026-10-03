import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026) — "KYC still shows up in the queue" for a
 * suspended or closed party. At the query: the advertiser, agent and
 * employee queues AND the working-account fragment in by default (the agent
 * queue also leaves the ladder's dead ends out), `includeInactive` takes it
 * away, every count reads the same where, and each row carries
 * `accountState`. The review-SLA escalation never picks an inactive party.
 */

type AnyFn = (...args: any[]) => any;
const table = () => ({ findMany: vi.fn<AnyFn>(async () => []), count: vi.fn<AnyFn>(async () => 0) });

const { prisma } = vi.hoisted(() => ({
  prisma: {
    advertiser: { findMany: vi.fn(), count: vi.fn() },
    agentProfile: { findMany: vi.fn(), count: vi.fn() },
    employee: { findMany: vi.fn(), count: vi.fn() },
    publisherKyc: { findMany: vi.fn() },
    printPartnerKyc: { findMany: vi.fn() },
    advertiserKyc: { findMany: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaAdvertiserKycRepository } from '../advertiser/prisma-advertiser-kyc.repository';
import { prismaAgentKycRepository } from '../agent/prisma-agent-kyc.repository';
import { prismaEmployeeKycRepository } from '../employee/prisma-employee-kyc.repository';
import { prismaKycEscalationRepository } from '../prisma-kyc-escalation.repository';
import {
  workingAdvertiserWhere,
  workingAgentAccountWhere,
  workingEmployeeWhere,
  workingPrintPartnerWhere,
  workingPublisherWhere,
} from '../../../shared/party-status';

const DEAD_ENDS = { stage: { notIn: ['REJECTED', 'WITHDRAWN', 'EXITED'] } };
const whereOf = (fn: { mock: { calls: any[][] } }, call = 0) => fn.mock.calls[call]![0].where.AND as object[];

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of [prisma.advertiser, prisma.agentProfile, prisma.employee]) {
    Object.assign(model, table());
  }
  prisma.publisherKyc.findMany = vi.fn(async () => []);
  prisma.printPartnerKyc.findMany = vi.fn(async () => []);
  prisma.advertiserKyc.findMany = vi.fn(async () => []);
});

describe('the advertiser queue', () => {
  it('lists working accounts by default; include=inactive or one advertiser by id finds everyone', async () => {
    await prismaAdvertiserKycRepository.findPage({}, 1, 20);
    expect(whereOf(prisma.advertiser.findMany)).toContainEqual(workingAdvertiserWhere());
    await prismaAdvertiserKycRepository.findPage({ includeInactive: true }, 1, 20);
    expect(whereOf(prisma.advertiser.findMany, 1)).not.toContainEqual(workingAdvertiserWhere());
    await prismaAdvertiserKycRepository.findPage({ advertiserId: 'adv_1' }, 1, 20);
    expect(whereOf(prisma.advertiser.findMany, 2)).not.toContainEqual(workingAdvertiserWhere());
  });

  it('every count behind the chips — states, breached, escalated, requested — takes the fragment', async () => {
    await prismaAdvertiserKycRepository.countByState({});
    await prismaAdvertiserKycRepository.countBreached({}, new Date());
    await prismaAdvertiserKycRepository.countEscalated({});
    await prismaAdvertiserKycRepository.countRequested({});
    for (const [args] of prisma.advertiser.count.mock.calls) expect(JSON.stringify(args.where)).toContain(JSON.stringify(workingAdvertiserWhere()));
  });

  it('rows say where the account stands', async () => {
    prisma.advertiser.findMany.mockResolvedValue([
      { id: 'adv_1', userId: 'usr_1', suspensionScopes: ['BLOCK_NEW'], kycStatus: 'PENDING', kyc: null, user: { isActive: true, closedAt: null } },
      { id: 'adv_2', userId: 'usr_2', suspensionScopes: [], kycStatus: 'PENDING', kyc: null, user: { isActive: false, closedAt: new Date() } },
    ]);
    const { items } = await prismaAdvertiserKycRepository.findPage({ includeInactive: true }, 1, 20);
    expect(items.map((item) => item.accountState)).toEqual(['SUSPENDED', 'CLOSED']);
  });
});

describe('the agent queue', () => {
  it('lists working agents past none of the dead ends, unless asked for the inactive', async () => {
    await prismaAgentKycRepository.findPage({}, 1, 20);
    expect(whereOf(prisma.agentProfile.findMany)).toEqual(expect.arrayContaining([workingAgentAccountWhere(), DEAD_ENDS]));
    await prismaAgentKycRepository.countByState({});
    for (const [args] of prisma.agentProfile.count.mock.calls) expect(args.where.AND).toContainEqual(DEAD_ENDS);
    await prismaAgentKycRepository.findPage({ includeInactive: true }, 1, 20);
    expect(whereOf(prisma.agentProfile.findMany, 1)).not.toContainEqual(DEAD_ENDS);
  });

  it('rows carry accountState, and the account facts read for it never leave the row', async () => {
    prisma.agentProfile.findMany.mockResolvedValue([
      { id: 'agt_1', userId: 'usr_1', displayId: 'AGT-1', city: null, createdAt: new Date(), stage: 'EXITED', status: 'SUSPENDED', suspensionScopes: [], user: { name: 'R', mobile: '+91', email: null, isActive: false, closedAt: null }, kyc: null },
    ]);
    const { items } = await prismaAgentKycRepository.findPage({ includeInactive: true }, 1, 20);
    expect(items[0]).toMatchObject({ accountState: 'EXITED', agent: { id: 'agt_1', user: { name: 'R', mobile: '+91', email: null } } });
    expect(items[0]!.agent).not.toHaveProperty('stage');
    expect(items[0]!.agent.user).not.toHaveProperty('closedAt');
  });
});

describe('the employee queue', () => {
  it('lists working staff unless asked for the inactive, and says where each stands', async () => {
    prisma.employee.findMany.mockResolvedValue([
      { id: 'emp_1', userId: 'usr_1', displayId: 'EMP-1', department: null, designation: null, employmentType: null, createdAt: new Date(), isActive: false, user: { name: 'E', mobile: '+91', email: null, isActive: true, closedAt: null }, kyc: null },
    ]);
    await prismaEmployeeKycRepository.findPage({}, 1, 20);
    expect(whereOf(prisma.employee.findMany)).toContainEqual(workingEmployeeWhere());
    const { items } = await prismaEmployeeKycRepository.findPage({ includeInactive: true }, 1, 20);
    expect(whereOf(prisma.employee.findMany, 1)).not.toContainEqual(workingEmployeeWhere());
    expect(items[0]).toMatchObject({ accountState: 'DEACTIVATED' });
    expect(items[0]!.employee).not.toHaveProperty('isActive');
  });
});

describe('the review-SLA escalation', () => {
  it('never picks an inactive party’s aged case', async () => {
    const cutoff = new Date();
    await prismaKycEscalationRepository.findAgedPending('PUBLISHER', cutoff, 10);
    expect(prisma.publisherKyc.findMany.mock.calls[0]![0].where).toMatchObject({ publisher: workingPublisherWhere() });
    await prismaKycEscalationRepository.findAgedPending('PRINT_PARTNER', cutoff, 10);
    expect(prisma.printPartnerKyc.findMany.mock.calls[0]![0].where).toMatchObject({ printPartner: workingPrintPartnerWhere() });
    await prismaKycEscalationRepository.findAgedPending('ADVERTISER', cutoff, 10);
    expect(prisma.advertiserKyc.findMany.mock.calls[0]![0].where.OR).toContainEqual({ profile: { is: workingAdvertiserWhere() } });
  });
});

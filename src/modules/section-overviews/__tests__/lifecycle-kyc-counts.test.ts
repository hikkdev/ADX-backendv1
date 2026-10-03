import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026): the section overviews' KYC counts are the
 * queues' counts — a suspended, deactivated or closed party is not waiting
 * on anybody, so it is not counted (and the agent counts leave the ladder's
 * dead ends out, as the agent queue does).
 */

type AnyFn = (...args: any[]) => any;
const counter = () => ({ count: vi.fn<AnyFn>(async () => 0) });

const { prisma } = vi.hoisted(() => ({ prisma: {} as Record<string, { count: ReturnType<typeof vi.fn> }> }));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import {
  workingAdvertiserWhere,
  workingAgentAccountWhere,
  workingEmployeeWhere,
  workingPrintPartnerWhere,
  workingPublisherWhere,
} from '../../../shared/party-status';
import { prismaSectionOverviewsRepository as repository } from '../prisma-section-overviews.repository';

beforeEach(() => {
  for (const model of ['publisher', 'advertiser', 'agentProfile', 'printPartner', 'employee']) prisma[model] = counter();
});

const everyCountHas = (model: string, fragment: object) => {
  const calls = prisma[model]!.count.mock.calls;
  expect(calls).toHaveLength(6);
  for (const [args] of calls) expect((args as { where: { AND: object[] } }).where.AND).toContainEqual(fragment);
};

describe('the KYC counts per state', () => {
  it('publishers, advertisers and print partners count working accounts only', async () => {
    await repository.publishersKycByState({});
    everyCountHas('publisher', workingPublisherWhere());
    await repository.advertisersKycByState({});
    everyCountHas('advertiser', workingAdvertiserWhere());
    await repository.printPartnersKycByState({});
    everyCountHas('printPartner', workingPrintPartnerWhere());
  });

  it('agents: working accounts past none of the dead ends; employees: working staff', async () => {
    await repository.agentsKycByState({});
    everyCountHas('agentProfile', workingAgentAccountWhere());
    everyCountHas('agentProfile', { stage: { notIn: ['REJECTED', 'WITHDRAWN', 'EXITED'] } });
    await repository.employeesKycByState();
    everyCountHas('employee', workingEmployeeWhere());
  });
});

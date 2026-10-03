import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026) — erasure completeness, at the query. The
 * person's own name, birth date and gender go, and their contact rows;
 * where the publisher was and the rest of the advertiser's billing address;
 * the agent's addresses, emergency contact, vehicle and coordinates, the
 * application's papers (rows and files) and AgentKyc.digioPayload; the print
 * shop's contact, address and papers; the HR record's papers and its KYC
 * links. `User.erasedAt` is stamped. And the closure that comes first now
 * switches sign-in off with the stamp, takes the shop off the roster, and
 * switches the HR record off.
 */

type AnyFn = (...args: any[]) => any;

const { prisma, tx } = vi.hoisted(() => {
  const tx = {
    user: { update: vi.fn() },
    userContact: { deleteMany: vi.fn() },
    publisher: { update: vi.fn() },
    advertiser: { update: vi.fn() },
    agentProfile: { update: vi.fn() },
    agentDocument: { findMany: vi.fn(), deleteMany: vi.fn() },
    publisherKyc: { findUnique: vi.fn(), update: vi.fn() },
    advertiserKyc: { findFirst: vi.fn(), update: vi.fn() },
    agentKyc: { findUnique: vi.fn(), update: vi.fn() },
    printPartner: { update: vi.fn() },
    printPartnerKyc: { findUnique: vi.fn(), update: vi.fn() },
    employee: { findUnique: vi.fn(), update: vi.fn() },
    employeeKyc: { findUnique: vi.fn(), update: vi.fn() },
    userKyc: { findUnique: vi.fn(), update: vi.fn() },
    uploadedFile: { deleteMany: vi.fn() },
    mobileTombstone: { upsert: vi.fn() },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      user: { update: vi.fn<AnyFn>() },
      printJob: { findMany: vi.fn<AnyFn>() },
      printQuote: { count: vi.fn<AnyFn>() },
      printPartner: { update: vi.fn<AnyFn>() },
      employee: { update: vi.fn<AnyFn>() },
    },
  };
});

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaAccountLifecycleRepository as repository } from '../prisma-account-lifecycle.repository';

const ERASED_AT = new Date('2026-10-02T10:00:00Z');
const plan = {
  userId: 'usr_1',
  userMobile: 'erased:abc',
  mobileHash: 'hash',
  publisher: { id: 'pub_1', mobile: 'erased:abc' },
  advertiser: { id: 'adv_1', mobile: 'erased:abc' },
  agentProfileId: 'agt_1',
  advertiserKycUserId: 'usr_1',
  printPartnerId: 'prt_1',
  employeeId: 'emp_1',
  erasedAt: ERASED_AT,
};

const dataOf = (fn: { mock: { calls: any[][] } }) => fn.mock.calls[0]![0].data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  tx.userContact.deleteMany.mockResolvedValue({ count: 2 });
  tx.agentDocument.findMany.mockResolvedValue([{ url: 'https://files/agt-dl.png' }]);
  tx.publisherKyc.findUnique.mockResolvedValue({ panNumber: 'ABCDE1234F', panFrontUrl: 'https://files/pub-pan.png' });
  tx.advertiserKyc.findFirst.mockResolvedValue({ id: 'akyc_1', panNumber: null, selfieUrl: 'https://files/adv-selfie.png' });
  tx.agentKyc.findUnique.mockResolvedValue({ panNumber: 'ABCDE1234F', govIdFrontUrl: 'https://files/agt-id.png' });
  tx.printPartnerKyc.findUnique.mockResolvedValue({ panNumber: 'ABCDE1234F', gstUrl: 'https://files/prt-gst.png' });
  tx.employee.findUnique.mockResolvedValue({ passportPhotoUrl: 'https://files/emp-photo.png', salarySlipUrls: ['https://files/slip-1.pdf'] });
  tx.employeeKyc.findUnique.mockResolvedValue({ panNumber: null, selfieUrl: 'https://files/emp-selfie.png' });
  tx.userKyc.findUnique.mockResolvedValue(null);
  tx.uploadedFile.deleteMany.mockResolvedValue({ count: 9 });
});

describe('erase() — everything the person was', () => {
  it('the person: names, birth date, gender, contacts, and the moment stamped', async () => {
    const footprint = await repository.erase(plan);
    expect(dataOf(tx.user.update)).toMatchObject({ firstName: null, lastName: null, dateOfBirth: null, gender: null, erasedAt: ERASED_AT, name: 'Erased user', email: null });
    expect(tx.userContact.deleteMany).toHaveBeenCalledWith({ where: { userId: 'usr_1' } });
    expect(footprint.profilesAnonymised).toEqual(expect.arrayContaining(['User', 'UserContact', 'Publisher', 'Advertiser', 'AgentProfile', 'PrintPartner', 'Employee']));
  });

  it('the parties’ addresses and pins', async () => {
    await repository.erase(plan);
    expect(dataOf(tx.publisher.update)).toMatchObject({ latitude: null, longitude: null, postalCode: null });
    expect(dataOf(tx.advertiser.update)).toMatchObject({ postalCode: null, country: null });
    expect(dataOf(tx.agentProfile.update)).toMatchObject({
      currentAddress: null,
      permanentAddress: null,
      emergencyContactName: null,
      emergencyContactRelation: null,
      emergencyContactPhone: null,
      vehicleNumber: null,
      currentLatitude: null,
      currentLongitude: null,
      currentPostalCode: null,
    });
    expect(dataOf(tx.printPartner.update)).toMatchObject({ name: 'ERASED', contactName: null, mobile: 'erased:abc', email: null, address: null, state: null, postalCode: null, latitude: null, longitude: null });
  });

  it('the papers: the agent’s document rows go; every KYC link is blanked, the Digio payloads nulled, PANs masked', async () => {
    const footprint = await repository.erase(plan);
    expect(tx.agentDocument.deleteMany).toHaveBeenCalledWith({ where: { agentId: 'agt_1' } });
    expect(dataOf(tx.agentKyc.update)).toMatchObject({ govIdFrontUrl: null, panNumber: 'XXXXXX234F', digioPayload: expect.anything() });
    expect(dataOf(tx.printPartnerKyc.update)).toMatchObject({ gstUrl: null, panFrontUrl: null, digioPayload: expect.anything() });
    expect(dataOf(tx.employee.update)).toMatchObject({ passportPhotoUrl: null, salarySlipUrls: [], epfFormUrls: [] });
    expect(dataOf(tx.employeeKyc.update)).toMatchObject({ selfieUrl: null, govIdFrontUrl: null });
    expect(tx.advertiserKyc.findFirst).toHaveBeenCalledWith({ where: { OR: [{ advertiserId: 'usr_1' }, { advertiserProfileId: 'adv_1' }] } });
    expect(tx.advertiserKyc.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'akyc_1' } }));
    expect(footprint.kycRecordsMasked).toEqual(expect.arrayContaining(['PublisherKyc', 'AdvertiserKyc', 'AgentDocument', 'AgentKyc', 'PrintPartnerKyc', 'EmployeeKyc']));
  });

  it('the stored files behind every blanked link go with the uploader’s own', async () => {
    await repository.erase(plan);
    const where = tx.uploadedFile.deleteMany.mock.calls[0]![0].where;
    expect(where.OR[0]).toEqual({ userId: 'usr_1', purpose: { in: ['KYC', 'AGENT_KYC', 'AVATAR'] } });
    expect(where.OR[1]).toEqual({ ownerUserId: 'usr_1', purpose: { in: ['KYC', 'AGENT_KYC', 'AVATAR'] } });
    expect(where.OR[2].url.in).toEqual(
      expect.arrayContaining([
        'https://files/agt-dl.png',
        'https://files/pub-pan.png',
        'https://files/adv-selfie.png',
        'https://files/agt-id.png',
        'https://files/prt-gst.png',
        'https://files/emp-photo.png',
        'https://files/slip-1.pdf',
        'https://files/emp-selfie.png',
      ]),
    );
  });
});

describe('the closure that comes first', () => {
  it('closeUser switches sign-in off with the stamp', async () => {
    await repository.closeUser('usr_1', { reason: 'Asked', byUserId: 'usr_admin', at: ERASED_AT });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'usr_1' }, data: { closedAt: ERASED_AT, closeReason: 'Asked', closedById: 'usr_admin', isActive: false } });
  });

  it('a print shop’s work in hand: jobs not collected or cancelled, quotes still submitted', async () => {
    prisma.printJob.findMany.mockResolvedValue([{ id: 'job_1' }]);
    prisma.printQuote.count.mockResolvedValue(3);
    expect(await repository.countOpenPrintWork('prt_1')).toEqual({ jobs: ['job_1'], quotes: 3 });
    expect(prisma.printJob.findMany).toHaveBeenCalledWith({ where: { printPartnerId: 'prt_1', status: { notIn: ['COLLECTED', 'CANCELLED'] } }, select: { id: true } });
  });

  it('the shop off the roster and asking for no quotes; the HR record off', async () => {
    await repository.retirePrintPartner('prt_1');
    expect(prisma.printPartner.update).toHaveBeenCalledWith({ where: { id: 'prt_1' }, data: { isActive: false, acceptsQuoteRequests: false } });
    await repository.deactivateEmployee('emp_1');
    expect(prisma.employee.update).toHaveBeenCalledWith({ where: { id: 'emp_1' }, data: { isActive: false } });
  });
});

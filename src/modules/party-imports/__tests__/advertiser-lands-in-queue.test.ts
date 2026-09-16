import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot S, at the Prisma seam: a committed advertiser row is created by the
 * REAL `advertisers` module — `registerAdvertiser` through
 * `prismaAdvertisersRepository` — so the identifier, the wallet and the
 * brand happen as a console Create, the row carries no kycStatus other than
 * the schema's PENDING default, and the REAL advertiser KYC queue
 * (`GET /advertiser-kyc`, through `kyc`'s public router) lists it as
 * AWAITING_DOCUMENTS the moment it exists (N3-B).
 *
 * The Prisma client is a small in-memory table; everything above it is the
 * production code.
 */

type AnyFn = (...args: any[]) => any;

const { prisma, importRepository, allocateIdentifier, audit } = vi.hoisted(() => {
  const advertisers: Record<string, unknown>[] = [];
  const prisma = {
    advertisers,
    advertiser: {
      create: vi.fn<AnyFn>(async ({ data }: { data: Record<string, unknown> }) => {
        // The schema's defaults, the way Postgres would apply them.
        const row = { id: `adv_${advertisers.length + 1}`, kycStatus: 'PENDING', createdAt: new Date(), userId: null, agentId: null, ...data };
        advertisers.push(row);
        return row;
      }),
      findUnique: vi.fn<AnyFn>(async ({ where }: { where: { mobile?: string; id?: string } }) =>
        advertisers.find((row) => (where.mobile ? row['mobile'] === where.mobile : row['id'] === where.id)) ?? null,
      ),
      findMany: vi.fn<AnyFn>(async () => advertisers.map((row) => ({ ...row, kyc: null }))),
      count: vi.fn<AnyFn>(async () => advertisers.length),
    },
    wallet: { upsert: vi.fn<AnyFn>(async ({ create }: { create: { advertiserId: string } }) => ({ id: `wal_${create.advertiserId}`, ...create })) },
    brand: { create: vi.fn<AnyFn>(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'brand_1', ...data })) },
    user: { findMany: vi.fn<AnyFn>(async () => []) },
  };
  return {
    prisma,
    importRepository: {
      createImport: vi.fn<AnyFn>(),
      listImports: vi.fn<AnyFn>(),
      findImport: vi.fn<AnyFn>(),
      stampRow: vi.fn<AnyFn>(async () => undefined),
      finishCommit: vi.fn<AnyFn>(),
      setStatus: vi.fn<AnyFn>(),
      matchAdvertisers: vi.fn<AnyFn>(),
      matchAgents: vi.fn<AnyFn>(),
      matchPrintPartners: vi.fn<AnyFn>(),
      matchEmployees: vi.fn<AnyFn>(),
      findUserByMobile: vi.fn<AnyFn>(),
    },
    allocateIdentifier: vi.fn<AnyFn>(async () => 'ADV-1509-2601'),
    audit: { logActivity: vi.fn<AnyFn>(), auditDiff: vi.fn<AnyFn>(() => ({})) },
  };
});

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});
vi.mock('../prisma-party-imports.repository', () => ({ prismaPartyImportsRepository: importRepository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier }));
vi.mock('../../../shared/audit', () => audit);
// Lot X-B: Pune is a typed town in this fixture — the key beside it is null.
vi.mock('../../pricing', () => ({
  resolveCity: async () => null,
  cityKeyFor: async () => null,
  withCityKey: async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: null }),
}));
vi.mock('../../auth', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../auth')>()), normalizeMobile: (m: string) => m }));
vi.mock('../../app-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app-config')>()),
  getPlatformSettings: async () => ({ kyc: { reviewSlaHours: 48 } }),
}));

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { commitImport } from '../party-imports.service';
import { advertiserKycRouter } from '../../kyc';

function desk() {
  const instance = express();
  instance.use(express.json());
  const api = express.Router();
  api.use('/advertiser-kyc', advertiserKycRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.advertisers.length = 0;
  importRepository.matchAdvertisers.mockResolvedValue({ byMobile: [], byPan: new Map(), byGstin: new Map(), blockedMobiles: new Map(), takenEmails: new Map() });
  importRepository.finishCommit.mockImplementation(async (id: string, counts: Record<string, number>) => ({ id, status: 'COMMITTED', fileName: 'book.csv', ...counts, rows: [] }));
});

describe('a committed advertiser lands PENDING, through the real module, and is in its KYC queue', () => {
  it('creates the row with no kycStatus over the default, the identifier, the wallet and the brand — and the queue lists it AWAITING_DOCUMENTS', async () => {
    importRepository.findImport.mockResolvedValue({
      id: 'imp_1',
      party: 'ADVERTISER',
      status: 'VALIDATED',
      fileName: 'book.csv',
      rows: [
        {
          id: 'r0',
          rowNumber: 2,
          outcome: 'CREATED',
          targetId: null,
          message: null,
          data: { mobile: '+919000000001', name: 'Fresh', companyName: 'Fresh Co', type: 'COMMERCIAL', city: 'Pune', plan: { action: 'CREATE', warnings: [] } },
        },
      ],
    });

    const committed = await commitImport('advertisers', 'imp_1', 'usr_admin');
    expect(committed).toMatchObject({ status: 'COMMITTED', createdCount: 1 });

    // The console's Create, exactly: one advertiser row with the minted identifier and no kycStatus written.
    expect(prisma.advertiser.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.advertiser.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({ mobile: '+919000000001', name: 'Fresh', companyName: 'Fresh Co', type: 'COMMERCIAL', city: 'Pune', cityId: null, displayId: 'ADV-1509-2601', userId: null, agentId: null });
    expect(data).not.toHaveProperty('kycStatus');
    expect(allocateIdentifier).toHaveBeenCalledWith('ADVERTISER');
    expect(prisma.wallet.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { advertiserId: 'adv_1' } }));
    expect(prisma.brand.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ advertiserId: 'adv_1', name: 'Fresh Co' }) }));

    // The row as it lands: PENDING, and stamped on the import row.
    expect(prisma.advertisers[0]).toMatchObject({ id: 'adv_1', kycStatus: 'PENDING' });
    expect(importRepository.stampRow).toHaveBeenCalledWith('r0', expect.objectContaining({ targetId: 'adv_1', outcome: 'CREATED' }));

    // The queue, read the way the desk reads it — through kyc's own router: the party is there, awaiting documents.
    const queue = await request(desk()).get('/api/v1/advertiser-kyc').set('Authorization', `Bearer ${tokenFor(['ADMIN'], 'usr_admin')}`);
    expect(queue.status).toBe(200);
    expect(queue.body.data.total).toBe(1);
    expect(queue.body.data.items[0]).toMatchObject({ state: 'AWAITING_DOCUMENTS', kycId: null, party: { id: 'adv_1', displayId: 'ADV-1509-2601', kycStatus: 'PENDING' } });
    // And the read asked for the queue's base filter — every not-yet-verified party — not a bare table scan.
    const calls = prisma.advertiser.findMany.mock.calls as [{ where: { AND: unknown[] } }][];
    expect(calls[calls.length - 1]![0].where.AND.length).toBeGreaterThan(0);

    // Audited as a creation, naming the import and the row.
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'ADVERTISER_CREATED', expect.objectContaining({ targetType: 'Advertiser', targetId: 'adv_1', metadata: expect.objectContaining({ importId: 'imp_1', rowNumber: 2 }) }));
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The party display-id backfill (`npm run backfill:party-ids`).
 *
 * Pinned: `check` counts and never reaches the allocator (which consumes a
 * counter) nor writes a row; a write issues each kind its own series —
 * PARTNER for a print partner — oldest first, dated to each row's own
 * `createdAt`; a row that already has an id is left alone; a second run
 * issues nothing; a write that does not land cannot loop.
 *
 * The allocator is the real one; only its Prisma repository is replaced, by
 * an in-memory store with an in-memory daily counter.
 */

type Row = { id: string; createdAt: Date; displayId: string | null };
type Kind = 'PUBLISHER' | 'ADVERTISER' | 'PARTNER' | 'AGENT' | 'USER' | 'ORDER';

const { store, repository } = vi.hoisted(() => {
  const store = {
    tables: { PUBLISHER: [], ADVERTISER: [], PARTNER: [], AGENT: [], USER: [], ORDER: [] } as Record<Kind, Row[]>,
    formats: new Map<string, Record<string, unknown>>(),
    counters: new Map<string, number>(),
  };
  const pending = (kind: Kind) => store.tables[kind].filter((row) => row.displayId === null).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const missing = (kind: Kind) => async (limit: number) => pending(kind).slice(0, limit).map(({ id, createdAt }) => ({ id, createdAt }));
  const set = (kind: Kind) => async (id: string, displayId: string) => {
    store.tables[kind].find((row) => row.id === id)!.displayId = displayId;
  };
  const repository = {
    findFormat: vi.fn(async (party: string) => store.formats.get(party) ?? null),
    listFormats: vi.fn(async () => [...store.formats.values()]),
    createFormat: vi.fn(async (data: Record<string, unknown>) => {
      const row = { id: `fmt_${String(data['party'])}`, ...data };
      store.formats.set(String(data['party']), row);
      return row;
    }),
    updateFormat: vi.fn(),
    nextSequence: vi.fn(async (party: string, dateKey: string) => {
      const key = `${party}:${dateKey}`;
      const next = (store.counters.get(key) ?? 0) + 1;
      store.counters.set(key, next);
      return next;
    }),
    publishersMissingIdentifier: vi.fn(missing('PUBLISHER')),
    setPublisherIdentifier: vi.fn(set('PUBLISHER')),
    advertisersMissingIdentifier: vi.fn(missing('ADVERTISER')),
    setAdvertiserIdentifier: vi.fn(set('ADVERTISER')),
    printPartnersMissingIdentifier: vi.fn(missing('PARTNER')),
    setPrintPartnerIdentifier: vi.fn(set('PARTNER')),
    agentsMissingIdentifier: vi.fn(missing('AGENT')),
    setAgentIdentifier: vi.fn(set('AGENT')),
    usersMissingIdentifier: vi.fn(missing('USER')),
    setUserIdentifier: vi.fn(set('USER')),
    ordersMissingIdentifier: vi.fn(missing('ORDER')),
    setOrderIdentifier: vi.fn(set('ORDER')),
    missingIdentifierSummary: vi.fn(async (party: Kind) => {
      const rows = pending(party);
      return { count: rows.length, oldest: rows[0]?.createdAt ?? null, newest: rows[rows.length - 1]?.createdAt ?? null };
    }),
  };
  return { store, repository };
});

vi.mock('../prisma-identifiers.repository', () => ({ prismaIdentifiersRepository: repository }));

import { backfillPartyIdentifiers, backfillPublisherIdentifiers, IDENTIFIED_PARTIES } from '../identifiers.backfill';

const SETTERS = ['setPublisherIdentifier', 'setAdvertiserIdentifier', 'setPrintPartnerIdentifier', 'setAgentIdentifier', 'setUserIdentifier', 'setOrderIdentifier'] as const;
const writes = () => SETTERS.reduce((sum, name) => sum + repository[name].mock.calls.length, 0);
const ids = (kind: Kind) => Object.fromEntries(store.tables[kind].map((row) => [row.id, row.displayId]));

// All in IST (the default format's zone): 18 Sep 11:30, 19 Sep 09:00, 19 Sep 10:00.
const SEP18_1130 = new Date('2026-09-18T06:00:00Z');
const SEP19_0900 = new Date('2026-09-19T03:30:00Z');
const SEP19_1000 = new Date('2026-09-19T04:30:00Z');

/** Three rows per kind, inserted newest-first so the order has to come from the backfill. */
function seedAll() {
  for (const kind of Object.keys(store.tables) as Kind[]) {
    const p = kind.toLowerCase();
    store.tables[kind] = [
      { id: `${p}_c`, createdAt: SEP19_1000, displayId: null },
      { id: `${p}_a`, createdAt: SEP18_1130, displayId: null },
      { id: `${p}_b`, createdAt: SEP19_0900, displayId: null },
    ];
  }
}

beforeEach(() => {
  for (const kind of Object.keys(store.tables) as Kind[]) store.tables[kind] = [];
  store.formats.clear();
  store.counters.clear();
  vi.clearAllMocks();
});

describe('backfillPartyIdentifiers — check', () => {
  it('counts every kind and issues nothing: no allocator, no counter, no write', async () => {
    seedAll();
    store.tables.PARTNER.push({ id: 'partner_named', createdAt: SEP18_1130, displayId: 'PRT-1809-2601' });

    for (const party of IDENTIFIED_PARTIES) {
      const report = await backfillPartyIdentifiers(party, { check: true });
      expect(report).toEqual({ party, missing: 3, oldest: SEP18_1130, newest: SEP19_1000, assigned: 0, remaining: 3 });
    }

    expect(repository.nextSequence).not.toHaveBeenCalled();
    expect(repository.findFormat).not.toHaveBeenCalled();
    expect(repository.createFormat).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
    for (const party of IDENTIFIED_PARTIES) expect(store.tables[party].filter((row) => row.id !== 'partner_named').every((row) => row.displayId === null)).toBe(true);
    expect(store.counters.size).toBe(0);
  });

  it('reports an empty series as nothing to do', async () => {
    expect(await backfillPartyIdentifiers('AGENT', { check: true })).toEqual({ party: 'AGENT', missing: 0, oldest: null, newest: null, assigned: 0, remaining: 0 });
  });
});

describe('backfillPartyIdentifiers — write', () => {
  it.each([
    ['PUBLISHER', 'PUB', 'setPublisherIdentifier'],
    ['ADVERTISER', 'ADV', 'setAdvertiserIdentifier'],
    ['PARTNER', 'PRT', 'setPrintPartnerIdentifier'],
    ['AGENT', 'AGT', 'setAgentIdentifier'],
    ['USER', 'ADX', 'setUserIdentifier'],
  ] as const)('%s: oldest first, dated to each row’s own createdAt, on its own series', async (party, prefix, setter) => {
    seedAll();

    const report = await backfillPartyIdentifiers(party);

    expect(report).toMatchObject({ party, missing: 3, assigned: 3, remaining: 0 });
    const p = party.toLowerCase();
    expect(ids(party)).toEqual({
      [`${p}_a`]: `${prefix}-1809-2601`,
      [`${p}_b`]: `${prefix}-1909-2601`,
      [`${p}_c`]: `${prefix}-1909-2602`,
    });
    // Oldest asks first, and each on its own day's counter under its own party type.
    expect(repository[setter].mock.calls.map(([id]) => id)).toEqual([`${p}_a`, `${p}_b`, `${p}_c`]);
    expect(repository.nextSequence.mock.calls).toEqual([
      [party, '2026-09-18'],
      [party, '2026-09-19'],
      [party, '2026-09-19'],
    ]);
    // No other kind was touched.
    expect(writes()).toBe(3);
    for (const other of Object.keys(store.tables) as Kind[]) {
      if (other !== party) expect(store.tables[other].every((row) => row.displayId === null)).toBe(true);
    }
  });

  it('a print partner is issued on the PARTNER series', async () => {
    store.tables.PARTNER = [{ id: 'suraj', createdAt: SEP19_0900, displayId: null }];
    await backfillPartyIdentifiers('PARTNER');
    expect(repository.createFormat).toHaveBeenCalledWith(expect.objectContaining({ party: 'PARTNER', prefix: 'PRT' }));
    expect(repository.nextSequence).toHaveBeenCalledWith('PARTNER', '2026-09-19');
    expect(ids('PARTNER')).toEqual({ suraj: 'PRT-1909-2601' });
  });

  it('leaves a row that already has an identifier alone, and continues that day’s count', async () => {
    store.tables.PUBLISHER = [
      { id: 'held', createdAt: SEP19_0900, displayId: 'PUB-1909-2601' },
      { id: 'late', createdAt: SEP19_1000, displayId: null },
    ];
    store.counters.set('PUBLISHER:2026-09-19', 1);

    const report = await backfillPartyIdentifiers('PUBLISHER');

    expect(report).toMatchObject({ missing: 1, assigned: 1, remaining: 0 });
    expect(ids('PUBLISHER')).toEqual({ held: 'PUB-1909-2601', late: 'PUB-1909-2602' });
    expect(repository.setPublisherIdentifier).toHaveBeenCalledTimes(1);
  });

  it('works through more rows than one batch, still oldest first', async () => {
    store.tables.ADVERTISER = [4, 2, 0, 3, 1].map((hour) => ({ id: `adv_${hour}`, createdAt: new Date(Date.UTC(2026, 8, 19, hour)), displayId: null }));

    const report = await backfillPartyIdentifiers('ADVERTISER', { batchSize: 2 });

    expect(report).toMatchObject({ missing: 5, assigned: 5, remaining: 0 });
    expect(repository.setAdvertiserIdentifier.mock.calls.map(([id]) => id)).toEqual(['adv_0', 'adv_1', 'adv_2', 'adv_3', 'adv_4']);
    expect(ids('ADVERTISER')['adv_4']).toBe('ADV-1909-2605');
  });

  it('is idempotent: a second run issues nothing', async () => {
    seedAll();
    for (const party of IDENTIFIED_PARTIES) await backfillPartyIdentifiers(party);
    const first = { ...Object.fromEntries(IDENTIFIED_PARTIES.map((party) => [party, ids(party)])) };
    vi.clearAllMocks();

    for (const party of IDENTIFIED_PARTIES) {
      expect(await backfillPartyIdentifiers(party)).toEqual({ party, missing: 0, oldest: null, newest: null, assigned: 0, remaining: 0 });
    }
    expect(repository.nextSequence).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
    expect(Object.fromEntries(IDENTIFIED_PARTIES.map((party) => [party, ids(party)]))).toEqual(first);
  });

  it('a write that does not land cannot loop: it stops at the rows it began with', async () => {
    seedAll();
    const lost = async () => undefined;
    repository.setAgentIdentifier.mockImplementationOnce(lost).mockImplementationOnce(lost).mockImplementationOnce(lost);

    const report = await backfillPartyIdentifiers('AGENT', { batchSize: 2 });

    expect(report).toMatchObject({ missing: 3, assigned: 3, remaining: 3 });
    expect(repository.setAgentIdentifier).toHaveBeenCalledTimes(3);
  });

  it('refuses a batch size that is not a positive integer', async () => {
    await expect(backfillPartyIdentifiers('USER', { batchSize: 0 })).rejects.toThrow(RangeError);
  });
});

describe('the existing publisher backfill', () => {
  it('still issues one batch and says whether any remain', async () => {
    seedAll();
    expect(await backfillPublisherIdentifiers(2)).toEqual({ assigned: 2, remaining: 1 });
    expect(await backfillPublisherIdentifiers()).toEqual({ assigned: 1, remaining: 0 });
    expect(ids('PUBLISHER')).toEqual({ publisher_a: 'PUB-1809-2601', publisher_b: 'PUB-1909-2601', publisher_c: 'PUB-1909-2602' });
  });
});

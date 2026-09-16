import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIST_PAGE_SIZE,
  MAX_LIST_PAGE_SIZE,
  countsFrom,
  listArgs,
  listQuerySchema,
  toListPage,
} from '../list-page';

const STATUSES = ['DRAFT', 'LIVE', 'ENDED'] as const;
const SORTS = ['NEWEST', 'PRICE_ASC', 'NAME'] as const;

const schema = listQuerySchema(STATUSES, SORTS);

describe('listQuerySchema', () => {
  it('defaults page, pageSize and sort so a bare request is still bounded', () => {
    const parsed = schema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(DEFAULT_LIST_PAGE_SIZE);
    expect(parsed.sort).toBe('NEWEST');
    expect(parsed.status).toBeUndefined();
    expect(parsed.q).toBeUndefined();
  });

  it('reads status as a comma list, which is how the chips arrive', () => {
    expect(schema.parse({ status: 'LIVE,ENDED' }).status).toEqual(['LIVE', 'ENDED']);
    expect(schema.parse({ status: 'LIVE' }).status).toEqual(['LIVE']);
  });

  it('refuses a status outside the enum rather than passing it to the database', () => {
    // GET /orders takes `z.string()` today and casts it `as any`, so a typo
    // reaches Postgres as an invalid enum and surfaces as a 500. This is the
    // whole reason the status facet is parsed against the module's own list.
    const bad = schema.safeParse({ status: 'LIVE,NONSENSE' });
    expect(bad.success).toBe(false);
  });

  it('refuses a sort key the module did not declare', () => {
    expect(schema.safeParse({ sort: 'PRICE_DESC' }).success).toBe(false);
    expect(schema.safeParse({ sort: 'PRICE_ASC' }).success).toBe(true);
  });

  it('trims the search term and drops an empty one', () => {
    expect(schema.parse({ q: '  mg road  ' }).q).toBe('mg road');
    expect(schema.safeParse({ q: '   ' }).success).toBe(false);
  });

  it('caps pageSize so ?pageSize=100000 cannot ask for the table', () => {
    expect(schema.safeParse({ pageSize: String(MAX_LIST_PAGE_SIZE + 1) }).success).toBe(false);
    expect(schema.parse({ pageSize: '50' }).pageSize).toBe(50);
  });

  it('refuses page 0 and negative pages', () => {
    expect(schema.safeParse({ page: '0' }).success).toBe(false);
    expect(schema.safeParse({ page: '-1' }).success).toBe(false);
  });
});

describe('listArgs', () => {
  it('turns a page into skip and take', () => {
    expect(listArgs({ page: 1, pageSize: 20 })).toEqual({ skip: 0, take: 20 });
    expect(listArgs({ page: 3, pageSize: 20 })).toEqual({ skip: 40, take: 20 });
  });
});

describe('countsFrom', () => {
  it('folds a Prisma groupBy into a status histogram', () => {
    const groups = [
      { status: 'LIVE', _count: { _all: 12 } },
      { status: 'DRAFT', _count: { _all: 7 } },
    ];
    expect(countsFrom(groups, STATUSES)).toEqual({ DRAFT: 7, LIVE: 12, ENDED: 0 });
  });

  it('reports every declared status, so a chip with no rows still reads 0 rather than vanishing', () => {
    expect(countsFrom([], STATUSES)).toEqual({ DRAFT: 0, LIVE: 0, ENDED: 0 });
  });
});

describe('toListPage', () => {
  it('carries the page whole — items, total and the chip counts together', () => {
    const page = toListPage(['a', 'b'], 42, { DRAFT: 7, LIVE: 12, ENDED: 23 }, { page: 2, pageSize: 2 });
    expect(page).toEqual({
      items: ['a', 'b'],
      total: 42,
      page: 2,
      pageSize: 2,
      counts: { DRAFT: 7, LIVE: 12, ENDED: 23 },
    });
  });

  it('reports an empty page honestly rather than as a missing one', () => {
    const page = toListPage([], 0, { DRAFT: 0, LIVE: 0, ENDED: 0 }, { page: 1, pageSize: 20 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });
});

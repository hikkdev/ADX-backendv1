import express, { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * HC-1 (1 Oct 2026) — the Holidays page follows a public calendar.
 *
 * What is pinned: the feed is unfolded and unescaped, and each day is
 * classified (Public holiday → PUBLIC, Observance → OPTIONAL, "Date is
 * tentative" → tentative); observances come in only when the setting says
 * so; a re-sync writes nothing; a person's own entry wins and the old boot
 * seed's rows are adopted; two events on one day share the row; a hidden
 * calendar row stays hidden; an edited calendar row turns MANUAL and the
 * sync leaves it alone; and a feed that cannot be read changes nothing.
 * `fetch` is stubbed throughout — nothing leaves the test.
 */

type Row = {
  id: string;
  date: Date;
  name: string;
  region: string | null;
  kind: 'PUBLIC' | 'OPTIONAL';
  source: 'MANUAL' | 'CALENDAR';
  externalId: string | null;
  tentative: boolean;
  hiddenAt: Date | null;
  createdAt: Date;
};

const { table, repository, state, calendarConfig, employees, agents, audit } = vi.hoisted(() => {
  const table: { rows: Row[]; seq: number } = { rows: [], seq: 0 };
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const byDate = (a: Row, b: Row) => a.date.getTime() - b.date.getTime();
  const repository = {
    findHolidaysInYear: vi.fn(async (year: number) =>
      table.rows.filter((r) => r.date.getUTCFullYear() === year && !r.hiddenAt).sort(byDate),
    ),
    findHolidaysInRange: vi.fn(async (from: Date, to: Date) =>
      table.rows.filter((r) => r.date >= from && r.date <= to && !r.hiddenAt).sort(byDate),
    ),
    findHolidayById: vi.fn(async (id: string) => table.rows.find((r) => r.id === id) ?? null),
    findHolidayOn: vi.fn(async (date: Date, region: string | null) =>
      table.rows.find((r) => iso(r.date) === iso(date) && r.region === region) ?? null,
    ),
    createHoliday: vi.fn(async (data: Partial<Row> & { date: Date; name: string; region: string | null; kind: Row['kind'] }) => {
      if (data.externalId && table.rows.some((r) => r.source === (data.source ?? 'MANUAL') && r.externalId === data.externalId)) {
        throw new Error('Unique constraint failed on (source, externalId)');
      }
      table.seq += 1;
      const row: Row = {
        id: `hol_${table.seq}`,
        source: 'MANUAL',
        externalId: null,
        tentative: false,
        hiddenAt: null,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        ...data,
      };
      table.rows.push(row);
      return { ...row };
    }),
    updateHoliday: vi.fn(async (id: string, data: Partial<Row>) => {
      const row = table.rows.find((r) => r.id === id);
      if (!row) throw new Error('Record to update not found');
      Object.assign(row, data);
      return { ...row };
    }),
    removeHoliday: vi.fn(async (id: string) => {
      const row = table.rows.find((r) => r.id === id)!;
      table.rows = table.rows.filter((r) => r.id !== id);
      return row;
    }),
    findAllHolidaysBetween: vi.fn(async (from: Date, to: Date) => table.rows.filter((r) => r.date >= from && r.date <= to).map((r) => ({ ...r }))),
    findHolidaysByExternalIds: vi.fn(async (ids: string[]) => table.rows.filter((r) => r.externalId && ids.includes(r.externalId)).map((r) => ({ ...r }))),
    countCalendarHolidaysInYear: vi.fn(async (year: number) =>
      table.rows.filter((r) => r.source === 'CALENDAR' && r.date.getUTCFullYear() === year).length,
    ),
  };
  const state: { value: Record<string, unknown> | null } = { value: null };
  return {
    table,
    repository,
    state,
    calendarConfig: { getEffectiveHolidayCalendarConfig: vi.fn() },
    employees: { listActiveEmployeesForDirectory: vi.fn(), findEmployeeByUserId: vi.fn() },
    agents: { listActiveAgentsForDirectory: vi.fn(), findAgentProfile: vi.fn() },
    audit: { logActivity: vi.fn() },
  };
});

vi.mock('../prisma-hr.repository', () => ({ prismaHrRepository: repository }));
vi.mock('../../app-config', () => ({
  getConfigObject: vi.fn(async () => state.value),
  saveConfigObject: vi.fn(async (_key: string, value: Record<string, unknown>) => {
    state.value = value;
    return value;
  }),
}));
vi.mock('../../../shared/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations')>();
  return { ...actual, ...calendarConfig };
});
vi.mock('../../employees', () => employees);
vi.mock('../../agents', () => agents);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { HOLIDAY_CALENDAR_DEFAULT_URL } from '../../../shared/integrations';
import { hrRouter } from '../hr.routes';
import { parseHolidayCalendar, unescapeText, unfoldLines } from '../holiday-calendar.parser';
import {
  HolidayCalendarUnavailableError,
  ensureHolidayCalendar,
  readHolidaySyncState,
  runScheduledHolidaySync,
  syncHolidayCalendar,
  syncYears,
} from '../holiday-calendar.service';

/**
 * An excerpt of Google's "Holidays in India" feed as fetched on 1 Oct 2026 —
 * CRLF line ends, the observance descriptions folded onto a second line
 * (CRLF + space) and escaped (`\n`, `\,`), two 2027 days marked tentative.
 */
const VEVENT = (lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const OBSERVANCE = [
  String.raw`DESCRIPTION:Observance\nTo hide observances\, go to Google Calendar Setting`,
  ' s > Holidays in India',
];
const FIXTURE = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:Holidays in India',
  'X-WR-TIMEZONE:UTC',
  ...VEVENT([
    'DTSTART;VALUE=DATE:20260126',
    'DTEND;VALUE=DATE:20260127',
    'UID:20260126_c26069b49o94ht7eclvg5pi030@google.com',
    'CLASS:PUBLIC',
    'DESCRIPTION:Public holiday',
    'STATUS:CONFIRMED',
    'SUMMARY:Republic Day',
    'TRANSP:TRANSPARENT',
  ]),
  ...VEVENT([
    'DTSTART;VALUE=DATE:20260321',
    'DTEND;VALUE=DATE:20260322',
    'UID:20260321_t5cv5mdng4bd0btbsf7fie6h80@google.com',
    'DESCRIPTION:Public holiday',
    'STATUS:CONFIRMED',
    'SUMMARY:Ramzan Id',
  ]),
  ...VEVENT([
    'DTSTART;VALUE=DATE:20260414',
    'DTEND;VALUE=DATE:20260415',
    'UID:20260414_0li1u1l16c065vkseuim4g71b8@google.com',
    ...OBSERVANCE,
    'STATUS:CONFIRMED',
    'SUMMARY:Vaisakhi',
  ]),
  ...VEVENT([
    'DTSTART;VALUE=DATE:20260414',
    'DTEND;VALUE=DATE:20260415',
    'UID:20260414_2ir59ab3vf0v8evqcn61tv6tng@google.com',
    'DESCRIPTION:Public holiday',
    'STATUS:CONFIRMED',
    'SUMMARY:Ambedkar Jayanti',
  ]),
  ...VEVENT([
    'DTSTART;VALUE=DATE:20260414',
    'DTEND;VALUE=DATE:20260415',
    'UID:20260414_g60k0bi4jlb403hs8dr2ur7ea8@google.com',
    ...OBSERVANCE,
    'STATUS:CONFIRMED',
    'SUMMARY:Vishu',
  ]),
  ...VEVENT([
    'DTSTART;VALUE=DATE:20270209',
    'DTEND;VALUE=DATE:20270210',
    'UID:20270209_aahi2e9puucb8ul8rps6555r00@google.com',
    String.raw`DESCRIPTION:Observance\nTo hide observances\, go to Google Calendar Setting`,
    String.raw` s > Holidays in India\nDate is tentative and may change.`,
    'STATUS:CONFIRMED',
    'SUMMARY:Ramadan Start (tentative)',
  ]),
  ...VEVENT([
    'DTSTART;VALUE=DATE:20270310',
    'DTEND;VALUE=DATE:20270311',
    'UID:20270310_2h899vh3h8hdotv5gea8gerksk@google.com',
    String.raw`DESCRIPTION:Public holiday\nDate is tentative and may change.`,
    'STATUS:CONFIRMED',
    'SUMMARY:Ramzan Id (tentative)',
  ]),
  'END:VCALENDAR',
  '',
].join('\r\n');

const UID = {
  republic: '20260126_c26069b49o94ht7eclvg5pi030@google.com',
  ramzan: '20260321_t5cv5mdng4bd0btbsf7fie6h80@google.com',
  ambedkar: '20260414_2ir59ab3vf0v8evqcn61tv6tng@google.com',
};
const YEARS = [2026, 2027];

const fetchMock = vi.fn();
let feed = FIXTURE;

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/hr', hrRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}
const admin = tokenFor(['ADMIN'], 'adm_1');

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const rowOn = (iso: string) => table.rows.find((r) => r.date.toISOString().startsWith(iso));
const manual = (iso: string, name: string, over: Partial<Row> = {}): Row => {
  table.seq += 1;
  const row: Row = {
    id: `hol_${table.seq}`,
    date: day(iso),
    name,
    region: null,
    kind: 'PUBLIC',
    source: 'MANUAL',
    externalId: null,
    tentative: false,
    hiddenAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
  table.rows.push(row);
  return row;
};
const config = (over: Record<string, unknown> = {}) =>
  calendarConfig.getEffectiveHolidayCalendarConfig.mockResolvedValue({
    enabled: true,
    url: HOLIDAY_CALENDAR_DEFAULT_URL,
    includeObservances: false,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  table.rows = [];
  table.seq = 0;
  state.value = null;
  feed = FIXTURE;
  config();
  fetchMock.mockImplementation(async () => new Response(feed, { status: 200, headers: { 'content-type': 'text/calendar' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading the feed', () => {
  it('unfolds continued lines and undoes the escapes', () => {
    expect(unfoldLines('DESCRIPTION:Observance\\nGo to Google Calendar Setting\r\n s > Holidays\r\nSUMMARY:X')).toEqual([
      'DESCRIPTION:Observance\\nGo to Google Calendar Settings > Holidays',
      'SUMMARY:X',
    ]);
    expect(unescapeText(String.raw`Observance\nTo hide observances\, go\; now \\ done`)).toBe('Observance\nTo hide observances, go; now \\ done');
  });

  it('classifies each day: Public holiday → PUBLIC, Observance → OPTIONAL, tentative where the feed says so', () => {
    const events = parseHolidayCalendar(FIXTURE);
    expect(events).toHaveLength(7);
    expect(events[0]).toEqual({ uid: UID.republic, date: '2026-01-26', name: 'Republic Day', kind: 'PUBLIC', observance: false, tentative: false });
    expect(events.find((e) => e.name === 'Vaisakhi')).toMatchObject({ kind: 'OPTIONAL', observance: true, tentative: false });
    // "(tentative)" leaves the name — the badge carries it.
    expect(events.find((e) => e.date === '2027-02-09')).toMatchObject({ name: 'Ramadan Start', kind: 'OPTIONAL', tentative: true });
    expect(events.find((e) => e.date === '2027-03-10')).toMatchObject({ name: 'Ramzan Id', kind: 'PUBLIC', tentative: true });
  });

  it('refuses text that is not a calendar', () => {
    expect(() => parseHolidayCalendar('<html>Sign in</html>')).toThrow('did not return a calendar');
  });

  it('defaults to this year and next in India', () => {
    // 31 Dec 2026, 19:00 UTC is already 1 Jan 2027 in India.
    expect(syncYears(undefined, new Date('2026-12-31T19:00:00.000Z'))).toEqual([2027, 2028]);
    expect(syncYears([2027, 2026, 2027], new Date())).toEqual([2026, 2027]);
  });
});

describe('syncHolidayCalendar', () => {
  it('brings the public holidays in, observances left out by default', async () => {
    const result = await syncHolidayCalendar({ years: YEARS });
    expect(fetchMock).toHaveBeenCalledWith(HOLIDAY_CALENDAR_DEFAULT_URL, expect.objectContaining({ signal: expect.anything() }));
    expect(result).toEqual({ added: 4, updated: 0, adopted: 0, skipped: 0, years: YEARS });
    expect(rowOn('2026-04-14')).toMatchObject({ name: 'Ambedkar Jayanti', kind: 'PUBLIC', source: 'CALENDAR', externalId: UID.ambedkar });
    expect(rowOn('2027-03-10')).toMatchObject({ name: 'Ramzan Id', kind: 'PUBLIC', tentative: true });
    expect(rowOn('2027-02-09')).toBeUndefined();
    expect(await readHolidaySyncState()).toMatchObject({ added: 4, error: null, years: YEARS });
  });

  it('brings observances in as OPTIONAL when the setting is on; two events one day share the row, PUBLIC first', async () => {
    config({ includeObservances: true });
    const result = await syncHolidayCalendar({ years: YEARS });
    expect(result.added).toBe(5);
    expect(rowOn('2026-04-14')).toMatchObject({ name: 'Ambedkar Jayanti · Vaisakhi · Vishu', kind: 'PUBLIC', externalId: UID.ambedkar });
    expect(rowOn('2027-02-09')).toMatchObject({ name: 'Ramadan Start', kind: 'OPTIONAL', tentative: true });
  });

  it('only syncs the years asked', async () => {
    const result = await syncHolidayCalendar({ years: [2027] });
    expect(result.added).toBe(1);
    expect(rowOn('2026-01-26')).toBeUndefined();
  });

  it('writes nothing the second time', async () => {
    config({ includeObservances: true });
    await syncHolidayCalendar({ years: YEARS });
    repository.createHoliday.mockClear();
    repository.updateHoliday.mockClear();
    const again = await syncHolidayCalendar({ years: YEARS });
    expect(again).toEqual({ added: 0, updated: 0, adopted: 0, skipped: 0, years: YEARS });
    expect(repository.createHoliday).not.toHaveBeenCalled();
    expect(repository.updateHoliday).not.toHaveBeenCalled();
  });

  it('follows the feed when an event changes: name, date, kind, tentative', async () => {
    await syncHolidayCalendar({ years: YEARS });
    feed = FIXTURE.replace('SUMMARY:Republic Day', 'SUMMARY:Republic Day (77th)').replace(
      String.raw`DESCRIPTION:Public holiday\nDate is tentative and may change.`,
      'DESCRIPTION:Public holiday',
    ).replace('SUMMARY:Ramzan Id (tentative)', 'SUMMARY:Ramzan Id').replace('DTSTART;VALUE=DATE:20270310', 'DTSTART;VALUE=DATE:20270311');
    const result = await syncHolidayCalendar({ years: YEARS });
    expect(result).toMatchObject({ added: 0, updated: 2 });
    expect(rowOn('2026-01-26')?.name).toBe('Republic Day (77th)');
    expect(rowOn('2027-03-10')).toBeUndefined();
    expect(rowOn('2027-03-11')).toMatchObject({ name: 'Ramzan Id', tentative: false });
  });

  it("leaves a person's own entry alone and counts it skipped", async () => {
    manual('2026-01-26', 'Republic Day — office closed');
    const result = await syncHolidayCalendar({ years: YEARS });
    expect(result).toMatchObject({ added: 3, skipped: 1 });
    expect(rowOn('2026-01-26')).toMatchObject({ name: 'Republic Day — office closed', source: 'MANUAL', externalId: null });
  });

  it("adopts the old boot seed's rows (date and name in HOLIDAYS_2026, any case)", async () => {
    manual('2026-03-21', 'Id-ul-Fitr');
    manual('2026-01-26', 'REPUBLIC DAY');
    const result = await syncHolidayCalendar({ years: YEARS });
    expect(result).toMatchObject({ added: 2, adopted: 2, skipped: 0 });
    expect(rowOn('2026-03-21')).toMatchObject({ name: 'Ramzan Id', source: 'CALENDAR', externalId: UID.ramzan });
    expect(table.rows).toHaveLength(4);
  });

  it('shares a day another calendar row already holds, PUBLIC winning over OPTIONAL', async () => {
    manual('2026-04-14', 'Tamil New Year', { source: 'CALENDAR', externalId: 'other-feed-uid', kind: 'OPTIONAL' });
    const result = await syncHolidayCalendar({ years: YEARS });
    expect(result).toMatchObject({ added: 3, updated: 1 });
    expect(rowOn('2026-04-14')).toMatchObject({ name: 'Ambedkar Jayanti · Tamil New Year', kind: 'PUBLIC', externalId: 'other-feed-uid' });
    const again = await syncHolidayCalendar({ years: YEARS });
    expect(again).toMatchObject({ added: 0, updated: 0 });
  });

  it('never deletes: a calendar row whose event left the feed stays', async () => {
    manual('2026-05-01', 'Buddha Purnima', { source: 'CALENDAR', externalId: 'gone-from-feed' });
    await syncHolidayCalendar({ years: YEARS });
    expect(rowOn('2026-05-01')).toMatchObject({ name: 'Buddha Purnima', source: 'CALENDAR' });
    expect(repository.removeHoliday).not.toHaveBeenCalled();
  });

  it('changes nothing when the feed cannot be fetched, and records the error', async () => {
    manual('2026-03-21', 'Id-ul-Fitr');
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(syncHolidayCalendar({ years: YEARS })).rejects.toBeInstanceOf(HolidayCalendarUnavailableError);
    expect(repository.createHoliday).not.toHaveBeenCalled();
    expect(repository.updateHoliday).not.toHaveBeenCalled();
    expect(rowOn('2026-03-21')).toMatchObject({ name: 'Id-ul-Fitr', source: 'MANUAL' });
    expect(await readHolidaySyncState()).toMatchObject({ error: 'The calendar could not be reached.', added: 0 });

    fetchMock.mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    await expect(syncHolidayCalendar({ years: YEARS })).rejects.toThrow('HTTP 404');
    fetchMock.mockResolvedValueOnce(new Response('<html></html>', { status: 200 }));
    await expect(syncHolidayCalendar({ years: YEARS })).rejects.toThrow('did not return a calendar');
    expect(table.rows).toHaveLength(1);
  });
});

describe('the page: hidden rows and edited rows', () => {
  it('a deleted calendar row is hidden, left off the list, and stays hidden through the next sync', async () => {
    await syncHolidayCalendar({ years: YEARS });
    const republic = rowOn('2026-01-26')!;

    const res = await request(app()).delete(`/api/v1/hr/holidays/${republic.id}`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ message: 'Holiday hidden', hidden: true });
    expect(rowOn('2026-01-26')?.hiddenAt).toBeInstanceOf(Date);
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'HOLIDAY_HIDDEN', expect.objectContaining({ targetId: republic.id }));

    const list = await request(app()).get('/api/v1/hr/holidays?year=2026').set('Authorization', `Bearer ${admin}`);
    expect(list.body.data.map((h: { name: string }) => h.name)).not.toContain('Republic Day');

    feed = FIXTURE.replace('SUMMARY:Republic Day', 'SUMMARY:Republic Day (renamed)');
    const again = await syncHolidayCalendar({ years: YEARS });
    expect(again).toMatchObject({ added: 0, updated: 0 });
    expect(rowOn('2026-01-26')).toMatchObject({ name: 'Republic Day', hiddenAt: expect.any(Date) });
  });

  it('a typed row is still deleted outright', async () => {
    const typed = manual('2026-11-09', 'Office day off');
    const res = await request(app()).delete(`/api/v1/hr/holidays/${typed.id}`).set('Authorization', `Bearer ${admin}`);
    expect(res.body.data).toEqual({ message: 'Holiday deleted', hidden: false });
    expect(rowOn('2026-11-09')).toBeUndefined();
  });

  it('a person can add a day over a hidden calendar row', async () => {
    await syncHolidayCalendar({ years: YEARS });
    const republic = rowOn('2026-01-26')!;
    await request(app()).delete(`/api/v1/hr/holidays/${republic.id}`).set('Authorization', `Bearer ${admin}`);
    const res = await request(app())
      .post('/api/v1/hr/holidays')
      .set('Authorization', `Bearer ${admin}`)
      .send({ date: '2026-01-26', name: 'Republic Day (office)' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ source: 'MANUAL', tentative: false });
  });

  it('editing a calendar row turns it MANUAL, and the sync leaves it alone — even moved to another day', async () => {
    await syncHolidayCalendar({ years: YEARS });
    const ramzan = rowOn('2026-03-21')!;
    const res = await request(app())
      .patch(`/api/v1/hr/holidays/${ramzan.id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Eid al-Fitr', date: '2026-03-20' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Eid al-Fitr', date: '2026-03-20', source: 'MANUAL' });

    const again = await syncHolidayCalendar({ years: YEARS });
    expect(again).toMatchObject({ added: 0, updated: 0, skipped: 1 });
    expect(rowOn('2026-03-21')).toBeUndefined();
    expect(rowOn('2026-03-20')).toMatchObject({ name: 'Eid al-Fitr', source: 'MANUAL' });
  });

  it('every row says where it came from and whether its date is tentative', async () => {
    await syncHolidayCalendar({ years: YEARS });
    manual('2027-11-01', 'Office day off');
    const res = await request(app()).get('/api/v1/hr/holidays?year=2027').set('Authorization', `Bearer ${admin}`);
    expect(res.body.data).toEqual([
      expect.objectContaining({ date: '2027-03-10', name: 'Ramzan Id', source: 'CALENDAR', tentative: true }),
      expect.objectContaining({ date: '2027-11-01', name: 'Office day off', source: 'MANUAL', tentative: false }),
    ]);
  });
});

describe('routes', () => {
  it('POST /hr/holidays/sync answers the result and is audited', async () => {
    const res = await request(app()).post('/api/v1/hr/holidays/sync').set('Authorization', `Bearer ${admin}`).send({ years: YEARS });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ added: 4, updated: 0, adopted: 0, skipped: 0, years: YEARS });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm_1',
      'HOLIDAY_CALENDAR_SYNCED',
      expect.objectContaining({ module: 'hr', metadata: expect.objectContaining({ added: 4, url: HOLIDAY_CALENDAR_DEFAULT_URL }) }),
    );
  });

  it('refuses while the calendar is off, and a bad body', async () => {
    config({ enabled: false });
    const off = await request(app()).post('/api/v1/hr/holidays/sync').set('Authorization', `Bearer ${admin}`).send({});
    expect(off.status).toBe(409);
    expect(off.body.error?.code ?? off.body.code).toBe('HOLIDAY_CALENDAR_OFF');
    expect(fetchMock).not.toHaveBeenCalled();

    config();
    const bad = await request(app()).post('/api/v1/hr/holidays/sync').set('Authorization', `Bearer ${admin}`).send({ years: [26] });
    expect(bad.status).toBe(400);
  });

  it('answers 502 in plain words when the feed cannot be read, audited as a failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 503 }));
    const res = await request(app()).post('/api/v1/hr/holidays/sync').set('Authorization', `Bearer ${admin}`).send({ years: YEARS });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).toContain('The calendar answered with an error (HTTP 503).');
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'HOLIDAY_CALENDAR_SYNC_FAILED', expect.anything());
  });

  it('GET /hr/holidays/calendar says what the page follows and when it last ran', async () => {
    const before = await request(app()).get('/api/v1/hr/holidays/calendar').set('Authorization', `Bearer ${admin}`);
    expect(before.body.data).toEqual({ enabled: true, url: HOLIDAY_CALENDAR_DEFAULT_URL, includeObservances: false, lastSync: null });
    await syncHolidayCalendar({ years: YEARS, now: new Date('2026-10-05T21:30:00.000Z') });
    const after = await request(app()).get('/api/v1/hr/holidays/calendar').set('Authorization', `Bearer ${admin}`);
    expect(after.body.data.lastSync).toEqual({ at: '2026-10-05T21:30:00.000Z', added: 4, updated: 0, adopted: 0, skipped: 0, error: null, years: YEARS });
  });

  it('is ADMIN, and Sync now needs hr.edit', async () => {
    const agent = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');
    const res = await request(app()).post('/api/v1/hr/holidays/sync').set('Authorization', `Bearer ${agent}`).send({});
    expect(res.status).toBe(403);
  });
});

describe('boot and the weekly run', () => {
  it('runs the old seed while the calendar is off, and no sync', async () => {
    config({ enabled: false });
    const outcome = await ensureHolidayCalendar(new Date('2026-10-01T00:00:00.000Z'));
    expect(outcome).toMatchObject({ mode: 'seed' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(table.rows.length).toBeGreaterThan(10);
    expect(await runScheduledHolidaySync()).toBeNull();
  });

  it('retires the seed while it is on: syncs once when next year has no calendar rows, then not again', async () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const first = await ensureHolidayCalendar(now);
    expect(first).toMatchObject({ mode: 'sync', result: { added: 4 } });
    expect(rowOn('2026-08-15')).toBeUndefined(); // no seed rows
    const second = await ensureHolidayCalendar(now);
    expect(second).toEqual({ mode: 'none' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the weekly run never throws on a dead feed', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await runScheduledHolidaySync(new Date('2026-10-05T00:00:00.000Z'))).toBeNull();
  });
});

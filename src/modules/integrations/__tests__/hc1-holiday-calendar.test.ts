import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * HC-1 (1 Oct 2026) — the holiday calendar as an integration section.
 *
 * `holidayCalendar { enabled (default on), url (default Google's Holidays in
 * India; https only), includeObservances (default off) }`. No secret in it:
 * drawn with its defaults filled in, written through the same PUT as every
 * other section, and a change is named in the trail with before and after.
 */
const { config, audit } = vi.hoisted(() => ({
  config: { getIntegrationsConfig: vi.fn(), updateIntegrationsConfig: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../../../shared/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations')>();
  return { ...actual, ...config };
});
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { HOLIDAY_CALENDAR_DEFAULT_URL, resolveHolidayCalendarConfig } from '../../../shared/integrations';
import { integrationsRouter } from '../integrations.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/integrations', integrationsRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm_1');

beforeEach(() => {
  vi.clearAllMocks();
  config.getIntegrationsConfig.mockResolvedValue({});
  config.updateIntegrationsConfig.mockResolvedValue({});
});

describe('the holidayCalendar section', () => {
  it('defaults to on, Google\'s Holidays in India, public holidays only', async () => {
    expect(HOLIDAY_CALENDAR_DEFAULT_URL).toBe(
      'https://calendar.google.com/calendar/ical/en.indian%23holiday%40group.v.calendar.google.com/public/basic.ics',
    );
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.holidayCalendar).toEqual({ enabled: true, url: HOLIDAY_CALENDAR_DEFAULT_URL, includeObservances: false });
  });

  it('draws what is stored, a blank address falling back to the default', () => {
    expect(resolveHolidayCalendarConfig({ enabled: false, url: '  ', includeObservances: true })).toEqual({
      enabled: false,
      url: HOLIDAY_CALENDAR_DEFAULT_URL,
      includeObservances: true,
    });
  });

  it('saves a patch through the existing route, audited with before and after', async () => {
    config.getIntegrationsConfig
      .mockResolvedValueOnce({})
      .mockResolvedValue({ holidayCalendar: { includeObservances: true } });
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'holidayCalendar', patch: { includeObservances: true } });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('holidayCalendar', { includeObservances: true });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm_1',
      'HOLIDAY_CALENDAR_CONFIG_UPDATED',
      expect.objectContaining({ diff: expect.objectContaining({ includeObservances: expect.anything() }) }),
    );
    expect(res.body.data.holidayCalendar.includeObservances).toBe(true);
  });

  it('refuses an address that is not https, and a field it does not know', async () => {
    const http = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'holidayCalendar', patch: { url: 'http://example.com/basic.ics' } });
    expect(http.status).toBe(400);
    const stray = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'holidayCalendar', patch: { apiKey: 'x' } });
    expect(stray.status).toBe(400);
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();
  });

  it('a null address goes back to the default', async () => {
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'holidayCalendar', patch: { url: null, enabled: false } });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('holidayCalendar', { url: null, enabled: false });
  });
});

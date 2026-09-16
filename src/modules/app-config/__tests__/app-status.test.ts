import { describe, expect, it } from 'vitest';
import { appStatusSchema, DEFAULT_APP_STATUS, gateFor, SERVICE_KEYS } from '../app-status';

/**
 * What a build must know before it can run: whether it is still supported,
 * whether ADX is up, and how each service is faring.
 *
 * The default is the safe answer. A default that locked people out of an app
 * nobody had configured would be the worst possible failure of this endpoint.
 */

describe('the default, before ops write the row', () => {
  it('supports every build, is not under maintenance, and reports every service up', () => {
    expect(appStatusSchema.safeParse(DEFAULT_APP_STATUS).success).toBe(true);
    expect(DEFAULT_APP_STATUS.minimumBuild).toEqual({ android: 0, ios: 0 });
    expect(DEFAULT_APP_STATUS.maintenance.active).toBe(false);
    expect(DEFAULT_APP_STATUS.services.map((service) => service.key)).toEqual([...SERVICE_KEYS]);
    expect(DEFAULT_APP_STATUS.services.every((service) => service.state === 'UP')).toBe(true);
  });
});

describe('the gate a build falls into', () => {
  const status = {
    minimumBuild: { android: 300, ios: 300 },
    latestBuild: { android: 310, ios: 310 },
    maintenance: { active: false },
  };

  it('forces an update below the minimum, offers one below the latest, and otherwise lets the app through', () => {
    expect(gateFor(status, 'android', 299)).toBe('FORCE_UPDATE');
    expect(gateFor(status, 'android', 305)).toBe('UPDATE_AVAILABLE');
    expect(gateFor(status, 'android', 310)).toBe('OK');
    expect(gateFor(status, 'ios', 400)).toBe('OK');
  });

  it('an unknown build is never blocked, and a forced update outranks maintenance', () => {
    expect(gateFor(status, 'android', 0)).toBe('OK');
    const down = { ...status, maintenance: { active: true } };
    expect(gateFor(down, 'android', 299)).toBe('FORCE_UPDATE');
    expect(gateFor(down, 'android', 310)).toBe('MAINTENANCE');
    expect(gateFor(down, 'android', 0)).toBe('MAINTENANCE');
  });
});

describe('what ops may write', () => {
  it('takes an incident and a maintenance window, and refuses an unknown service', () => {
    const ok = appStatusSchema.safeParse({
      ...DEFAULT_APP_STATUS,
      maintenance: { active: true, message: 'Scheduled maintenance', until: '2026-09-12T20:30:00.000Z' },
      incident: { title: 'Payout delays', message: 'Bank partner issue.', since: '2026-09-11T05:50:00.000Z', severity: 'WARNING' },
      services: [{ key: 'payments', label: 'Payments and payouts', state: 'DEGRADED', note: 'Bank partner' }],
    });
    expect(ok.success).toBe(true);
    expect(appStatusSchema.safeParse({ ...DEFAULT_APP_STATUS, services: [{ key: 'weather', label: 'Weather', state: 'UP' }] }).success).toBe(false);
    expect(appStatusSchema.safeParse({ ...DEFAULT_APP_STATUS, storeUrl: { android: 'not-a-url', ios: 'https://apps.apple.com/x' } }).success).toBe(false);
  });
});

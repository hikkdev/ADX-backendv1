import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Onboarding addresses (the owner, 1 Oct 2026): one address search bar on
 * every onboarding flow, filling the address all the way to the PIN code.
 * The agent application had no PIN for the current address; it now rides
 * the two routes that take `currentAddress` — the applicant's own
 * `PATCH /agents/me/application/profile` and the desk's
 * `PATCH /agents/:id/application/profile` — as `currentPostalCode`.
 *
 * Pinned: both schemas take it trimmed and nullable (a blank box is null),
 * never require it, and refuse a bad PIN in words; each route hands it to
 * its service; a bad PIN is a 400 whose details name the field, and nothing
 * is written.
 */

const { service } = vi.hoisted(() => ({
  service: { updateMyApplicationProfile: vi.fn(), updateProfileAtDesk: vi.fn() },
}));

vi.mock('../application/application.service', async (importOriginal) => ({ ...(await importOriginal<object>()), ...service }));

import { ApiError } from '../../../shared/errors';
import { PIN_CODE_MESSAGE } from '../../../shared/validation';
import { updateMyApplicationProfileHandler, updateProfileAtDeskHandler } from '../application/application.controller';
import { applicationProfileSchema, deskProfileSchema } from '../application/application.schema';

const call = async (handler: (req: never, res: never) => Promise<void>, body: Record<string, unknown>) => {
  const res = { json: vi.fn() };
  await handler({ body, params: { id: 'agt_1' }, user: { sub: 'usr_1', roles: ['ADMIN'] } } as never, res as never);
  return res.json.mock.calls[0]?.[0].data;
};

beforeEach(() => {
  vi.clearAllMocks();
  service.updateMyApplicationProfile.mockImplementation(async (_user: string, input: Record<string, unknown>) => ({ profile: input }));
  service.updateProfileAtDesk.mockImplementation(async (_id: string, input: Record<string, unknown>) => ({ profile: input }));
});

describe('the two schemas that take the current address', () => {
  it.each([
    ['applicationProfileSchema', applicationProfileSchema],
    ['deskProfileSchema', deskProfileSchema],
  ] as const)('%s takes the PIN trimmed, a blank box as null, and never requires it', (_name, schema) => {
    expect(schema.parse({ currentAddress: '14, 5th Cross', currentPostalCode: ' 560095 ' }).currentPostalCode).toBe('560095');
    expect(schema.parse({ currentPostalCode: '' }).currentPostalCode).toBeNull();
    expect(schema.parse({ currentPostalCode: null }).currentPostalCode).toBeNull();
    expect(schema.parse({ currentAddress: '14, 5th Cross' })).not.toHaveProperty('currentPostalCode');
  });

  it.each([
    ['applicationProfileSchema', applicationProfileSchema],
    ['deskProfileSchema', deskProfileSchema],
  ] as const)('%s refuses a bad PIN in words', (_name, schema) => {
    for (const bad of ['56009', '056009', '5600955', 'KA0001']) {
      const parsed = schema.safeParse({ currentPostalCode: bad });
      expect(parsed.success).toBe(false);
      expect(parsed.error!.issues[0]).toMatchObject({ path: ['currentPostalCode'], message: PIN_CODE_MESSAGE });
    }
  });
});

describe('the routes', () => {
  it("PATCH /agents/me/application/profile hands it to the applicant's own update", async () => {
    const data = await call(updateMyApplicationProfileHandler, { currentAddress: '14, 5th Cross', currentLatitude: 12.93, currentLongitude: 77.62, currentPostalCode: '560095' });
    expect(service.updateMyApplicationProfile).toHaveBeenCalledWith('usr_1', { currentAddress: '14, 5th Cross', currentLatitude: 12.93, currentLongitude: 77.62, currentPostalCode: '560095' });
    expect(data.profile.currentPostalCode).toBe('560095');
  });

  it("PATCH /agents/:id/application/profile hands it to the desk's edit", async () => {
    await call(updateProfileAtDeskHandler, { currentPostalCode: '560095' });
    expect(service.updateProfileAtDesk).toHaveBeenCalledWith('agt_1', { currentPostalCode: '560095' }, 'usr_1', expect.anything());
  });

  it.each([
    ['PATCH /agents/me/application/profile', updateMyApplicationProfileHandler, 'updateMyApplicationProfile'],
    ['PATCH /agents/:id/application/profile', updateProfileAtDeskHandler, 'updateProfileAtDesk'],
  ] as const)('%s answers 400 for a bad PIN, naming the field, and writes nothing', async (_route, handler, write) => {
    const error = await call(handler, { currentPostalCode: '05609' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect((error as ApiError & { details: { fieldErrors: Record<string, string[]> } }).details.fieldErrors['currentPostalCode']).toEqual([PIN_CODE_MESSAGE]);
    expect(service[write]).not.toHaveBeenCalled();
  });
});

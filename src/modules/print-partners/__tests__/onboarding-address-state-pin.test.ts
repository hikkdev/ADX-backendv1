import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Onboarding addresses (the owner, 1 Oct 2026): one address search bar on
 * every onboarding flow, filling the address all the way to the PIN code.
 * A print shop had neither a state nor a PIN; both now ride every route that
 * takes the shop's `address` — the desk's create (`POST /print-partners`)
 * and edit (`PATCH /print-partners/:id`), the shop's own profile
 * (`PATCH /print-partners/me`) and its application
 * (`POST /print-partners/me/application`) — land on the row, and come back
 * on every read through `shapePartner`.
 *
 * Pinned: each schema takes them trimmed and nullable (a blank box is null);
 * a bad PIN is a 400 whose details name the field with a message a person
 * can act on, and nothing is written; the handlers hand them to the service
 * and answer them back; the repository writes the columns on both creates.
 */

type Row = Record<string, unknown>;

const { service, prisma, tx } = vi.hoisted(() => {
  const tx = {
    user: { create: vi.fn(async () => ({ id: 'usr_prt' })) },
    userRole: { upsert: vi.fn(async () => ({})) },
    printPartner: { create: vi.fn(async ({ data }: { data: Row }) => ({ id: 'prt_1', ...data })) },
  };
  return {
    tx,
    prisma: { $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) },
    service: {
      createPartner: vi.fn(),
      updatePartner: vi.fn(),
      updateMe: vi.fn(),
      completeApplication: vi.fn(),
      getPartnerForUser: vi.fn(),
    },
  };
});

vi.mock('../print-partners.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...service,
  rateCardStateOf: vi.fn(() => ({ hasRateCard: false, fileId: null, fileUrl: null, updatedAt: null, rows: [] })),
}));
vi.mock('../../../shared/audit', () => ({ auditDiff: vi.fn(), logActivity: vi.fn(), findActivityRows: vi.fn() }));
vi.mock('../../../shared/database', async (importOriginal) => ({ ...(await importOriginal<object>()), prisma }));

import { ApiError } from '../../../shared/errors';
import { PIN_CODE_MESSAGE } from '../../../shared/validation';
import { completeMyApplicationHandler, createPartnerHandler, shapePartner, updateMyProfileHandler, updatePartnerHandler } from '../print-partners.controller';
import { applicationDetailsSchema, createPartnerSchema, updateMeSchema, updatePartnerSchema } from '../print-partners.schema';
import { prismaPrintPartnersRepository } from '../prisma-print-partners.repository';

const T = new Date('2026-10-01T10:00:00.000Z');
const partner = (over: Row = {}) => ({
  id: 'prt_1',
  displayId: 'PRT-0110-2601',
  userId: 'usr_prt',
  name: 'Balaji Prints',
  mobile: '+919845012345',
  email: null,
  address: '7, Industrial Estate',
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411019',
  latitude: 18.5,
  longitude: 73.8,
  capabilities: [],
  maxWidthFt: null,
  kycStatus: 'PENDING',
  entityType: null,
  appliedAt: T,
  activatedAt: null,
  createdAt: T,
  updatedAt: T,
  ...over,
});

const call = async (handler: (req: never, res: never) => Promise<void>, body: Row, params: Row = { id: 'prt_1' }) => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await handler({ body, params, user: { sub: 'usr_admin', roles: ['ADMIN'] } } as never, res as never);
  return res.json.mock.calls[0]?.[0].data;
};

/** The 400 the handler throws: VALIDATION_ERROR, the field named with the person-facing message. */
const refusal = async (handler: (req: never, res: never) => Promise<void>, body: Row) => {
  const error = await call(handler, body).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  return (error as ApiError & { details: { fieldErrors: Record<string, string[]> } }).details.fieldErrors;
};

beforeEach(() => {
  vi.clearAllMocks();
  service.createPartner.mockImplementation(async (input: Row) => partner(input));
  service.updatePartner.mockImplementation(async (_id: string, input: Row) => ({ before: partner(), after: partner(input) }));
  service.updateMe.mockImplementation(async (_row: Row, input: Row) => ({ before: partner(), after: partner(input) }));
  service.completeApplication.mockImplementation(async (_row: Row, input: Row) => ({ before: partner(), after: partner(input) }));
  service.getPartnerForUser.mockResolvedValue(partner());
});

describe('the four schemas that take the shop address', () => {
  const schemas = [
    ['createPartnerSchema', createPartnerSchema, { name: 'Balaji Prints', mobile: '9845012345' }],
    ['updatePartnerSchema', updatePartnerSchema, {}],
    ['updateMeSchema', updateMeSchema, {}],
    ['applicationDetailsSchema', applicationDetailsSchema, {}],
  ] as const;

  it.each(schemas)('%s takes the state and the PIN trimmed, a blank box as null', (_name, schema, base) => {
    expect(schema.parse({ ...base, address: '7, Industrial Estate', state: ' Maharashtra ', postalCode: ' 411019 ' })).toMatchObject({ state: 'Maharashtra', postalCode: '411019' });
    expect(schema.parse({ ...base, address: 'x', state: '', postalCode: '  ' })).toMatchObject({ state: null, postalCode: null });
    expect(schema.parse({ ...base, address: 'x', state: null, postalCode: null })).toMatchObject({ state: null, postalCode: null });
  });

  it.each(schemas)('%s refuses a bad PIN and an over-long state, in words', (_name, schema, base) => {
    for (const bad of ['41101', '041101', '4110190', 'PUNE01']) {
      const parsed = schema.safeParse({ ...base, postalCode: bad });
      expect(parsed.success).toBe(false);
      expect(parsed.error!.issues.find((issue) => issue.path[0] === 'postalCode')?.message).toBe(PIN_CODE_MESSAGE);
    }
    expect(schema.safeParse({ ...base, state: 'M'.repeat(81) }).success).toBe(false);
  });

  it('neither is required', () => {
    expect(createPartnerSchema.safeParse({ name: 'Balaji Prints', mobile: '9845012345', address: '7, Industrial Estate' }).success).toBe(true);
  });
});

describe('the routes', () => {
  it('POST /print-partners hands them to the create and answers them back', async () => {
    const data = await call(createPartnerHandler, { name: 'Balaji Prints', mobile: '9845012345', address: '7, Industrial Estate', city: 'Pune', state: 'Maharashtra', postalCode: '411019', latitude: 18.5, longitude: 73.8 });
    expect(service.createPartner).toHaveBeenCalledWith(expect.objectContaining({ state: 'Maharashtra', postalCode: '411019' }));
    expect(data).toMatchObject({ address: '7, Industrial Estate', city: 'Pune', state: 'Maharashtra', postalCode: '411019' });
  });

  it('PATCH /print-partners/:id hands them to the edit', async () => {
    const data = await call(updatePartnerHandler, { state: 'Karnataka', postalCode: '560001' });
    expect(service.updatePartner).toHaveBeenCalledWith('prt_1', { state: 'Karnataka', postalCode: '560001' });
    expect(data).toMatchObject({ state: 'Karnataka', postalCode: '560001' });
  });

  it('PATCH /print-partners/me hands them to the shop\'s own update', async () => {
    const data = await call(updateMyProfileHandler, { address: '9, MIDC', state: 'Maharashtra', postalCode: '411026' });
    expect(service.updateMe).toHaveBeenCalledWith(expect.objectContaining({ id: 'prt_1' }), { address: '9, MIDC', state: 'Maharashtra', postalCode: '411026' });
    expect(data).toMatchObject({ postalCode: '411026' });
  });

  it('POST /print-partners/me/application hands them to the application', async () => {
    await call(completeMyApplicationHandler, { address: '9, MIDC', state: 'Maharashtra', postalCode: '411026' });
    expect(service.completeApplication).toHaveBeenCalledWith(expect.objectContaining({ id: 'prt_1' }), { address: '9, MIDC', state: 'Maharashtra', postalCode: '411026' });
  });

  it.each([
    ['POST /print-partners', createPartnerHandler, { name: 'Balaji Prints', mobile: '9845012345', postalCode: '41101' }, 'createPartner'],
    ['PATCH /print-partners/:id', updatePartnerHandler, { postalCode: '41101' }, 'updatePartner'],
    ['PATCH /print-partners/me', updateMyProfileHandler, { postalCode: '41101' }, 'updateMe'],
    ['POST /print-partners/me/application', completeMyApplicationHandler, { postalCode: '41101' }, 'completeApplication'],
  ] as const)('%s answers 400 for a bad PIN, naming the field, and writes nothing', async (_route, handler, body, write) => {
    const fields = await refusal(handler as never, body);
    expect(fields['postalCode']).toEqual([PIN_CODE_MESSAGE]);
    expect(service[write]).not.toHaveBeenCalled();
  });
});

describe('every read', () => {
  it('shapePartner answers the state and the PIN beside the address, null where the row has none', () => {
    expect(shapePartner(partner() as never)).toMatchObject({ address: '7, Industrial Estate', city: 'Pune', state: 'Maharashtra', postalCode: '411019', latitude: 18.5, longitude: 73.8 });
    expect(shapePartner(partner({ state: null, postalCode: null }) as never)).toMatchObject({ state: null, postalCode: null });
  });
});

describe('the repository stores them', () => {
  it("writes the columns on the desk's create", async () => {
    await prismaPrintPartnersRepository.createPartner({ displayId: 'PRT-1', mobile: '+919845012345', name: 'Balaji Prints', address: '7, Industrial Estate', state: 'Maharashtra', postalCode: '411019' });
    expect(tx.printPartner.create).toHaveBeenCalledWith({ data: expect.objectContaining({ address: '7, Industrial Estate', state: 'Maharashtra', postalCode: '411019' }) });
  });

  it("writes the columns on the shop's application, null when not given", async () => {
    await prismaPrintPartnersRepository.createApplication({ userId: 'usr_prt', appliedAt: T, displayId: 'PRT-2', mobile: '+919845012346', name: 'Quick Prints' });
    expect(tx.printPartner.create).toHaveBeenCalledWith({ data: expect.objectContaining({ state: null, postalCode: null }) });
  });
});

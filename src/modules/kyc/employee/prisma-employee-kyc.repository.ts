import { Prisma, prisma } from '../../../shared/database';
import type { EmployeeKyc, KycStatus } from '../../../shared/database';
import { KYC_QUEUE_STATES, deriveKycState, kycPartyStateWhere, type KycQueueState } from '../../../shared/kyc-state';
import type {
  EmployeeDigioFields,
  EmployeeDigioUpdate,
  EmployeeKycFilter,
  EmployeeKycQueueRow,
  EmployeeKycRepository,
  EmployeeKycRequestStamp,
  EmployeeSlice,
} from './employee-kyc.repository';
import type { EmployeeKycDocuments } from './employee-kyc.schema';

const employeeSelect = {
  select: {
    id: true,
    userId: true,
    displayId: true,
    department: true,
    designation: true,
    createdAt: true,
    user: { select: { name: true, mobile: true, email: true } },
  },
} as const;

const withEmployee = { employee: employeeSelect } as const;

/* ── N3-B: the queue is every Employee ───────────────────────────────────── */

/** The state the filter asks for: `state`, else the `status` alias. */
const stateOf = (filter: EmployeeKycFilter): KycQueueState | undefined => filter.state ?? filter.status;

/** The employee's search box — name, display id, email or mobile contains. */
function searchWhere(q: string | undefined): Prisma.EmployeeWhereInput {
  const term = q?.trim();
  if (!term) return {};
  return {
    OR: [
      { displayId: { contains: term, mode: 'insensitive' } },
      { user: { name: { contains: term, mode: 'insensitive' } } },
      { user: { email: { contains: term, mode: 'insensitive' } } },
      { user: { mobile: { contains: term } } },
    ],
  };
}

/** Every employee (there is no mirror column on the row), narrowed by state and the search box. */
function partyWhere(filter: EmployeeKycFilter): Prisma.EmployeeWhereInput {
  const parts: Prisma.EmployeeWhereInput[] = [];
  const state = stateOf(filter);
  if (state) parts.push(kycPartyStateWhere(state, false));
  if (filter.q) parts.push(searchWhere(filter.q));
  return { AND: parts };
}

/** A row with no record spreads every record column as null. */
const EMPTY_RECORD = Object.fromEntries(Object.values(Prisma.EmployeeKycScalarFieldEnum).map((column) => [column, null])) as { [K in keyof EmployeeKyc]: null };

function toQueueRow(employee: EmployeeSlice & { kyc: EmployeeKyc | null }): EmployeeKycQueueRow {
  const { kyc, ...slice } = employee;
  return {
    ...(kyc ?? EMPTY_RECORD),
    id: kyc?.id ?? employee.id,
    employeeId: employee.id,
    kycId: kyc?.id ?? null,
    state: deriveKycState(kyc),
    employee: slice,
  };
}

export const prismaEmployeeKycRepository: EmployeeKycRepository = {
  async findPage(where: EmployeeKycFilter, page: number, pageSize: number) {
    const [rows, total] = await Promise.all([
      prisma.employee.findMany({
        where: partyWhere(where),
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Oldest submission first: the queue is worked in the order it arrived;
        // N3-B: employees with nothing in follow, by when the employee joined.
        orderBy: [{ kyc: { submittedAt: { sort: 'asc', nulls: 'last' } } }, { createdAt: 'asc' }],
        select: { ...employeeSelect.select, kyc: true },
      }),
      prisma.employee.count({ where: partyWhere(where) }),
    ]);
    return { items: rows.map(toQueueRow), total };
  },

  async countByState(where: EmployeeKycFilter) {
    const base: EmployeeKycFilter = { ...where, state: undefined, status: undefined };
    const entries = await Promise.all(
      KYC_QUEUE_STATES.map(async (state) => [state, await prisma.employee.count({ where: partyWhere({ ...base, state }) })] as const),
    );
    return Object.fromEntries(entries) as Record<KycQueueState, number>;
  },

  findByEmployeeId(employeeId: string) {
    return prisma.employeeKyc.findUnique({ where: { employeeId }, include: withEmployee });
  },

  findEmployeeContact(employeeId: string) {
    return prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, userId: true, displayId: true, user: { select: { name: true, email: true, mobile: true } } },
    });
  },

  record(employeeId: string, data: EmployeeKycDocuments, recordedById: string) {
    const now = new Date();
    // N3-B: the desk recorded it — `recordedVia` DESK, `method` MANUAL, like the three parties' desk PUTs.
    return prisma.employeeKyc.upsert({
      where: { employeeId },
      create: { employeeId, ...data, recordedById, recordedVia: 'DESK', method: 'MANUAL', status: 'PENDING', submittedAt: now },
      update: { ...data, recordedById, recordedVia: 'DESK', method: 'MANUAL', status: 'PENDING', rejectionReason: null, submittedAt: now, reviewedAt: null, reviewedById: null },
      include: withEmployee,
    });
  },

  review(employeeId: string, status: KycStatus, rejectionReason: string | null, reviewedById: string) {
    return prisma.employeeKyc.update({
      where: { employeeId },
      data: { status, rejectionReason, reviewedAt: new Date(), reviewedById },
      include: withEmployee,
    });
  },

  requestKyc(employeeId: string, stamp: EmployeeKycRequestStamp) {
    const data = { requestedAt: stamp.at, requestedById: stamp.requestedById, requestedChannel: stamp.requestedChannel };
    return prisma.employeeKyc.upsert({ where: { employeeId }, update: data, create: { employeeId, ...data }, include: withEmployee });
  },

  upsertDigio(employeeId: string, fields: EmployeeDigioFields) {
    return prisma.employeeKyc.upsert({ where: { employeeId }, update: fields, create: { employeeId, ...fields }, include: withEmployee });
  },

  findByDigioRequestId(kycId: string) {
    return prisma.employeeKyc.findFirst({ where: { digioRequestId: kycId }, include: withEmployee });
  },

  applyDigioWebhook(id: string, update: EmployeeDigioUpdate) {
    const { digioPayload, ...rest } = update;
    // Digio's completion is the recording — nobody at ADX held the documents;
    // an approval puts the row on the Digio path.
    return prisma.employeeKyc.update({
      where: { id },
      data: {
        ...rest,
        digioPayload: digioPayload as Prisma.InputJsonValue,
        recordedVia: 'DIGIO',
        recordedById: null,
        ...(update.status === 'VERIFIED' ? { method: 'DIGIO' } : {}),
      },
      include: withEmployee,
    });
  },
};

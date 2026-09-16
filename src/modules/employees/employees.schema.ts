import { z } from 'zod';
import { upperEnum } from '../../shared/validation';

/**
 * Document fields accepted on employee create/update.
 *
 * Clients first POST the file to /upload (purpose=KYC) to get a URL, then send
 * that URL here — mirrors how PublisherKyc works.
 */
const documentFields = {
  passportPhotoUrl: z.string().url().optional(),
  referenceLetterUrl: z.string().url().optional(),
  ndaAgreementUrl: z.string().url().optional(),
  nonCompeteAgreementUrl: z.string().url().optional(),
  class10MarksheetUrl: z.string().url().optional(),
  class12MarksheetUrl: z.string().url().optional(),
  graduationMarksheetUrl: z.string().url().optional(),
  postGraduationMarksheetUrl: z.string().url().optional(),
  form2NominationUrl: z.string().url().optional(),
  form6aUrl: z.string().url().optional(),
  esiFormUrl: z.string().url().optional(),
  form2FamilyDeclarationUrl: z.string().url().optional(),
  form6EmployeeRegistrationUrl: z.string().url().optional(),
  salaryAccountLetterUrl: z.string().url().optional(),
  salarySlipUrls: z.array(z.string().url()).optional(),
  complianceFormUrls: z.array(z.string().url()).optional(),
  epfFormUrls: z.array(z.string().url()).optional(),
  gratuityFormUrls: z.array(z.string().url()).optional(),
};

/**
 * A new joiner who also needs a console login, in one call. The invitation is
 * the ordinary one — `auth` owns it — sent to the address on the user record,
 * so an employee with no email is a 409 rather than a silent skip.
 */
const inviteToConsoleSchema = z.object({
  roleConfigId: z.string().min(1).optional(),
  method: upperEnum(['PASSWORD', 'GOOGLE'] as const).default('PASSWORD'),
});

/**
 * Lot G (Q122/Q140): where and how the person works. `departmentId` is the
 * record (the `Department` row `hr` owns); the free `department` string stays
 * one release and is kept in step with the record's name on every write.
 */
export const WORK_MODES = ['OFFICE', 'REMOTE', 'HYBRID', 'FIELD'] as const;
export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] as const;

const workFields = {
  departmentId: z.string().trim().min(1).max(64).nullable().optional(),
  region: z.string().trim().min(1).max(80).nullable().optional(),
  workMode: upperEnum(WORK_MODES).nullable().optional(),
  employmentType: upperEnum(EMPLOYMENT_TYPES).nullable().optional(),
};

export const createEmployeeSchema = z.object({
  userId: z.string().min(1),
  department: z.string().optional(),
  designation: z.string().optional(),
  inviteToConsole: inviteToConsoleSchema.optional(),
  ...workFields,
  ...documentFields,
});

export const updateEmployeeSchema = z.object({
  department: z.string().optional(),
  designation: z.string().optional(),
  isActive: z.boolean().optional(),
  ...workFields,
  /**
   * Lot E (Q98): the person's id in the HR tool, which `hrmsLink` is built
   * from. Unique across records; `null` unlinks.
   */
  externalHrmsId: z.string().trim().min(1).max(120).nullable().optional(),
  ...documentFields,
});

/**
 * GET /employees — Lot E: the directory's search box and its two filters,
 * over the paginated list the console already reads.
 */
/** G13-B: REGION joins the three — the region column, A to Z, blanks last. */
export const EMPLOYEE_SORTS = ['NAME', 'ROLE', 'JOINED', 'REGION'] as const;
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;

export const listEmployeesQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  department: z.string().trim().min(1).max(120).optional(),
  /** Lot G (Q122): by the department record. */
  departmentId: z.string().trim().min(1).max(64).optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  /**
   * Lot G (Q113): the directory's server sort — the person's name, their
   * designation (ROLE), or when the record was made (JOINED); G13-B: their
   * region (REGION). Absent, the table draws the newest joined first, as it
   * always has.
   */
  sort: z.enum(EMPLOYEE_SORTS).optional(),
  /** Absent, the words ascend and the date descends — see `employeeOrderBy`. */
  dir: z.enum(SORT_DIRECTIONS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  // Clamped rather than refused: the old handler capped at 100 and the console relies on it.
  pageSize: z.coerce.number().int().min(1).default(20).transform((value) => Math.min(100, value)),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>;
export type EmployeeFilter = Pick<ListEmployeesQuery, 'q' | 'department' | 'departmentId' | 'active'>;
export type EmployeeSort = (typeof EMPLOYEE_SORTS)[number];
export type EmployeeOrder = { sort: EmployeeSort; dir: (typeof SORT_DIRECTIONS)[number] };

/**
 * Lot G (Q113): the order a list query resolves to. A name or a role reads
 * A to Z unless told otherwise; a joining date reads newest first, which is
 * what the directory drew before it could be sorted at all.
 */
export function employeeOrderBy(query: { sort?: EmployeeSort | undefined; dir?: EmployeeOrder['dir'] | undefined }): EmployeeOrder {
  const sort = query.sort ?? 'JOINED';
  return { sort, dir: query.dir ?? (sort === 'JOINED' ? 'desc' : 'asc') };
}

/**
 * GET /employees/workload — Lot G (Q120/Q139). `[from, to]` are calendar
 * days (inclusive), the window at most a year; `granularity` is the bucket
 * the chart draws. Defaults: the last twelve weeks, by week.
 */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const WORKLOAD_GRANULARITIES = ['week', 'month'] as const;
export const workloadQuerySchema = z
  .object({
    from: isoDay.optional(),
    to: isoDay.optional(),
    granularity: z.enum(WORKLOAD_GRANULARITIES).default('week'),
  })
  .refine((query) => !(query.from && query.to) || query.from <= query.to, { message: 'from must not be after to', path: ['from'] });
export type WorkloadQuery = z.infer<typeof workloadQuerySchema>;
export type WorkloadGranularity = (typeof WORKLOAD_GRANULARITIES)[number];

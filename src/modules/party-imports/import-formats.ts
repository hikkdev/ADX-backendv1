import type { z } from 'zod';
import { formatCsv } from '../../shared/csv';
import { ApiError } from '../../shared/errors';
import { ADVERTISER_INDUSTRIES } from '../advertisers';
import { EMPLOYMENT_TYPES, WORK_MODES } from '../employees';
import { LISTING_CATEGORIES } from '../listings';
import { createLeadSchema, LEAD_SIDES } from '../leads';
import { marketDataImportRowSchema } from '../pricing';
import { PUBLISHER_IMPORT_COLUMNS, PUBLISHER_TYPES, publisherImportRowSchema } from '../publishers';
import { DEFAULT_COLUMNS, parseStatement } from '../reconciliation';
import {
  ADVERTISER_COLUMNS,
  AGENT_COLUMNS,
  EMPLOYEE_COLUMNS,
  LISTING_COLUMNS,
  PRINT_PARTNER_COLUMNS,
  RATE_CARD_COLUMNS,
  advertiserRowSchema,
  agentRowSchema,
  employeeRowSchema,
  listingRowSchema,
  printPartnerRowSchema,
  rateCardRowSchema,
} from './party-imports.schema';

/**
 * Lot U — the format guide (the owner, 15 Sep: "a set of instructions
 * towards the format of the csv file for every kind of import on the
 * platform — how many columns, what titles etc").
 *
 * One JSON per import kind, and a template.csv per kind. The guide is a
 * column table kept BESIDE each validator — the parties' and the publisher's
 * two here, the publisher book's, the leads', the market-data and the finance
 * reconciliation importers' through their modules' exports — and
 * `import-formats.test.ts` walks every kind asserting the guide's columns
 * and the validator's keys are the same set, and that the sample rows pass
 * the validator. So the guide cannot say a column the validator does not
 * take, nor omit one it does.
 */

export const FORMAT_KINDS = ['publishers', 'advertisers', 'agents', 'print-partners', 'employees', 'listings', 'rate-card', 'leads', 'market-data', 'finance-reconciliation'] as const;
export type FormatKind = (typeof FORMAT_KINDS)[number];

export type ColumnType = 'text' | 'mobile' | 'email' | 'enum' | 'number' | 'money' | 'date' | 'url' | 'list';

export type ColumnGuide = {
  name: string;
  required: boolean;
  type: ColumnType;
  description: string;
  example: string;
  enumValues?: readonly string[];
  maxLength?: number;
};

export type ImportFormat = {
  kind: FormatKind;
  title: string;
  purpose: string;
  /** Where the file goes, and in what shape. */
  route: string;
  columns: ColumnGuide[];
  rules: string[];
  sampleRows: [Record<string, string>, Record<string, string>];
  templateCsvUrl: string;
};

type Format = Omit<ImportFormat, 'templateCsvUrl'> & {
  /** The validator's keys — what the contract test compares the columns against. */
  schemaKeys: () => readonly string[];
  /** Runs one sample row (CSV strings) through the validator; null when it passes. */
  validate: (row: Record<string, string>) => string | null;
};

const templateUrl = (kind: FormatKind) => `/api/v1/party-imports/formats/${kind}/template.csv`;

const firstIssue = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }): string | null =>
  result.success ? null : `${String(result.error?.issues[0]?.path[0] ?? 'row')}: ${result.error?.issues[0]?.message ?? 'invalid'}`;

/** A CSV row for a validator that takes text (the party kits): blanks stay, the schemas read them as absent. */
const textValidator = (schema: z.ZodType) => (row: Record<string, string>) => firstIssue(schema.safeParse(row));

/** A CSV row for a JSON-shaped validator: blanks are absent, number columns become numbers, booleans booleans. */
const jsonValidator = (schema: z.ZodType, columns: ColumnGuide[]) => (row: Record<string, string>) => {
  const body: Record<string, unknown> = {};
  for (const column of columns) {
    const value = row[column.name];
    if (value === undefined || value === '') continue;
    body[column.name] = column.type === 'number' ? Number(value) : value;
  }
  return firstIssue(schema.safeParse(body));
};

const keysOf = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape);

const NEVER_REFUSED = 'The batch is never refused: every row is planned and reported, and the report says what each row will do before anything is committed.';
const MOBILE_RULE = 'mobile is the merge key: a number already on the platform merges — filling only the columns that are empty — or is skipped when there is nothing to add; the same number twice in the file skips the later row.';
const CASING_RULE = 'Enum columns accept any casing.';
const INVALID_RULE = 'A malformed value makes the row INVALID and the message names the column.';

/* ── Column tables, beside each validator ──────────────────────────────── */

const col = (name: string, required: boolean, type: ColumnType, description: string, example: string, extra: Partial<ColumnGuide> = {}): ColumnGuide => ({ name, required, type, description, example, ...extra });

const publishers: Format = {
  kind: 'publishers',
  title: 'Publishers (the legacy book)',
  purpose: "A publisher book kept in a spreadsheet, brought onto the platform: one publisher per row, mobile the key. Validated with a per-row report, then committed.",
  route: 'POST /api/v1/publishers/import — a CSV under `file`, or a JSON body { rows }',
  columns: [
    col('name', false, 'text', 'The publisher as they are known.', 'Metro Spaces Pvt Ltd', { maxLength: 160 }),
    col('mobile', true, 'mobile', 'The publisher\'s mobile, ten digits or +91 — the key a merge matches on.', '9876543210'),
    col('email', false, 'email', 'The publisher\'s email.', 'ops@metrospaces.in'),
    col('type', false, 'enum', 'What kind of publisher.', 'BUSINESS', { enumValues: PUBLISHER_TYPES }),
    col('gstin', false, 'text', 'The GSTIN, 15 characters; upper-cased and format-checked.', '27ABCDE1234F1Z5'),
    col('address', false, 'text', 'The registered address.', '12, MG Road, Pune', { maxLength: 500 }),
    col('city', false, 'text', 'The city; resolved against the catalogue, kept as typed when unknown.', 'Pune', { maxLength: 80 }),
    col('state', false, 'text', 'The state.', 'Maharashtra', { maxLength: 80 }),
    col('contactName', false, 'text', 'The person ADX reaches when the account is not a person.', 'Asha Rao', { maxLength: 160 }),
    col('contactMobile', false, 'mobile', 'That person\'s mobile.', '9876500000'),
    col('contactEmail', false, 'email', 'That person\'s email.', 'asha@metrospaces.in'),
    col('panNumber', false, 'text', 'The PAN, ten characters; upper-cased and format-checked.', 'ABCDE1234F'),
  ],
  rules: [MOBILE_RULE, 'A PAN or GSTIN already on another publisher is a WARNING and the row still creates.', 'An unknown city is a WARNING, kept as typed.', CASING_RULE, INVALID_RULE, NEVER_REFUSED],
  sampleRows: [
    { name: 'Metro Spaces Pvt Ltd', mobile: '9876543210', email: 'ops@metrospaces.in', type: 'BUSINESS', gstin: '27ABCDE1234F1Z5', address: '12, MG Road, Pune', city: 'Pune', state: 'Maharashtra', contactName: 'Asha Rao', contactMobile: '9876500000', contactEmail: 'asha@metrospaces.in', panNumber: 'ABCDE1234F' },
    { name: 'Ravi Kulkarni', mobile: '9822012345', email: '', type: 'INDIVIDUAL', gstin: '', address: '', city: 'Nashik', state: 'Maharashtra', contactName: '', contactMobile: '', contactEmail: '', panNumber: '' },
  ],
  schemaKeys: () => PUBLISHER_IMPORT_COLUMNS,
  validate: textValidator(publisherImportRowSchema),
};

const advertisers: Format = {
  kind: 'advertisers',
  title: 'Advertisers',
  purpose: 'An advertiser book: one advertiser per row, mobile the key. Each row creates through the console\'s own Create (identifier, wallet, brand, KYC pending).',
  route: 'POST /api/v1/party-imports/advertisers — a CSV under `file`, or a JSON body { rows }',
  columns: [
    col('name', false, 'text', 'The advertiser\'s name.', 'Fresh Foods', { maxLength: 120 }),
    col('mobile', true, 'mobile', 'The advertiser\'s mobile — the merge key.', '9000000001'),
    col('email', false, 'email', 'Lower-cased on the way in.', 'hello@freshfoods.in'),
    col('type', false, 'enum', 'What kind of advertiser.', 'COMMERCIAL', { enumValues: ['INDIVIDUAL', 'COMMERCIAL', 'NGO', 'AGENCY'] }),
    col('companyName', false, 'text', 'The company behind the account.', 'Fresh Foods Pvt Ltd', { maxLength: 160 }),
    col('industry', false, 'enum', 'One of the advertiser industries.', 'Retail', { enumValues: ADVERTISER_INDUSTRIES }),
    col('gstin', false, 'text', 'The GSTIN; upper-cased and format-checked.', '27ABCDE1234F1Z5'),
    col('panNumber', false, 'text', 'The PAN; validated and kept on the report only — the PAN lives on the KYC record.', 'ABCDE1234F'),
    col('address', false, 'text', 'Lands as the billing address.', '4, FC Road, Pune', { maxLength: 400 }),
    col('city', false, 'text', 'Resolved against the catalogue; unknown warns.', 'Pune', { maxLength: 80 }),
    col('state', false, 'text', 'The state.', 'Maharashtra', { maxLength: 80 }),
    col('contactName', false, 'text', 'Kept on the report only — the profile has no contact-name column.', 'Meera Shah', { maxLength: 120 }),
  ],
  rules: [MOBILE_RULE, 'A PAN or GSTIN already on another advertiser is a WARNING and the row still creates.', 'panNumber and contactName are validated and reported but not written.', CASING_RULE, INVALID_RULE, NEVER_REFUSED],
  sampleRows: [
    { name: 'Fresh Foods', mobile: '9000000001', email: 'hello@freshfoods.in', type: 'COMMERCIAL', companyName: 'Fresh Foods Pvt Ltd', industry: 'Retail', gstin: '27ABCDE1234F1Z5', panNumber: 'ABCDE1234F', address: '4, FC Road, Pune', city: 'Pune', state: 'Maharashtra', contactName: 'Meera Shah' },
    { name: 'Sunita Patil', mobile: '9000000002', email: '', type: 'INDIVIDUAL', companyName: '', industry: '', gstin: '', panNumber: '', address: '', city: 'Mumbai', state: '', contactName: '' },
  ],
  schemaKeys: () => ADVERTISER_COLUMNS,
  validate: textValidator(advertiserRowSchema),
};

const agents: Format = {
  kind: 'agents',
  title: 'Agents',
  purpose: 'Field agents: one per row. A new number gets a user, the role and a profile in one write; a number already on an account gains the role and a profile.',
  route: 'POST /api/v1/party-imports/agents — a CSV under `file`, or a JSON body { rows }',
  columns: [
    col('name', false, 'text', 'The agent\'s name (the account\'s).', 'Ravi Kumar', { maxLength: 120 }),
    col('mobile', true, 'mobile', 'The agent\'s mobile — the merge key.', '9000000011'),
    col('email', false, 'email', 'The account\'s email; one already on another account, or twice in the file, cannot create.', 'ravi@example.in'),
    col('side', true, 'enum', 'Which side the agent works — picks the role.', 'PUBLISHER', { enumValues: ['PUBLISHER', 'ADVERTISER'] }),
    col('city', false, 'text', 'Resolved against the catalogue; unknown warns.', 'Pune', { maxLength: 80 }),
    col('state', false, 'text', 'The state.', 'Maharashtra', { maxLength: 80 }),
  ],
  rules: [MOBILE_RULE, 'side is required.', 'A merge fills only city and state — name and email are the account\'s.', 'An email already on another account, or used twice in the file, makes the row INVALID.', CASING_RULE, INVALID_RULE, NEVER_REFUSED],
  sampleRows: [
    { name: 'Ravi Kumar', mobile: '9000000011', email: 'ravi@example.in', side: 'PUBLISHER', city: 'Pune', state: 'Maharashtra' },
    { name: 'Neha Joshi', mobile: '9000000012', email: '', side: 'ADVERTISER', city: 'Mumbai', state: '' },
  ],
  schemaKeys: () => AGENT_COLUMNS,
  validate: textValidator(agentRowSchema),
};

const printPartners: Format = {
  kind: 'print-partners',
  title: 'Print partners',
  purpose: 'Print shops: one per row. Each creates the sign-in-disabled account, the identifier and the wallet the console\'s Create makes.',
  route: 'POST /api/v1/party-imports/print-partners — a CSV under `file`, or a JSON body { rows }',
  columns: [
    col('name', false, 'text', 'The shop\'s name.', 'Fresh Press', { maxLength: 120 }),
    col('mobile', true, 'mobile', 'The shop\'s mobile — the merge key; a number already on an ADX account cannot create a partner.', '9000000021'),
    col('legalName', false, 'text', 'The registered name.', 'Fresh Press Pvt Ltd', { maxLength: 200 }),
    col('gstin', false, 'text', 'The GSTIN; upper-cased and format-checked.', '27ABCDE1234F1Z5'),
    col('panNumber', false, 'text', 'The PAN; upper-cased and format-checked.', 'ABCDE1234F'),
    col('contactName', false, 'text', 'Who to call.', 'Sameer Khan', { maxLength: 120 }),
    col('email', false, 'email', 'The account\'s email; one already on another account cannot create.', 'print@freshpress.in'),
    col('address', false, 'text', 'The shop\'s address.', '7, Industrial Estate, Pune', { maxLength: 500 }),
    col('city', false, 'text', 'Resolved against the catalogue; unknown warns.', 'Pune', { maxLength: 80 }),
    col('capabilities', false, 'list', 'Pipe-separated: what the shop prints.', 'flex|vinyl|backlit'),
    col('maxWidthFt', false, 'number', 'The widest print, in feet, at most two decimals.', '12.5'),
    col('turnaroundDays', false, 'number', 'Whole days, at most 365.', '3'),
  ],
  rules: [MOBILE_RULE, 'A PAN or GSTIN already on another partner is a WARNING and the row still creates.', 'A number already on an ADX account is INVALID: a print partner needs its own number.', INVALID_RULE, NEVER_REFUSED],
  sampleRows: [
    { name: 'Fresh Press', mobile: '9000000021', legalName: 'Fresh Press Pvt Ltd', gstin: '27ABCDE1234F1Z5', panNumber: 'ABCDE1234F', contactName: 'Sameer Khan', email: 'print@freshpress.in', address: '7, Industrial Estate, Pune', city: 'Pune', capabilities: 'flex|vinyl|backlit', maxWidthFt: '12.5', turnaroundDays: '3' },
    { name: 'Quick Prints', mobile: '9000000022', legalName: '', gstin: '', panNumber: '', contactName: '', email: '', address: '', city: 'Nagpur', capabilities: 'vinyl', maxWidthFt: '', turnaroundDays: '' },
  ],
  schemaKeys: () => PRINT_PARTNER_COLUMNS,
  validate: textValidator(printPartnerRowSchema),
};

const employees: Format = {
  kind: 'employees',
  title: 'Employees',
  purpose: 'The HR sheet: one employee per row. A new number gets an account with no role (console access comes from an invitation) and the employee record.',
  route: 'POST /api/v1/party-imports/employees — a CSV under `file`, or a JSON body { rows }',
  columns: [
    col('name', false, 'text', 'The employee\'s name (the account\'s).', 'Meera Iyer', { maxLength: 120 }),
    col('mobile', true, 'mobile', 'The employee\'s mobile — the merge key.', '9000000031'),
    col('email', false, 'email', 'The account\'s email; one already on another account, or twice in the file, cannot create.', 'meera@adx.in'),
    col('department', false, 'text', 'The department, by name.', 'Operations', { maxLength: 120 }),
    col('designation', false, 'text', 'The title.', 'Analyst', { maxLength: 120 }),
    col('region', false, 'text', 'The region worked.', 'West', { maxLength: 80 }),
    col('workMode', false, 'enum', 'Where the work happens.', 'HYBRID', { enumValues: WORK_MODES }),
    col('employmentType', false, 'enum', 'The employment basis.', 'FULL_TIME', { enumValues: EMPLOYMENT_TYPES }),
  ],
  rules: [MOBILE_RULE, 'A merge fills only the record\'s five columns — name and email are the account\'s.', 'An email already on another account, or used twice in the file, makes the row INVALID.', CASING_RULE, INVALID_RULE, NEVER_REFUSED],
  sampleRows: [
    { name: 'Meera Iyer', mobile: '9000000031', email: 'meera@adx.in', department: 'Operations', designation: 'Analyst', region: 'West', workMode: 'HYBRID', employmentType: 'FULL_TIME' },
    { name: 'Arjun Nair', mobile: '9000000032', email: '', department: 'Sales', designation: '', region: 'South', workMode: 'FIELD', employmentType: 'CONTRACT' },
  ],
  schemaKeys: () => EMPLOYEE_COLUMNS,
  validate: textValidator(employeeRowSchema),
};

const listings: Format = {
  kind: 'listings',
  title: 'Listings (a publisher\'s spots)',
  purpose: 'A publisher\'s inventory, one spot per row, imported on their behalf. Every created spot goes under ONE supply attempt — the publisher accepts one listing agreement for the whole file — and is never made ACTIVE by the import.',
  route: 'POST /api/v1/party-imports/listings?publisherId= — a CSV under `file`, or a JSON body { rows }',
  columns: [
    col('externalRef', false, 'text', 'The publisher\'s own id for the spot — the merge key when present.', 'MS-0042', { maxLength: 120 }),
    col('title', true, 'text', 'What the spot is called.', 'FC Road Hoarding', { maxLength: 200 }),
    col('category', true, 'enum', 'The listing category.', 'OUTDOOR', { enumValues: LISTING_CATEGORIES }),
    col('subType', false, 'text', 'The sub-type in the publisher\'s words.', 'Hoarding', { maxLength: 120 }),
    col('description', false, 'text', 'The selling description.', 'Faces the junction, lit at night', { maxLength: 2000 }),
    col('address', true, 'text', 'Where the spot is; geocoded when latitude and longitude are not given. Also the merge key when externalRef is absent.', '44, FC Road, Pune', { maxLength: 500 }),
    col('city', false, 'text', 'Resolved against the catalogue; unknown warns and is kept as typed.', 'Pune', { maxLength: 80 }),
    col('state', false, 'text', 'Used to geocode; the listing keeps no state of its own.', 'Maharashtra', { maxLength: 80 }),
    col('latitude', false, 'number', 'Decimal degrees; with longitude, or neither.', '18.5236'),
    col('longitude', false, 'number', 'Decimal degrees; with latitude, or neither.', '73.8412'),
    col('mediaType', false, 'text', 'A media type by name or slug from the taxonomy; unknown is INVALID.', 'Hoarding', { maxLength: 120 }),
    col('sizeClass', false, 'text', 'A size class by slug or name; unknown is INVALID.', '20x10', { maxLength: 80 }),
    col('size', false, 'text', 'The size as text.', '20 x 10 ft', { maxLength: 80 }),
    col('material', false, 'text', 'A material by slug or name; unknown is INVALID.', 'flex', { maxLength: 80 }),
    col('ratePerDay', false, 'money', 'The rate per day. One of ratePerDay and monthlyPrice is required.', '1200'),
    col('monthlyPrice', false, 'money', 'The old shape: divided by 30 into the daily rate.', '36000'),
    col('slotsTotal', false, 'number', 'How many advertisers the spot carries at once (a screen\'s loop), 1–24; only a screen may say more than 1.', '1'),
    col('instantBooking', false, 'enum', 'Opt the spot into automatic acceptance (gated by the platform).', 'no', { enumValues: ['yes', 'no'] }),
    col('photos', false, 'list', 'Pipe-separated photo URLs, at most 20.', 'https://cdn.adx.in/a.jpg|https://cdn.adx.in/b.jpg'),
  ],
  rules: [
    'title, category, address and a price (ratePerDay or monthlyPrice) are required.',
    'The same externalRef as a spot an earlier import brought in, or the same address as one of the publisher\'s spots, merges: the blanks are filled (description, subType, media type, size class, material, and the rate only when the spot has none) and a set rate is never overwritten; nothing to fill is SKIPPED.',
    'The same externalRef or address twice in the file skips the later row.',
    'A row without coordinates is geocoded; when the map cannot place it the row WARNS ("place it on the map before publishing") and still creates.',
    'A rate below the ADX rate-card floor for that kind of spot WARNS and still creates — the publish gate stays the guard.',
    'Another publisher\'s spot within 25 m WARNS ("possible duplicate of …") and still creates.',
    'An unknown media type, size class or material is INVALID naming the column.',
    'Commit opens one supply attempt for the publisher and files every created spot under it; the agreement is not sent automatically — the console offers "Send the agreement".',
    CASING_RULE,
    INVALID_RULE,
    NEVER_REFUSED,
  ],
  sampleRows: [
    { externalRef: 'MS-0042', title: 'FC Road Hoarding', category: 'OUTDOOR', subType: 'Hoarding', description: 'Faces the junction, lit at night', address: '44, FC Road, Pune', city: 'Pune', state: 'Maharashtra', latitude: '18.5236', longitude: '73.8412', mediaType: 'Hoarding', sizeClass: '20x10', size: '20 x 10 ft', material: 'flex', ratePerDay: '1200', monthlyPrice: '', slotsTotal: '1', instantBooking: 'no', photos: 'https://cdn.adx.in/a.jpg|https://cdn.adx.in/b.jpg' },
    { externalRef: '', title: 'Station Concourse Screen', category: 'TRANSIT', subType: 'Digital screen', description: '', address: '1, Station Road, Pune', city: 'Pune', state: '', latitude: '', longitude: '', mediaType: '', sizeClass: '', size: '', material: '', ratePerDay: '', monthlyPrice: '90000', slotsTotal: '6', instantBooking: '', photos: '' },
  ],
  schemaKeys: () => LISTING_COLUMNS,
  validate: textValidator(listingRowSchema),
};

const rateCard: Format = {
  kind: 'rate-card',
  title: 'Rate card (a publisher\'s rates)',
  purpose: 'A publisher\'s rate card applied to their listings: one rate per row, the listing named by displayId, externalRef or exact title.',
  route: 'POST /api/v1/party-imports/rate-card?publisherId= — a CSV under `file`, or a JSON body { rows }',
  columns: [
    col('listing', true, 'text', 'The listing: its displayId (ADX-LST-…), the externalRef an import gave it, or its exact title — resolved in that order.', 'ADX-LST-00042', { maxLength: 200 }),
    col('ratePerDay', false, 'money', 'The new rate per day. One of ratePerDay and monthlyPrice is required.', '1800'),
    col('monthlyPrice', false, 'money', 'The old shape: divided by 30 into the daily rate.', '54000'),
    col('slotsTotal', false, 'number', 'The loop, 1–24, when it changes too.', '1'),
    col('effectiveFrom', false, 'date', 'YYYY-MM-DD; today when omitted. A future day is not supported.', '2026-09-15'),
  ],
  rules: [
    'A listing the reference does not name on this publisher is INVALID; a title two listings share is INVALID (use the displayId).',
    'The same listing twice in the file skips the later row; a rate already at the value (and the loop unchanged) is SKIPPED.',
    'A rate below the ADX floor WARNS and still sets; a listing with a booking running WARNS — the running order\'s accrual snapshots keep the rate it was placed at.',
    'A future effectiveFrom is INVALID: future rates are not supported; rates apply as the import commits.',
    'Commit sets each rate through the listing\'s own update door (ratePerDaySetAt stamped) and audits the reprice per listing.',
    INVALID_RULE,
    NEVER_REFUSED,
  ],
  sampleRows: [
    { listing: 'ADX-LST-00042', ratePerDay: '1800', monthlyPrice: '', slotsTotal: '', effectiveFrom: '' },
    { listing: 'MS-0042', ratePerDay: '', monthlyPrice: '54000', slotsTotal: '1', effectiveFrom: '2026-09-15' },
  ],
  schemaKeys: () => RATE_CARD_COLUMNS,
  validate: textValidator(rateCardRowSchema),
};

const leadRowSchema = createLeadSchema.omit({ source: true });
const leads: Format = {
  kind: 'leads',
  title: 'Leads',
  purpose: 'A batch of prospects for the field team, pasted in by ops: one lead per row, with a source for the batch. Dry-run answers the per-row report without writing.',
  route: 'POST /api/v1/leads/import — a JSON body { source, rows, dryRun? } (the CSV template maps to rows column by column)',
  columns: [
    col('side', true, 'enum', 'Which side the lead is for.', 'PUBLISHER', { enumValues: LEAD_SIDES }),
    col('businessName', true, 'text', 'The business.', 'Sunrise Gym', { maxLength: 160 }),
    col('category', false, 'text', 'The business category.', 'Fitness', { maxLength: 60 }),
    col('contactName', false, 'text', 'Who to ask for.', 'Kiran Desai', { maxLength: 120 }),
    col('phone', false, 'text', 'A phone number, 6–20 characters.', '9876543210', { maxLength: 20 }),
    col('email', false, 'email', 'An email.', 'kiran@sunrisegym.in'),
    col('address', false, 'text', 'The street address.', '3, Baner Road, Pune', { maxLength: 300 }),
    col('locality', false, 'text', 'The locality.', 'Baner', { maxLength: 120 }),
    col('city', false, 'text', 'The city.', 'Pune', { maxLength: 80 }),
    col('latitude', false, 'number', 'Decimal degrees.', '18.5590'),
    col('longitude', false, 'number', 'Decimal degrees.', '73.7868'),
    col('interest', false, 'text', 'What they want.', 'Gym mirror decals', { maxLength: 200 }),
    col('bestTimeFrom', false, 'text', 'HH:MM, when to call from.', '11:00'),
    col('bestTimeTo', false, 'text', 'HH:MM, when to call until.', '17:00'),
    col('estimatedCommission', false, 'money', 'Omit it and the platform quotes what it actually pays.', '1450'),
    col('assignedAgentId', false, 'text', 'An agent id to assign the lead to.', '', { maxLength: 64 }),
  ],
  rules: [
    'side and businessName are required; the batch carries one source.',
    'A phone or email already on a lead is DUPLICATE_LEAD; one already on an account is EXISTING_ACCOUNT; a malformed row is INVALID — each row is reported and the batch goes on.',
    'At most 500 rows per batch.',
    'dryRun answers the same report and writes nothing.',
  ],
  sampleRows: [
    { side: 'PUBLISHER', businessName: 'Sunrise Gym', category: 'Fitness', contactName: 'Kiran Desai', phone: '9876543210', email: 'kiran@sunrisegym.in', address: '3, Baner Road, Pune', locality: 'Baner', city: 'Pune', latitude: '18.5590', longitude: '73.7868', interest: 'Gym mirror decals', bestTimeFrom: '11:00', bestTimeTo: '17:00', estimatedCommission: '1450', assignedAgentId: '' },
    { side: 'ADVERTISER', businessName: 'Bake House', category: 'Food', contactName: '', phone: '9822098220', email: '', address: '', locality: 'Kothrud', city: 'Pune', latitude: '', longitude: '', interest: '', bestTimeFrom: '', bestTimeTo: '', estimatedCommission: '', assignedAgentId: '' },
  ],
  schemaKeys: () => keysOf(leadRowSchema),
  validate: (row) => jsonValidator(leadRowSchema, leads.columns)(row),
};

const marketData: Format = {
  kind: 'market-data',
  title: 'Market data (researched rates)',
  purpose: 'Observed rates for the pricing engine\'s comparable pools: one observation per row, classified by the same vocabulary listings use.',
  route: 'POST /api/v1/pricing/market-data/import — a JSON body { source, filename?, note?, publisherId?, rows } (the CSV template maps to rows column by column)',
  columns: [
    col('contributorName', true, 'text', 'Who observed the rate.', 'Field survey Sept', { maxLength: 160 }),
    col('venueTypeSlug', false, 'text', 'The venue the spot sits in, by slug; omit for outdoor.', 'gym', { maxLength: 80 }),
    col('publisherId', false, 'text', 'Set when the researched company is also an ADX publisher, so they count once.', ''),
    col('mediaTypeSlug', true, 'text', 'The media type, by slug.', 'hoarding', { maxLength: 80 }),
    col('sizeClassSlug', true, 'text', 'The size class, by slug.', '20x10', { maxLength: 80 }),
    col('materialSlug', false, 'text', 'The material, by slug.', 'flex', { maxLength: 80 }),
    col('latitude', true, 'number', 'Decimal degrees.', '18.5204'),
    col('longitude', true, 'number', 'Decimal degrees.', '73.8567'),
    col('city', false, 'text', 'The city.', 'Pune', { maxLength: 120 }),
    col('locality', false, 'text', 'The locality.', 'Deccan', { maxLength: 160 }),
    col('ratePerDay', true, 'money', 'The observed rate per day.', '1500'),
    col('observedAt', true, 'date', 'When it was observed (a date the platform can read).', '2026-09-01'),
  ],
  rules: [
    'contributorName, mediaTypeSlug, sizeClassSlug, latitude, longitude, ratePerDay and observedAt are required.',
    'Slugs must already be in the controlled lists; an unknown slug makes the row INVALID.',
    'At most 5000 rows per upload; the batch can be revoked afterwards.',
  ],
  sampleRows: [
    { contributorName: 'Field survey Sept', venueTypeSlug: '', publisherId: '', mediaTypeSlug: 'hoarding', sizeClassSlug: '20x10', materialSlug: 'flex', latitude: '18.5204', longitude: '73.8567', city: 'Pune', locality: 'Deccan', ratePerDay: '1500', observedAt: '2026-09-01' },
    { contributorName: 'Field survey Sept', venueTypeSlug: 'gym', publisherId: '', mediaTypeSlug: 'mirror-decal', sizeClassSlug: '2x3', materialSlug: '', latitude: '18.5590', longitude: '73.7868', city: 'Pune', locality: 'Baner', ratePerDay: '250', observedAt: '2026-09-02' },
  ],
  schemaKeys: () => keysOf(marketDataImportRowSchema),
  validate: (row) => jsonValidator(marketDataImportRowSchema, marketData.columns)(row),
};

const reconciliationColumns = () => Object.values(DEFAULT_COLUMNS).filter((name): name is string => Boolean(name));
const financeReconciliation: Format = {
  kind: 'finance-reconciliation',
  title: 'Bank statement (finance reconciliation)',
  purpose: 'A bank\'s statement export, read into lines the reconciliation desk matches against payouts and receipts. These are the default headings; a bank statement profile can rename them and set the date format.',
  route: 'POST /api/v1/finance/reconciliation/imports — a CSV under `file`, with bankAccountId and an optional profileId',
  columns: [
    col(DEFAULT_COLUMNS.date, true, 'date', 'The value date, dd/MM/yyyy by default (the profile can set the format).', '01/09/2026'),
    col(DEFAULT_COLUMNS.description, true, 'text', 'The narration.', 'NEFT ADX PAYOUT 8821'),
    col(DEFAULT_COLUMNS.utr!, false, 'text', 'The bank reference / UTR.', 'N245261234567'),
    col(DEFAULT_COLUMNS.debit!, false, 'money', 'Money out. Give debit and credit, or one signed amount column.', ''),
    col(DEFAULT_COLUMNS.credit!, false, 'money', 'Money in.', '12500.00'),
    col(DEFAULT_COLUMNS.balance!, false, 'money', 'The running balance.', '1,52,300.50'),
  ],
  rules: [
    'A row needs a date, a narration and money on one side (Debit or Credit); the file is read from the first row that carries the Date and Description headings.',
    'Amounts may carry commas, ₹, brackets or a Dr/Cr suffix.',
    'A line already imported (same date, narration, amount and direction) is one line, not two.',
    'An unreadable row is reported with its number and the rest of the file still imports.',
  ],
  sampleRows: [
    { [DEFAULT_COLUMNS.date]: '01/09/2026', [DEFAULT_COLUMNS.description]: 'NEFT ADX PAYOUT 8821', [DEFAULT_COLUMNS.utr!]: 'N245261234567', [DEFAULT_COLUMNS.debit!]: '', [DEFAULT_COLUMNS.credit!]: '12500.00', [DEFAULT_COLUMNS.balance!]: '1,52,300.50' },
    { [DEFAULT_COLUMNS.date]: '02/09/2026', [DEFAULT_COLUMNS.description]: 'UPI PRINT PARTNER 4410', [DEFAULT_COLUMNS.utr!]: '', [DEFAULT_COLUMNS.debit!]: '3200.00', [DEFAULT_COLUMNS.credit!]: '', [DEFAULT_COLUMNS.balance!]: '1,49,100.50' },
  ],
  schemaKeys: reconciliationColumns,
  validate: (row) => {
    const header = reconciliationColumns();
    const parsed = parseStatement(formatCsv([header, header.map((name) => row[name] ?? '')]));
    return parsed.problems[0]?.problem ?? (parsed.lines.length === 1 ? null : 'no line read');
  },
};

const FORMATS: Record<FormatKind, Format> = {
  publishers,
  advertisers,
  agents,
  'print-partners': printPartners,
  employees,
  listings,
  'rate-card': rateCard,
  leads,
  'market-data': marketData,
  'finance-reconciliation': financeReconciliation,
};

const formatOf = (kind: string): Format => {
  const found = (FORMATS as Record<string, Format | undefined>)[kind];
  if (!found) throw new ApiError(404, 'NOT_FOUND', `No import kind "${kind}"; one of ${FORMAT_KINDS.join(', ')}`);
  return found;
};

const toGuide = ({ schemaKeys: _keys, validate: _validate, ...guide }: Format): ImportFormat => ({ ...guide, templateCsvUrl: templateUrl(guide.kind) });

/** GET /party-imports/formats — every kind. */
export const formatGuides = (): ImportFormat[] => FORMAT_KINDS.map((kind) => toGuide(FORMATS[kind]));

/** GET /party-imports/formats/:kind — one kind; 404 for a word that is not one. */
export const formatGuide = (kind: FormatKind | string): ImportFormat => toGuide(formatOf(kind));

/** GET /party-imports/formats/:kind/template.csv — the header row and the two sample rows. */
export function templateCsv(kind: FormatKind | string): string {
  const format = formatOf(kind);
  const header = format.columns.map((column) => column.name);
  return formatCsv([header, ...format.sampleRows.map((row) => header.map((name) => row[name] ?? ''))]);
}

/** The validator's keys for a kind — what the contract test compares the guide against. */
export const schemaKeysOf = (kind: FormatKind): readonly string[] => FORMATS[kind].schemaKeys();

/** One sample row through the kind's validator: null when it passes, else the first problem. */
export const validateSample = (kind: FormatKind, row: Record<string, string>): string | null => FORMATS[kind].validate(row);

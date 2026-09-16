import type { Request } from 'express';
import type { z } from 'zod';
import type { ImportParty } from '../../shared/database';
import { auditDiff, logActivity } from '../../shared/audit';
import { registerAdvertiser, updateProfile as updateAdvertiserProfile } from '../advertisers';
import { createAgent, updateAgent } from '../agents';
import { createPartner, updatePartner } from '../print-partners';
import { createEmployee, updateEmployee } from '../employees';
import { createUser } from '../users';
import { prismaPartyImportsRepository as repository } from './prisma-party-imports.repository';
import type { MatchSet, MatchedParty } from './party-imports.repository';
import {
  ADVERTISER_COLUMNS,
  AGENT_COLUMNS,
  EMPLOYEE_COLUMNS,
  PRINT_PARTNER_COLUMNS,
  advertiserRowSchema,
  agentRowSchema,
  employeeRowSchema,
  printPartnerRowSchema,
  type ParsedRow,
  type PartyKey,
} from './party-imports.schema';

/**
 * Lot S — one adapter per party. The importer never writes a party row: a
 * CREATE goes through the party's own creation service (display ids,
 * wallets, brands, users, roles, kycStatus PENDING — everything a console
 * Create does), a MERGE through its update service, and each is audited
 * under the action the console's handler would have used, with the import
 * and the row in the metadata.
 */

/** The row's columns as strings, mobile aside. */
export type Fields = Record<string, string>;

export type CommitContext = {
  byUserId: string;
  req?: Request | undefined;
  importId: string;
  rowNumber: number;
};

/** T-B: `userId` for the parties whose console page takes the account id (employees) — the row carries it as `targetUserId`. */
export type Created = { id: string; displayId: string | null; userId?: string | null };

export interface PartyAdapter {
  key: PartyKey;
  party: ImportParty;
  /** The file's header, in report order. */
  columns: readonly string[];
  rowSchema: z.ZodType<unknown>;
  /** Columns a merge may fill when the party has them empty. */
  mergeable: readonly string[];
  /** Columns the file may carry that the party keeps nowhere the importer can write — reported, never written. */
  unwritten: readonly string[];
  /** The label a message uses: "advertiser", "agent" … */
  noun: string;
  /** Whether the create makes a User — then an email already on an account, or twice in the batch, cannot create. */
  uniqueEmail: boolean;
  match(rows: ParsedRow[]): Promise<MatchSet>;
  create(row: ParsedRow, ctx: CommitContext): Promise<Created>;
  merge(target: MatchedParty, fill: Fields, ctx: CommitContext): Promise<void>;
}

const unique = <T>(values: (T | undefined | null)[]): T[] => [...new Set(values.filter((value): value is T => value !== undefined && value !== null && value !== ''))];

const meta = (ctx: CommitContext, extra: Record<string, unknown> = {}) => ({ importId: ctx.importId, rowNumber: ctx.rowNumber, ...extra });

/* ── Advertisers ───────────────────────────────────────────────────────── */

const advertisers: PartyAdapter = {
  key: 'advertisers',
  party: 'ADVERTISER',
  columns: ADVERTISER_COLUMNS,
  rowSchema: advertiserRowSchema,
  mergeable: ['name', 'email', 'type', 'companyName', 'industry', 'gstin', 'address', 'city', 'state'],
  // The PAN lives on the KYC record, which only a submission writes; there is no contact-name column.
  unwritten: ['panNumber', 'contactName'],
  noun: 'advertiser',
  uniqueEmail: false,
  match: (rows) =>
    repository.matchAdvertisers({
      mobiles: unique(rows.map((row) => row.mobile)),
      pans: unique(rows.map((row) => row['panNumber'])),
      gstins: unique(rows.map((row) => row['gstin'])),
    }),
  async create(row, ctx) {
    // The console's Create for someone with no app account: no user, no
    // agent. `registerAdvertiser` mints the identifier, the wallet and the
    // brand and leaves kycStatus at its PENDING default.
    const advertiser = await registerAdvertiser({
      name: row['name'] ?? row.mobile,
      mobile: row.mobile,
      email: row['email'] ?? null,
      ...(row['type'] ? { type: row['type'] as 'INDIVIDUAL' | 'COMMERCIAL' | 'NGO' | 'AGENCY' } : {}),
      companyName: row['companyName'] ?? null,
      gstin: row['gstin'] ?? null,
      billingAddress: row['address'] ?? null,
      city: row['city'] ?? null,
      state: row['state'] ?? null,
      industry: row['industry'] ?? null,
      userId: null,
      agentId: null,
    });
    await logActivity(ctx.byUserId, 'ADVERTISER_CREATED', {
      req: ctx.req,
      module: 'party-imports',
      targetType: 'Advertiser',
      targetId: advertiser.id,
      metadata: meta(ctx, { displayId: advertiser.displayId, name: advertiser.name, mobile: advertiser.mobile, source: 'import' }),
    });
    return { id: advertiser.id, displayId: advertiser.displayId };
  },
  async merge(target, fill, ctx) {
    const { address, type, ...rest } = fill;
    const after = await updateAdvertiserProfile(target.id, {
      ...rest,
      ...(address !== undefined ? { billingAddress: address } : {}),
      ...(type !== undefined ? { type: type as 'INDIVIDUAL' | 'COMMERCIAL' | 'NGO' | 'AGENCY' } : {}),
    });
    await logActivity(ctx.byUserId, 'ADVERTISER_PROFILE_UPDATED', {
      req: ctx.req,
      module: 'party-imports',
      targetType: 'Advertiser',
      targetId: after.id,
      diff: auditDiff(target.fields, { ...target.fields, ...fill }),
      metadata: meta(ctx, { source: 'import', fields: Object.keys(fill) }),
    });
  },
};

/* ── Agents ────────────────────────────────────────────────────────────── */

const agents: PartyAdapter = {
  key: 'agents',
  party: 'AGENT',
  columns: AGENT_COLUMNS,
  rowSchema: agentRowSchema,
  // Name and email are the User's; the profile's own columns are the two below.
  mergeable: ['city', 'state'],
  unwritten: [],
  noun: 'agent',
  uniqueEmail: true,
  match: (rows) =>
    repository.matchAgents({
      mobiles: unique(rows.map((row) => row.mobile)),
      emails: unique(rows.map((row) => row['email'])),
    }),
  async create(row, ctx) {
    // The desk's Create: a new number gets a user, a role and a profile in
    // one write; a number that already belongs to somebody gains the role
    // and a profile. The side is validated as required at planning.
    const agent = await createAgent({
      mobile: row.mobile,
      name: row['name'] ?? row.mobile,
      ...(row['email'] ? { email: row['email'] } : {}),
      side: row['side'] as 'PUBLISHER' | 'ADVERTISER',
      ...(row['city'] ? { city: row['city'] } : {}),
      ...(row['state'] ? { state: row['state'] } : {}),
    });
    await logActivity(ctx.byUserId, 'AGENT_CREATED', {
      req: ctx.req,
      module: 'party-imports',
      targetType: 'AgentProfile',
      targetId: agent.id,
      metadata: meta(ctx, { displayId: agent.displayId, mobile: row.mobile, side: row['side'], source: 'import' }),
    });
    return { id: agent.id, displayId: agent.displayId };
  },
  async merge(target, fill, ctx) {
    await updateAgent(target.id, { ...(fill['city'] ? { city: fill['city'] } : {}), ...(fill['state'] ? { state: fill['state'] } : {}) });
    await logActivity(ctx.byUserId, 'AGENT_UPDATED', {
      req: ctx.req,
      module: 'party-imports',
      targetType: 'AgentProfile',
      targetId: target.id,
      diff: auditDiff(target.fields, { ...target.fields, ...fill }),
      metadata: meta(ctx, { source: 'import', fields: Object.keys(fill) }),
    });
  },
};

/* ── Print partners ────────────────────────────────────────────────────── */

const splitCapabilities = (value: string | undefined): string[] => (value ? value.split('|').map((part) => part.trim()).filter(Boolean) : []);

const printPartners: PartyAdapter = {
  key: 'print-partners',
  party: 'PRINT_PARTNER',
  columns: PRINT_PARTNER_COLUMNS,
  rowSchema: printPartnerRowSchema,
  mergeable: ['name', 'legalName', 'gstin', 'panNumber', 'contactName', 'email', 'address', 'city', 'capabilities', 'maxWidthFt', 'turnaroundDays'],
  unwritten: [],
  noun: 'print partner',
  uniqueEmail: true,
  match: (rows) =>
    repository.matchPrintPartners({
      mobiles: unique(rows.map((row) => row.mobile)),
      pans: unique(rows.map((row) => row['panNumber'])),
      gstins: unique(rows.map((row) => row['gstin'])),
      emails: unique(rows.map((row) => row['email'])),
    }),
  async create(row, ctx) {
    // The desk's Create: the sign-in-disabled User, the identifier, the wallet.
    const partner = await createPartner({
      name: row['name'] ?? row.mobile,
      mobile: row.mobile,
      legalName: row['legalName'] ?? null,
      gstin: row['gstin'] ?? null,
      panNumber: row['panNumber'] ?? null,
      contactName: row['contactName'] ?? null,
      email: row['email'] ?? null,
      address: row['address'] ?? null,
      city: row['city'] ?? null,
      capabilities: splitCapabilities(row['capabilities']),
      maxWidthFt: row['maxWidthFt'] ?? null,
      turnaroundDays: row['turnaroundDays'] ? Number(row['turnaroundDays']) : null,
    });
    await logActivity(ctx.byUserId, 'PRINT_PARTNER_CREATED', {
      req: ctx.req,
      module: 'party-imports',
      targetType: 'PrintPartner',
      targetId: partner.id,
      metadata: meta(ctx, { displayId: partner.displayId, name: partner.name, city: partner.city, userId: partner.userId, source: 'import' }),
    });
    return { id: partner.id, displayId: partner.displayId };
  },
  async merge(target, fill, ctx) {
    const { capabilities, turnaroundDays, ...rest } = fill;
    const { before, after } = await updatePartner(target.id, {
      ...rest,
      ...(capabilities !== undefined ? { capabilities: splitCapabilities(capabilities) } : {}),
      ...(turnaroundDays !== undefined ? { turnaroundDays: Number(turnaroundDays) } : {}),
    });
    await logActivity(ctx.byUserId, 'PRINT_PARTNER_UPDATED', {
      req: ctx.req,
      module: 'party-imports',
      targetType: 'PrintPartner',
      targetId: after.id,
      diff: auditDiff(before, after),
      metadata: meta(ctx, { source: 'import', fields: Object.keys(fill) }),
    });
  },
};

/* ── Employees ─────────────────────────────────────────────────────────── */

const employees: PartyAdapter = {
  key: 'employees',
  party: 'EMPLOYEE',
  columns: EMPLOYEE_COLUMNS,
  rowSchema: employeeRowSchema,
  // Name and email are the User's; the record's own columns are the five below.
  mergeable: ['department', 'designation', 'region', 'workMode', 'employmentType'],
  unwritten: [],
  noun: 'employee',
  uniqueEmail: true,
  match: (rows) =>
    repository.matchEmployees({
      mobiles: unique(rows.map((row) => row.mobile)),
      emails: unique(rows.map((row) => row['email'])),
    }),
  async create(row, ctx) {
    // An employee needs a User first. A number already on an account (with
    // no employee record — a matched one merged instead) gets the record
    // against that account; a new number gets the User the way POST /users
    // makes it, with no role: console access comes from an invitation.
    let userId = (await repository.findUserByMobile(row.mobile))?.id ?? null;
    if (!userId) {
      const user = await createUser({
        mobile: row.mobile,
        ...(row['name'] ? { name: row['name'] } : {}),
        ...(row['email'] ? { email: row['email'] } : {}),
        roles: [],
      });
      userId = user.id;
      await logActivity(user.id, 'USER_CREATED_BY_ADMIN', {
        req: ctx.req,
        module: 'party-imports',
        targetType: 'User',
        targetId: user.id,
        diff: auditDiff(null, { mobile: user.mobile, name: user.name, email: user.email, roles: [] }),
        metadata: meta(ctx, { createdBy: ctx.byUserId, roles: [], source: 'import' }),
      });
    }
    const { employee } = await createEmployee({
      userId,
      ...(row['department'] ? { department: row['department'] } : {}),
      ...(row['designation'] ? { designation: row['designation'] } : {}),
      ...(row['region'] ? { region: row['region'] } : {}),
      ...(row['workMode'] ? { workMode: row['workMode'] as 'OFFICE' | 'REMOTE' | 'HYBRID' | 'FIELD' } : {}),
      ...(row['employmentType'] ? { employmentType: row['employmentType'] as 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERN' } : {}),
    });
    await logActivity(ctx.byUserId, 'EMPLOYEE_CREATED', {
      req: ctx.req,
      module: 'party-imports',
      targetType: 'Employee',
      targetId: employee.id,
      metadata: meta(ctx, { userId: employee.userId, displayId: employee.displayId, source: 'import' }),
    });
    return { id: employee.id, displayId: employee.displayId, userId: employee.userId };
  },
  async merge(target, fill, ctx) {
    if (!target.userId) throw new Error('An employee match carries its user id');
    const { workMode, employmentType, ...rest } = fill;
    const { before, after } = await updateEmployee(target.userId, {
      ...rest,
      ...(workMode !== undefined ? { workMode: workMode as 'OFFICE' | 'REMOTE' | 'HYBRID' | 'FIELD' } : {}),
      ...(employmentType !== undefined ? { employmentType: employmentType as 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERN' } : {}),
    });
    await logActivity(ctx.byUserId, 'EMPLOYEE_UPDATED', {
      req: ctx.req,
      module: 'party-imports',
      targetType: 'Employee',
      targetId: after.id,
      diff: auditDiff(before, after, ['department', 'departmentId', 'designation', 'region', 'workMode', 'employmentType']),
      metadata: meta(ctx, { userId: after.userId, source: 'import', fields: Object.keys(fill) }),
    });
  },
};

export const ADAPTERS: Record<PartyKey, PartyAdapter> = { advertisers, agents, 'print-partners': printPartners, employees };

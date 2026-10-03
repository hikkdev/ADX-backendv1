import { randomBytes } from 'crypto';
import type { CheckStatus, CheckType, ErrorClass, VerificationCaseType, VerificationProviderName } from './checks';
import type { SessionStatus, SessionStep } from './composites';

/**
 * The verification layer's ports — Cashfree Phase 1.
 *
 * The router records every attempt, the sessions keep Cashfree's composite
 * runs, the events de-duplicate webhooks. Each is a port so the layer runs
 * the same against Postgres (`prisma-stores.ts`, wired by bootstrap) and
 * against memory — which is what an unwired process and every unit test
 * gets, so a test of a KYC service never writes to anybody's database.
 */

export type AttemptRecord = {
  id: string;
  caseType: VerificationCaseType;
  caseId: string;
  sessionId: string | null;
  checkType: CheckType;
  provider: VerificationProviderName;
  attemptNo: number;
  /** Sent to the provider as `verification_id` — the row's own id. */
  verificationId: string;
  status: CheckStatus;
  errorClass: ErrorClass | null;
  failureCode: string | null;
  latencyMs: number | null;
  providerRef: string | null;
  nameMatchScore: number | null;
  result: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AttemptOpen = { caseType: VerificationCaseType; caseId: string; sessionId?: string | null | undefined; checkType: CheckType; provider: VerificationProviderName };
export type AttemptOutcome = {
  status: CheckStatus;
  errorClass?: ErrorClass | null | undefined;
  failureCode?: string | null | undefined;
  latencyMs?: number | null | undefined;
  providerRef?: string | null | undefined;
  nameMatchScore?: number | null | undefined;
  result?: Record<string, unknown> | null | undefined;
};

export interface AttemptStore {
  /** A PENDING row with its number in the case's run of this check; its id is the `verification_id`. */
  open(input: AttemptOpen): Promise<AttemptRecord>;
  close(id: string, outcome: AttemptOutcome): Promise<AttemptRecord>;
  /** The technical failure that sent the router on: who was tried next. */
  markFailedOver(id: string, to: VerificationProviderName): Promise<void>;
  find(id: string): Promise<AttemptRecord | null>;
  findByProviderRef(provider: VerificationProviderName, checkType: CheckType, providerRef: string): Promise<AttemptRecord | null>;
  listForCase(caseType: VerificationCaseType, caseId: string, limit?: number): Promise<AttemptRecord[]>;
  /** Attempts still waiting on the person or the provider, oldest first — for the sweep. */
  listUnfinished(checkTypes: readonly CheckType[], limit: number): Promise<AttemptRecord[]>;
  /** Everything since a moment, newest first — for the health read. */
  listSince(since: Date, limit: number): Promise<AttemptRecord[]>;
}

export type SessionSubject = {
  /** The name the checks compare against — the party's as ADX holds it. */
  name: string;
  party: 'PUBLISHER' | 'ADVERTISER' | 'AGENT' | 'PRINT_PARTNER' | 'EMPLOYEE';
  /** True for a business: the reference name for the bank account is the entity's, from its PAN or GSTIN. */
  business: boolean;
  /** The name the identity step gave (DigiLocker), and the name the entity's PAN / GSTIN gave. Names only. */
  identityName?: string | null | undefined;
  entityName?: string | null | undefined;
};

export type SessionRecord = {
  id: string;
  caseType: VerificationCaseType;
  caseId: string;
  workflowKey: string | null;
  provider: VerificationProviderName;
  ownerUserId: string | null;
  subject: SessionSubject | null;
  steps: SessionStep[];
  status: SessionStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionCreate = Pick<SessionRecord, 'caseType' | 'caseId' | 'workflowKey' | 'provider' | 'ownerUserId' | 'subject' | 'steps' | 'status' | 'expiresAt'>;

export interface SessionStore {
  create(input: SessionCreate): Promise<SessionRecord>;
  find(id: string): Promise<SessionRecord | null>;
  update(id: string, patch: Partial<Pick<SessionRecord, 'steps' | 'status' | 'subject' | 'ownerUserId'>>): Promise<SessionRecord>;
  /** The newest session of a case that may still be acted on, if there is one. */
  findOpenForCase(caseType: VerificationCaseType, caseId: string): Promise<SessionRecord | null>;
  listForCase(caseType: VerificationCaseType, caseId: string): Promise<SessionRecord[]>;
  /** A login's sessions that may still be acted on, newest first — how a person finds their way back to one. */
  listOpenForOwner(ownerUserId: string): Promise<SessionRecord[]>;
  /** Open sessions past their time — for the sweep to close. */
  listOverdue(now: Date, limit: number): Promise<SessionRecord[]>;
}

export interface ProviderEventStore {
  /** True the first time an event is seen; false for a repeat (the provider's retry, or the same event sent twice). */
  claim(provider: VerificationProviderName, eventId: string, eventType: string | null): Promise<{ fresh: boolean; id: string | null }>;
  finish(id: string, outcome: string): Promise<void>;
}

/** 32 characters, letters and digits only — within every limit Cashfree puts on an id of ours (`verification_id` ≤ 50, `user_id` ≤ 40). */
export function newVerificationId(): string {
  return `va${randomBytes(15).toString('hex')}`;
}

/* ── memory ────────────────────────────────────────────────────── */

export function memoryAttemptStore(): AttemptStore & { rows: AttemptRecord[] } {
  const rows: AttemptRecord[] = [];
  const must = (id: string): AttemptRecord => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`No verification attempt ${id}`);
    return row;
  };
  return {
    rows,
    async open(input) {
      const id = newVerificationId();
      const now = new Date();
      const row: AttemptRecord = {
        id,
        caseType: input.caseType,
        caseId: input.caseId,
        sessionId: input.sessionId ?? null,
        checkType: input.checkType,
        provider: input.provider,
        attemptNo: rows.filter((r) => r.caseType === input.caseType && r.caseId === input.caseId && r.checkType === input.checkType).length + 1,
        verificationId: id,
        status: 'PENDING',
        errorClass: null,
        failureCode: null,
        latencyMs: null,
        providerRef: null,
        nameMatchScore: null,
        result: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(row);
      return { ...row };
    },
    async close(id, outcome) {
      const row = must(id);
      Object.assign(row, {
        status: outcome.status,
        errorClass: outcome.errorClass ?? null,
        failureCode: outcome.failureCode ?? null,
        ...(outcome.latencyMs !== undefined ? { latencyMs: outcome.latencyMs } : {}),
        ...(outcome.providerRef !== undefined ? { providerRef: outcome.providerRef } : {}),
        ...(outcome.nameMatchScore !== undefined ? { nameMatchScore: outcome.nameMatchScore } : {}),
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        updatedAt: new Date(),
      });
      return { ...row };
    },
    async markFailedOver(id, to) {
      const row = must(id);
      row.result = { ...(row.result ?? {}), failedOverTo: to };
    },
    async find(id) {
      const row = rows.find((candidate) => candidate.id === id);
      return row ? { ...row } : null;
    },
    async findByProviderRef(provider, checkType, providerRef) {
      const row = [...rows].reverse().find((r) => r.provider === provider && r.checkType === checkType && r.providerRef === providerRef);
      return row ? { ...row } : null;
    },
    async listForCase(caseType, caseId, limit = 200) {
      return rows.filter((r) => r.caseType === caseType && r.caseId === caseId).slice(-limit).reverse().map((r) => ({ ...r }));
    },
    async listUnfinished(checkTypes, limit) {
      return rows.filter((r) => (r.status === 'PENDING' || r.status === 'NEEDS_USER_ACTION') && checkTypes.includes(r.checkType)).slice(0, limit).map((r) => ({ ...r }));
    },
    async listSince(since, limit) {
      return rows.filter((r) => r.createdAt >= since).slice(-limit).reverse().map((r) => ({ ...r }));
    },
  };
}

export function memorySessionStore(): SessionStore & { rows: SessionRecord[] } {
  const rows: SessionRecord[] = [];
  let seq = 0;
  const live = (status: SessionStatus) => status === 'OPEN' || status === 'NEEDS_USER_ACTION';
  return {
    rows,
    async create(input) {
      const now = new Date();
      seq += 1;
      const row: SessionRecord = { id: `vs_${seq}_${randomBytes(4).toString('hex')}`, ...input, createdAt: now, updatedAt: now };
      rows.push(row);
      return { ...row };
    },
    async find(id) {
      const row = rows.find((candidate) => candidate.id === id);
      return row ? { ...row } : null;
    },
    async update(id, patch) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Error(`No verification session ${id}`);
      Object.assign(row, patch, { updatedAt: new Date() });
      return { ...row };
    },
    async findOpenForCase(caseType, caseId) {
      const row = [...rows].reverse().find((r) => r.caseType === caseType && r.caseId === caseId && live(r.status));
      return row ? { ...row } : null;
    },
    async listForCase(caseType, caseId) {
      return rows.filter((r) => r.caseType === caseType && r.caseId === caseId).reverse().map((r) => ({ ...r }));
    },
    async listOpenForOwner(ownerUserId) {
      return rows.filter((r) => r.ownerUserId === ownerUserId && live(r.status)).reverse().map((r) => ({ ...r }));
    },
    async listOverdue(now, limit) {
      return rows.filter((r) => live(r.status) && r.expiresAt <= now).slice(0, limit).map((r) => ({ ...r }));
    },
  };
}

export function memoryEventStore(): ProviderEventStore & { rows: { id: string; provider: string; eventId: string; eventType: string | null; outcome: string | null }[] } {
  const rows: { id: string; provider: string; eventId: string; eventType: string | null; outcome: string | null }[] = [];
  return {
    rows,
    async claim(provider, eventId, eventType) {
      if (rows.some((row) => row.provider === provider && row.eventId === eventId)) return { fresh: false, id: null };
      const id = `pe_${rows.length + 1}`;
      rows.push({ id, provider, eventId, eventType, outcome: null });
      return { fresh: true, id };
    },
    async finish(id, outcome) {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) row.outcome = outcome;
    },
  };
}

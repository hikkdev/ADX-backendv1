import { describe, expect, it } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026) — one meaning per word. The pure check and
 * the where-fragments every desk reads: the precedence the pills follow, the
 * fragments that partition each table the same way, the `?include=inactive`
 * switch, and the two 409s a closed or blocked party meets.
 */

import {
  AGENT_DEAD_END_STAGES,
  accountStateOf,
  advertiserStateWhere,
  agentStateWhere,
  assertNotClosed,
  assertOpenForKyc,
  includesInactive,
  isWorkingAccount,
  isWorkingAgent,
  isWorkingUser,
  publisherStateWhere,
  workingAgentWhere,
  workingEmployeeWhere,
  workingPrintPartnerWhere,
  workingPublisherWhere,
  workingUserWhere,
} from '..';

const user = (over: Partial<{ isActive: boolean; closedAt: Date | null }> = {}) => ({ isActive: true, closedAt: null, ...over });
const CLOSED = new Date('2026-09-30T00:00:00Z');

describe('accountStateOf — the precedence the pills follow', () => {
  it('reads a working party ACTIVE, and a party nobody signs in to yet ACTIVE too', () => {
    expect(accountStateOf({ user: user(), suspensionScopes: [] })).toBe('ACTIVE');
    expect(accountStateOf({ user: null, suspensionScopes: [] })).toBe('ACTIVE');
  });

  it('puts EXITED first, then CLOSED', () => {
    expect(accountStateOf({ stage: 'EXITED', status: 'SUSPENDED', user: user({ closedAt: CLOSED }) })).toBe('EXITED');
    expect(accountStateOf({ user: user({ closedAt: CLOSED, isActive: false }), suspensionScopes: ['BLOCK_NEW', 'BLOCK_SIGNIN'] })).toBe('CLOSED');
    // A print partner carries its closure beside the row.
    expect(accountStateOf({ isActive: false, closedAt: CLOSED })).toBe('CLOSED');
  });

  it('reads the row switch off as DEACTIVATED (print partner, employee)', () => {
    expect(accountStateOf({ isActive: false })).toBe('DEACTIVATED');
    expect(accountStateOf({ isActive: true, user: user({ isActive: false }) })).toBe('DEACTIVATED');
  });

  it('tells a sign-in suspension from a deactivation, even with the cascade BLOCK_NEW', () => {
    expect(accountStateOf({ user: user({ isActive: false }), suspensionScopes: ['BLOCK_SIGNIN'] })).toBe('SUSPENDED');
    // A user Deactivate puts BLOCK_NEW on the profile too — it still reads DEACTIVATED.
    expect(accountStateOf({ user: user({ isActive: false }), suspensionScopes: ['BLOCK_NEW'] })).toBe('DEACTIVATED');
  });

  it('reads BLOCK_NEW, or an agent status SUSPENDED, as SUSPENDED; a frozen wallet alone is still ACTIVE', () => {
    expect(accountStateOf({ user: user(), suspensionScopes: ['BLOCK_NEW'] })).toBe('SUSPENDED');
    expect(accountStateOf({ user: user(), suspensionScopes: [], status: 'SUSPENDED', stage: 'ACTIVE' })).toBe('SUSPENDED');
    expect(accountStateOf({ user: user(), suspensionScopes: ['FREEZE_WALLET'] })).toBe('ACTIVE');
  });

  it('a working agent is ACTIVE, through the ladder and switched on', () => {
    const agent = { user: user(), suspensionScopes: [], stage: 'ACTIVE', status: 'ACTIVE' };
    expect(isWorkingAgent(agent)).toBe(true);
    expect(isWorkingAgent({ ...agent, status: 'ON_LEAVE' })).toBe(false);
    expect(isWorkingAgent({ ...agent, stage: 'TRAINING' })).toBe(false);
    expect(isWorkingAgent({ ...agent, user: user({ closedAt: CLOSED }) })).toBe(false);
    expect(isWorkingAccount({ ...agent, status: 'ON_LEAVE' })).toBe(true);
  });

  it('a working user signs in and is not closed', () => {
    expect(isWorkingUser(user())).toBe(true);
    expect(isWorkingUser(user({ isActive: false }))).toBe(false);
    expect(isWorkingUser(user({ closedAt: CLOSED }))).toBe(false);
  });
});

describe('the where-fragments', () => {
  it('a working user is isActive and never closed', () => {
    expect(workingUserWhere()).toEqual({ isActive: true, closedAt: null });
  });

  it('a working publisher: no BLOCK_NEW, and no account or one that signs in', () => {
    expect(workingPublisherWhere()).toEqual({
      AND: [{ OR: [{ userId: null }, { user: { is: { isActive: true, closedAt: null } } }] }, { NOT: { suspensionScopes: { has: 'BLOCK_NEW' } } }],
    });
    expect(publisherStateWhere('ACTIVE')).toEqual(workingPublisherWhere());
    expect(advertiserStateWhere('CLOSED')).toEqual({ user: { is: { closedAt: { not: null } } } });
  });

  it('the publisher fragments tell a sign-in suspension from a deactivation, as the pills do', () => {
    expect(publisherStateWhere('DEACTIVATED')).toEqual({
      AND: [{ user: { is: { closedAt: null, isActive: false } } }, { NOT: { suspensionScopes: { has: 'BLOCK_SIGNIN' } } }],
    });
    expect(publisherStateWhere('SUSPENDED')).toMatchObject({ OR: [{ AND: [{ user: { is: { closedAt: null, isActive: false } } }, { suspensionScopes: { has: 'BLOCK_SIGNIN' } }] }, expect.anything()] });
  });

  it('agents: EXITED is its own state, every other one excludes it', () => {
    expect(agentStateWhere('EXITED')).toEqual({ stage: 'EXITED' });
    for (const state of ['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'CLOSED'] as const) {
      expect((agentStateWhere(state).AND as object[])[0]).toEqual({ stage: { not: 'EXITED' } });
    }
  });

  it('an agent offered work: the ACTIVE account, stage ACTIVE and status ACTIVE', () => {
    expect(workingAgentWhere()).toEqual({ AND: [agentStateWhere('ACTIVE'), { stage: 'ACTIVE' }, { status: 'ACTIVE' }] });
    expect(AGENT_DEAD_END_STAGES).toEqual(['REJECTED', 'WITHDRAWN', 'EXITED']);
  });

  it('a print partner is its switch; an employee its switch and an account that signs in', () => {
    expect(workingPrintPartnerWhere()).toEqual({ isActive: true });
    expect(workingEmployeeWhere()).toEqual({ isActive: true, user: { isActive: true, closedAt: null } });
  });
});

describe('?include=inactive', () => {
  it('reads the word in any case, alone, in a comma list or repeated', () => {
    expect(includesInactive('inactive')).toBe(true);
    expect(includesInactive('INACTIVE')).toBe(true);
    expect(includesInactive('kyc, inactive')).toBe(true);
    expect(includesInactive(['kyc', 'inactive'])).toBe(true);
  });

  it('ignores anything else rather than refusing it', () => {
    expect(includesInactive(undefined)).toBe(false);
    expect(includesInactive('')).toBe(false);
    expect(includesInactive('all')).toBe(false);
    expect(includesInactive(1)).toBe(false);
  });
});

describe('the doors a closed or blocked party does not come through', () => {
  it('KYC is never asked of a closed account — 409 ACCOUNT_CLOSED', () => {
    expect(() => assertOpenForKyc({ closedAt: CLOSED, suspensionScopes: [] })).toThrow(expect.objectContaining({ statusCode: 409, code: 'ACCOUNT_CLOSED' }));
  });

  it('nor of one suspended from new work — 409 ACCOUNT_SUSPENDED', () => {
    expect(() => assertOpenForKyc({ closedAt: null, suspensionScopes: ['BLOCK_NEW'] })).toThrow(expect.objectContaining({ statusCode: 409, code: 'ACCOUNT_SUSPENDED' }));
  });

  it('a frozen wallet or a working account is asked as ever', () => {
    expect(() => assertOpenForKyc({ closedAt: null, suspensionScopes: ['FREEZE_WALLET'] })).not.toThrow();
    expect(() => assertOpenForKyc({})).not.toThrow();
  });

  it('reactivation refuses a closed account', () => {
    expect(() => assertNotClosed(CLOSED)).toThrow(expect.objectContaining({ statusCode: 409, code: 'ACCOUNT_CLOSED' }));
    expect(() => assertNotClosed(null)).not.toThrow();
  });
});

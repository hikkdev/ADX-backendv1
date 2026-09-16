import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A verifier finding (d): a password reset revoked refresh tokens only.
 *
 * An access token is a signed claim and outlives the row it came from, so an
 * attacker holding one kept the console for up to its whole lifetime after
 * the victim reset their password. The reset now goes through
 * `revokeSessions`, which also writes the revocation marker
 * `authenticate()` reads — the same thing a deactivation and a role change
 * already did.
 */

const { repository, tokens, audit, password, security, twoFactor } = vi.hoisted(() => ({
  repository: {
    setPasswordHash: vi.fn(),
    findByEmail: vi.fn(),
    findLoginUserByEmail: vi.fn(),
    findById: vi.fn(),
  },
  tokens: { revokeSessions: vi.fn(), revokeAllRefreshTokens: vi.fn() },
  audit: { logActivity: vi.fn() },
  password: {
    consumePasswordResetToken: vi.fn(),
    createPasswordResetToken: vi.fn(),
    hashPassword: vi.fn(),
    verifyPassword: vi.fn(),
  },
  security: { assertAccountNotLocked: vi.fn(), clearFailedLogins: vi.fn(), registerFailedLogin: vi.fn() },
  twoFactor: { isAdmin: vi.fn(), issueChallenge: vi.fn() },
}));

vi.mock('../../prisma-auth.repository', () => ({ prismaAuthRepository: repository }));
vi.mock('../../tokens/tokens.service', () => tokens);
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../password.service', () => password);
vi.mock('../login-security.service', () => security);
vi.mock('../../two-factor/two-factor.service', () => twoFactor);
vi.mock('../../auth.session', () => ({ sessionMeta: vi.fn(), startSession: vi.fn() }));
vi.mock('../../../../shared/email', () => ({ passwordResetEmail: vi.fn(), sendEmail: vi.fn() }));

import { resetPasswordHandler } from '../password.controller';

const response = () => {
  const res: Record<string, unknown> = {};
  res['status'] = vi.fn(() => res);
  res['json'] = vi.fn(() => res);
  return res as never;
};

beforeEach(() => {
  vi.clearAllMocks();
  password.consumePasswordResetToken.mockResolvedValue('usr_1');
  password.hashPassword.mockResolvedValue('hash');
});

describe('resetting a password', () => {
  it('ends every session — refresh tokens and the access tokens still in flight', async () => {
    const req = { body: { token: 'a'.repeat(40), newPassword: 'Str0ng-passw0rd!' }, ip: '127.0.0.1', headers: {} } as never;
    await resetPasswordHandler(req, response());

    expect(repository.setPasswordHash).toHaveBeenCalledWith('usr_1', 'hash');
    expect(tokens.revokeSessions).toHaveBeenCalledWith('usr_1', 'PASSWORD_RESET');
    expect(tokens.revokeAllRefreshTokens).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith('usr_1', 'PASSWORD_RESET', req);
  });
});

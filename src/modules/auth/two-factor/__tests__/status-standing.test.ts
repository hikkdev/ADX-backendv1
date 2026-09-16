import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M-B — `GET /auth/2fa/status` carries the console standing:
 * `roleConfig { id, name, isSystem }` and `isSuperAdmin`, through the port
 * access-control fills at load (`auth.ports.registerConsoleStandingResolver`).
 * Unregistered, the launch rule answers — an ADMIN with no role config is
 * a super admin, nobody else has a console.
 */
const { repository, settings } = vi.hoisted(() => ({
  repository: { findUser: vi.fn(), countUnusedRecoveryCodes: vi.fn() },
  settings: { auth: { adminTwoFactor: { authenticatorRequired: false, smsAllowedWhenEnrolled: true } } },
}));

vi.mock('../prisma-two-factor.repository', () => ({ prismaTwoFactorRepository: repository }));
vi.mock('../../prisma-auth.repository', () => ({ prismaAuthRepository: {} }));
vi.mock('../../auth.session', () => ({ startSession: vi.fn(), sessionMeta: vi.fn() }));
vi.mock('../../otp/otp.service', () => ({ sendOtp: vi.fn(), verifyOtp: vi.fn(), normalizeMobile: (m: string) => m }));
vi.mock('../../../notifications', () => ({ notify: vi.fn(), createNotification: vi.fn() }));
vi.mock('../../../../shared/audit', () => ({ logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) }));
vi.mock('../../../../shared/cache', () => ({ redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));
vi.mock('../../../app-config', () => ({ getPlatformSettings: vi.fn(async () => settings) }));

import { twoFactorStatusHandler } from '../two-factor.controller';
import { launchConsoleStanding, registerConsoleStandingResolver, resolveConsoleStanding } from '../../auth.ports';

const user = (roles: string[], over: Record<string, unknown> = {}) => ({
  id: 'adm_1',
  mobile: '+919845012210',
  email: 'asha.rao@adx.co',
  isActive: true,
  emailOtpFallbackCount: 0,
  emailOtpFallbackResetAt: null,
  totpSecretEnc: null,
  totpEnrolledAt: null,
  roles: roles.map((role) => ({ role })),
  ...over,
});

const request = (roles: string[]) => ({ user: { sub: 'adm_1', roles }, headers: {} }) as never;
const response = () => {
  const res: Record<string, unknown> = {};
  res['json'] = vi.fn(() => res);
  res['set'] = vi.fn(() => res);
  return res as never as { json: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  registerConsoleStandingResolver(null);
  repository.countUnusedRecoveryCodes.mockResolvedValue(0);
});

describe('the port', () => {
  it('answers the launch rule until access-control registers its predicate', async () => {
    expect(launchConsoleStanding(['ADMIN'])).toEqual({ roleConfig: null, isSuperAdmin: true });
    expect(launchConsoleStanding(['PUBLISHER'])).toEqual({ roleConfig: null, isSuperAdmin: false });
    await expect(resolveConsoleStanding('adm_1', ['ADMIN'])).resolves.toEqual({ roleConfig: null, isSuperAdmin: true });
    const resolver = vi.fn(async () => ({ roleConfig: { id: 'rc_1', name: 'Finance', isSystem: false }, isSuperAdmin: false }));
    registerConsoleStandingResolver(resolver);
    await expect(resolveConsoleStanding('adm_1', ['ADMIN'])).resolves.toEqual({ roleConfig: { id: 'rc_1', name: 'Finance', isSystem: false }, isSuperAdmin: false });
    expect(resolver).toHaveBeenCalledWith('adm_1', ['ADMIN']);
  });
});

describe('GET /auth/2fa/status', () => {
  it('carries roleConfig and isSuperAdmin beside the methods, the enrolment and the policy', async () => {
    repository.findUser.mockResolvedValue(user(['ADMIN']));
    registerConsoleStandingResolver(async () => ({ roleConfig: { id: 'rc_s', name: 'Super admin', isSystem: true }, isSuperAdmin: true }));
    const res = response();
    await twoFactorStatusHandler(request(['ADMIN']), res as never);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        methods: ['SMS', 'EMAIL'],
        authenticator: { enrolled: false, enrolledAt: null, recoveryCodesLeft: 0 },
        policy: settings.auth.adminTwoFactor,
        mustEnrolAuthenticator: false,
        roleConfig: { id: 'rc_s', name: 'Super admin', isSystem: true },
        isSuperAdmin: true,
      },
    });
  });

  it('asks the predicate with the roles the row holds, and a non-admin reads null and false', async () => {
    repository.findUser.mockResolvedValue(user(['PUBLISHER']));
    const resolver = vi.fn(async () => ({ roleConfig: null, isSuperAdmin: false }));
    registerConsoleStandingResolver(resolver);
    const res = response();
    await twoFactorStatusHandler(request(['PUBLISHER']), res as never);
    expect(resolver).toHaveBeenCalledWith('adm_1', ['PUBLISHER']);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ methods: [], roleConfig: null, isSuperAdmin: false }) });
  });
});

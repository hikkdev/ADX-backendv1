import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ED-1 — proving the account's own primary email after a number-first sign-in.
 *
 * What is pinned: the send runs the one-value-one-account rule and files the
 * code under CONTACT_VERIFY against the normalised address; an address the
 * account already proved is refused (409 ALREADY_VERIFIED); the verify
 * insists the code was issued to this account, writes the address as the
 * primary with `emailVerifiedAt` stamped, mirrors it onto the party rows and
 * audits the before/after pair.
 */
const { auth, repository, identity, users, audit } = vi.hoisted(() => ({
  auth: { CONTACT_VERIFY_PURPOSE: 'CONTACT_VERIFY', sendEmailCodeToAddressForUser: vi.fn(), verifyEmailCodeFor: vi.fn() },
  repository: { findById: vi.fn(), updateProfile: vi.fn() },
  identity: { assertIdentityFree: vi.fn(), normalizeContactValue: vi.fn((_kind: string, value: string) => value.trim().toLowerCase()) },
  users: { mirrorBasicsToParties: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn((before: unknown, after: unknown) => ({ before, after })) },
}));

vi.mock('../../auth', () => auth);
vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));
vi.mock('../users-identity', () => identity);
vi.mock('../users.service', () => users);
vi.mock('../../../shared/audit', () => audit);

import { sendPrimaryEmailCode, verifyPrimaryEmail } from '../users-email.service';

const account = (over: Record<string, unknown> = {}) => ({ id: 'usr_1', mobile: '+919845012210', name: 'Asha', email: null, emailVerifiedAt: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  identity.assertIdentityFree.mockResolvedValue(undefined);
  auth.sendEmailCodeToAddressForUser.mockResolvedValue({ resendAfterSeconds: 60, sendsRemaining: 2, expiresInSeconds: 600, devOtp: '123456' });
  auth.verifyEmailCodeFor.mockResolvedValue('usr_1');
  repository.updateProfile.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({ ...account(), ...data, publisherProfile: null, advertiserProfile: null }));
  users.mirrorBasicsToParties.mockResolvedValue(undefined);
  audit.logActivity.mockResolvedValue(undefined);
});

describe('sendPrimaryEmailCode', () => {
  it('checks the address is free of every other account, then files the code under CONTACT_VERIFY', async () => {
    repository.findById.mockResolvedValue(account());
    const result = await sendPrimaryEmailCode('usr_1', ' Asha@Work.CO ');
    expect(identity.assertIdentityFree).toHaveBeenCalledWith('EMAIL', 'asha@work.co', { ownPrimaryOf: 'usr_1' });
    expect(auth.sendEmailCodeToAddressForUser).toHaveBeenCalledWith('usr_1', 'asha@work.co', 'CONTACT_VERIFY');
    expect(result).toMatchObject({ email: 'asha@work.co', resendAfterSeconds: 60, devOtp: '123456' });
  });

  it('refuses the account\'s own address once it is proved', async () => {
    repository.findById.mockResolvedValue(account({ email: 'asha@work.co', emailVerifiedAt: new Date() }));
    await expect(sendPrimaryEmailCode('usr_1', 'asha@work.co')).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_VERIFIED' });
    expect(auth.sendEmailCodeToAddressForUser).not.toHaveBeenCalled();
  });

  it('lets a taken address through as the 409 the identity rule throws', async () => {
    repository.findById.mockResolvedValue(account());
    identity.assertIdentityFree.mockRejectedValue(Object.assign(new Error('taken'), { statusCode: 409, code: 'CONTACT_TAKEN' }));
    await expect(sendPrimaryEmailCode('usr_1', 'asha@work.co')).rejects.toMatchObject({ code: 'CONTACT_TAKEN' });
  });
});

describe('verifyPrimaryEmail', () => {
  it('writes the proved address as the primary, stamped now, mirrored and audited', async () => {
    repository.findById.mockResolvedValue(account({ email: 'old@work.co' }));
    const updated = await verifyPrimaryEmail('usr_1', 'Asha@Work.co', '123456');

    expect(auth.verifyEmailCodeFor).toHaveBeenCalledWith('asha@work.co', '123456', 'CONTACT_VERIFY');
    expect(identity.assertIdentityFree).toHaveBeenCalledWith('EMAIL', 'asha@work.co', { ownPrimaryOf: 'usr_1' });
    expect(repository.updateProfile).toHaveBeenCalledWith('usr_1', { email: 'asha@work.co', emailVerifiedAt: expect.any(Date) });
    expect(users.mirrorBasicsToParties).toHaveBeenCalledWith(expect.objectContaining({ id: 'usr_1' }), { name: 'Asha', mobile: '+919845012210' }, { email: 'asha@work.co' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_1', 'EMAIL_VERIFIED', expect.objectContaining({ module: 'users', metadata: expect.objectContaining({ via: 'PROFILE', from: 'old@work.co', to: 'asha@work.co' }) }));
    expect(updated).toMatchObject({ email: 'asha@work.co' });
  });

  it('refuses a code that was issued to another account', async () => {
    repository.findById.mockResolvedValue(account());
    auth.verifyEmailCodeFor.mockResolvedValue('usr_2');
    await expect(verifyPrimaryEmail('usr_1', 'asha@work.co', '123456')).rejects.toMatchObject({ statusCode: 401 });
    expect(repository.updateProfile).not.toHaveBeenCalled();
  });

  it('passes the OTP refusal through untouched', async () => {
    repository.findById.mockResolvedValue(account());
    auth.verifyEmailCodeFor.mockRejectedValue(Object.assign(new Error('Incorrect code. Try again.'), { statusCode: 401, reason: 'OTP_INVALID' }));
    await expect(verifyPrimaryEmail('usr_1', 'asha@work.co', '000000')).rejects.toMatchObject({ reason: 'OTP_INVALID' });
  });
});

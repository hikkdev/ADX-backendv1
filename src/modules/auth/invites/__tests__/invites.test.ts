import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A, Q26 — invitations to the console.
 *
 * What is pinned: one open invite per address; the link carries a token that
 * is stored hashed and re-rolled on every resend; a token that is spent,
 * revoked, expired or invented never names an address; acceptance is two
 * steps, the first sending an OTP to the number the invitee typed and the
 * second creating the admin with the console role the invite carried.
 */
const { repository, otp, password, notifications } = vi.hoisted(() => ({
  repository: {
    findOpenByEmail: vi.fn(),
    findById: vi.fn(),
    findByTokenHash: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    refresh: vi.fn(),
    revoke: vi.fn(),
    roleConfigExists: vi.fn(),
    findUserByEmail: vi.fn(),
    findUserById: vi.fn(),
    promoteInvitee: vi.fn(),
  },
  otp: { sendOtp: vi.fn(), verifyOtp: vi.fn(), normalizeMobile: vi.fn((m: string) => m) },
  password: { hashPassword: vi.fn(async () => 'hashed') },
  notifications: { notify: vi.fn() },
}));

vi.mock('../prisma-invites.repository', () => ({ prismaInvitesRepository: repository }));
vi.mock('../../otp/otp.service', () => otp);
vi.mock('../../password/password.service', () => password);
vi.mock('../../../notifications', () => notifications);

import {
  acceptInvite,
  createInvite,
  describeInvite,
  INVITE_TTL_DAYS,
  resendInvite,
  revokeInvite,
} from '../invites.service';

const invite = (over: Record<string, unknown> = {}) => ({
  id: 'inv_1',
  email: 'new.admin@adx.co',
  method: 'PASSWORD',
  roleConfigId: 'rc_1',
  tokenHash: 'hash',
  invitedByUserId: 'adm_1',
  expiresAt: new Date(Date.now() + 86_400_000),
  acceptedAt: null,
  acceptedUserId: null,
  revokedAt: null,
  createdAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findUserByEmail.mockResolvedValue(null);
  repository.findOpenByEmail.mockResolvedValue(null);
  repository.roleConfigExists.mockResolvedValue(true);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => invite(data));
  repository.refresh.mockImplementation(async (id: string, tokenHash: string, expiresAt: Date) => invite({ id, tokenHash, expiresAt }));
  repository.revoke.mockImplementation(async (id: string) => invite({ id, revokedAt: new Date() }));
  repository.findById.mockResolvedValue(invite());
  repository.findUserById.mockResolvedValue({ id: 'usr_new', email: null, mobile: '+919845012210', name: null });
  repository.promoteInvitee.mockResolvedValue({
    id: 'usr_new',
    email: 'new.admin@adx.co',
    mobile: '+919845012210',
    name: 'New Admin',
    roles: [{ role: 'ADMIN' }],
  });
  otp.sendOtp.mockResolvedValue({ expiresInSeconds: 600, resendAfterSeconds: 60, sendsRemaining: 2, devOtp: '123456' });
  otp.verifyOtp.mockResolvedValue('usr_new');
  notifications.notify.mockResolvedValue({ notificationId: null, templateKey: 'admin-invite', deliveries: [] });
});

describe('issuing an invitation', () => {
  it('stores a hashed token, sends the link and dates it a week out', async () => {
    const view = await createInvite({ email: 'new.admin@adx.co', roleConfigId: 'rc_1', method: 'PASSWORD' }, 'adm_1');

    const [data] = repository.create.mock.calls[0] as [Record<string, unknown>];
    expect(String(data['tokenHash'])).toHaveLength(64);
    const days = (new Date(data['expiresAt'] as Date).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(INVITE_TTL_DAYS);

    // Lot E (Q87): the `admin-invite` template through the dispatcher, to an
    // address with no user behind it. The raw token goes in the link and nowhere else.
    const [event, userId, vars, opts] = notifications.notify.mock.calls[0] as [string, string | null, Record<string, string>, Record<string, unknown>];
    expect(event).toBe('ADMIN_INVITE');
    expect(userId).toBeNull();
    expect(vars['url']).toContain('?token=');
    expect(vars['url']).not.toContain(String(data['tokenHash']));
    expect(opts).toMatchObject({ recipient: { email: 'new.admin@adx.co' }, immediate: true });
    expect(view.status).toBe('OPEN');
  });

  it('refuses an address that already has an account, or an open invitation', async () => {
    repository.findUserByEmail.mockResolvedValue({ id: 'usr_1' });
    await expect(createInvite({ email: 'taken@adx.co', method: 'PASSWORD' }, 'adm_1')).rejects.toMatchObject({ statusCode: 409 });

    repository.findUserByEmail.mockResolvedValue(null);
    repository.findOpenByEmail.mockResolvedValue(invite());
    await expect(createInvite({ email: 'new.admin@adx.co', method: 'PASSWORD' }, 'adm_1')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses a console role that does not exist', async () => {
    repository.roleConfigExists.mockResolvedValue(false);
    await expect(createInvite({ email: 'new.admin@adx.co', roleConfigId: 'rc_none', method: 'PASSWORD' }, 'adm_1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('resending and revoking', () => {
  it('re-rolls the token, so the old link stops working', async () => {
    await resendInvite('inv_1');
    const [, tokenHash] = repository.refresh.mock.calls[0] as [string, string, Date];
    expect(tokenHash).not.toBe('hash');
    expect(notifications.notify).toHaveBeenCalled();
  });

  it('will not touch one that is already accepted or revoked, and 404s an unknown id', async () => {
    repository.findById.mockResolvedValue(invite({ acceptedAt: new Date() }));
    await expect(resendInvite('inv_1')).rejects.toMatchObject({ statusCode: 409 });
    repository.findById.mockResolvedValue(invite({ revokedAt: new Date() }));
    await expect(revokeInvite('inv_1')).rejects.toMatchObject({ statusCode: 409 });
    repository.findById.mockResolvedValue(null);
    await expect(revokeInvite('inv_1')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('what the accept screen may read', () => {
  it('names the address only for a live invitation', async () => {
    repository.findByTokenHash.mockResolvedValue(invite());
    await expect(describeInvite('raw')).resolves.toMatchObject({ email: 'new.admin@adx.co', valid: true });

    repository.findByTokenHash.mockResolvedValue(invite({ revokedAt: new Date() }));
    await expect(describeInvite('raw')).resolves.toEqual({ email: '', method: 'PASSWORD', expiresAt: null, valid: false });

    repository.findByTokenHash.mockResolvedValue(null);
    await expect(describeInvite('invented')).resolves.toMatchObject({ valid: false, email: '' });
  });

  it('looks the token up by its hash, never by the raw value', async () => {
    repository.findByTokenHash.mockResolvedValue(null);
    await describeInvite('raw-token');
    const [hash] = repository.findByTokenHash.mock.calls[0] as [string];
    expect(hash).not.toBe('raw-token');
    expect(hash).toHaveLength(64);
  });
});

describe('accepting it', () => {
  beforeEach(() => repository.findByTokenHash.mockResolvedValue(invite()));

  it('sends a code to the number on the first call, and creates nothing', async () => {
    const result = await acceptInvite({ token: 'raw', name: 'New Admin', mobile: '+919845012210' });
    expect(otp.sendOtp).toHaveBeenCalledWith('+919845012210', 'REGISTER');
    expect(result).toMatchObject({ stage: 'OTP_SENT', mobile: '+919845012210' });
    expect(repository.promoteInvitee).not.toHaveBeenCalled();
  });

  it('creates the admin on the second call, with the console role the invite carried', async () => {
    const result = await acceptInvite({
      token: 'raw',
      name: 'New Admin',
      mobile: '+919845012210',
      otpCode: '123456',
      password: 'a-long-enough-password',
    });

    expect(otp.verifyOtp).toHaveBeenCalledWith('+919845012210', '123456', 'REGISTER');
    expect(repository.promoteInvitee).toHaveBeenCalledWith(
      expect.objectContaining({ inviteId: 'inv_1', userId: 'usr_new', email: 'new.admin@adx.co', roleConfigId: 'rc_1', passwordHash: 'hashed' }),
    );
    expect(result).toMatchObject({ stage: 'ACCEPTED', roles: ['ADMIN'] });
  });

  it('needs a password when the invitation said PASSWORD, and none when it said GOOGLE', async () => {
    await expect(acceptInvite({ token: 'raw', name: 'N', mobile: '+91984', otpCode: '123456' })).rejects.toMatchObject({
      statusCode: 400,
    });

    repository.findByTokenHash.mockResolvedValue(invite({ method: 'GOOGLE' }));
    await acceptInvite({ token: 'raw', name: 'N', mobile: '+919845012210', otpCode: '123456' });
    expect(repository.promoteInvitee).toHaveBeenCalledWith(expect.objectContaining({ passwordHash: null }));
  });

  it('refuses a token that is not live, and an address that got an account in the meantime', async () => {
    repository.findByTokenHash.mockResolvedValue(invite({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(acceptInvite({ token: 'raw', name: 'N', mobile: '+91984' })).rejects.toMatchObject({ statusCode: 400 });

    repository.findByTokenHash.mockResolvedValue(invite());
    repository.findUserByEmail.mockResolvedValue({ id: 'usr_1' });
    await expect(acceptInvite({ token: 'raw', name: 'N', mobile: '+91984' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('will not promote a row that is already somebody’s account', async () => {
    repository.findUserById.mockResolvedValue({ id: 'usr_new', email: 'someone@else.co' });
    await expect(
      acceptInvite({ token: 'raw', name: 'N', mobile: '+919845012210', otpCode: '123456', password: 'a-long-enough-password' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.promoteInvitee).not.toHaveBeenCalled();
  });
});

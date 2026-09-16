import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * K-B1 — a person's contacts beside the primary pair.
 *
 * What is pinned: a value that is any account's primary or any contact row
 * is refused 409 CONTACT_TAKEN saying which; a contact starts unverified and
 * is proved with a code through auth's senders under CONTACT_VERIFY_PURPOSE
 * (a code issued for another account is a refusal); make-primary swaps the
 * value in one transaction, the old primary drops down to a verified
 * contact, and a PHONE promotion runs the two-code change's post-swap work
 * (sessions revoked, audit with the pair, the old number told); the person
 * may promote only a verified contact, the desk an unverified one with a
 * reason and the audit row says UNVERIFIED.
 */
const { repository, auth, audit } = vi.hoisted(() => ({
  repository: {
    findWithRoles: vi.fn(),
    findById: vi.fn(),
    findByMobile: vi.fn(),
    findByEmail: vi.fn(),
    findContacts: vi.fn(),
    findContact: vi.fn(),
    findContactByValue: vi.fn(),
    createContact: vi.fn(),
    updateContact: vi.fn(),
    deleteContact: vi.fn(),
    swapPrimary: vi.fn(),
    findNamesByIds: vi.fn(),
  },
  auth: {
    normalizeMobile: vi.fn((m: string) => (m.startsWith('+') ? m : `+91${m}`)),
    sendOtpToNumberForUser: vi.fn(),
    sendEmailCodeToAddressForUser: vi.fn(),
    verifyOtp: vi.fn(),
    verifyEmailCodeFor: vi.fn(),
    hasProvenEmail: vi.fn(),
    completeMobileChange: vi.fn(),
    CONTACT_VERIFY_PURPOSE: 'CONTACT_VERIFY',
    revokeSessions: vi.fn(),
    requireTwoFactorFor: vi.fn(),
    sendPasswordResetLink: vi.fn(),
  },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn((a: object | null, b: object | null) => ({ before: a, after: b })) },
}));

vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));
vi.mock('../../auth', () => auth);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../access-control', () => ({ getRoleConfigForUser: vi.fn(), assignRoleConfig: vi.fn(), assignRoleConfigSchema: {} }));
vi.mock('../../publishers', () => ({ registerPublisher: vi.fn() }));
vi.mock('../../advertisers', () => ({ registerAdvertiser: vi.fn() }));

import {
  addContact,
  listContacts,
  makePrimary,
  sendContactCode,
  verifyContact,
  markContactVerified,
  removeContact,
} from '../users-contacts.service';
import { makeUserContactPrimary, makeMyContactPrimary, addUserContact, removeUserContact, markUserContactVerified } from '../users-contacts.controller';

const NOW = new Date('2026-09-14T10:00:00Z');

const user = (over: Record<string, unknown> = {}) => ({
  id: 'usr_1',
  mobile: '+919845012210',
  mobileVerifiedAt: NOW,
  email: 'asha@adx.co',
  name: 'Asha',
  isActive: true,
  roles: [{ role: 'PUBLISHER' }],
  ...over,
});

const contact = (over: Record<string, unknown> = {}) => ({
  id: 'ct_1',
  userId: 'usr_1',
  kind: 'PHONE',
  value: '+919000000001',
  label: 'Work',
  verifiedAt: null,
  addedById: 'usr_1',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const request = (over: Record<string, unknown> = {}) =>
  ({ params: { id: 'usr_1', contactId: 'ct_1' }, body: {}, user: { sub: 'adm_1' }, ip: '127.0.0.1', headers: {}, method: 'POST', ...over }) as never;

const response = () => {
  const res: Record<string, unknown> = {};
  res['status'] = vi.fn(() => res);
  res['json'] = vi.fn(() => res);
  return res as never as { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findWithRoles.mockResolvedValue(user());
  repository.findById.mockResolvedValue(user());
  repository.findByMobile.mockResolvedValue(null);
  repository.findByEmail.mockResolvedValue(null);
  repository.findContactByValue.mockResolvedValue(null);
  repository.findContacts.mockResolvedValue([]);
  repository.findContact.mockResolvedValue(contact());
  repository.createContact.mockImplementation(async (data: Record<string, unknown>) => contact({ ...data, id: 'ct_new' }));
  repository.updateContact.mockImplementation(async (id: string, data: Record<string, unknown>) => contact({ id, ...data }));
  repository.deleteContact.mockResolvedValue(undefined);
  repository.findNamesByIds.mockResolvedValue([{ id: 'usr_1', name: 'Asha', mobile: '+919845012210' }]);
  repository.swapPrimary.mockImplementation(async ({ contact: row }: { contact: { kind: string; value: string } }) =>
    user(row.kind === 'PHONE' ? { mobile: row.value } : { email: row.value }),
  );
  auth.hasProvenEmail.mockResolvedValue(true);
  auth.sendOtpToNumberForUser.mockResolvedValue({ expiresInSeconds: 600, resendAfterSeconds: 60, sendsRemaining: 2, devOtp: '123456' });
  auth.sendEmailCodeToAddressForUser.mockResolvedValue({ expiresInSeconds: 600, resendAfterSeconds: 60, sendsRemaining: 2 });
  auth.verifyOtp.mockResolvedValue('usr_1');
  auth.verifyEmailCodeFor.mockResolvedValue('usr_1');
});

describe('the read', () => {
  it('answers the primary pair and every contact with who added it', async () => {
    repository.findContacts.mockResolvedValue([contact(), contact({ id: 'ct_2', kind: 'EMAIL', value: 'asha@work.co', addedById: 'adm_1' })]);
    repository.findNamesByIds.mockResolvedValue([
      { id: 'usr_1', name: 'Asha', mobile: '+919845012210' },
      { id: 'adm_1', name: 'Ops', mobile: '+919999999999' },
    ]);
    const view = await listContacts('usr_1');
    expect(view.primary).toEqual({ mobile: '+919845012210', mobileVerifiedAt: NOW, email: 'asha@adx.co', emailVerified: true });
    expect(view.contacts).toHaveLength(2);
    expect(view.contacts[1]).toMatchObject({ id: 'ct_2', kind: 'EMAIL', value: 'asha@work.co', addedBy: { id: 'adm_1', name: 'Ops' } });
    expect(repository.findNamesByIds).toHaveBeenCalledTimes(1);
  });
});

describe('adding a contact', () => {
  it('normalises the value and starts it unverified, naming who added it', async () => {
    const row = await addContact('usr_1', 'adm_1', { kind: 'EMAIL', value: '  Asha@Work.CO ' });
    expect(repository.createContact).toHaveBeenCalledWith({ userId: 'usr_1', kind: 'EMAIL', value: 'asha@work.co', label: undefined, addedById: 'adm_1' });
    expect(row.verifiedAt).toBeNull();
    await addContact('usr_1', 'usr_1', { kind: 'PHONE', value: '9000000002' });
    expect(repository.createContact).toHaveBeenLastCalledWith(expect.objectContaining({ value: '+919000000002' }));
  });

  it("refuses a value that is any account's primary — the owner's own included", async () => {
    repository.findByMobile.mockResolvedValue(user({ id: 'usr_2' }));
    await expect(addContact('usr_1', 'usr_1', { kind: 'PHONE', value: '+919000000009' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONTACT_TAKEN',
      details: { which: 'PRIMARY', userId: 'usr_2' },
    });
    repository.findByMobile.mockResolvedValue(user());
    await expect(addContact('usr_1', 'usr_1', { kind: 'PHONE', value: '+919845012210' })).rejects.toMatchObject({ code: 'CONTACT_TAKEN', details: { which: 'PRIMARY', userId: 'usr_1' } });
    expect(repository.createContact).not.toHaveBeenCalled();
  });

  it("refuses a value that is another contact row, anyone's", async () => {
    repository.findContactByValue.mockResolvedValue(contact({ id: 'ct_9', userId: 'usr_7' }));
    await expect(addContact('usr_1', 'usr_1', { kind: 'PHONE', value: '+919000000001' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONTACT_TAKEN',
      details: { which: 'CONTACT', userId: 'usr_7', contactId: 'ct_9' },
    });
  });

  it('the desk needs a reason, and audits USER_CONTACT_ADDED against the account', async () => {
    await expect(addUserContact(request({ body: { kind: 'PHONE', value: '+919000000003' } }), response() as never)).rejects.toMatchObject({ statusCode: 400 });
    const res = response();
    await addUserContact(request({ body: { kind: 'PHONE', value: '+919000000003', reason: 'given on the support call' } }), res as never);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_1',
      'USER_CONTACT_ADDED',
      expect.objectContaining({ targetType: 'UserContact', targetId: 'ct_new', metadata: expect.objectContaining({ addedBy: 'adm_1', reason: 'given on the support call' }) }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('the code', () => {
  it('goes to the phone through auth, under the contact-verify purpose', async () => {
    const result = await sendContactCode('usr_1', 'ct_1');
    expect(auth.sendOtpToNumberForUser).toHaveBeenCalledWith('usr_1', '+919000000001', 'CONTACT_VERIFY');
    expect(result).toMatchObject({ kind: 'PHONE', expiresInSeconds: 600, devOtp: '123456' });
  });

  it('goes to the address through the email sender', async () => {
    repository.findContact.mockResolvedValue(contact({ kind: 'EMAIL', value: 'asha@work.co' }));
    await sendContactCode('usr_1', 'ct_1');
    expect(auth.sendEmailCodeToAddressForUser).toHaveBeenCalledWith('usr_1', 'asha@work.co', 'CONTACT_VERIFY');
    expect(auth.sendOtpToNumberForUser).not.toHaveBeenCalled();
  });

  it('is refused for a verified contact, and for somebody else\'s contact id', async () => {
    repository.findContact.mockResolvedValue(contact({ verifiedAt: NOW }));
    await expect(sendContactCode('usr_1', 'ct_1')).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_VERIFIED' });
    repository.findContact.mockResolvedValue(contact({ userId: 'usr_2' }));
    await expect(sendContactCode('usr_1', 'ct_1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('verifying with the code stamps verifiedAt; a code issued for another account does not', async () => {
    const row = await verifyContact('usr_1', 'ct_1', '123456');
    expect(auth.verifyOtp).toHaveBeenCalledWith('+919000000001', '123456', 'CONTACT_VERIFY');
    expect(repository.updateContact).toHaveBeenCalledWith('ct_1', { verifiedAt: expect.any(Date) });
    expect(row.verifiedAt).toBeInstanceOf(Date);

    auth.verifyOtp.mockResolvedValue('usr_other');
    await expect(verifyContact('usr_1', 'ct_1', '123456')).rejects.toMatchObject({ statusCode: 401 });
    expect(repository.updateContact).toHaveBeenCalledTimes(1);
  });

  it('verifies an email contact through the email verifier', async () => {
    repository.findContact.mockResolvedValue(contact({ kind: 'EMAIL', value: 'asha@work.co' }));
    await verifyContact('usr_1', 'ct_1', '654321');
    expect(auth.verifyEmailCodeFor).toHaveBeenCalledWith('asha@work.co', '654321', 'CONTACT_VERIFY');
  });

  it('the desk may mark it verified instead, with a reason, audited USER_CONTACT_MARKED_VERIFIED', async () => {
    await expect(markUserContactVerified(request({ body: {} }), response() as never)).rejects.toMatchObject({ statusCode: 400 });
    await markUserContactVerified(request({ body: { reason: 'read the code back on the call' } }), response() as never);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_1',
      'USER_CONTACT_MARKED_VERIFIED',
      expect.objectContaining({ targetType: 'UserContact', metadata: expect.objectContaining({ markedBy: 'adm_1', reason: 'read the code back on the call', how: 'READ_BACK' }) }),
    );
    repository.findContact.mockResolvedValue(contact({ verifiedAt: NOW }));
    await expect(markContactVerified('usr_1', 'ct_1')).rejects.toMatchObject({ code: 'ALREADY_VERIFIED' });
  });
});

describe('removing a contact', () => {
  it('the desk audits USER_CONTACT_REMOVED with the reason and what the row was', async () => {
    await removeUserContact(request({ body: { reason: 'the number was given in error' }, method: 'DELETE' }), response() as never);
    expect(repository.deleteContact).toHaveBeenCalledWith('ct_1');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_1',
      'USER_CONTACT_REMOVED',
      expect.objectContaining({ metadata: expect.objectContaining({ removedBy: 'adm_1', reason: 'the number was given in error' }) }),
    );
  });

  it('is a 404 for a contact that is not this account\'s', async () => {
    repository.findContact.mockResolvedValue(contact({ userId: 'usr_2' }));
    await expect(removeContact('usr_1', 'ct_1')).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.deleteContact).not.toHaveBeenCalled();
  });
});

describe('make-primary', () => {
  it('PHONE: swaps in one transaction, the old primary drops down verified, and the two-code post-swap work runs', async () => {
    repository.findContact.mockResolvedValue(contact({ verifiedAt: NOW }));
    const change = await makePrimary('usr_1', 'adm_1', 'ct_1', { allowUnverified: true, action: 'USER_PRIMARY_CHANGED', metadata: { reason: 'lost the SIM' } });

    expect(repository.swapPrimary).toHaveBeenCalledWith({
      userId: 'usr_1',
      contact: expect.objectContaining({ id: 'ct_1', value: '+919000000001' }),
      previous: { value: '+919845012210', verifiedAt: NOW },
      actorId: 'adm_1',
      verifiedAt: NOW,
    });
    expect(auth.completeMobileChange).toHaveBeenCalledWith('usr_1', '+919845012210', '+919000000001', {
      action: 'USER_PRIMARY_CHANGED',
      module: 'users',
      metadata: { reason: 'lost the SIM', changedBy: 'adm_1', verified: 'VERIFIED', contactId: 'ct_1' },
    });
    expect(change).toMatchObject({ kind: 'PHONE', before: '+919845012210', after: '+919000000001', wasVerified: true });
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('EMAIL: swaps, the old address drops down as a contact with the proof it had, no session goes, audited with the pair', async () => {
    repository.findContact.mockResolvedValue(contact({ kind: 'EMAIL', value: 'asha@work.co', verifiedAt: NOW }));
    const change = await makePrimary('usr_1', 'usr_1', 'ct_1', { allowUnverified: false, action: 'PRIMARY_CONTACT_CHANGED' });
    // Lot K2 (Lot K verifier): hasProvenEmail vouched for the old address, so it drops down verified.
    expect(auth.hasProvenEmail).toHaveBeenCalledWith('usr_1', 'asha@adx.co');
    expect(repository.swapPrimary).toHaveBeenCalledWith(expect.objectContaining({ previous: { value: 'asha@adx.co', verifiedAt: expect.any(Date) }, actorId: 'usr_1' }));
    expect(auth.completeMobileChange).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_1',
      'PRIMARY_CONTACT_CHANGED',
      expect.objectContaining({ diff: { before: { email: 'asha@adx.co' }, after: { email: 'asha@work.co' } }, metadata: expect.objectContaining({ verified: 'VERIFIED' }) }),
    );
    expect(change).toMatchObject({ kind: 'EMAIL', before: 'asha@adx.co', after: 'asha@work.co' });
  });

  it('Lot K2: an old primary email that was never proved drops down UNVERIFIED — moving it is not proof', async () => {
    auth.hasProvenEmail.mockResolvedValue(false);
    repository.findContact.mockResolvedValue(contact({ kind: 'EMAIL', value: 'asha@work.co', verifiedAt: NOW }));
    await makePrimary('usr_1', 'usr_1', 'ct_1', { allowUnverified: false, action: 'PRIMARY_CONTACT_CHANGED' });
    expect(repository.swapPrimary).toHaveBeenCalledWith(expect.objectContaining({ previous: { value: 'asha@adx.co', verifiedAt: null } }));
  });

  it("Lot K2: the desk mount refuses the acting admin's own id — an admin proves their own contact like everyone else", async () => {
    await expect(
      makeUserContactPrimary(request({ params: { id: 'adm_1', contactId: 'ct_1' }, body: { reason: 'my own number' } }), response() as never),
    ).rejects.toMatchObject({ statusCode: 403, code: 'USE_YOUR_OWN_SETTINGS' });
    expect(repository.swapPrimary).not.toHaveBeenCalled();
  });

  it('EMAIL with no previous address writes no drop-down row', async () => {
    repository.findWithRoles.mockResolvedValue(user({ email: null }));
    repository.findContact.mockResolvedValue(contact({ kind: 'EMAIL', value: 'asha@work.co', verifiedAt: NOW }));
    await makePrimary('usr_1', 'usr_1', 'ct_1', { allowUnverified: false, action: 'PRIMARY_CONTACT_CHANGED' });
    expect(repository.swapPrimary).toHaveBeenCalledWith(expect.objectContaining({ previous: null }));
  });

  it('the person may only promote a verified contact', async () => {
    await expect(makeMyContactPrimary(request({ user: { sub: 'usr_1' } }), response() as never)).rejects.toMatchObject({ statusCode: 409, code: 'CONTACT_NOT_VERIFIED' });
    expect(repository.swapPrimary).not.toHaveBeenCalled();
  });

  it('the desk may promote an unverified one with a reason — the audit row says UNVERIFIED and the new primary carries no stamp', async () => {
    await expect(makeUserContactPrimary(request({ body: {} }), response() as never)).rejects.toMatchObject({ statusCode: 400 });
    const res = response();
    await makeUserContactPrimary(request({ body: { reason: 'confirmed the new number on a call' } }), res as never);
    expect(repository.swapPrimary).toHaveBeenCalledWith(expect.objectContaining({ verifiedAt: null, actorId: 'adm_1' }));
    expect(auth.completeMobileChange).toHaveBeenCalledWith(
      'usr_1',
      '+919845012210',
      '+919000000001',
      expect.objectContaining({ action: 'USER_PRIMARY_CHANGED', metadata: expect.objectContaining({ reason: 'confirmed the new number on a call', verified: 'UNVERIFIED', changedBy: 'adm_1' }) }),
    );
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({ kind: 'PHONE', before: '+919845012210', after: '+919000000001', wasVerified: false, sessionsRevoked: true }),
    });
  });

  it('refuses when the value has since become another account\'s primary', async () => {
    repository.findContact.mockResolvedValue(contact({ verifiedAt: NOW }));
    repository.findByMobile.mockResolvedValue(user({ id: 'usr_2' }));
    await expect(makePrimary('usr_1', 'usr_1', 'ct_1', { allowUnverified: false, action: 'X' })).rejects.toMatchObject({ code: 'CONTACT_TAKEN' });
    expect(repository.swapPrimary).not.toHaveBeenCalled();
  });
});

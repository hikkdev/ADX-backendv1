import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Print partners — Lot B (Q50/B4b), owner decisions 50 and 122; Lot H
 * (Q147), the owner's 6 Sep and 13 Sep mechanics.
 *
 * A partner is an account ops creates inactive, a row ops keeps, a wallet
 * from day one. The rules under test are the ones that protect other
 * people's accounts — a partner is never attached to an existing number —
 * and the ones that keep the roster honest: deactivation is idempotent,
 * ends the partner's sessions, and takes nothing away that was earned.
 * Lot H adds activation (the switch that lets the partner sign in), the
 * partner's own profile and rate card, and the money from their own phone
 * under the ordinary rules.
 */

type Row = Record<string, any>;

const NOW = new Date('2026-09-14T09:00:00Z');

const { fake, repository, identifiers, wallets, payouts, auth, notifications, uploads, audit, settings, pricing } = vi.hoisted(() => {
  const fake = { partners: new Map<string, Row>(), users: new Map<string, Row>(), files: new Map<string, Row>() };
  const repository = {
    findUserByMobile: vi.fn(async (mobile: string) => fake.users.get(mobile) ?? null),
    emailTaken: vi.fn(async () => false),
    createPartner: vi.fn(async (data: Row) => {
      const row: Row = {
        id: `prt_${fake.partners.size + 1}`,
        userId: `usr_prt_${fake.partners.size + 1}`,
        isActive: true,
        createdAt: new Date('2026-09-12T10:00:00Z'),
        notes: null,
        email: null,
        activatedAt: null,
        activatedById: null,
        rateCardFileId: null,
        rateCardUpdatedAt: null,
        rateCardRows: null,
        acceptsQuoteRequests: true,
        invoiceUploadFileId: null,
        kycStatus: 'PENDING',
        ...data,
      };
      fake.partners.set(row.id, row);
      fake.users.set(row.mobile, { id: row.userId, isActive: false });
      return row;
    }),
    findPartner: vi.fn(async (id: string) => fake.partners.get(id) ?? null),
    // PP-1: the shop's own application — the row on an account that exists.
    createApplication: vi.fn(async ({ userId, appliedAt, ...data }: Row) => {
      const row: Row = { id: `prt_${fake.partners.size + 1}`, userId, isActive: true, createdAt: appliedAt, activatedAt: null, activatedById: null, appliedAt, rateCardFileId: null, rateCardRows: null, acceptsQuoteRequests: true, kycStatus: 'PENDING', ...data };
      fake.partners.set(row.id, row);
      return row;
    }),
    findUserRoles: vi.fn(async (): Promise<string[]> => []),
    findPartnerByUserId: vi.fn(async (userId: string) => [...fake.partners.values()].find((row) => row.userId === userId) ?? null),
    findPartnerByUser: vi.fn(async (userId: string) => [...fake.partners.values()].find((row) => row.userId === userId) ?? null),
    updatePartner: vi.fn(async (id: string, patch: Row) => {
      const next = { ...fake.partners.get(id), ...patch };
      fake.partners.set(id, next);
      return next;
    }),
    setUserActive: vi.fn(async (userId: string, active: boolean) => {
      for (const user of fake.users.values()) if (user.id === userId) user.isActive = active;
    }),
    listPartners: vi.fn(),
    listPartnerFiles: vi.fn(async () => [{ id: 'file_inv_1', filename: 'aug.pdf', mimeType: 'application/pdf', sizeBytes: 100, url: '/api/v1/files/file_inv_1', createdAt: NOW }]),
    createJob: vi.fn(),
    findJobByOrder: vi.fn(),
    findJob: vi.fn(),
    updateJob: vi.fn(),
    listJobsForPartner: vi.fn(async () => [{ id: 'job_1', status: 'READY' }]),
    countJobsForPartner: vi.fn(async () => [{ status: 'READY', count: 1 }]),
    findFilesByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, filename: `${id}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, url: `/api/v1/files/${id}`, createdAt: new Date('2026-09-01T00:00:00Z') }))),
    findLastLogins: vi.fn(async (ids: string[]) => ids.map((userId) => ({ userId, lastLoginAt: userId === 'usr_prt_1' ? NOW : null }))),
  };
  return {
    fake,
    repository,
    identifiers: { allocateIdentifier: vi.fn(async () => 'PRT-1209-2601') },
    wallets: {
      ensureWallet: vi.fn(async () => ({ id: 'wal_prt' })),
      findWalletFor: vi.fn(async () => ({ id: 'wal_prt' })),
      listEntries: vi.fn(async (): Promise<Row[]> => []),
      snapshot: vi.fn(async () => ({ walletId: 'wal_prt', balance: '500.00', withdrawable: '500.00' })),
      sumEntries: vi.fn(async () => ({ total: '0.00', count: 0 })),
      move: vi.fn(),
    },
    payouts: {
      listWithdrawals: vi.fn(async (_filter?: Row): Promise<Row[]> => []),
      withholdingFor: vi.fn(),
      withdrawalAllowance: vi.fn(async () => ({ maximum: '500.00', minimum: '100.00' })),
      listMethods: vi.fn(async (): Promise<Row[]> => []),
      addMethod: vi.fn(async (userId: string, input: Row) => ({ id: 'pm_new', userId, ...input, status: 'PENDING_VERIFICATION' })),
      requestWithdrawal: vi.fn(async (walletId: string, input: Row) => ({ id: 'wdr_1', walletId, amount: input.amount, netAmount: input.amount, status: 'REQUESTED' })),
    },
    auth: {
      normalizeMobile: (mobile: string) => {
        const digits = mobile.replace(/\D/g, '');
        return digits.length === 10 ? `+91${digits}` : mobile;
      },
      revokeSessions: vi.fn(async () => undefined),
    },
    notifications: { notify: vi.fn(async () => ({ notificationId: 'ntf_1', templateKey: 'partner-activated', deliveries: [] })) },
    uploads: { findUploadedFile: vi.fn(async (id: string) => fake.files.get(id) ?? null) },
    audit: { findActivityRows: vi.fn(async (): Promise<Row[]> => []), logActivity: vi.fn(async () => undefined) },
    // PP-1: the application audits under the applicant's login.
    // Lot N: the activation gate reads `kyc.printPartnerActivationRequiresKyc`; off is today's behaviour.
    settings: { getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48, escalationSlaMultiplier: 2, printPartnerActivationRequiresKyc: false } })) },
    pricing: {
      assertCityAllows: vi.fn(),
      // Lot X-B: the city key — Bengaluru (and its old spelling) and Mysuru are catalogued; the rest are typed towns.
      cityKeyFor: vi.fn(async (name: string | null | undefined) =>
        name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : name && /^mysuru$/i.test(name.trim()) ? { cityId: 'city_mysuru', slug: 'mysuru' } : null,
      ),
      withCityKey: vi.fn(async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: (await pricing.cityKeyFor(data.city))?.cityId ?? null })),
    },
  };
});

vi.mock('../prisma-print-partners.repository', () => ({ prismaPrintPartnersRepository: repository }));
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../wallets', () => wallets);
vi.mock('../../payouts', () => payouts);
vi.mock('../../orders', () => ({ getOrderSummary: vi.fn(), registerPrintJobPort: vi.fn(), notifyAdmins: vi.fn(), shortId: (id: string) => id.slice(-6) }));
vi.mock('../../auth', () => auth);
vi.mock('../../notifications', () => notifications);
vi.mock('../../uploads', () => uploads);
vi.mock('../../app-config', () => settings);
vi.mock('../../pricing', () => pricing);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import {
  activatePartner,
  applyAsPartner,
  createPartner,
  deactivatePartner,
  getPartnerForUser,
  hasRateCard,
  listPartnerInvoicesWithMonths,
  partnerEarnings,
  partnerEarningsSummary,
  partnerLedger,
  partnerProfile,
  reactivatePartner,
  recordPartnerInvoice,
  recordPartnerInvoiceOnBehalf,
  requestPartnerWithdrawal,
  setRateCard,
  setRateCardOnBehalf,
  updateMe,
  updatePartner,
  withLastLogin,
} from '../print-partners.service';
import { ApiError } from '../../../shared/errors';

/** Lot V: the city gate as pricing answers it — Bengaluru launched, Mysuru planned, anything else off the catalogue. */
const OPEN = { supplyIntake: true, publishing: true, demand: true, agentOnboarding: true, printPartners: true, leadFeeds: true };
const OFF = { supplyIntake: false, publishing: false, demand: false, agentOnboarding: false, printPartners: false, leadFeeds: false };
const cityView = (name: string | null | undefined) =>
  name && /^mysuru$/i.test(name)
    ? { support: 'INACTIVE', resolved: true, stage: 'PLANNED', switches: OFF, city: { slug: 'mysuru', name: 'Mysuru' } }
    : name && /^bengaluru$/i.test(name)
      ? { support: 'ACTIVE', resolved: true, stage: 'LAUNCHED', switches: OPEN, city: { slug: 'bengaluru', name: 'Bengaluru' } }
      : { support: 'UNKNOWN', resolved: false, stage: null, switches: OPEN, city: null };
const gate = async (name: string | null | undefined, fn: keyof typeof OPEN) => {
  const view = cityView(name);
  if (view.resolved && !view.switches[fn]) {
    throw new ApiError(400, 'CITY_NOT_OPEN', `ADX is not open for ${fn} in ${view.city!.name} (planned).`, { stage: view.stage, function: fn, city: view.city!.slug });
  }
  return view;
};

beforeEach(() => {
  vi.clearAllMocks();
  pricing.assertCityAllows.mockImplementation(gate);
  fake.partners.clear();
  fake.users.clear();
  fake.files.clear();
  settings.getPlatformSettings.mockResolvedValue({ kyc: { reviewSlaHours: 48, escalationSlaMultiplier: 2, printPartnerActivationRequiresKyc: false } });
});

describe('creating a partner', () => {
  it('creates the inactive account, the row, the identifier and the wallet together', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '98765 43210', city: 'Bengaluru' });
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('PARTNER');
    expect(repository.createPartner).toHaveBeenCalledWith(
      expect.objectContaining({ displayId: 'PRT-1209-2601', mobile: '+919876543210', name: 'Rapid Prints', city: 'Bengaluru', cityId: 'city_bengaluru' })
    );
    expect(wallets.ensureWallet).toHaveBeenCalledWith({ kind: 'PRINT_PARTNER', id: partner.id }, 'Rapid Prints · print partner');
    expect(partner.displayId).toBe('PRT-1209-2601');
    // Lot H: created with the sign-in switch off; activation is ops' own step.
    expect(partner.activatedAt).toBeNull();
    expect(fake.users.get('+919876543210')?.isActive).toBe(false);
  });

  it('never attaches to an existing account — the number has to be the partner’s own', async () => {
    fake.users.set('+919876543210', { id: 'usr_publisher' });
    await expect(createPartner({ name: 'Rapid Prints', mobile: '9876543210' })).rejects.toMatchObject({
      statusCode: 409,
    });
    // Checked before the identifier is allocated, so a refusal burns no number.
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
    expect(repository.createPartner).not.toHaveBeenCalled();
  });

  it('refuses an email another account holds', async () => {
    repository.emailTaken.mockResolvedValueOnce(true);
    await expect(
      createPartner({ name: 'Rapid Prints', mobile: '9876543210', email: 'shop@example.com' })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  /* Lot V: a partner is signed where the city's rollout stage has print partners on. */
  it('refuses a partner in a planned city with CITY_NOT_OPEN, burning no identifier, and takes one in a town the catalogue lacks', async () => {
    await expect(createPartner({ name: 'Early Press', mobile: '9876543210', city: 'Mysuru' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'CITY_NOT_OPEN',
      details: { function: 'printPartners', city: 'mysuru' },
    });
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
    const far = await createPartner({ name: 'Far Press', mobile: '9876543210', city: 'Rameswaram' });
    expect(far.city).toBe('Rameswaram');
    expect(pricing.assertCityAllows).toHaveBeenCalledWith('Rameswaram', 'printPartners');
  });

  it('Lot X-B: the old spelling keys to the catalogue row, a typed town keeps its string with a null key', async () => {
    await createPartner({ name: 'Old Spelling Press', mobile: '9876543210', city: 'Bangalore' });
    expect(repository.createPartner).toHaveBeenCalledWith(expect.objectContaining({ city: 'Bangalore', cityId: 'city_bengaluru' }));
    await createPartner({ name: 'Typed Press', mobile: '9876543211', city: 'Rameswaram' });
    expect(repository.createPartner).toHaveBeenLastCalledWith(expect.objectContaining({ city: 'Rameswaram', cityId: null }));
  });
});

describe('PP-1: a shop applies from the app', () => {
  it('writes the row with appliedAt on the applicant\'s own account, the identifier and the wallet, and audits it', async () => {
    const { partner, created } = await applyAsPartner('usr_shop', { name: 'Rapid Prints', legalName: 'Rapid Prints LLP', mobile: '9876500001', email: 'hi@rapid.in' }, NOW);
    expect(created).toBe(true);
    expect(partner).toMatchObject({ displayId: 'PRT-1209-2601', mobile: '+919876500001', name: 'Rapid Prints', legalName: 'Rapid Prints LLP', appliedAt: NOW, activatedAt: null });
    expect(repository.createApplication).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_shop', appliedAt: NOW }));
    expect(wallets.ensureWallet).toHaveBeenCalledWith({ kind: 'PRINT_PARTNER', id: partner.id }, expect.any(String));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_shop', 'PRINT_PARTNER_APPLIED', undefined, expect.objectContaining({ partnerId: partner.id }));
    // Applying again is the same application.
    await expect(applyAsPartner('usr_shop', { name: 'Rapid Prints', mobile: '9876500001' }, NOW)).resolves.toMatchObject({ created: false, partner: { id: partner.id } });
  });

  it('refuses a number that already holds a publisher, advertiser or agent account', async () => {
    repository.findUserRoles.mockResolvedValueOnce(['PUBLISHER']);
    await expect(applyAsPartner('usr_pub', { name: 'Side Shop', mobile: '9876500002' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.createApplication).not.toHaveBeenCalled();
  });

  it('is activated through the desk\'s usual door once reviewed', async () => {
    const { partner } = await applyAsPartner('usr_shop', { name: 'Rapid Prints', mobile: '9876500001' }, NOW);
    fake.users.set(partner.mobile, { id: 'usr_shop', isActive: true });
    const result = await activatePartner(partner.id, 'usr_ops', NOW);
    expect(result.activated).toBe(true);
    expect(result.after).toMatchObject({ appliedAt: NOW, activatedAt: NOW, activatedById: 'usr_ops' });
  });
});

describe('keeping the roster', () => {
  it('patches the fields given and reports the before and after for the audit diff', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    const { before, after } = await updatePartner(partner.id, { city: 'Mysuru', maxWidthFt: '12.50', capabilities: ['flex', 'vinyl'] });
    expect(before.city).toBeNull();
    expect(after.city).toBe('Mysuru');
    // Lot X-B: the key rides with the patched city; a patch of other fields leaves it alone.
    expect(repository.updatePartner).toHaveBeenLastCalledWith(partner.id, expect.objectContaining({ city: 'Mysuru', cityId: 'city_mysuru' }));
    await updatePartner(partner.id, { notes: 'x' });
    expect(repository.updatePartner).toHaveBeenLastCalledWith(partner.id, { notes: 'x' });
    expect(after.maxWidthFt?.toFixed(2)).toBe('12.50');
    expect(after.capabilities).toEqual(['flex', 'vinyl']);
  });

  it('deactivates once, keeps the reason, ends the sessions, and answers the same the second time', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    await activatePartner(partner.id, 'usr_admin', NOW);
    const first = await deactivatePartner(partner.id, 'Closed for the season');
    expect(first.before.isActive).toBe(true);
    expect(first.after.isActive).toBe(false);
    expect(first.after.notes).toContain('Deactivated: Closed for the season');
    // Lot H: off the roster is off the app — the account is switched off and every session ended.
    expect(repository.setUserActive).toHaveBeenLastCalledWith(partner.userId, false);
    expect(auth.revokeSessions).toHaveBeenCalledWith(partner.userId, 'PRINT_PARTNER_DEACTIVATED');
    const second = await deactivatePartner(partner.id, 'again');
    expect(second.after).toBe(second.before);
    expect(auth.revokeSessions).toHaveBeenCalledTimes(1);
  });

  it('reactivation switches the account back on only when it had been activated', async () => {
    const never = await createPartner({ name: 'Never Activated', mobile: '9876543210' });
    await deactivatePartner(never.id);
    await reactivatePartner(never.id);
    expect(repository.setUserActive).not.toHaveBeenCalledWith(never.userId, true);

    const once = await createPartner({ name: 'Activated Once', mobile: '9876543211' });
    await activatePartner(once.id, 'usr_admin', NOW);
    await deactivatePartner(once.id);
    const after = await reactivatePartner(once.id);
    expect(after.isActive).toBe(true);
    expect(repository.setUserActive).toHaveBeenLastCalledWith(once.userId, true);
  });

  it('answers 404 for a partner that is not there', async () => {
    await expect(deactivatePartner('prt_missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});

/* Lot H: the switch that lets the partner sign in. */
describe('activating the account', () => {
  it('switches the user on, stamps who and when, and tells the partner by SMS', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210', email: 'shop@example.com' });
    const result = await activatePartner(partner.id, 'usr_admin', NOW);
    expect(result.activated).toBe(true);
    expect(result.after.activatedAt).toEqual(NOW);
    expect(result.after.activatedById).toBe('usr_admin');
    expect(repository.setUserActive).toHaveBeenCalledWith(partner.userId, true);
    expect(fake.users.get('+919876543210')?.isActive).toBe(true);
    expect(notifications.notify).toHaveBeenCalledWith(
      'PARTNER_ACTIVATED',
      partner.userId,
      { name: 'Rapid Prints', mobile: '+919876543210' },
      expect.objectContaining({ recipient: { mobile: '+919876543210', email: 'shop@example.com' } }),
    );
  });

  it('is idempotent — a second activation re-stamps nothing and sends nothing', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    const first = await activatePartner(partner.id, 'usr_admin', NOW);
    const second = await activatePartner(partner.id, 'usr_other', new Date(NOW.getTime() + 1000));
    expect(second.activated).toBe(false);
    expect(second.after.activatedAt).toEqual(first.after.activatedAt);
    expect(second.after.activatedById).toBe('usr_admin');
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('refuses a partner that is off the roster — reactivate first', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    await deactivatePartner(partner.id);
    await expect(activatePartner(partner.id, 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.setUserActive).not.toHaveBeenCalledWith(partner.userId, true);
  });

  /* Lot V: activation is when the partner starts being asked to quote, so the city gate sits here too. */
  it('refuses activation once the city has closed its print partners, and activates as ever in a launched one', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210', city: 'Bengaluru' });
    pricing.assertCityAllows.mockImplementationOnce(async (name: string | null | undefined, fn: keyof typeof OPEN) => {
      throw new ApiError(400, 'CITY_NOT_OPEN', `ADX is not open for ${fn} in ${name} (paused).`, { stage: 'PAUSED', function: fn, city: 'bengaluru' });
    });
    await expect(activatePartner(partner.id, 'usr_admin', NOW)).rejects.toMatchObject({ code: 'CITY_NOT_OPEN', details: { stage: 'PAUSED' } });
    expect(repository.setUserActive).not.toHaveBeenCalledWith(partner.userId, true);
    const result = await activatePartner(partner.id, 'usr_admin', NOW);
    expect(result.activated).toBe(true);
    // Lot X-B: judged by the key the row carries, the spelling beside it.
    expect(pricing.assertCityAllows).toHaveBeenLastCalledWith('Bengaluru', 'printPartners', 'city_bengaluru');
  });

  it('a notice that cannot be sent does not undo the activation', async () => {
    notifications.notify.mockRejectedValueOnce(new Error('rail down'));
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    const result = await activatePartner(partner.id, 'usr_admin', NOW);
    expect(result.activated).toBe(true);
    expect(fake.users.get('+919876543210')?.isActive).toBe(true);
  });

  /* Lot N: the KYC gate, under both settings. */
  it('activates a PENDING-KYC partner while kyc.printPartnerActivationRequiresKyc is off (the default)', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    expect(fake.partners.get(partner.id)?.kycStatus).toBe('PENDING');
    const result = await activatePartner(partner.id, 'usr_admin', NOW);
    expect(result.activated).toBe(true);
  });

  it('refuses 409 KYC_REQUIRED while the setting is on and the partner is not VERIFIED, and activates once VERIFIED', async () => {
    settings.getPlatformSettings.mockResolvedValue({ kyc: { reviewSlaHours: 48, escalationSlaMultiplier: 2, printPartnerActivationRequiresKyc: true } });
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    await expect(activatePartner(partner.id, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, code: 'KYC_REQUIRED', details: { kycStatus: 'PENDING' } });
    expect(repository.setUserActive).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();

    fake.partners.set(partner.id, { ...fake.partners.get(partner.id), kycStatus: 'VERIFIED' });
    const result = await activatePartner(partner.id, 'usr_admin', NOW);
    expect(result.activated).toBe(true);
    expect(repository.setUserActive).toHaveBeenCalledWith(partner.userId, true);
  });

  it('leaves an already-activated partner idempotent even when the gate is on', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    await activatePartner(partner.id, 'usr_admin', NOW);
    settings.getPlatformSettings.mockResolvedValue({ kyc: { reviewSlaHours: 48, escalationSlaMultiplier: 2, printPartnerActivationRequiresKyc: true } });
    const second = await activatePartner(partner.id, 'usr_admin', NOW);
    expect(second.activated).toBe(false);
  });
});

/* Lot H: the partner on their own phone. */
describe('the partner’s own profile', () => {
  it('finds the partner behind the signed-in user and refuses a user with no row', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    await expect(getPartnerForUser(partner.userId)).resolves.toMatchObject({ id: partner.id });
    await expect(getPartnerForUser('usr_publisher')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('draws the page from the row, the wallet and the rate card state', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    const view = await partnerProfile(partner);
    expect(view.walletId).toBe('wal_prt');
    expect(view.balances).toMatchObject({ balance: '500.00' });
    expect(view.rateCard).toEqual({ hasRateCard: false, fileId: null, fileUrl: null, updatedAt: null, rows: [] });
  });

  it('lets the partner change the contact, the address, the capabilities and the quote switch — never the legal identity', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    const { after } = await updateMe(partner, { contactName: 'Meena', city: 'Mysuru', capabilities: ['flex'], acceptsQuoteRequests: false, turnaroundDays: 2 });
    expect(after).toMatchObject({ contactName: 'Meena', city: 'Mysuru', capabilities: ['flex'], acceptsQuoteRequests: false, turnaroundDays: 2 });
    expect(repository.updatePartner).toHaveBeenLastCalledWith(partner.id, expect.not.objectContaining({ name: expect.anything() }));
  });

  it('refuses an email another account holds', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    repository.emailTaken.mockResolvedValueOnce(true);
    await expect(updateMe(partner, { email: 'taken@example.com' })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the rate card', () => {
  it('rows alone make a rate card, stamped with the moment', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    const { after } = await setRateCard(partner, { rows: [{ material: 'Flex', unit: 'sqft', ratePerUnit: '12.00' }] }, NOW);
    expect(after.rateCardRows).toEqual([{ material: 'Flex', unit: 'sqft', ratePerUnit: '12.00' }]);
    expect(after.rateCardUpdatedAt).toEqual(NOW);
    expect(after.rateCardFileId).toBeNull();
    expect(hasRateCard(after)).toBe(true);
  });

  it('takes a file the partner uploaded under PARTNER_RATE_CARD, and nobody else’s', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    fake.files.set('file_rc', { id: 'file_rc', userId: partner.userId, ownerUserId: null, purpose: 'PARTNER_RATE_CARD' });
    fake.files.set('file_theirs', { id: 'file_theirs', userId: 'usr_other', ownerUserId: null, purpose: 'PARTNER_RATE_CARD' });
    fake.files.set('file_wrong', { id: 'file_wrong', userId: partner.userId, ownerUserId: null, purpose: 'AVATAR' });

    const { after } = await setRateCard(partner, { fileId: 'file_rc', rows: [] }, NOW);
    expect(after.rateCardFileId).toBe('file_rc');
    expect(hasRateCard(after)).toBe(true);

    await expect(setRateCard(partner, { fileId: 'file_theirs', rows: [] })).rejects.toMatchObject({ statusCode: 404 });
    await expect(setRateCard(partner, { fileId: 'file_missing', rows: [] })).rejects.toMatchObject({ statusCode: 404 });
    await expect(setRateCard(partner, { fileId: 'file_wrong', rows: [] })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('replaces the card whole — a new card without the file drops the file', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    fake.files.set('file_rc', { id: 'file_rc', userId: partner.userId, ownerUserId: null, purpose: 'PARTNER_RATE_CARD' });
    const first = await setRateCard(partner, { fileId: 'file_rc', rows: [] }, NOW);
    const second = await setRateCard(first.after, { rows: [{ material: 'Vinyl', unit: 'sqft', ratePerUnit: '18.00' }] }, NOW);
    expect(second.after.rateCardFileId).toBeNull();
    expect(second.after.rateCardRows).toHaveLength(1);
  });
});

describe('the money, from the partner’s own phone', () => {
  it('draws the earnings page from the wallet, the allowance, the ledger and the withdrawals', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    wallets.listEntries.mockResolvedValueOnce([
      { id: 'we_1', type: 'EARNING', amount: '500.00', balanceAfter: '500.00', orderId: 'ord_1', reference: 'job_1', note: 'Print job', createdAt: NOW },
    ]);
    const view = await partnerEarnings(partner, { limit: 20 });
    expect(view.walletId).toBe('wal_prt');
    expect(payouts.withdrawalAllowance).toHaveBeenCalledWith('wal_prt');
    expect(view.entries[0]).toMatchObject({ amount: '500.00', orderId: 'ord_1' });
    expect(payouts.listWithdrawals).toHaveBeenCalledWith({ walletId: 'wal_prt', limit: 50 });
  });

  it('raises the withdrawal under payouts’ own rules, to the VERIFIED default method unless one is named', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    payouts.listMethods.mockResolvedValueOnce([
      { id: 'pm_pending', status: 'PENDING_VERIFICATION', isDefault: true },
      { id: 'pm_ok', status: 'VERIFIED', isDefault: false },
    ]);
    await requestPartnerWithdrawal(partner, { amount: '400.00' }, NOW);
    expect(payouts.requestWithdrawal).toHaveBeenCalledWith('wal_prt', { amount: '400.00', payoutMethodId: 'pm_ok', userId: partner.userId }, NOW);

    await requestPartnerWithdrawal(partner, { amount: '100.00', payoutMethodId: 'pm_named' }, NOW);
    expect(payouts.requestWithdrawal).toHaveBeenLastCalledWith('wal_prt', expect.objectContaining({ payoutMethodId: 'pm_named' }), NOW);
  });

  it('refuses a withdrawal with no verified method to send to', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    payouts.listMethods.mockResolvedValueOnce([{ id: 'pm_pending', status: 'PENDING_VERIFICATION', isDefault: true }]);
    await expect(requestPartnerWithdrawal(partner, { amount: '400.00' })).rejects.toMatchObject({ statusCode: 400 });
    expect(payouts.requestWithdrawal).not.toHaveBeenCalled();
  });

  it('records the month’s invoice from the partner’s own PARTNER_INVOICE file', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    fake.files.set('file_inv', { id: 'file_inv', userId: partner.userId, ownerUserId: null, purpose: 'PARTNER_INVOICE' });
    const { after } = await recordPartnerInvoice(partner, { fileId: 'file_inv', month: '2026-08' });
    expect(after.invoiceUploadFileId).toBe('file_inv');
    fake.files.set('file_rc', { id: 'file_rc', userId: partner.userId, ownerUserId: null, purpose: 'PARTNER_RATE_CARD' });
    await expect(recordPartnerInvoice(partner, { fileId: 'file_rc', month: '2026-08' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('the ledger view', () => {
  it('assembles the wallet, its lines, the withdrawals, the jobs and the invoices', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    wallets.listEntries.mockResolvedValueOnce([
      { id: 'we_1', type: 'EARNING', amount: '500.00', balanceAfter: '500.00', orderId: 'ord_1', reference: 'job_1', note: 'Print job', createdAt: new Date() },
    ]);
    const view = await partnerLedger(partner.id, { limit: 20 });
    expect(wallets.findWalletFor).toHaveBeenCalledWith({ kind: 'PRINT_PARTNER', id: partner.id });
    expect(wallets.listEntries).toHaveBeenCalledWith('wal_prt', { limit: 20 });
    expect(payouts.listWithdrawals).toHaveBeenCalledWith({ walletId: 'wal_prt', limit: 50 });
    expect(view.walletId).toBe('wal_prt');
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toMatchObject({ amount: '500.00', orderId: 'ord_1' });
    expect(view.jobs).toHaveLength(1);
    expect(view.jobCounts).toEqual({ READY: 1 });
    // Lot H: the invoices the partner uploaded, from the files themselves.
    expect(repository.listPartnerFiles).toHaveBeenCalledWith(partner.userId, 'PARTNER_INVOICE', 36);
    expect(view.invoices).toHaveLength(1);
  });
});

/* ── G13-B: the desk on the partner's behalf, the invoices with months, the earnings summary, the last login ── */

describe('G13-B: the desk on the partner\'s behalf', () => {
  it('sets the rate card for a partner who never activates — the file the partner\'s own or the admin\'s upload', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    fake.files.set('file_admin', { id: 'file_admin', userId: 'usr_admin', ownerUserId: null, purpose: 'PARTNER_RATE_CARD' });
    fake.files.set('file_onbehalf', { id: 'file_onbehalf', userId: 'usr_admin', ownerUserId: partner.userId, purpose: 'PARTNER_RATE_CARD' });
    fake.files.set('file_stranger', { id: 'file_stranger', userId: 'usr_other', ownerUserId: null, purpose: 'PARTNER_RATE_CARD' });

    const { after } = await setRateCardOnBehalf(partner.id, { fileId: 'file_admin', rows: [] }, 'usr_admin', NOW);
    expect(after.rateCardFileId).toBe('file_admin');
    expect(after.rateCardUpdatedAt).toEqual(NOW);
    expect((await setRateCardOnBehalf(partner.id, { fileId: 'file_onbehalf', rows: [] }, 'usr_admin', NOW)).after.rateCardFileId).toBe('file_onbehalf');
    await expect(setRateCardOnBehalf(partner.id, { fileId: 'file_stranger', rows: [] }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 404 });
    await expect(setRateCardOnBehalf('prt_nope', { rows: [{ material: 'Flex', unit: 'sqft', ratePerUnit: '1.00' }] }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('flips acceptsQuoteRequests from the desk', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    const { after } = await updatePartner(partner.id, { acceptsQuoteRequests: false });
    expect(after.acceptsQuoteRequests).toBe(false);
  });

  it('records the month\'s invoice on behalf from the admin\'s own PARTNER_INVOICE upload', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    fake.files.set('file_inv_admin', { id: 'file_inv_admin', userId: 'usr_admin', ownerUserId: null, purpose: 'PARTNER_INVOICE' });
    const { after } = await recordPartnerInvoiceOnBehalf(partner.id, { fileId: 'file_inv_admin', month: '2026-08' }, 'usr_admin');
    expect(after.invoiceUploadFileId).toBe('file_inv_admin');
    fake.files.set('file_wrong', { id: 'file_wrong', userId: 'usr_admin', ownerUserId: null, purpose: 'PARTNER_RATE_CARD' });
    await expect(recordPartnerInvoiceOnBehalf(partner.id, { fileId: 'file_wrong', month: '2026-08' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('G13-B: the invoices with their months', () => {
  it('lists the partner\'s own files and the ones an admin recorded on their behalf, each with the month off the audit row', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    audit.findActivityRows.mockResolvedValueOnce([
      { metadata: { month: '2026-08', fileId: 'file_inv_1' } },
      { metadata: { month: '2026-07', fileId: 'file_inv_admin', onBehalf: true } },
      { metadata: { month: '2026-06', fileId: 'file_inv_admin', onBehalf: true } }, // an older row for the same file — the newest wins
    ]);
    const invoices = await listPartnerInvoicesWithMonths(partner);
    expect(audit.findActivityRows).toHaveBeenCalledWith(
      { action: 'PARTNER_INVOICE_UPLOADED', targetType: 'PrintPartner', targetId: partner.id },
      { skip: 0, take: 500, sort: 'newest' },
    );
    expect(repository.findFilesByIds).toHaveBeenCalledWith(['file_inv_admin']);
    expect(invoices.map((row) => [row.id, row.month, row.recordedBy])).toEqual([
      ['file_inv_1', '2026-08', 'PARTNER'],
      ['file_inv_admin', '2026-07', 'ADMIN'],
    ]);
  });

  it('a file uploaded and never recorded carries no month', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    const invoices = await listPartnerInvoicesWithMonths(partner);
    expect(invoices).toEqual([expect.objectContaining({ id: 'file_inv_1', month: null, recordedBy: null })]);
    expect(repository.findFilesByIds).not.toHaveBeenCalled();
  });
});

describe('G13-B: the earnings summary', () => {
  it('sums the EARNING lines of this Indian month and the last, the withdrawals in flight, and every one paid', async () => {
    const partner = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    wallets.sumEntries.mockResolvedValueOnce({ total: '1200.00', count: 2 }).mockResolvedValueOnce({ total: '800.00', count: 1 });
    payouts.listWithdrawals.mockImplementation(async (filter?: Row) =>
      filter?.status?.includes('PAID')
        ? [{ netAmount: '500.00' }, { netAmount: '250.50' }]
        : [{ netAmount: '300.00' }],
    );
    const summary = await partnerEarningsSummary(partner, new Date('2026-09-14T09:00:00Z'));
    expect(summary).toEqual({ thisMonth: '1200.00', lastMonth: '800.00', pending: '300.00', paidToDate: '750.50' });
    // September 2026 in India opens at 31 Aug 18:30Z; August at 31 Jul 18:30Z.
    expect(wallets.sumEntries).toHaveBeenNthCalledWith(1, 'wal_prt', ['EARNING'], new Date('2026-08-31T18:30:00Z'), new Date('2026-09-30T18:30:00Z'));
    expect(wallets.sumEntries).toHaveBeenNthCalledWith(2, 'wal_prt', ['EARNING'], new Date('2026-07-31T18:30:00Z'), new Date('2026-08-31T18:30:00Z'));
    expect(payouts.listWithdrawals).toHaveBeenCalledWith({ walletId: 'wal_prt', status: ['REQUESTED', 'APPROVED', 'PROCESSING'], limit: 200 });
    expect(payouts.listWithdrawals).toHaveBeenCalledWith({ walletId: 'wal_prt', status: ['PAID'], limit: 200 });
  });
});

describe('G13-B: the last login', () => {
  it('reads User.lastLoginAt for a page of partners in one lookup; null for one who never signed in', async () => {
    const first = await createPartner({ name: 'Rapid Prints', mobile: '9876543210' });
    const second = await createPartner({ name: 'Bright Banners', mobile: '9876543211' });
    const rows = await withLastLogin([first, second]);
    expect(repository.findLastLogins).toHaveBeenCalledWith([first.userId, second.userId]);
    expect(rows.map((row) => row.lastLoginAt)).toEqual([NOW, null]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot D (Q123/Q94): the package terms, and the catalogue editor.
 *
 * The terms: accepted by the advertiser (or their agent under a live grant)
 * on the version live now, rendered from the template and the sale, before
 * either payment door opens. The editor: ops reprice and rename without a
 * deploy; a sale keeps the snapshot it was priced on; entitlements stay copy.
 */

const { repository, agreements, grants, audit } = vi.hoisted(() => ({
  repository: {
    listPackages: vi.fn(),
    findPackageByTier: vi.fn(),
    upsertPackage: vi.fn(),
    updatePackage: vi.fn(),
    listAddOns: vi.fn(),
    findAddOnByCode: vi.fn(),
    upsertAddOn: vi.fn(),
    updateAddOn: vi.fn(),
  },
  agreements: {
    currentTemplate: vi.fn(),
    recordAcceptance: vi.fn(),
    transactionAcceptance: vi.fn(),
  },
  grants: { liveGrantFor: vi.fn() },
  audit: { logActivity: vi.fn(async () => undefined) },
}));

vi.mock('../prisma-packages.repository', () => ({ prismaPackagesRepository: repository }));
vi.mock('../../agreements', () => agreements);
vi.mock('../../access-grants', () => grants);
vi.mock('../../notifications', () => ({ createNotification: vi.fn(), notify: vi.fn(async () => ({ notificationId: null, templateKey: null, deliveries: [] })) }));
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity: audit.logActivity,
}));

import {
  acceptSaleTerms,
  assertMayAcceptTerms,
  assertSaleTermsAccepted,
  createAddOn,
  listCatalogue,
  renderPackageTerms,
  updateAddOn,
  updatePlan,
} from '../packages.service';

const sale = (over: Record<string, unknown> = {}) =>
  ({
    id: 'sale_1',
    reference: 'PKG-2026-482913',
    advertiserId: 'adv_1',
    agentId: 'agt_1',
    tier: 'GROWTH',
    packageName: 'Growth',
    cycle: 'ANNUAL',
    months: 12,
    status: 'PENDING_PAYMENT',
    subtotal: new Decimal('299988'),
    discountAmount: new Decimal('59997.60'),
    gstAmount: new Decimal('43198.27'),
    total: new Decimal('283188.67'),
    advertiser: { id: 'adv_1', name: 'Nilgiri Coffee', companyName: null, email: null, mobile: '+919812340001' },
    lines: [
      { kind: 'PLAN', code: 'GROWTH', label: 'Growth plan', pricePerMonth: new Decimal('24999'), months: 12, amount: new Decimal('299988') },
    ],
    ...over,
  }) as never;

const advertiser = { userId: 'usr_adv', isAdmin: false, advertiserId: 'adv_1', agentId: null };
const agent = { userId: 'usr_agt', isAdmin: false, advertiserId: null, agentId: 'agt_1' };
const admin = { userId: 'usr_ops', isAdmin: true, advertiserId: null, agentId: null };
const ctx = { acceptedByUserId: 'usr_adv', ipAddress: '10.0.0.1', userAgent: 'app/1.0' };

beforeEach(() => {
  vi.clearAllMocks();
  agreements.currentTemplate.mockResolvedValue({ id: 'tpl_1', kind: 'PACKAGE_SALE', version: 2, body: 'Package terms' });
  agreements.recordAcceptance.mockResolvedValue({ id: 'acc_1', templateVersion: 2 });
  agreements.transactionAcceptance.mockResolvedValue({ kind: 'PACKAGE_SALE', accepted: true, templateVersion: 2, currentVersion: 2, current: true });
  repository.listPackages.mockResolvedValue([{ id: 'pkg_1' }]);
  repository.listAddOns.mockResolvedValue([{ id: 'add_1' }]);
});

describe('the package terms', () => {
  it('renders the template with the sale enumerated', () => {
    const text = renderPackageTerms('Body', sale());
    expect(text).toContain('## This order');
    expect(text).toContain('Package PKG-2026-482913 — Growth (GROWTH)');
    expect(text).toContain('1. Growth plan — ₹24999.00/month × 12 = ₹299988.00');
    expect(text).toContain('total ₹283188.67');
    expect(renderPackageTerms('Before {{sale}} After', sale())).toMatch(/^Before Package PKG-2026-482913[\s\S]*After$/);
  });

  it('records the acceptance for the advertiser, anchored on the sale, rendered server-side', async () => {
    const result = await acceptSaleTerms(sale(), ctx);
    expect(result).toEqual({ accepted: true, templateVersion: 2, acceptanceId: 'acc_1' });
    expect(agreements.recordAcceptance).toHaveBeenCalledWith({
      kind: 'PACKAGE_SALE',
      party: { advertiserId: 'adv_1' },
      anchor: { packageSaleId: 'sale_1' },
      ctx,
      renderedDocument: expect.stringContaining('Package terms'),
    });
  });

  it('a cancelled or expired sale has no terms left to accept', async () => {
    await expect(acceptSaleTerms(sale({ status: 'CANCELLED' }), ctx)).rejects.toMatchObject({ statusCode: 409 });
    await expect(acceptSaleTerms(sale({ status: 'EXPIRED' }), ctx)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('the advertiser may accept; their agent only under a live grant; an admin never', async () => {
    await expect(assertMayAcceptTerms(sale(), advertiser)).resolves.toBeUndefined();

    grants.liveGrantFor.mockResolvedValue({ id: 'grant_1' });
    await expect(assertMayAcceptTerms(sale(), agent)).resolves.toBeUndefined();
    expect(grants.liveGrantFor).toHaveBeenCalledWith('agt_1', { advertiserId: 'adv_1' }, 'PROFILE');

    grants.liveGrantFor.mockResolvedValue(null);
    await expect(assertMayAcceptTerms(sale(), agent)).rejects.toMatchObject({ statusCode: 403 });

    await expect(assertMayAcceptTerms(sale(), admin)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('payment needs the terms on the version live now — 403 AGREEMENT_REQUIRED otherwise', async () => {
    await expect(assertSaleTermsAccepted('sale_1')).resolves.toMatchObject({ current: true });

    agreements.transactionAcceptance.mockResolvedValue({ kind: 'PACKAGE_SALE', accepted: true, templateVersion: 1, currentVersion: 2, current: false });
    await expect(assertSaleTermsAccepted('sale_1')).rejects.toMatchObject({
      statusCode: 403,
      code: 'AGREEMENT_REQUIRED',
      message: expect.stringContaining('changed since'),
    });

    agreements.transactionAcceptance.mockResolvedValue({ kind: 'PACKAGE_SALE', accepted: false, templateVersion: null, currentVersion: 2, current: false });
    await expect(assertSaleTermsAccepted('sale_1')).rejects.toMatchObject({ code: 'AGREEMENT_REQUIRED' });
  });
});

describe('E7-3: the catalogue read', () => {
  const addOn = (over: Record<string, unknown> = {}) => ({
    id: 'add_1',
    code: 'PREMIUM_ANALYTICS',
    name: 'Premium analytics',
    pricePerMonth: new Decimal('2500'),
    description: null,
    isActive: true,
    sortOrder: 1,
    ...over,
  });
  const plan = (over: Record<string, unknown> = {}) => ({
    id: 'pkg_growth',
    tier: 'GROWTH',
    name: 'Growth',
    pricePerMonth: new Decimal('24999'),
    description: null,
    isPopular: true,
    entitlements: { campaignsPerMonth: 8 },
    isActive: true,
    sortOrder: 2,
    ...over,
  });

  beforeEach(() => {
    repository.listPackages.mockImplementation(async (includeInactive?: boolean) =>
      includeInactive ? [plan(), plan({ id: 'pkg_pro', tier: 'PRO', isActive: false, sortOrder: 3 })] : [plan()],
    );
    repository.listAddOns.mockImplementation(async (includeInactive?: boolean) =>
      includeInactive ? [addOn(), addOn({ id: 'add_2', code: 'RETIRED', isActive: false, sortOrder: 2 })] : [addOn()],
    );
  });

  it('answers the active rows only by default, each carrying isActive and sortOrder', async () => {
    const out = await listCatalogue();
    expect(out.packages).toHaveLength(1);
    expect(out.addOns).toHaveLength(1);
    expect(out.packages[0]).toMatchObject({ tier: 'GROWTH', isActive: true, sortOrder: 2, pricePerMonth: '24999.00' });
    expect(out.addOns[0]).toMatchObject({ code: 'PREMIUM_ANALYTICS', isActive: true, sortOrder: 1 });
    expect(repository.listPackages).toHaveBeenLastCalledWith(false);
    expect(repository.listAddOns).toHaveBeenLastCalledWith(false);
  });

  it('includes the retired rows when the desk asks', async () => {
    const out = await listCatalogue({ includeInactive: true });
    expect(out.packages.map((p) => [p.tier, p.isActive])).toEqual([['GROWTH', true], ['PRO', false]]);
    expect(out.addOns.map((a) => [a.code, a.isActive])).toEqual([['PREMIUM_ANALYTICS', true], ['RETIRED', false]]);
  });
});

describe('the catalogue editor', () => {
  const plan = (over: Record<string, unknown> = {}) => ({
    id: 'pkg_growth',
    tier: 'GROWTH',
    name: 'Growth',
    pricePerMonth: new Decimal('24999'),
    description: 'For a brand running campaigns every month.',
    isPopular: true,
    entitlements: { campaignsPerMonth: 8 },
    isActive: true,
    sortOrder: 2,
    ...over,
  });
  const editor = { userId: 'usr_ops' };

  it('reprices a plan and audits the money and the switch', async () => {
    repository.findPackageByTier.mockResolvedValue(plan());
    repository.updatePackage.mockImplementation(async (_tier, patch) => plan(patch));

    const after = await updatePlan('GROWTH', { pricePerMonth: '27999', entitlements: { campaignsPerMonth: 10 }, isActive: false }, editor);

    expect(repository.updatePackage).toHaveBeenCalledWith('GROWTH', {
      pricePerMonth: new Decimal('27999'),
      entitlements: { campaignsPerMonth: 10 },
      isActive: false,
    });
    expect(after.isActive).toBe(false);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_ops',
      'PACKAGE_PLAN_UPDATED',
      expect.objectContaining({
        module: 'packages',
        targetType: 'AdvertiserPackage',
        targetId: 'pkg_growth',
        diff: expect.objectContaining({
          pricePerMonth: { before: '24999.00', after: '27999.00' },
          isActive: { before: true, after: false },
        }),
      }),
    );
  });

  it('404s a plan the catalogue does not carry', async () => {
    repository.findPackageByTier.mockResolvedValue(null);
    await expect(updatePlan('PRO', { name: 'Pro+' }, editor)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('creates an add-on once — a second create with the same code is a conflict', async () => {
    repository.findAddOnByCode.mockResolvedValue(null);
    repository.upsertAddOn.mockImplementation(async (data) => ({ id: 'add_new', isActive: true, ...data }));

    await createAddOn({ code: 'PRIORITY_INSTALL', name: 'Priority install', pricePerMonth: '1500' }, editor);
    expect(repository.upsertAddOn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PRIORITY_INSTALL', pricePerMonth: new Decimal('1500'), sortOrder: 0 }),
    );
    expect(audit.logActivity).toHaveBeenCalledWith('usr_ops', 'PACKAGE_ADDON_CREATED', expect.objectContaining({ targetId: 'add_new' }));

    repository.findAddOnByCode.mockResolvedValue({ id: 'add_new', code: 'PRIORITY_INSTALL' });
    await expect(createAddOn({ code: 'PRIORITY_INSTALL', name: 'x', pricePerMonth: '1' }, editor)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('E7-3: reactivates a retired add-on through the same PATCH', async () => {
    repository.findAddOnByCode.mockResolvedValue({ id: 'add_1', code: 'PREMIUM_ANALYTICS', name: 'Premium analytics', pricePerMonth: new Decimal('2500'), isActive: false });
    repository.updateAddOn.mockResolvedValue({ id: 'add_1', code: 'PREMIUM_ANALYTICS', name: 'Premium analytics', pricePerMonth: new Decimal('2500'), isActive: true });

    const after = await updateAddOn('PREMIUM_ANALYTICS', { isActive: true }, editor);

    expect(after.isActive).toBe(true);
    expect(repository.updateAddOn).toHaveBeenCalledWith('PREMIUM_ANALYTICS', { isActive: true });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_ops',
      'PACKAGE_ADDON_UPDATED',
      expect.objectContaining({ diff: { isActive: { before: false, after: true } } }),
    );
  });

  it('retires an add-on and audits it', async () => {
    repository.findAddOnByCode.mockResolvedValue({ id: 'add_1', code: 'PREMIUM_ANALYTICS', name: 'Premium analytics', pricePerMonth: new Decimal('2500'), isActive: true });
    repository.updateAddOn.mockResolvedValue({ id: 'add_1', code: 'PREMIUM_ANALYTICS', name: 'Premium analytics', pricePerMonth: new Decimal('2500'), isActive: false });

    await updateAddOn('PREMIUM_ANALYTICS', { isActive: false }, editor);

    expect(repository.updateAddOn).toHaveBeenCalledWith('PREMIUM_ANALYTICS', { isActive: false });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_ops',
      'PACKAGE_ADDON_UPDATED',
      expect.objectContaining({ diff: { isActive: { before: true, after: false } } }),
    );
  });
});

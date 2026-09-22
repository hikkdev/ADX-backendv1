import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How an agent comes to exist.
 *
 * Not in either app: agents are created at the admin's desk, in person, and
 * then sign in with the number typed there. Until this route existed the
 * agents module was two GETs, the console's "Add agent" button was a toast
 * saying the opposite policy, and `sendOtp` silently ignored numbers it did
 * not know — so a person hired as an agent had no way to come into being.
 */

const { repository, identifiers, auth, pricing } = vi.hoisted(() => ({
  repository: {
    findUserByMobile: vi.fn(),
    emailTaken: vi.fn(),
    createAgent: vi.fn(),
    attachAgent: vi.fn(),
    findById: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
  auth: { normalizeMobile: vi.fn((m: string) => (m.startsWith('+') ? m : `+91${m}`)) },
  pricing: {
    assertCityAllows: vi.fn(),
    // Lot X-B: the city key — Bengaluru (and its old spelling) and Mysuru are catalogued; the rest are typed towns.
    cityKeyFor: vi.fn(async (name: string | null | undefined) =>
      name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : name && /^mysuru$/i.test(name.trim()) ? { cityId: 'city_mysuru', slug: 'mysuru' } : null,
    ),
    withCityKey: vi.fn(async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: (await pricing.cityKeyFor(data.city))?.cityId ?? null })),
  },
}));

vi.mock('../prisma-agents.repository', () => ({ prismaAgentsRepository: repository }));
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../auth', () => auth);
vi.mock('../../pricing', () => pricing);

import { ApiError } from '../../../shared/errors';
import { createAgent } from '../agents.service';

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
  repository.findUserByMobile.mockResolvedValue(null);
  repository.emailTaken.mockResolvedValue(false);
  repository.createAgent.mockResolvedValue({ id: 'agt_new' });
  repository.attachAgent.mockResolvedValue({ id: 'agt_attached' });
  repository.findById.mockImplementation(async (id: string) => ({ id, displayId: 'AGT-1009-2601' }));
  identifiers.allocateIdentifier.mockResolvedValue('AGT-1009-2601');
  pricing.assertCityAllows.mockImplementation(gate);
});

describe('creating an agent', () => {
  it('writes a new person as user, role and profile, with an AGT- identifier', async () => {
    const agent = await createAgent({ mobile: '9876543210', name: 'Rahul Kumar', side: 'PUBLISHER' });

    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('AGENT');
    expect(repository.createAgent).toHaveBeenCalledWith({
      mobile: '+919876543210',
      name: 'Rahul Kumar',
      role: 'AGENT_PUBLISHER',
      displayId: 'AGT-1009-2601',
      stage: 'ACTIVE',
    });
    expect(agent).toMatchObject({ id: 'agt_new', displayId: 'AGT-1009-2601' });
  });

  it('gives an advertiser-side agent the advertiser role', async () => {
    await createAgent({ mobile: '9876543210', name: 'Meera S', side: 'ADVERTISER', city: 'Bengaluru' });
    expect(repository.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'AGENT_ADVERTISER', city: 'Bengaluru', cityId: 'city_bengaluru' }),
    );
    expect(pricing.assertCityAllows).toHaveBeenCalledWith('Bengaluru', 'agentOnboarding');
  });

  it('Lot X-B: the old spelling keys to the catalogue row, a typed town keeps its string with a null key', async () => {
    await createAgent({ mobile: '9876543210', name: 'Meera S', side: 'ADVERTISER', city: 'Bangalore' });
    expect(repository.createAgent).toHaveBeenCalledWith(expect.objectContaining({ city: 'Bangalore', cityId: 'city_bengaluru' }));
    await createAgent({ mobile: '9876543211', name: 'Typed', side: 'ADVERTISER', city: 'Rameswaram' });
    expect(repository.createAgent).toHaveBeenLastCalledWith(expect.objectContaining({ city: 'Rameswaram', cityId: null }));
  });

  /* Lot V: agents are onboarded where the city's rollout stage says so. */
  it('refuses an agent in a planned city with CITY_NOT_OPEN, burning no identifier, and takes one in a town the catalogue lacks', async () => {
    await expect(createAgent({ mobile: '9876543210', name: 'Too Early', side: 'PUBLISHER', city: 'Mysuru' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'CITY_NOT_OPEN',
      details: { stage: 'PLANNED', function: 'agentOnboarding', city: 'mysuru' },
    });
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
    expect(repository.createAgent).not.toHaveBeenCalled();

    await createAgent({ mobile: '9876543210', name: 'Far Away', side: 'PUBLISHER', city: 'Rameswaram' });
    expect(repository.createAgent).toHaveBeenCalledWith(expect.objectContaining({ city: 'Rameswaram' }));
  });

  /* A publisher hired as an agent keeps their account and gains the role. */
  it('attaches the role and a profile to a number that already has an account', async () => {
    repository.findUserByMobile.mockResolvedValue({ id: 'usr_pub', agentProfileId: null, roles: ['PUBLISHER'] });

    const agent = await createAgent({ mobile: '9876543210', name: 'Rahul Kumar', side: 'PUBLISHER' });

    expect(repository.createAgent).not.toHaveBeenCalled();
    expect(repository.attachAgent).toHaveBeenCalledWith('usr_pub', expect.objectContaining({ role: 'AGENT_PUBLISHER' }));
    expect(agent).toMatchObject({ id: 'agt_attached' });
  });

  /* One person, one profile, one earnings ledger. */
  it('refuses a number that is already an agent, and burns no identifier doing so', async () => {
    repository.findUserByMobile.mockResolvedValue({ id: 'usr_a', agentProfileId: 'agt_a', roles: ['AGENT_PUBLISHER'] });

    await expect(
      createAgent({ mobile: '9876543210', name: 'Rahul Kumar', side: 'PUBLISHER' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
  });

  it('refuses an email that belongs to somebody else', async () => {
    repository.emailTaken.mockResolvedValue(true);
    await expect(
      createAgent({ mobile: '9876543210', name: 'Rahul Kumar', email: 'r@example.in', side: 'PUBLISHER' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
  });

  it('normalises the number before looking it up, so 98765… and +9198765… are one person', async () => {
    await createAgent({ mobile: '9876543210', name: 'Rahul Kumar', side: 'PUBLISHER' });
    expect(repository.findUserByMobile).toHaveBeenCalledWith('+919876543210');
  });
});

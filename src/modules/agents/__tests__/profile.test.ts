import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D5 — the agent's status, territory and work preferences.
 *
 * What is pinned: the shape ops may write (DR 07's fields, with the hours in
 * order and the days a real week), that a patch lands on an agent who exists
 * and comes back as the full record, and that the agent's own preference
 * route is the DR 07 subset only — it cannot set the status or the territory.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findByUserId: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../prisma-agents.repository', () => ({ prismaAgentsRepository: repository }));
// Lot X-B: the city key beside a patched city.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
  withCityKey: async (data: { city?: string | null }) =>
    data.city === undefined ? data : { ...data, cityId: /^(bengaluru|bangalore)$/i.test((data.city ?? '').trim()) ? 'city_bengaluru' : null },
}));

import { agentPreferencesSchema, updateAgentSchema } from '../agents.schema';
import { getMyPreferences, updateAgent, updateMyPreferences } from '../agents.service';

const profile = {
  id: 'agt_1',
  userId: 'usr_1',
  status: 'ACTIVE',
  territory: 'Bengaluru South',
  homeZone: 'Koramangala',
  radiusKm: 8,
  workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
  hoursFrom: '09:00',
  hoursTo: '19:00',
  autoAcceptInZone: false,
  orderTypes: ['OUTDOOR'],
  maxActiveOrders: 3,
  businessName: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(profile);
  repository.findByUserId.mockResolvedValue(profile);
  repository.update.mockImplementation(async (_id: string, patch: object) => ({ ...profile, ...patch }));
});

describe('what ops may write', () => {
  it('is DR 07 as drawn: radius, home zone, days, hours, auto-accept, order types, a cap', () => {
    expect(
      updateAgentSchema.parse({
        territory: ' Bengaluru South ',
        homeZone: 'Koramangala',
        radiusKm: 8,
        workingDays: ['MON', 'SAT'],
        hoursFrom: '09:00',
        hoursTo: '19:00',
        autoAcceptInZone: true,
        orderTypes: ['OUTDOOR', 'TRANSIT'],
        maxActiveOrders: 3,
        status: 'ON_LEAVE',
      })
    ).toEqual({
      territory: 'Bengaluru South',
      homeZone: 'Koramangala',
      radiusKm: 8,
      workingDays: ['MON', 'SAT'],
      hoursFrom: '09:00',
      hoursTo: '19:00',
      autoAcceptInZone: true,
      orderTypes: ['OUTDOOR', 'TRANSIT'],
      maxActiveOrders: 3,
      status: 'ON_LEAVE',
    });
  });

  it('refuses a day that is not one, hours out of order, and a status that is not one', () => {
    expect(updateAgentSchema.safeParse({ workingDays: ['FUNDAY'] }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ hoursFrom: '19:00', hoursTo: '09:00' }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ hoursFrom: '9am' }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ status: 'RETIRED' }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ orderTypes: ['BILLBOARD'] }).success).toBe(false);
  });

  it("the agent's own preferences cannot touch the status or the territory", () => {
    const parsed = agentPreferencesSchema.parse({ status: 'SUSPENDED', territory: 'Elsewhere', radiusKm: 5 });
    expect(parsed).toEqual({ radiusKm: 5 });
  });
});

describe('writing it', () => {
  it('lands on the agent and returns the whole record', async () => {
    const updated = await updateAgent('agt_1', { status: 'ON_LEAVE', maxActiveOrders: 2 });
    expect(repository.update).toHaveBeenCalledWith('agt_1', { status: 'ON_LEAVE', maxActiveOrders: 2 });
    expect(updated).toMatchObject({ id: 'agt_1' });
  });

  it('refuses an agent who does not exist', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(updateAgent('agt_x', { radiusKm: 5 })).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it("the agent's own route resolves their profile and answers the DR 07 subset", async () => {
    expect(await getMyPreferences('usr_1')).toEqual({
      homeZone: 'Koramangala',
      radiusKm: 8,
      workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
      hoursFrom: '09:00',
      hoursTo: '19:00',
      autoAcceptInZone: false,
      orderTypes: ['OUTDOOR'],
      maxActiveOrders: 3,
    });
    const after = await updateMyPreferences('usr_1', { autoAcceptInZone: true });
    expect(repository.update).toHaveBeenCalledWith('agt_1', { autoAcceptInZone: true });
    expect(after.autoAcceptInZone).toBe(true);
    expect(after).not.toHaveProperty('status');
  });

  it('is refused without an agent profile', async () => {
    repository.findByUserId.mockResolvedValue(null);
    await expect(getMyPreferences('usr_x')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the city key on a patch (Lot X-B)', () => {
  it('a patched city carries its key (null for a typed town); a patch of other fields leaves the key alone', async () => {
    await updateAgent('agt_1', { city: 'Bangalore' });
    expect(repository.update).toHaveBeenCalledWith('agt_1', { city: 'Bangalore', cityId: 'city_bengaluru' });
    await updateAgent('agt_1', { city: 'Rameswaram' });
    expect(repository.update).toHaveBeenLastCalledWith('agt_1', { city: 'Rameswaram', cityId: null });
    await updateAgent('agt_1', { status: 'ON_LEAVE' });
    expect(repository.update).toHaveBeenLastCalledWith('agt_1', { status: 'ON_LEAVE' });
  });
});

describe('account lifecycle (2 Oct 2026): status changes into and out of a suspension go through Suspend / Reinstate', () => {
  it('refuses SUSPENDED with a sentence pointing to Suspend, writing nothing', async () => {
    await expect(updateAgent('agt_1', { status: 'SUSPENDED' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Use Suspend') });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('refuses any status on a suspended agent, pointing to Reinstate', async () => {
    repository.findById.mockResolvedValue({ ...profile, status: 'SUSPENDED', suspensionScopes: ['BLOCK_NEW'] });
    await expect(updateAgent('agt_1', { status: 'ACTIVE' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Reinstate') });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('still moves a working agent between working and on leave, and leaves a suspended agent’s other fields editable', async () => {
    await updateAgent('agt_1', { status: 'ON_LEAVE' });
    expect(repository.update).toHaveBeenCalledWith('agt_1', { status: 'ON_LEAVE' });
    repository.findById.mockResolvedValue({ ...profile, status: 'SUSPENDED', suspensionScopes: ['BLOCK_NEW'] });
    await updateAgent('agt_1', { territory: 'North' });
    expect(repository.update).toHaveBeenLastCalledWith('agt_1', { territory: 'North' });
  });
});

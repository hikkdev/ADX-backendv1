import { ist, type Fact, type Seed } from './in-memory.repository';

/**
 * The window every section test reads: ten Indian days, 1–10 September
 * 2026, so the previous window is 22–31 August. Two facts sit on the seam —
 * 00:15 IST on the 1st (this window) and 23:30 IST on the 31st (the one
 * before) — which is where a UTC-day implementation would put them wrong.
 */
export const QUERY = { from: '2026-09-01', to: '2026-09-10' } as const;
export const NOW = ist('2026-09-15T12:00');

export const WINDOW_START = ist('2026-09-01T00:00');
export const WINDOW_END = ist('2026-09-11T00:00');
export const PREVIOUS_START = ist('2026-08-22T00:00');

export const labelsOf = async (ids: readonly string[]) => ids.map((id) => ({ id, label: `Name ${id}`, displayId: `D-${id}` }));

const blr = (local: string, extra: Partial<Fact> = {}): Fact => ({ at: ist(local), city: 'Bengaluru', ...extra });
const mum = (local: string, extra: Partial<Fact> = {}): Fact => ({ at: ist(local), city: 'Mumbai', ...extra });

/** Three created in the window (one on the seam), five before it (one on the seam), one long ago. */
export const partyCreations = (): Fact[] => [
  blr('2026-09-01T00:15'),
  blr('2026-09-03T10:00'),
  mum('2026-09-10T23:59'),
  blr('2026-08-31T23:30'),
  blr('2026-08-25T09:00'),
  mum('2026-08-24T09:00'),
  mum('2026-08-23T09:00'),
  blr('2026-08-22T00:01'),
  blr('2026-01-01T09:00'),
];

export const publishersSeed = (): Seed => ({
  publisher: partyCreations(),
  publisherFirstListing: [blr('2026-09-02T11:00'), blr('2026-09-02T15:00'), mum('2026-08-30T11:00')],
  publisherFirstBooking: [blr('2026-09-05T00:00'), mum('2026-08-29T00:00')],
  publisherEarning: [
    blr('2026-09-04T00:00', { key: 'pub_a', amount: '1500.00' }),
    blr('2026-09-06T00:00', { key: 'pub_a', amount: '500.25' }),
    mum('2026-09-06T00:00', { key: 'pub_b', amount: '3000.00' }),
    blr('2026-08-28T00:00', { key: 'pub_a', amount: '4000.00' }),
  ],
  publisherPayout: [blr('2026-09-08T12:00', { amount: '2000.00' }), blr('2026-08-26T12:00', { amount: '2500.00' })],
  kyc: { AWAITING_DOCUMENTS: 4, REQUESTED: 1, PENDING: 2, NEEDS_INFO: 1, REJECTED: 0, VERIFIED: 7 },
  states: { publishersWithLiveListing: 6, publishersSuspended: 1, publishersClosed: 2 },
  groups: { city: [{ key: 'Bengaluru', count: 6 }, { key: 'Mumbai', count: 3 }], agent: [{ key: 'agt_1', count: 5 }, { key: 'agt_2', count: 2 }] },
});

export const advertisersSeed = (): Seed => ({
  advertiser: partyCreations(),
  advertiserFirstCampaign: [blr('2026-09-02T11:00'), mum('2026-08-30T11:00')],
  advertiserSpend: [
    blr('2026-09-01T00:15', { key: 'adv_a', amount: '10000.00' }),
    blr('2026-09-07T10:00', { key: 'adv_a', amount: '2500.50' }),
    mum('2026-09-07T10:00', { key: 'adv_b', amount: '20000.00' }),
    blr('2026-08-31T23:30', { key: 'adv_c', amount: '9000.00' }),
  ],
  advertiserTopUp: [blr('2026-09-03T10:00', { amount: '5000.00' }), mum('2026-08-25T10:00', { amount: '8000.00' })],
  kyc: { AWAITING_DOCUMENTS: 2, REQUESTED: 0, PENDING: 3, NEEDS_INFO: 0, REJECTED: 1, VERIFIED: 5 },
  groups: {
    city: [{ key: 'Bengaluru', count: 5 }, { key: 'Mumbai', count: 4 }],
    industry: [{ key: 'Retail', count: 6 }, { key: 'Education', count: 3 }],
    agent: [{ key: 'agt_1', count: 3 }],
  },
});

export const agentsSeed = (): Seed => ({
  agent: partyCreations(),
  onboarding: [blr('2026-09-01T00:15'), blr('2026-09-04T10:00'), mum('2026-08-31T23:30')],
  visit: [blr('2026-09-02T10:00', { key: 'agt_1' }), blr('2026-09-09T10:00', { key: 'agt_2' }), mum('2026-08-28T10:00', { key: 'agt_3' })],
  job: [blr('2026-09-02T16:00', { key: 'agt_1' }), mum('2026-08-27T16:00', { key: 'agt_3' }), mum('2026-08-27T17:00', { key: 'agt_4' })],
  incentive: [
    blr('2026-09-03T10:00', { key: 'agt_1', amount: '800.00' }),
    blr('2026-09-08T10:00', { key: 'agt_2', amount: '1200.00' }),
    mum('2026-08-29T10:00', { key: 'agt_3', amount: '300.00' }),
  ],
  kyc: { AWAITING_DOCUMENTS: 1, REQUESTED: 0, PENDING: 1, NEEDS_INFO: 0, REJECTED: 0, VERIFIED: 7 },
  states: { agentsSuspended: 1 },
  groups: { city: [{ key: 'Bengaluru', count: 6 }, { key: 'Mumbai', count: 3 }] },
});

/**
 * LH9: the leads. Four created in the window (one on the seam), three
 * before; two first contacts this window; three conversions this window
 * (led_a after 2 days, led_b after 5, led_r after 10 — recycled on the 4th
 * and back as a customer on the 9th), one the window before; two catches
 * this window, one before; one loss each side; the hunt's money: ₹100 +
 * ₹500 + ₹500 recorded, one ₹200 top-up; last window ₹100 and no top-up.
 */
export const leadsSeed = (): Seed => ({
  lead: [
    blr('2026-09-01T00:15', { key: 'led_a' }),
    blr('2026-09-03T10:00', { key: 'led_b' }),
    mum('2026-09-06T10:00', { key: 'led_c' }),
    blr('2026-09-10T23:59', { key: 'led_d' }),
    blr('2026-08-31T23:30', { key: 'led_e' }),
    mum('2026-08-25T09:00', { key: 'led_f' }),
    blr('2026-08-23T09:00', { key: 'led_r' }),
  ],
  leadContact: [blr('2026-09-02T10:00', { key: 'led_a' }), mum('2026-09-07T10:00', { key: 'led_c' }), blr('2026-08-26T10:00', { key: 'led_e' })],
  leadConversion: [
    blr('2026-09-03T10:00', { key: 'led_a', amount: '2' }),
    blr('2026-09-08T10:00', { key: 'led_b', amount: '5' }),
    blr('2026-09-09T10:00', { key: 'led_r', amount: '10' }),
    mum('2026-08-30T10:00', { key: 'led_f', amount: '4' }),
  ],
  leadActivation: [blr('2026-09-05T10:00', { key: 'led_a' }), blr('2026-09-10T10:00', { key: 'led_b' }), mum('2026-08-31T10:00', { key: 'led_f' })],
  leadLoss: [mum('2026-09-08T10:00', { key: 'led_c' }), blr('2026-08-28T10:00', { key: 'led_e' })],
  leadIncentive: [
    blr('2026-09-03T10:00', { key: 'agt_1', amount: '100.00' }),
    blr('2026-09-05T10:00', { key: 'agt_1', amount: '500.00' }),
    blr('2026-09-10T10:00', { key: 'agt_2', amount: '500.00' }),
    mum('2026-08-30T10:00', { key: 'agt_3', amount: '100.00' }),
  ],
  leadTopUp: [blr('2026-09-05T10:00', { key: 'agt_1', amount: '200.00' })],
  leadRecycle: [blr('2026-09-04T10:00', { key: 'led_r' }), blr('2026-09-06T10:00', { key: 'led_d' }), blr('2026-08-24T10:00', { key: 'led_x' })],
  states: { leadsOpen: 12 },
  groups: { city: [{ key: 'Bengaluru', count: 9 }, { key: 'Mumbai', count: 3 }], temperature: [{ key: 'HOT', count: 3 }, { key: 'WARM', count: 5 }, { key: 'COLD', count: 4 }] },
});

export const printPartnersSeed = (): Seed => ({
  printPartner: partyCreations(),
  quoteRequest: [blr('2026-09-02T10:00'), blr('2026-09-02T11:00'), mum('2026-09-05T10:00'), blr('2026-08-30T10:00')],
  quote: [
    blr('2026-09-02T12:00', { key: 'ACCEPTED' }),
    blr('2026-09-03T12:00', { key: 'SUBMITTED' }),
    mum('2026-09-05T12:00', { key: 'REJECTED' }),
    mum('2026-09-05T13:00', { key: 'ACCEPTED' }),
    blr('2026-08-30T12:00', { key: 'ACCEPTED' }),
  ],
  printJob: [
    blr('2026-09-06T10:00', { key: 'prt_1', amount: '4000.00' }),
    blr('2026-09-09T10:00', { key: 'prt_1', amount: '1000.00' }),
    mum('2026-09-09T11:00', { key: 'prt_2', amount: '7000.00' }),
    blr('2026-08-28T10:00', { key: 'prt_1', amount: '3000.00' }),
  ],
  kyc: { AWAITING_DOCUMENTS: 3, REQUESTED: 0, PENDING: 0, NEEDS_INFO: 0, REJECTED: 0, VERIFIED: 6 },
  states: {
    printPartnersActive: 8,
    printPartnersAccepting: 5,
    turnaroundDays: { [WINDOW_START.toISOString()]: 3.5, [PREVIOUS_START.toISOString()]: 4.25 },
  },
  groups: { city: [{ key: 'Bengaluru', count: 6 }, { key: 'Mumbai', count: 3 }] },
});

export const employeesSeed = (): Seed => ({
  employee: [{ at: ist('2026-09-02T09:00') }, { at: ist('2026-09-09T09:00') }, { at: ist('2026-08-30T09:00') }, { at: ist('2025-03-01T09:00') }],
  holiday: [{ at: ist('2026-09-05T00:00') }, { at: ist('2026-08-27T00:00') }, { at: ist('2026-08-15T00:00') }],
  kyc: { AWAITING_DOCUMENTS: 1, REQUESTED: 1, PENDING: 0, NEEDS_INFO: 0, REJECTED: 0, VERIFIED: 2 },
});

export const usersSeed = (): Seed => ({
  user: partyCreations(),
  signIn: [blr('2026-09-01T00:15'), blr('2026-09-04T10:00'), mum('2026-09-04T11:00'), blr('2026-08-31T23:30'), mum('2026-08-26T09:00')],
  userClosed: [blr('2026-09-07T10:00'), mum('2026-08-01T10:00')],
  states: { erasureRequestsOpen: 2, usersWithoutRole: 1 },
  groups: {
    role: [
      { key: 'PUBLISHER', count: 10 },
      { key: 'ADVERTISER', count: 8 },
      { key: 'AGENT_PUBLISHER', count: 3 },
      { key: 'AGENT_ADVERTISER', count: 2 },
      { key: 'PARTNER', count: 4 },
      { key: 'ADMIN', count: 4 },
    ],
    city: [{ key: 'Bengaluru', count: 12 }, { key: 'Mumbai', count: 6 }],
  },
});

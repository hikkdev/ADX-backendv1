import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LH10 (the Lead Hunt, 22 Sep 2026) — anti-gaming and quality.
 *
 * Pinned: the four integrity patterns and what each flag says; a flag is
 * opened once per lead and kind and never re-opened over a decision; the
 * desk's CONFIRMED / DISMISSED is audited and refuses a second decision;
 * the QA evidence reads (a visit's photo, fix and distance; a recording
 * kept without the consent line); the nightly draw takes every nth row
 * once; the quality score is the pass share less the confirmed flags, null
 * under the floor; and the clawback reverses the activation reward when the
 * account closes or its business comes down inside thirty days — once, with
 * the agent told.
 */

const { repository, payouts, agents, notifications, audit } = vi.hoisted(() => ({
  repository: {
    leadsCreatedSince: vi.fn(async () => []),
    leadsWithPhone: vi.fn(async () => []),
    accountsWithPhone: vi.fn(async () => []),
    referralFor: vi.fn(async () => null),
    deviceTokensFor: vi.fn(async () => []),
    userIdsWithDeviceTokens: vi.fn(async () => []),
    userIdForLead: vi.fn(async () => null),
    capturesInHour: vi.fn(async () => ({ count: 0, leadIds: [] })),
    leadsWithExternalKey: vi.fn(async () => []),
    repeatedFormMessages: vi.fn(async () => []),
    findFlag: vi.fn(async () => null),
    createFlag: vi.fn(async (data: Record<string, unknown>) => ({ id: 'flg_1', ...data })),
    updateFlag: vi.fn(async () => ({})),
    findFlagById: vi.fn(),
    listFlags: vi.fn(async () => []),
    countFlags: vi.fn(async () => []),
    visitsCompletedBetween: vi.fn(async () => []),
    callsBetween: vi.fn(async () => []),
    qaSampleExists: vi.fn(async () => false),
    createQaSample: vi.fn(async (data: Record<string, unknown>) => ({ id: 'qa_1', ...data })),
    findQaSample: vi.fn(),
    updateQaSample: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ id: 'qa_1', kind: 'VISIT', agentId: 'agt_1', visitId: 'vst_1', messageId: null, leadId: null, evidence: {}, autoVerdict: 'FAIL', reviewedByUserId: null, reviewedAt: null, note: null, sampledAt: new Date('2026-09-22T00:00:00.000Z'), ...patch })),
    listQaSamples: vi.fn(async () => []),
    qaSamplesForAgent: vi.fn(async () => []),
    confirmedFlagsForAgent: vi.fn(async () => 0),
    activatedSince: vi.fn(async () => []),
    accountStanding: vi.fn(async () => ({ live: true, closed: false, label: null })),
    activationIncentiveFor: vi.fn(async () => null),
  },
  payouts: { clawbackIncentive: vi.fn(async () => ({ id: 'inc_1' })) },
  agents: { getAgentWithUser: vi.fn(async () => ({ id: 'agt_1', userId: 'usr_agent' })) },
  notifications: { notify: vi.fn(async () => ({})) },
  audit: { logActivity: vi.fn(async () => undefined) },
}));

vi.mock('../prisma-integrity.repository', () => ({ prismaIntegrityRepository: repository }));
vi.mock('../../payouts', () => payouts);
vi.mock('../../agents', () => agents);
vi.mock('../../notifications', () => notifications);
vi.mock('../../../shared/audit', () => ({ ...audit, auditDiff: vi.fn(() => ({})) }));

import { BURST_PER_HOUR, decideFlag, listFlags, scanIntegrity, scanLead } from '../integrity.service';
import { CLAWBACK_DAYS, watchClawbacks } from '../clawback.service';
import { everyNth, MIN_QUALITY_SAMPLE, qualityFor, readCallEvidence, readVisitEvidence, reviewQaSample, sampleQa } from '../qa.service';

const NOW = new Date('2026-09-22T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const lead = (over: Record<string, unknown> = {}) => ({
  id: 'led_1',
  displayId: 'LED-0001',
  businessName: 'Suraj Kumar Prints',
  phoneNormalised: '+919845012210',
  capturedByAgentId: null,
  capturedAt: null,
  assignedAgentId: 'agt_1',
  externalKey: null,
  createdAt: new Date(NOW.getTime() - DAY),
  ...over,
});

const visit = (over: Record<string, unknown> = {}) => ({
  id: 'vst_1',
  displayId: 'VST-0001',
  agentId: 'agt_1',
  leadId: 'led_1',
  businessName: 'Suraj Kumar Prints',
  completedAt: NOW,
  latitude: 12.9352,
  longitude: 77.6245,
  proofFileId: 'fil_1',
  proofLatitude: 12.9353,
  proofLongitude: 77.6246,
  proofAt: NOW,
  ...over,
});

const call = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  leadId: 'led_1',
  byAgentId: 'agt_1',
  durationSec: 95,
  consentPlayed: true,
  recordingFileId: 'fil_rec',
  outcome: 'ANSWERED',
  at: NOW,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.leadsCreatedSince.mockResolvedValue([] as never);
  repository.leadsWithPhone.mockResolvedValue([] as never);
  repository.accountsWithPhone.mockResolvedValue([] as never);
  repository.referralFor.mockResolvedValue(null as never);
  repository.capturesInHour.mockResolvedValue({ count: 0, leadIds: [] } as never);
  repository.leadsWithExternalKey.mockResolvedValue([] as never);
  repository.repeatedFormMessages.mockResolvedValue([] as never);
  repository.findFlag.mockResolvedValue(null as never);
  repository.qaSampleExists.mockResolvedValue(false as never);
  repository.qaSamplesForAgent.mockResolvedValue([] as never);
  repository.confirmedFlagsForAgent.mockResolvedValue(0 as never);
  repository.activatedSince.mockResolvedValue([] as never);
});

describe('the four integrity patterns', () => {
  it('flags a self-referral by the number, by the login, and by the device', async () => {
    repository.referralFor.mockResolvedValue({ id: 'ref_1', referrerKind: 'PUBLISHER', referrerId: 'pub_9', referrerName: 'Ravi', referrerPhone: '+91 98450 12210', referrerUserId: 'usr_ravi', creditedAt: null } as never);
    const [byPhone] = await scanLead(lead());
    expect(byPhone).toMatchObject({ kind: 'SELF_REFERRAL', agentId: 'agt_1' });
    expect((byPhone!.evidence as { reason: string }).reason).toBe('SAME_PHONE');

    // A different number, but the same login behind the lead's account.
    vi.clearAllMocks();
    repository.referralFor.mockResolvedValue({ id: 'ref_1', referrerKind: 'AGENT', referrerId: 'agt_9', referrerName: 'Ravi', referrerPhone: '+919000000000', referrerUserId: 'usr_ravi', creditedAt: null } as never);
    repository.userIdForLead.mockResolvedValue('usr_ravi' as never);
    const [byLogin] = await scanLead(lead());
    expect((byLogin!.evidence as { reason: string }).reason).toBe('SAME_LOGIN');

    // A different login, but the same device.
    vi.clearAllMocks();
    repository.referralFor.mockResolvedValue({ id: 'ref_1', referrerKind: 'PUBLISHER', referrerId: 'pub_9', referrerName: 'Ravi', referrerPhone: '+919000000000', referrerUserId: 'usr_ravi', creditedAt: new Date() } as never);
    repository.userIdForLead.mockResolvedValue('usr_other' as never);
    repository.deviceTokensFor.mockResolvedValue(['tok_1'] as never);
    repository.userIdsWithDeviceTokens.mockResolvedValue(['usr_other'] as never);
    const [byDevice] = await scanLead(lead());
    expect((byDevice!.evidence as { reason: string; credited: boolean })).toMatchObject({ reason: 'SAME_DEVICE', credited: true });
  });

  it('flags a number reused across leads or already held by an account, a capture burst and a lead-form replay', async () => {
    repository.leadsWithPhone.mockResolvedValue([
      { id: 'led_2', displayId: 'LED-0002', businessName: 'Two', createdAt: NOW },
      { id: 'led_3', displayId: 'LED-0003', businessName: 'Three', createdAt: NOW },
    ] as never);
    const [reuse] = await scanLead(lead());
    expect(reuse).toMatchObject({ kind: 'PHONE_REUSE' });
    expect(reuse!.detail).toContain('3 leads carry this number');

    // The reading the table forces: a normalised number is unique across
    // leads, so the one that matters is a "new lead" already held by an account.
    vi.clearAllMocks();
    repository.leadsWithPhone.mockResolvedValue([] as never);
    repository.accountsWithPhone.mockResolvedValue([{ kind: 'PUBLISHER', id: 'pub_3', name: 'Ravi Prints' }] as never);
    const [known] = await scanLead(lead());
    expect(known!.detail).toContain('already belongs to publisher Ravi Prints');

    vi.clearAllMocks();
    repository.leadsWithPhone.mockResolvedValue([] as never);
    repository.accountsWithPhone.mockResolvedValue([] as never);
    repository.capturesInHour.mockResolvedValue({ count: BURST_PER_HOUR + 3, leadIds: ['led_1'] } as never);
    const [burst] = await scanLead(lead({ capturedByAgentId: 'agt_7', capturedAt: NOW }));
    expect(burst).toMatchObject({ kind: 'CAPTURE_BURST', agentId: 'agt_7' });
    // At the threshold exactly, nothing is said.
    repository.capturesInHour.mockResolvedValue({ count: BURST_PER_HOUR, leadIds: [] } as never);
    expect(await scanLead(lead({ capturedByAgentId: 'agt_7', capturedAt: NOW }))).toEqual([]);

    vi.clearAllMocks();
    repository.leadsWithPhone.mockResolvedValue([] as never);
    repository.accountsWithPhone.mockResolvedValue([] as never);
    repository.leadsWithExternalKey.mockResolvedValue([
      { id: 'led_1', displayId: 'LED-0001', businessName: 'One', createdAt: NOW },
      { id: 'led_9', displayId: 'LED-0009', businessName: 'Nine', createdAt: NOW },
    ] as never);
    const [replay] = await scanLead(lead({ externalKey: 'meta:123' }));
    expect(replay).toMatchObject({ kind: 'WEBHOOK_REPLAY' });
    expect(replay!.detail).toContain('meta:123');
  });

  it('opens each flag once and leaves a decided one alone', async () => {
    repository.leadsCreatedSince.mockResolvedValue([lead()] as never);
    repository.leadsWithPhone.mockResolvedValue([{ id: 'led_2', displayId: 'LED-0002', businessName: 'Two', createdAt: NOW }] as never);
    const first = await scanIntegrity(NOW);
    expect(first).toMatchObject({ scanned: 1, flagged: 1, byKind: { PHONE_REUSE: 1 } });
    expect(repository.createFlag).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    repository.leadsCreatedSince.mockResolvedValue([lead()] as never);
    repository.leadsWithPhone.mockResolvedValue([{ id: 'led_2', displayId: 'LED-0002', businessName: 'Two', createdAt: NOW }] as never);
    repository.findFlag.mockResolvedValue({ id: 'flg_1', status: 'DISMISSED' } as never);
    const again = await scanIntegrity(NOW);
    expect(again.flagged).toBe(0);
    expect(repository.createFlag).not.toHaveBeenCalled();
  });

  it('flags the same form payload landing on two leads', async () => {
    repository.repeatedFormMessages.mockResolvedValue([
      { providerId: 'form:meta:1', leadId: 'led_1', count: 1 },
      { providerId: 'form:meta:1', leadId: 'led_2', count: 1 },
      { providerId: 'form:meta:2', leadId: 'led_3', count: 1 },
    ] as never);
    const result = await scanIntegrity(NOW);
    expect(result.flagged).toBe(2);
    expect(repository.createFlag.mock.calls.every((call) => (call[0] as { kind: string }).kind === 'WEBHOOK_REPLAY')).toBe(true);
  });
});

describe("the desk's decision", () => {
  it('confirms or dismisses once, audited, and says what waits', async () => {
    repository.findFlagById.mockResolvedValue({
      id: 'flg_1', leadId: 'led_1', kind: 'PHONE_REUSE', status: 'OPEN', detail: 'x', evidence: null, agentId: 'agt_1',
      openedAt: NOW, decidedAt: null, decidedByUserId: null, note: null,
      lead: { displayId: 'LED-0001', businessName: 'Suraj Kumar Prints', city: 'Bengaluru', side: 'PUBLISHER', stage: 'SCORED', assignedAgentId: 'agt_1' },
    } as never);
    await decideFlag('flg_1', { status: 'CONFIRMED', note: 'Same shop twice' }, 'usr_admin', NOW);
    expect(repository.updateFlag).toHaveBeenCalledWith('flg_1', expect.objectContaining({ status: 'CONFIRMED', decidedByUserId: 'usr_admin', decidedAt: NOW }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'LEAD_FLAG_CONFIRMED', undefined, expect.objectContaining({ flagId: 'flg_1', agentId: 'agt_1' }));

    repository.findFlagById.mockResolvedValue({ id: 'flg_1', status: 'CONFIRMED', leadId: 'led_1', kind: 'PHONE_REUSE', lead: {} } as never);
    await expect(decideFlag('flg_1', { status: 'DISMISSED' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('counts the open flags by kind for the desk chips', async () => {
    repository.listFlags.mockResolvedValue([] as never);
    repository.countFlags.mockResolvedValue([{ kind: 'PHONE_REUSE', count: 3 }] as never);
    const page = await listFlags({});
    expect(page.openByKind).toEqual({ SELF_REFERRAL: 0, PHONE_REUSE: 3, CAPTURE_BURST: 0, WEBHOOK_REPLAY: 0 });
  });
});

describe('the QA evidence', () => {
  it('reads a visit: the photo, the fix and how far it was from the site', () => {
    const near = readVisitEvidence(visit());
    expect(near.verdict).toBe('PASS');
    expect(near.evidence.photo).toBe(true);
    expect(near.evidence.metres).toBeLessThan(50);

    expect(readVisitEvidence(visit({ proofFileId: null })).verdict).toBe('FAIL');
    expect(readVisitEvidence(visit({ proofLatitude: null, proofLongitude: null })).verdict).toBe('FAIL');
    // Two kilometres away is not the site.
    expect(readVisitEvidence(visit({ proofLatitude: 12.96, proofLongitude: 77.65 })).verdict).toBe('FAIL');
    // A site with no coordinates cannot fail the distance test.
    const noSite = readVisitEvidence(visit({ latitude: null, longitude: null }));
    expect(noSite.verdict).toBe('PASS');
    expect(noSite.evidence.metres).toBeNull();
  });

  it('reads a call: a recording kept without the consent line fails, and a two-second answered call fails', () => {
    expect(readCallEvidence(call()).verdict).toBe('PASS');
    expect(readCallEvidence(call({ consentPlayed: false })).verdict).toBe('FAIL');
    expect(readCallEvidence(call({ recordingFileId: null, durationSec: 4 })).verdict).toBe('FAIL');
    // Nobody picked up: there was nothing to record or to say.
    expect(readCallEvidence(call({ recordingFileId: null, durationSec: 0, outcome: 'NO_ANSWER' })).verdict).toBe('PASS');
  });

  it('draws every nth row once and stores what the evidence said', async () => {
    expect(everyNth([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 5)).toEqual([1, 6, 11]);
    repository.visitsCompletedBetween.mockResolvedValue([visit(), visit({ id: 'vst_2' }), visit({ id: 'vst_3', proofFileId: null })] as never);
    repository.callsBetween.mockResolvedValue([call(), call({ id: 'msg_2' })] as never);
    const drawn = await sampleQa(NOW);
    // One in five visits, one in ten calls: the first of each.
    expect(drawn).toEqual({ visits: 1, calls: 1, failed: 0 });
    expect(repository.createQaSample).toHaveBeenCalledWith(expect.objectContaining({ kind: 'VISIT', visitId: 'vst_1', autoVerdict: 'PASS' }));
    expect(repository.createQaSample).toHaveBeenCalledWith(expect.objectContaining({ kind: 'CALL', messageId: 'msg_1', agentId: 'agt_1' }));

    // A sample already drawn is not drawn again.
    vi.clearAllMocks();
    repository.visitsCompletedBetween.mockResolvedValue([visit()] as never);
    repository.callsBetween.mockResolvedValue([] as never);
    repository.qaSampleExists.mockResolvedValue(true as never);
    expect((await sampleQa(NOW)).visits).toBe(0);
  });

  it('asks for a reason when ops overrule the evidence, and records the review', async () => {
    repository.findQaSample.mockResolvedValue({ id: 'qa_1', kind: 'VISIT', agentId: 'agt_1', autoVerdict: 'FAIL' } as never);
    await expect(reviewQaSample('qa_1', { verdict: 'PASS' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 400 });
    await reviewQaSample('qa_1', { verdict: 'PASS', note: 'The photo was on the order, not the visit' }, 'usr_admin', NOW);
    expect(repository.updateQaSample).toHaveBeenCalledWith('qa_1', expect.objectContaining({ verdict: 'PASS', reviewedByUserId: 'usr_admin' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'LEAD_QA_REVIEWED', undefined, expect.objectContaining({ autoVerdict: 'FAIL', verdict: 'PASS' }));
  });
});

describe('the quality score', () => {
  const sample = (verdict: string, over: Record<string, unknown> = {}) => ({ kind: 'VISIT', autoVerdict: verdict, verdict: null, sampledAt: NOW, ...over });

  it('is the pass share less the confirmed flags, and a reviewed verdict beats the automatic one', async () => {
    repository.qaSamplesForAgent.mockResolvedValue([sample('PASS'), sample('PASS'), sample('PASS'), sample('PASS'), sample('FAIL'), sample('FAIL', { verdict: 'PASS' })] as never);
    repository.confirmedFlagsForAgent.mockResolvedValue(1 as never);
    const quality = await qualityFor('agt_1', NOW);
    // Five of six pass once the review is honoured: 0.833 − 0.1 → 0.73.
    expect(quality).toMatchObject({ samples: 6, passed: 5, failed: 1, reviewed: 1, confirmedFlags: 1, flagPenalty: '0.10' });
    expect(quality.score).toBe('0.73');
  });

  it('is null under the floor, and never falls below zero', async () => {
    repository.qaSamplesForAgent.mockResolvedValue([sample('PASS'), sample('PASS')] as never);
    expect((await qualityFor('agt_1', NOW)).score).toBeNull();
    expect(MIN_QUALITY_SAMPLE).toBeGreaterThan(2);

    repository.qaSamplesForAgent.mockResolvedValue(Array.from({ length: 6 }, () => sample('FAIL')) as never);
    repository.confirmedFlagsForAgent.mockResolvedValue(9 as never);
    const bad = await qualityFor('agt_1', NOW);
    expect(bad.score).toBe('0.00');
    // The penalty is capped, whatever the count.
    expect(bad.flagPenalty).toBe('0.50');
  });
});

describe('the clawback', () => {
  const activated = (over: Record<string, unknown> = {}) => ({
    id: 'led_1',
    displayId: 'LED-0001',
    businessName: 'Suraj Kumar Prints',
    assignedAgentId: 'agt_1',
    activatedAt: new Date(NOW.getTime() - 5 * DAY),
    convertedPublisherId: 'pub_1',
    convertedAdvertiserId: null,
    ...over,
  });

  it('reverses the activation reward when the account closed, and tells the agent', async () => {
    repository.activatedSince.mockResolvedValue([activated()] as never);
    repository.accountStanding.mockResolvedValue({ live: false, closed: true, label: 'Suraj Kumar Prints' } as never);
    repository.activationIncentiveFor.mockResolvedValue({ id: 'inc_1', agentId: 'agt_1', status: 'CREDITED', amount: '500.00' } as never);
    const result = await watchClawbacks(NOW);
    expect(result).toMatchObject({ checked: 1, reversed: 1, amount: ['500.00'] });
    expect(payouts.clawbackIncentive).toHaveBeenCalledWith('inc_1', expect.objectContaining({ reason: expect.stringContaining(`closed within ${CLAWBACK_DAYS} days`) }), NOW);
    expect(audit.logActivity).toHaveBeenCalledWith('system', 'LEAD_ACTIVATION_CLAWED_BACK', undefined, expect.objectContaining({ incentiveId: 'inc_1', amount: '500.00' }));
    expect(notifications.notify).toHaveBeenCalledWith('INCENTIVE_REVERSED', 'usr_agent', expect.objectContaining({ amount: '500.00' }));
  });

  it('reverses when the business came down, leaves a live account alone, and does nothing without a reward', async () => {
    repository.activatedSince.mockResolvedValue([activated()] as never);
    repository.accountStanding.mockResolvedValue({ live: false, closed: false, label: 'x' } as never);
    repository.activationIncentiveFor.mockResolvedValue({ id: 'inc_1', agentId: 'agt_1', status: 'PENDING_VERIFICATION', amount: '500.00' } as never);
    expect((await watchClawbacks(NOW)).reversed).toBe(1);
    expect(payouts.clawbackIncentive).toHaveBeenCalledWith('inc_1', expect.objectContaining({ reason: expect.stringContaining('came down') }), NOW);

    vi.clearAllMocks();
    repository.activatedSince.mockResolvedValue([activated()] as never);
    repository.accountStanding.mockResolvedValue({ live: true, closed: false, label: 'x' } as never);
    expect((await watchClawbacks(NOW)).reversed).toBe(0);
    expect(payouts.clawbackIncentive).not.toHaveBeenCalled();

    vi.clearAllMocks();
    repository.activatedSince.mockResolvedValue([activated()] as never);
    repository.accountStanding.mockResolvedValue({ live: false, closed: true, label: 'x' } as never);
    repository.activationIncentiveFor.mockResolvedValue(null as never);
    expect((await watchClawbacks(NOW)).reversed).toBe(0);
  });

  it('reads only the last thirty days of activations', async () => {
    await watchClawbacks(NOW);
    const since = (repository.activatedSince.mock.calls[0] as unknown as [Date, number])[0];
    expect(since).toEqual(new Date(NOW.getTime() - CLAWBACK_DAYS * DAY));
  });
});

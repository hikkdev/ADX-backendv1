import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AG-1 (the owner, 20 Sep 2026): the agent application's doors.
 *
 * A person applies, the profile and papers go in, the agreement is accepted,
 * Submit is refused until every step is done and then puts the application
 * under review; the desk reviews a paper, activates with a grade and an
 * engagement (or refuses without a verified identity), and exits an agent.
 */

const { repository, identifiers, pricing, notifications, agreements, audit, port, cashfree, fleet } = vi.hoisted(() => ({
  cashfree: { lookupVehicleRc: vi.fn() },
  fleet: { fleetProvenanceFor: vi.fn(async (): Promise<{ partnerId: string; partnerName: string; inviteId: string } | null> => null), markFleetInviteApplied: vi.fn(), markFleetInviteActivated: vi.fn() },
  repository: {
    createApplication: vi.fn(),
    findByUserId: vi.fn(),
    findById: vi.fn(),
    patch: vi.fn(),
    patchPerson: vi.fn(),
    replaceSideRows: vi.fn(),
    upsertDocument: vi.fn(),
    removeDocument: vi.fn(),
    reviewDocument: vi.fn(),
    numberHeldElsewhere: vi.fn(),
    findAgentByReferralCode: vi.fn(),
    findApplications: vi.fn(),
    countByStage: vi.fn(),
    employeeExists: vi.fn(),
    createInterview: vi.fn(),
    findInterview: vi.fn(),
    updateInterview: vi.fn(),
    documentsExpiring: vi.fn(),
    stampDocument: vi.fn(),
    findDocument: vi.fn(),
    agentsForPurge: vi.fn(),
    purgeDocuments: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn(async () => 'AGT-2009-2601') },
  pricing: { assertCityAllows: vi.fn(), withCityKey: vi.fn(async (d: object) => d) },
  notifications: { notify: vi.fn(async () => ({ notificationId: null })) },
  agreements: { platformStanding: vi.fn(), recordAcceptance: vi.fn() },
  audit: { logActivity: vi.fn(async () => undefined) },
  port: { hasPayoutMethod: vi.fn(), certificationState: vi.fn(), assessmentState: vi.fn(async () => ({ required: false, passed: false, modules: [] })), mirrorIdentityDocument: vi.fn(async () => undefined), adminUserIds: vi.fn(async () => ['adm_1']), settleExit: vi.fn(async () => ({ sessionsEnded: true, grantsRevoked: 1, qrDeactivated: true, payout: { amount: '1250.00', reference: 'WD-1', outcome: 'REQUESTED' }, notes: [] })), purgeFile: vi.fn(async () => true) },
}));

vi.mock('../application/prisma-application.repository', () => ({ prismaApplicationRepository: repository }));
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../pricing', () => pricing);
vi.mock('../../notifications', () => notifications);
vi.mock('../../agreements', () => agreements);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../application/fleet.service', () => fleet);
vi.mock('../../../shared/integrations', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/integrations')>()), lookupVehicleRc: cashfree.lookupVehicleRc }));

import { registerApplicationPort } from '../application/application.port';
import { acceptAgreementAtDesk, apply, decideApplication, exitAgent, fileMyDocument, listApplications, reviewDocument, submitAtDesk, submitMyApplication, updateProfileAtDesk } from '../application/application.service';
import { IDENTITY_KINDS, requiredDocuments } from '../application/application.rules';

registerApplicationPort(port);

type Doc = { kind: string; status: string; url: string; numberMasked: string | null; expiresAt: Date | null; reviewNote: string | null; uploadedVia: string; updatedAt: Date; id: string; version: number };

const doc = (kind: string, status = 'SUBMITTED'): Doc => ({ id: `doc_${kind}`, kind, status, url: `https://files/${kind}`, numberMasked: null, expiresAt: null, reviewNote: null, uploadedVia: 'APP', updatedAt: new Date(), version: 1 });

/** A publisher-side applicant with a complete profile; documents and stage vary per test. */
function record(over: Record<string, unknown> = {}) {
  return {
    id: 'agt_1',
    userId: 'usr_1',
    displayId: 'AGT-2009-2601',
    roles: ['AGENT_PUBLISHER'],
    stage: 'PROFILE',
    city: 'Bengaluru',
    state: 'Karnataka',
    languages: ['Kannada'],
    vehicleType: 'NONE',
    vehicleNumber: null,
    currentAddress: '12, 4th Cross',
    currentLatitude: null,
    currentLongitude: null,
    permanentAddress: 'Kochi',
    emergencyContactName: 'Priya',
    emergencyContactRelation: 'Sister',
    emergencyContactPhone: '+919000000009',
    highestEducation: null,
    salesExperienceYears: null,
    industries: [],
    noticePeriodDays: null,
    territory: null,
    homeZone: null,
    grade: null,
    sourceKind: 'SELF',
    applicationSubmittedAt: null,
    activatedAt: null,
    holdReason: null,
    rejectionReason: null,
    reviewNote: null,
    engagementType: null,
    engagementStartAt: null,
    engagementEndAt: null,
    probationEndsAt: null,
    reportingManagerId: null,
    weeklyHours: null,
    exitedAt: null,
    exitReason: null,
    exitNote: null,
    rehireEligible: true,
    blacklistedAt: null,
    screenedAt: null,
    screenedById: null,
    screeningNote: null,
    heldFromStage: null,
    interviews: [],
    user: { id: 'usr_1', name: 'Rahul Menon', mobile: '+919000000301', email: null, dateOfBirth: new Date('1996-03-04'), gender: 'MALE', isActive: true },
    documents: [] as Doc[],
    educations: [],
    employments: [],
    references: [],
    platformExperiences: [],
    kyc: null,
    ...over,
  };
}

const complete = () => requiredDocuments('PUBLISHER', 'NONE').map((kind) => doc(kind));

beforeEach(() => {
  vi.clearAllMocks();
  repository.patch.mockResolvedValue(undefined);
  repository.replaceSideRows.mockResolvedValue(undefined);
  repository.numberHeldElsewhere.mockResolvedValue(false);
  repository.employeeExists.mockResolvedValue(true);
  port.hasPayoutMethod.mockResolvedValue(true);
  port.certificationState.mockResolvedValue({ state: 'LOCKED', available: false });
  agreements.platformStanding.mockResolvedValue({ satisfied: true, currentVersion: 1 });
});

describe('applying', () => {
  it('makes an applicant at PROFILE with the side\'s role, and says what the profile still lacks', async () => {
    repository.findByUserId.mockResolvedValueOnce(null);
    repository.createApplication.mockResolvedValue(record({ languages: [], vehicleType: null }));
    const view = await apply('usr_1', { side: 'PUBLISHER' });
    expect(repository.createApplication).toHaveBeenCalledWith('usr_1', expect.objectContaining({ role: 'AGENT_PUBLISHER', displayId: 'AGT-2009-2601', sourceKind: 'SELF' }));
    expect(view.agent.stage).toBe('PROFILE');
    expect(view.ladder.nextStep).toBe('PROFILE');
    expect(view.ladder.steps[0]?.missing).toEqual(['At least one language you speak', 'How you will travel (vehicle)']);
  });

  it('is idempotent for someone who already applied, and refuses an agent who left', async () => {
    repository.findByUserId.mockResolvedValueOnce(record({ stage: 'DOCUMENTS' }));
    await expect(apply('usr_1', { side: 'PUBLISHER' })).resolves.toMatchObject({ agent: { stage: 'DOCUMENTS' } });
    expect(repository.createApplication).not.toHaveBeenCalled();
    repository.findByUserId.mockResolvedValueOnce(record({ stage: 'EXITED' }));
    await expect(apply('usr_1', { side: 'PUBLISHER' })).rejects.toMatchObject({ statusCode: 409, code: 'APPLICATION_CLOSED' });
  });

  it('stamps the referrer when a referral code is given', async () => {
    repository.findByUserId.mockResolvedValueOnce(null);
    repository.findAgentByReferralCode.mockResolvedValue({ id: 'agt_ref' });
    repository.createApplication.mockResolvedValue(record());
    await apply('usr_1', { side: 'PUBLISHER', referralCode: 'RAHUL10' });
    expect(repository.createApplication).toHaveBeenCalledWith('usr_1', expect.objectContaining({ sourceKind: 'REFERRAL', referredByAgentId: 'agt_ref' }));
  });
});

describe('filing a paper', () => {
  it('stores it masked and hashed, mirrors an identity paper onto the KYC record, and moves the stage on', async () => {
    const before = record({ stage: 'PROFILE' });
    repository.findByUserId.mockResolvedValueOnce(before);
    repository.upsertDocument.mockResolvedValue({ id: 'doc_PAN', version: 1 });
    repository.findById.mockResolvedValue(record({ stage: 'PROFILE', documents: [doc('PAN')] }));
    const view = await fileMyDocument('usr_1', 'PAN', { url: 'https://files/pan.jpg', number: 'ABCDE1234F' });
    expect(repository.upsertDocument).toHaveBeenCalledWith(expect.objectContaining({ kind: 'PAN', numberMasked: 'ABCDE****F', uploadedVia: 'APP', uploadedById: 'usr_1' }));
    expect(port.mirrorIdentityDocument).toHaveBeenCalledWith('agt_1', 'usr_1', 'PAN', 'https://files/pan.jpg', 'ABCDE1234F');
    // The profile is complete, so the ladder now stands at DOCUMENTS.
    expect(repository.patch).toHaveBeenCalledWith('agt_1', { stage: 'DOCUMENTS' });
    expect(view.documents.find((d) => d.kind === 'PAN')?.status).toBe('SUBMITTED');
  });

  it('refuses a number already on another account', async () => {
    repository.findByUserId.mockResolvedValueOnce(record());
    repository.numberHeldElsewhere.mockResolvedValue(true);
    await expect(fileMyDocument('usr_1', 'PAN', { url: 'https://files/pan.jpg', number: 'ABCDE1234F' })).rejects.toMatchObject({ statusCode: 409, code: 'DOCUMENT_HELD_ELSEWHERE' });
  });

  it('refuses a kind the side does not list', async () => {
    repository.findByUserId.mockResolvedValueOnce(record());
    await expect(fileMyDocument('usr_1', 'RESUME', { url: 'https://files/cv.pdf' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('submitting', () => {
  it('is refused with what is missing until every step is done', async () => {
    repository.findByUserId.mockResolvedValueOnce(record({ stage: 'DOCUMENTS', documents: [doc('PAN')] }));
    port.hasPayoutMethod.mockResolvedValue(false);
    await expect(submitMyApplication('usr_1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'APPLICATION_INCOMPLETE',
      details: { nextStep: 'DOCUMENTS', missing: expect.arrayContaining(['Aadhaar (front)', 'A bank account or UPI ID for payouts']) },
    });
    expect(repository.patch).not.toHaveBeenCalledWith('agt_1', expect.objectContaining({ stage: 'UNDER_REVIEW' }));
  });

  it('puts a complete application with ADX — at SCREENING while the paper check is open (AG-4) — and tells the applicant and the desk', async () => {
    repository.findByUserId.mockResolvedValueOnce(record({ stage: 'AGREEMENT', documents: complete() }));
    repository.findByUserId.mockResolvedValueOnce(record({ stage: 'SCREENING', documents: complete(), applicationSubmittedAt: new Date() }));
    const view = await submitMyApplication('usr_1');
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.objectContaining({ stage: 'SCREENING', applicationSubmittedAt: expect.any(Date) }));
    expect(notifications.notify).toHaveBeenCalledWith('AGENT_APPLICATION_RECEIVED', 'usr_1', expect.objectContaining({ side: 'field agent' }), expect.anything());
    expect(notifications.notify).toHaveBeenCalledWith('AGENT_APPLICATION_RECEIVED', 'adm_1', expect.anything(), expect.objectContaining({ channels: [] }));
    expect(view.agent.stage).toBe('SCREENING');
    expect(view.ladder.steps.find((s) => s.key === 'SCREENING')).toMatchObject({ state: 'WAITING', missing: ["The desk's paper check"] });
    expect(view.ladder.canSubmit).toBe(false);
  });
});

describe('the desk', () => {
  it('a flagged paper goes back to the applicant with the note', async () => {
    repository.findById.mockResolvedValueOnce(record({ stage: 'UNDER_REVIEW', documents: complete() }));
    repository.reviewDocument.mockResolvedValue({ id: 'doc_PAN' });
    repository.findById.mockResolvedValueOnce(record({ stage: 'UNDER_REVIEW', documents: complete().map((d) => (d.kind === 'PAN' ? { ...d, status: 'FLAGGED', reviewNote: 'Blurred' } : d)) }));
    const view = await reviewDocument('agt_1', 'PAN', { decision: 'FLAGGED', note: 'Blurred' }, 'adm_1');
    expect(repository.reviewDocument).toHaveBeenCalledWith('agt_1', 'PAN', 'FLAGGED', 'Blurred', 'adm_1');
    expect(notifications.notify).toHaveBeenCalledWith('AGENT_DOCUMENT_RETURNED', 'usr_1', expect.objectContaining({ document: 'PAN card', note: 'Blurred' }), expect.anything());
    expect(view.ladder.steps[1]).toMatchObject({ key: 'DOCUMENTS', state: 'ACTION_NEEDED' });
  });

  it('will not activate without a verified identity, nor from the wrong stage', async () => {
    repository.findById.mockResolvedValueOnce(record({ stage: 'UNDER_REVIEW', documents: complete() }));
    await expect(decideApplication('agt_1', { decision: 'ACTIVATE', grade: 'G1' }, 'adm_1')).rejects.toMatchObject({ statusCode: 409, code: 'IDENTITY_UNVERIFIED' });
    repository.findById.mockResolvedValueOnce(record({ stage: 'DOCUMENTS', documents: complete() }));
    await expect(decideApplication('agt_1', { decision: 'ACTIVATE', grade: 'G1' }, 'adm_1')).rejects.toMatchObject({ statusCode: 409, code: 'DECISION_NOT_ALLOWED' });
  });

  it('activates with the grade and a gig engagement by default for a publisher agent, once the KYC set is verified', async () => {
    repository.findById.mockResolvedValueOnce(record({ stage: 'UNDER_REVIEW', documents: complete(), kyc: { status: 'VERIFIED', reviewedAt: new Date() } }));
    repository.findById.mockResolvedValueOnce(record({ stage: 'ACTIVE', grade: 'G2', documents: complete(), activatedAt: new Date(), engagementType: 'GIG' }));
    const view = await decideApplication('agt_1', { decision: 'ACTIVATE', grade: 'G2', territory: 'Koramangala' }, 'adm_1');
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.objectContaining({ stage: 'ACTIVE', status: 'ACTIVE', grade: 'G2', gradeSetById: 'adm_1', engagementType: 'GIG', engagementEndAt: null, probationEndsAt: null, territory: 'Koramangala', activatedById: 'adm_1' }));
    expect(notifications.notify).toHaveBeenCalledWith('AGENT_APPLICATION_DECISION', 'usr_1', expect.objectContaining({ decision: 'accepted' }), expect.anything());
    expect(view.agent).toMatchObject({ stage: 'ACTIVE', grade: 'G2', gradeLabel: 'Senior field' });
  });

  it('a sales agent gets a six-month contract with three months\' probation unless the desk says otherwise; vouching in person approves the identity papers', async () => {
    // AG-4: a G3 needs both interview rounds passed; the identity vouch covers the paper screen.
    const interview = (round: number) => ({ id: `int_${round}`, agentId: 'agt_1', round, scheduledAt: new Date('2026-09-22T05:00:00Z'), mode: 'IN_PERSON', location: null, interviewerId: null, outcome: 'PASSED', marks: 4, notes: null, decidedAt: new Date(), decidedById: 'adm_1', createdById: 'adm_1', createdAt: new Date(), updatedAt: new Date() });
    const sales = record({ roles: ['AGENT_ADVERTISER'], stage: 'UNDER_REVIEW', highestEducation: 'GRADUATE', salesExperienceYears: 3, references: [{ id: 'r1' }], interviews: [interview(1), interview(2)], documents: requiredDocuments('ADVERTISER', null).map((kind) => doc(kind, IDENTITY_KINDS.includes(kind) ? 'SUBMITTED' : 'APPROVED')) });
    repository.findById.mockResolvedValueOnce(sales);
    repository.reviewDocument.mockResolvedValue({ id: 'x' });
    repository.findById.mockResolvedValueOnce({ ...sales, stage: 'ACTIVE', grade: 'G3' });
    await decideApplication('agt_1', { decision: 'ACTIVATE', grade: 'G3', identityCheckedInPerson: true, engagementStartAt: '2026-10-01' }, 'adm_1');
    const patch = repository.patch.mock.calls.find((c) => c[1]?.stage === 'ACTIVE')?.[1] as { engagementType: string; engagementStartAt: Date; engagementEndAt: Date; probationEndsAt: Date };
    expect(patch.engagementType).toBe('CONTRACT');
    expect(patch.engagementStartAt.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(patch.engagementEndAt.toISOString().slice(0, 10)).toBe('2027-03-30');
    expect(patch.probationEndsAt.toISOString().slice(0, 10)).toBe('2026-12-30');
    // The six identity papers were SUBMITTED and are now APPROVED "seen in person".
    expect(repository.reviewDocument).toHaveBeenCalledTimes(6);
    expect(repository.reviewDocument).toHaveBeenCalledWith('agt_1', 'AADHAAR_FRONT', 'APPROVED', 'Seen in person at the desk', 'adm_1');
  });

  it('a rejection and a hold carry their reason; a resume goes back under review', async () => {
    repository.findById.mockResolvedValueOnce(record({ stage: 'UNDER_REVIEW' }));
    repository.findById.mockResolvedValueOnce(record({ stage: 'REJECTED', rejectionReason: 'Papers did not match' }));
    await decideApplication('agt_1', { decision: 'REJECT', note: 'Papers did not match' }, 'adm_1');
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.objectContaining({ stage: 'REJECTED', rejectionReason: 'Papers did not match' }));
    repository.findById.mockResolvedValueOnce(record({ stage: 'ON_HOLD', applicationSubmittedAt: new Date() }));
    repository.findById.mockResolvedValueOnce(record({ stage: 'UNDER_REVIEW' }));
    await decideApplication('agt_1', { decision: 'RESUME' }, 'adm_1');
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.objectContaining({ stage: 'UNDER_REVIEW', holdReason: null }));
  });

  it('exits an active agent, keeping or closing the door', async () => {
    repository.findById.mockResolvedValueOnce(record({ stage: 'ACTIVE' }));
    repository.findById.mockResolvedValueOnce(record({ stage: 'EXITED', exitReason: 'MISCONDUCT', blacklistedAt: new Date() }));
    const view = await exitAgent('agt_1', { reason: 'MISCONDUCT', note: 'Forged a proof', rehireEligible: true, blacklist: true }, 'adm_1');
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.objectContaining({ stage: 'EXITED', exitReason: 'MISCONDUCT', rehireEligible: false, blacklistedAt: expect.any(Date) }));
    expect(view.agent.exit.blacklisted).toBe(true);
    repository.findById.mockResolvedValueOnce(record({ stage: 'UNDER_REVIEW' }));
    await expect(exitAgent('agt_1', { reason: 'RESIGNED', rehireEligible: true, blacklist: false }, 'adm_1')).rejects.toMatchObject({ code: 'DECISION_NOT_ALLOWED' });
  });
});

/**
 * AG-3: the desk runs the same ladder for someone standing in front of it.
 */
describe("the desk, on the applicant's behalf", () => {
  it("writes the person's own fields beside the profile, and records the terms as shown on paper", async () => {
    repository.findById.mockResolvedValue(record({ stage: 'PROFILE' }));
    await updateProfileAtDesk('agt_1', { name: 'Rahul K Menon', dateOfBirth: '1996-03-04', gender: 'MALE', city: 'Bengaluru', languages: ['Kannada', 'Hindi'] }, 'adm_1');
    expect(repository.patchPerson).toHaveBeenCalledWith('usr_1', { name: 'Rahul K Menon', dateOfBirth: new Date('1996-03-04T00:00:00Z'), gender: 'MALE' });
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.objectContaining({ city: 'Bengaluru', languages: ['Kannada', 'Hindi'] }));
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.not.objectContaining({ name: expect.anything() }));

    agreements.platformStanding.mockResolvedValue({ satisfied: false, currentVersion: 1 });
    await acceptAgreementAtDesk('agt_1', 'adm_1', { ipAddress: '10.0.0.1', userAgent: 'console' });
    expect(agreements.recordAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'AGENT_PUBLISHER_PLATFORM',
        party: { agentId: 'agt_1' },
        ctx: expect.objectContaining({ acceptedByUserId: 'adm_1', ipAddress: '10.0.0.1' }),
        renderedDocument: expect.stringContaining('Accepted at the ADX desk'),
      }),
    );
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'AGENT_AGREEMENT_RECORDED_AT_DESK', expect.anything());
  });

  it('submits for them only once the ladder allows it, saying what is missing otherwise', async () => {
    port.hasPayoutMethod.mockResolvedValue(false);
    port.certificationState.mockResolvedValue({ state: 'LOCKED', available: false });
    agreements.platformStanding.mockResolvedValue({ satisfied: true, currentVersion: 1 });
    repository.findById.mockResolvedValue(record({ stage: 'BANK', documents: complete() }));
    await expect(submitAtDesk('agt_1', 'adm_1')).rejects.toMatchObject({ statusCode: 409, code: 'APPLICATION_INCOMPLETE', details: { missing: ['A bank account or UPI ID for payouts'], nextStep: 'BANK' } });

    port.hasPayoutMethod.mockResolvedValue(true);
    repository.findById.mockResolvedValueOnce(record({ stage: 'AGREEMENT', documents: complete() }));
    repository.findById.mockResolvedValueOnce(record({ stage: 'SCREENING', documents: complete(), applicationSubmittedAt: new Date() }));
    const view = await submitAtDesk('agt_1', 'adm_1');
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.objectContaining({ stage: 'SCREENING', applicationSubmittedAt: expect.any(Date) }));
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'AGENT_APPLICATION_SUBMITTED', expect.objectContaining({ metadata: { atDesk: true } }));
    expect(view.agent.stage).toBe('SCREENING');
  });

  it('a resumed, unsubmitted hold settles onto its real rung rather than PROFILE', async () => {
    port.hasPayoutMethod.mockResolvedValue(false);
    port.certificationState.mockResolvedValue({ state: 'LOCKED', available: false });
    agreements.platformStanding.mockResolvedValue({ satisfied: false, currentVersion: 1 });
    repository.findById.mockResolvedValueOnce(record({ stage: 'ON_HOLD', holdReason: 'Bring the degree', documents: complete() }));
    repository.findById.mockResolvedValueOnce(record({ stage: 'PROFILE', documents: complete() }));
    const view = await decideApplication('agt_1', { decision: 'RESUME' }, 'adm_1');
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.objectContaining({ stage: 'PROFILE', holdReason: null }));
    expect(repository.patch).toHaveBeenLastCalledWith('agt_1', { stage: 'BANK' });
    expect(view.agent.stage).toBe('BANK');
  });

  it('the queue takes a group of stages, and each row folds its side and its paper counts', async () => {
    repository.findApplications.mockResolvedValue({ items: [{ id: 'agt_1', displayId: 'AGT-2009-2601', stage: 'UNDER_REVIEW', grade: null, sourceKind: 'SELF', city: 'Bengaluru', createdAt: new Date(), applicationSubmittedAt: new Date(), activatedAt: null, roles: ['AGENT_PUBLISHER'], user: { name: 'Rahul', mobile: '+919000000301', email: null }, documents: [{ kind: 'PAN', status: 'APPROVED' }, { kind: 'SELFIE', status: 'FLAGGED' }, { kind: 'AADHAAR_FRONT', status: 'REUPLOAD_REQUESTED' }] }], total: 1 });
    repository.countByStage.mockResolvedValue([{ stage: 'UNDER_REVIEW', count: 1 }, { stage: 'PROFILE', count: 4 }]);
    const { items, meta } = await listApplications({ group: 'WITH_DESK', page: 1, pageSize: 25 });
    expect(repository.findApplications).toHaveBeenCalledWith({ stage: undefined, stages: ['UNDER_REVIEW', 'SCREENING', 'TRAINING'], side: undefined, q: undefined }, 1, 25);
    expect(items[0]).toMatchObject({ side: 'PUBLISHER', documents: { filed: 3, flagged: 2 } });
    expect(meta.counts).toEqual({ UNDER_REVIEW: 1, PROFILE: 4 });
    // A single stage wins over the group.
    await listApplications({ stage: 'ON_HOLD', group: 'CLOSED', page: 1, pageSize: 25 });
    expect(repository.findApplications).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'ON_HOLD', stages: undefined }), 1, 25);
  });
});

/**
 * AG-4: screening, the gates, the sweep, the RC check.
 */
describe('AG-4: screening and the gates', () => {
  const interviewRow = (over: Record<string, unknown> = {}) => ({ id: 'int_1', agentId: 'agt_1', round: 1, scheduledAt: new Date('2026-09-25T05:00:00Z'), mode: 'IN_PERSON', location: 'ADX office', interviewerId: null, outcome: 'SCHEDULED', marks: null, notes: null, decidedAt: null, decidedById: null, createdById: 'adm_1', createdAt: new Date(), updatedAt: new Date(), ...over });

  it('books an interview, tells the applicant, and records the outcome with marks', async () => {
    port.hasPayoutMethod.mockResolvedValue(true);
    agreements.platformStanding.mockResolvedValue({ satisfied: true, currentVersion: 1 });
    const sales = record({ roles: ['AGENT_ADVERTISER'], stage: 'SCREENING', applicationSubmittedAt: new Date(), highestEducation: 'GRADUATE', salesExperienceYears: 3, references: [{ id: 'r1' }], documents: requiredDocuments('ADVERTISER', null).map((kind) => doc(kind, 'APPROVED')) });
    repository.findById.mockResolvedValueOnce(sales);
    repository.createInterview.mockResolvedValue(interviewRow());
    repository.findById.mockResolvedValueOnce({ ...sales, interviews: [interviewRow()] });
    const { scheduleInterview, recordInterviewOutcome } = await import('../application/application.service');
    const view = await scheduleInterview('agt_1', { round: 1, scheduledAt: '2026-09-25T10:30:00+05:30', mode: 'IN_PERSON', location: 'ADX office' }, 'adm_1');
    expect(repository.createInterview).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agt_1', round: 1, mode: 'IN_PERSON', location: 'ADX office', createdById: 'adm_1' }));
    expect(notifications.notify).toHaveBeenCalledWith('AGENT_INTERVIEW_SCHEDULED', 'usr_1', expect.objectContaining({ where: 'ADX office', round: '1' }), expect.anything());
    expect(view.screening.nextInterview).toMatchObject({ round: 1, outcome: 'SCHEDULED' });
    expect(view.ladder.steps.find((s) => s.key === 'SCREENING')).toMatchObject({ state: 'WAITING', missing: ['The interview on 2026-09-25'] });

    repository.findById.mockResolvedValueOnce({ ...sales, interviews: [interviewRow()] });
    repository.findInterview.mockResolvedValue(interviewRow());
    repository.updateInterview.mockResolvedValue(interviewRow({ outcome: 'PASSED', marks: 4 }));
    repository.findById.mockResolvedValueOnce({ ...sales, interviews: [interviewRow({ outcome: 'PASSED', marks: 4 })] });
    const after = await recordInterviewOutcome('agt_1', 'int_1', { outcome: 'PASSED', marks: 4, notes: 'Spoke well' }, 'adm_1');
    expect(repository.updateInterview).toHaveBeenCalledWith('int_1', expect.objectContaining({ outcome: 'PASSED', marks: 4, notes: 'Spoke well', decidedById: 'adm_1' }));
    expect(after.screening).toMatchObject({ done: true, interviewPassed: true });
    // Screening done, no lesson published for the side: the desk's decision is all that is left.
    expect(repository.patch).toHaveBeenLastCalledWith('agt_1', { stage: 'UNDER_REVIEW' });
  });

  it('will not activate while the screen or the training is open, unless the desk waives it', async () => {
    port.hasPayoutMethod.mockResolvedValue(true);
    port.certificationState.mockResolvedValue({ state: 'LOCKED', available: true });
    const sales = record({ roles: ['AGENT_ADVERTISER'], stage: 'SCREENING', applicationSubmittedAt: new Date(), highestEducation: 'GRADUATE', salesExperienceYears: 3, references: [{ id: 'r1' }], kyc: { status: 'VERIFIED', reviewedAt: new Date() }, documents: requiredDocuments('ADVERTISER', null).map((kind) => doc(kind, 'APPROVED')) });
    repository.findById.mockResolvedValueOnce(sales);
    await expect(decideApplication('agt_1', { decision: 'ACTIVATE', grade: 'G2' }, 'adm_1')).rejects.toMatchObject({ statusCode: 409, code: 'SCREENING_INCOMPLETE' });
    repository.findById.mockResolvedValueOnce({ ...sales, screenedAt: new Date(), screenedById: 'adm_1' });
    await expect(decideApplication('agt_1', { decision: 'ACTIVATE', grade: 'G2' }, 'adm_1')).rejects.toMatchObject({ statusCode: 409, code: 'TRAINING_INCOMPLETE' });
    repository.findById.mockResolvedValueOnce({ ...sales, screenedAt: new Date(), screenedById: 'adm_1' });
    repository.findById.mockResolvedValueOnce({ ...sales, stage: 'ACTIVE', grade: 'G2' });
    await decideApplication('agt_1', { decision: 'ACTIVATE', grade: 'G2', waiveTraining: true, note: 'Trained on the job' }, 'adm_1');
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'AGENT_APPLICATION_DECIDED', expect.objectContaining({ metadata: expect.objectContaining({ waiveTraining: true }) }));
    port.certificationState.mockResolvedValue({ state: 'LOCKED', available: false });
  });

  it('a hold on a working agent goes back to ACTIVE on resume, and the sweep holds them when a paper lapses', async () => {
    const { runDocumentExpirySweep } = await import('../application/application.service');
    // The hold remembers where it came from.
    repository.findById.mockResolvedValueOnce(record({ stage: 'ACTIVE', activatedAt: new Date() }));
    repository.findById.mockResolvedValueOnce(record({ stage: 'ON_HOLD', heldFromStage: 'ACTIVE', activatedAt: new Date() }));
    await decideApplication('agt_1', { decision: 'HOLD', note: 'Bring the renewed licence' }, 'adm_1');
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.objectContaining({ stage: 'ON_HOLD', heldFromStage: 'ACTIVE' }));
    repository.findById.mockResolvedValueOnce(record({ stage: 'ON_HOLD', heldFromStage: 'ACTIVE', activatedAt: new Date() }));
    repository.findById.mockResolvedValueOnce(record({ stage: 'ACTIVE', activatedAt: new Date() }));
    await decideApplication('agt_1', { decision: 'RESUME' }, 'adm_1');
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.objectContaining({ stage: 'ACTIVE', heldFromStage: null, holdReason: null }));

    // The sweep: a reminder seven days out, once; a lapse on the day holds a working agent.
    const now = new Date('2026-10-01T00:00:00Z');
    const soon = { id: 'doc_dl', agentId: 'agt_1', kind: 'DRIVING_LICENCE_FRONT', status: 'APPROVED', expiresAt: new Date('2026-10-06T00:00:00Z'), expiryRemindedAt: null, expiryReminderDays: null, agent: { id: 'agt_1', userId: 'usr_1', stage: 'ACTIVE', displayId: 'AGT-1', user: { name: 'Rahul' } } };
    const gone = { ...soon, id: 'doc_ins', kind: 'VEHICLE_INSURANCE', expiresAt: new Date('2026-09-30T00:00:00Z') };
    repository.documentsExpiring.mockResolvedValue([soon, gone]);
    const result = await runDocumentExpirySweep(now);
    expect(result).toEqual({ considered: 2, reminded: 1, expired: 1, held: 1 });
    expect(repository.stampDocument).toHaveBeenCalledWith('doc_dl', { expiryRemindedAt: now, expiryReminderDays: 7 });
    expect(repository.stampDocument).toHaveBeenCalledWith('doc_ins', { status: 'EXPIRED', expiredAt: now });
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.objectContaining({ stage: 'ON_HOLD', heldFromStage: 'ACTIVE', holdReason: expect.stringContaining('Vehicle insurance expired on 2026-09-30') }));
    expect(notifications.notify).toHaveBeenCalledWith('AGENT_DOCUMENT_EXPIRING', 'usr_1', expect.objectContaining({ document: 'Driving licence (front)', days: '5' }), expect.anything());
    expect(notifications.notify).toHaveBeenCalledWith('AGENT_DOCUMENT_EXPIRED', 'usr_1', expect.objectContaining({ document: 'Vehicle insurance' }), expect.anything());
    // Reminded already for this window: not again.
    repository.stampDocument.mockClear();
    repository.documentsExpiring.mockResolvedValue([{ ...soon, expiryRemindedAt: now, expiryReminderDays: 7 }]);
    expect(await runDocumentExpirySweep(now)).toEqual({ considered: 1, reminded: 0, expired: 0, held: 0 });
    expect(repository.stampDocument).not.toHaveBeenCalled();

    // The renewed paper approved: back to work by itself.
    const held = record({ stage: 'ON_HOLD', heldFromStage: 'ACTIVE', activatedAt: new Date(), vehicleType: 'SCOOTER', documents: [...complete(), doc('VEHICLE_INSURANCE', 'SUBMITTED')] });
    repository.findById.mockResolvedValueOnce(held);
    repository.reviewDocument.mockResolvedValue({ id: 'doc_ins' });
    const renewed = { ...held, documents: held.documents.map((d) => (d.kind === 'VEHICLE_INSURANCE' ? { ...d, status: 'APPROVED' } : d)) };
    repository.findById.mockResolvedValueOnce(renewed); // the review's own settle
    repository.findById.mockResolvedValueOnce(renewed); // resumeIfRenewed
    repository.findById.mockResolvedValueOnce({ ...renewed, stage: 'ACTIVE', heldFromStage: null });
    const back = await reviewDocument('agt_1', 'VEHICLE_INSURANCE', { decision: 'APPROVED' }, 'adm_1');
    expect(repository.patch).toHaveBeenCalledWith('agt_1', { stage: 'ACTIVE', heldFromStage: null, holdReason: null });
    expect(back.agent.stage).toBe('ACTIVE');
  });

  it("checks the vehicle RC with Cashfree and stamps the paper with the owner-name match; a refusal is a 409 the desk reads", async () => {
    const { verifyVehicleRcAtDesk } = await import('../application/application.service');
    const rider = record({ stage: 'SCREENING', vehicleType: 'SCOOTER', vehicleNumber: 'KA01AB1234', documents: [...complete(), doc('VEHICLE_RC')] });
    repository.findById.mockResolvedValue(rider);
    repository.findDocument.mockResolvedValue({ id: 'doc_rc', kind: 'VEHICLE_RC' });
    cashfree.lookupVehicleRc.mockResolvedValueOnce({ ok: true, facts: { registrationNumber: 'KA01AB1234', ownerName: 'RAHUL MENON', status: 'VALID', insuranceValidUntil: '2027-01-01' }, raw: { owner: 'RAHUL MENON' } });
    const view = await verifyVehicleRcAtDesk('agt_1', 'adm_1');
    expect(repository.stampDocument).toHaveBeenCalledWith('doc_rc', expect.objectContaining({ verifiedVia: 'CASHFREE_VRS', verificationPayload: expect.objectContaining({ ownerName: 'RAHUL MENON', nameMatch: 100 }) }));
    expect(view.verification).toMatchObject({ via: 'CASHFREE_VRS', nameMatch: 100 });

    cashfree.lookupVehicleRc.mockResolvedValueOnce({ ok: false, code: 'REFUSED', status: 403, message: 'IP not whitelisted' });
    await expect(verifyVehicleRcAtDesk('agt_1', 'adm_1')).rejects.toMatchObject({ statusCode: 409, code: 'VERIFICATION_UNAVAILABLE', message: 'IP not whitelisted' });
    repository.findById.mockReset();
  });
});

/**
 * AG-5: the fleet's provenance, the exit's settlement, the purge.
 */
describe('AG-5: fleets, the exit, the purge', () => {
  it('a number a fleet partner invited applies as FLEET with the partner named, and activation marks the invite', async () => {
    repository.findByUserId.mockResolvedValueOnce(null);
    fleet.fleetProvenanceFor.mockResolvedValueOnce({ partnerId: 'fp_1', partnerName: 'Swift Riders', inviteId: 'inv_1' });
    repository.createApplication.mockResolvedValueOnce(record({ stage: 'PROFILE', sourceKind: 'FLEET', sourceNote: 'Swift Riders', fleetPartnerId: 'fp_1' }));
    const view = await apply('usr_1', { side: 'PUBLISHER' });
    expect(repository.createApplication).toHaveBeenCalledWith('usr_1', expect.objectContaining({ sourceKind: 'FLEET', sourceNote: 'Swift Riders', fleetPartnerId: 'fp_1' }));
    expect(fleet.markFleetInviteApplied).toHaveBeenCalledWith('inv_1', 'agt_1');
    expect(view.agent.sourceKind).toBe('FLEET');

    repository.findById.mockResolvedValueOnce(record({ stage: 'UNDER_REVIEW', documents: complete(), kyc: { status: 'VERIFIED', reviewedAt: new Date() } }));
    repository.findById.mockResolvedValueOnce(record({ stage: 'ACTIVE', grade: 'G1' }));
    await decideApplication('agt_1', { decision: 'ACTIVATE', grade: 'G1', waiveScreening: true, note: 'Papers checked' }, 'adm_1');
    expect(fleet.markFleetInviteActivated).toHaveBeenCalledWith('agt_1');
  });

  it('the exit settles: sessions, grants, the QR code, the closing payout — and the agent is told', async () => {
    repository.findById.mockResolvedValueOnce(record({ stage: 'ACTIVE', activatedAt: new Date() }));
    repository.findById.mockResolvedValueOnce(record({ stage: 'EXITED', exitReason: 'RESIGNED' }));
    const result = await exitAgent('agt_1', { reason: 'RESIGNED', rehireEligible: true, blacklist: false }, 'adm_1');
    expect(repository.patch).toHaveBeenCalledWith('agt_1', expect.objectContaining({ stage: 'EXITED', status: 'SUSPENDED', exitReason: 'RESIGNED' }));
    expect(port.settleExit).toHaveBeenCalledWith('agt_1', 'usr_1');
    expect(result.settlement).toMatchObject({ grantsRevoked: 1, payout: { amount: '1250.00' } });
    expect(notifications.notify).toHaveBeenCalledWith('AGENT_APPLICATION_DECISION', 'usr_1', expect.objectContaining({ decision: 'ended' }), expect.objectContaining({ inApp: expect.objectContaining({ title: 'Your ADX engagement has ended' }) }));
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'AGENT_EXITED', expect.objectContaining({ metadata: expect.objectContaining({ grantsRevoked: 1 }) }));
  });

  it('ninety days after an exit the papers are purged — the files through the port, the rows deleted, the profile stamped', async () => {
    const { purgeExitedDocuments } = await import('../application/application.service');
    repository.agentsForPurge.mockResolvedValue([{ id: 'agt_9', exitedAt: new Date('2026-06-01T00:00:00Z'), exitedById: 'adm_1', documents: [{ id: 'd1', url: 'http://x/files/f1' }, { id: 'd2', url: 'http://x/files/f2' }] }]);
    const now = new Date('2026-09-21T00:00:00Z');
    const result = await purgeExitedDocuments(now);
    expect(repository.agentsForPurge).toHaveBeenCalledWith(new Date('2026-06-23T00:00:00Z'));
    expect(port.purgeFile).toHaveBeenCalledTimes(2);
    expect(repository.purgeDocuments).toHaveBeenCalledWith('agt_9', now);
    expect(result).toEqual({ agents: 1, documents: 2, files: 2 });
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'AGENT_DOCUMENTS_PURGED', expect.objectContaining({ targetId: 'agt_9' }));
  });
});

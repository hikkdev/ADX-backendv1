import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent's journey, walked as a state machine rather than as endpoints.
 *
 * Every one of these calls already worked in isolation, and the flow was still
 * impossible to finish: from IN_PROGRESS the agent had four actions and not one
 * of them advanced the order, while the only forward transition was rendered
 * exclusively inside a branch that only that transition could produce. Testing
 * endpoints one at a time is exactly how that survived, so these tests walk the
 * ladder instead.
 */

const { repository, notify, listings, assignment, qr, appConfig } = vi.hoisted(() => ({
  appConfig: { getFlow: vi.fn() },
  repository: {
    findById: vi.fn(),
    findWithPublisher: vi.fn(),
    findWithVerification: vi.fn(),
    update: vi.fn(),
    upsertVerification: vi.fn(),
    addPhotos: vi.fn(),
    countPhotos: vi.fn(),
    listPhotos: vi.fn(),
  },
  notify: { notifyUser: vi.fn(), notifyAdmins: vi.fn(), notifyAgent: vi.fn(), shortId: (s: string) => s.slice(0, 6) },
  listings: { setListingAvailability: vi.fn(), getListingWithPublisher: vi.fn() },
  assignment: { autoAssignAgent: vi.fn() },
  qr: {
    generateQr: vi.fn(),
    deactivateQrsFor: vi.fn(),
    findActiveQrFor: vi.fn(),
    assertQrForRef: vi.fn(),
    PICKUP_PURPOSE: 'PICKUP',
  },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../orders.notify', () => notify);
vi.mock('../../listings', () => listings);
vi.mock('../assignment/assignment.service', () => assignment);
vi.mock('../../qr', () => qr);
vi.mock('../../app-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../app-config')>();
  return { ...actual, ...appConfig };
});

import {
  agentCaptureCondition,
  agentCaptureInstallation,
  agentCollectPrints,
  agentRejectCondition,
  agentSubmitInstallation,
  fulfilmentEvidence,
  markPrintReady,
  pickupCode,
  publisherChooseFulfilment,
} from '../fulfilment/fulfilment.service';
import { registerCreativeGatePort, resetCreativeGatePort } from '../creative-gate.port';
import { orderError } from '../orders.errors';

const AGENT = 'agt_1';
const PUBLISHER_USER = 'usr_pub';
const order = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  status: 'IN_PROGRESS',
  agentId: AGENT,
  ...over,
});

/** The shape `findWithPublisher` returns: the order, its listing, its owner. */
const booking = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  status: 'PENDING_PRINT',
  agentId: null,
  installBy: null,
  printReadyAt: null,
  listing: {
    id: 'lst_1',
    title: 'Reception mirror',
    // True, as it is on every listing on the platform, and deliberately
    // irrelevant now: the fork reads the order, not this.
    agentCanInstall: true,
    publisher: { id: 'pub_1', userId: PUBLISHER_USER, address: '12 MG Road', city: null, state: null },
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  appConfig.getFlow.mockResolvedValue(null);
  repository.findById.mockResolvedValue(order());
  repository.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
  repository.upsertVerification.mockResolvedValue({});
  repository.addPhotos.mockResolvedValue(1);
  repository.countPhotos.mockResolvedValue([
    { kind: 'CONDITION', count: 2 },
    { kind: 'INSTALLATION', count: 1 },
  ]);
  repository.listPhotos.mockResolvedValue([]);
  repository.findWithVerification.mockResolvedValue({
    id: 'ord_1',
    status: 'IN_PROGRESS',
    selfInstallCheckedInAt: null,
    verification: { qrScanned: true },
  });
  assignment.autoAssignAgent.mockResolvedValue(undefined);
  // Fire-and-forget notifications are still awaited-on-catch by the services,
  // so the mocks have to be thenable or the transition throws on its own alert.
  notify.notifyUser.mockResolvedValue(undefined);
  notify.notifyAdmins.mockResolvedValue(undefined);
  notify.notifyAgent.mockResolvedValue(undefined);
});

describe('the job can be finished', () => {
  /* The bug, as a test: this is the transition that did not exist. */
  it('moves an installed job on to the completion code', async () => {
    const result = await agentSubmitInstallation('ord_1', AGENT, { attested: true });
    expect(repository.update).toHaveBeenCalledWith('ord_1', { status: 'PENDING_OTP' });
    expect(result).toMatchObject({ status: 'PENDING_OTP' });
  });

  it('marks the checklist passed, so the record says a person attested to it', async () => {
    await agentSubmitInstallation('ord_1', AGENT, { attested: true });
    expect(repository.upsertVerification).toHaveBeenCalledWith(
      'ord_1',
      expect.objectContaining({ checklistPassed: true, verifiedAt: expect.any(Date) })
    );
  });

  /* The frame's accuracy checkbox is a gate, not decoration. */
  it('refuses without the attestation', async () => {
    await expect(
      agentSubmitInstallation('ord_1', AGENT, { attested: false })
    ).rejects.toThrow('ATTESTATION_REQUIRED');
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('refuses while the site has not been checked in to', async () => {
    repository.findWithVerification.mockResolvedValue({
      id: 'ord_1',
      status: 'IN_PROGRESS',
      selfInstallCheckedInAt: null,
      verification: { qrScanned: false },
    });
    await expect(
      agentSubmitInstallation('ord_1', AGENT, { attested: true })
    ).rejects.toThrow('EVIDENCE_INCOMPLETE');
  });

  it('refuses while there is no photograph of the advertisement in place', async () => {
    repository.countPhotos.mockResolvedValue([{ kind: 'CONDITION', count: 2 }]);
    await expect(
      agentSubmitInstallation('ord_1', AGENT, { attested: true })
    ).rejects.toThrow('EVIDENCE_INCOMPLETE');
  });

  it('is idempotent — a second submit does not reissue anything', async () => {
    repository.findById.mockResolvedValue(order({ status: 'PENDING_OTP' }));
    const result = await agentSubmitInstallation('ord_1', AGENT, { attested: true });
    expect(repository.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'PENDING_OTP' });
  });

  it('will not submit somebody else’s job', async () => {
    repository.findById.mockResolvedValue(order({ agentId: 'agt_other' }));
    await expect(
      agentSubmitInstallation('ord_1', AGENT, { attested: true })
    ).rejects.toThrow('NOT_YOUR_ORDER');
  });
});

describe('the publisher chooses who installs', () => {
  /*
   * The bug this fixes is not a broken transition but a constant one:
   * `markPrintReady` forked on `Listing.agentCanInstall`, which defaults to
   * true and which nothing in the codebase writes. So the SELF_INSTALL half of
   * the state machine could not be reached from any input at all.
   */
  it('records the answer against the booking, not the listing', async () => {
    repository.findWithPublisher.mockResolvedValue(booking());
    await publisherChooseFulfilment('ord_1', PUBLISHER_USER, 'PUBLISHER');
    expect(repository.update).toHaveBeenCalledWith('ord_1', { installBy: 'PUBLISHER' });
  });

  it('sends a self-install booking to the publisher when the prints are ready', async () => {
    repository.findWithPublisher.mockResolvedValue(booking({ installBy: 'PUBLISHER' }));
    await markPrintReady('ord_1');
    expect(repository.update).toHaveBeenCalledWith(
      'ord_1',
      expect.objectContaining({ status: 'SELF_INSTALL' })
    );
    expect(assignment.autoAssignAgent).not.toHaveBeenCalled();
  });

  it('dispatches an agent when the publisher asked ADX to install', async () => {
    repository.findWithPublisher.mockResolvedValue(booking({ installBy: 'ADX' }));
    await markPrintReady('ord_1');
    expect(repository.update).toHaveBeenCalledWith(
      'ord_1',
      expect.objectContaining({ status: 'PENDING_AGENT' })
    );
    expect(assignment.autoAssignAgent).toHaveBeenCalledWith('ord_1');
  });

  /* A9: the code on the package, minted once the prints exist to put it on. */
  it('mints the pickup code for the package, replacing any earlier one', async () => {
    repository.findWithPublisher.mockResolvedValue(booking({ installBy: 'ADX' }));
    await markPrintReady('ord_1');
    expect(qr.deactivateQrsFor).toHaveBeenCalledWith('ORDER', 'ord_1');
    expect(qr.generateQr).toHaveBeenCalledWith('ORDER', 'ord_1', ['AGENT_PUBLISHER'], { purpose: 'PICKUP' });
  });

  /* Lot D (Q120): the hard gate. Nothing prints — no code, neither fork —
     until the campaign's artwork on this order is APPROVED. */
  describe('the artwork gate', () => {
    afterEach(() => resetCreativeGatePort());

    it('refuses CREATIVE_NOT_APPROVED before the pickup code and before either fork', async () => {
      registerCreativeGatePort({ artworkApprovedFor: async () => ({ approved: false, reason: 'in review' }) });
      repository.findWithPublisher.mockResolvedValue(booking({ installBy: 'ADX' }));
      await expect(markPrintReady('ord_1')).rejects.toThrow('CREATIVE_NOT_APPROVED');
      expect(qr.generateQr).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
      expect(assignment.autoAssignAgent).not.toHaveBeenCalled();

      repository.findWithPublisher.mockResolvedValue(booking({ installBy: 'PUBLISHER' }));
      await expect(markPrintReady('ord_1')).rejects.toThrow('CREATIVE_NOT_APPROVED');
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('is a 409 with its own code on the wire', () => {
      expect(() => orderError(new Error('CREATIVE_NOT_APPROVED'))).toThrow(
        expect.objectContaining({ statusCode: 409, code: 'CREATIVE_NOT_APPROVED' }),
      );
    });

    it('prints once the port says the artwork is approved — and always, unregistered', async () => {
      registerCreativeGatePort({ artworkApprovedFor: async () => ({ approved: true, reason: null }) });
      repository.findWithPublisher.mockResolvedValue(booking({ installBy: 'ADX' }));
      await markPrintReady('ord_1');
      expect(qr.generateQr).toHaveBeenCalled();
    });
  });

  it('mints no pickup code for a self-install', async () => {
    repository.findWithPublisher.mockResolvedValue(booking({ installBy: 'PUBLISHER' }));
    await markPrintReady('ord_1');
    expect(qr.generateQr).not.toHaveBeenCalled();
  });

  it('finds the live pickup code, and only a pickup code', async () => {
    qr.findActiveQrFor.mockResolvedValue({ id: 'qr_pick', metadata: { purpose: 'PICKUP' } });
    expect(await pickupCode('ord_1')).toEqual({ qrId: 'qr_pick' });
    qr.findActiveQrFor.mockResolvedValue({ id: 'qr_site', metadata: null });
    expect(await pickupCode('ord_1')).toBeNull();
    qr.findActiveQrFor.mockResolvedValue(null);
    expect(await pickupCode('ord_1')).toBeNull();
  });

  /* Orders placed before P2 existed. Somebody is dispatched rather than a
     publisher being left waiting on a job they never agreed to. */
  it('falls to ADX when the publisher was never asked', async () => {
    repository.findWithPublisher.mockResolvedValue(booking({ installBy: null }));
    await markPrintReady('ord_1');
    expect(repository.update).toHaveBeenCalledWith(
      'ord_1',
      expect.objectContaining({ status: 'PENDING_AGENT' })
    );
  });

  it('is a no-op when the same answer arrives twice', async () => {
    repository.findWithPublisher.mockResolvedValue(booking({ installBy: 'ADX' }));
    await publisherChooseFulfilment('ord_1', PUBLISHER_USER, 'ADX');
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('locks once ADX has printed, rather than re-forking behind somebody', async () => {
    repository.findWithPublisher.mockResolvedValue(
      booking({ status: 'PENDING_AGENT', installBy: 'ADX', printReadyAt: new Date() })
    );
    await expect(
      publisherChooseFulfilment('ord_1', PUBLISHER_USER, 'PUBLISHER')
    ).rejects.toThrow('FULFILMENT_LOCKED');
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('will not answer for somebody else’s spot', async () => {
    repository.findWithPublisher.mockResolvedValue(booking());
    await expect(
      publisherChooseFulfilment('ord_1', 'usr_someone_else', 'PUBLISHER')
    ).rejects.toThrow('NOT_YOUR_ORDER');
  });
});

describe('evidence is kept', () => {
  /* All four of the frames' named proofs, not the first two. */
  it('stores every condition photograph, not just two', async () => {
    await agentCaptureCondition('ord_1', AGENT, ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'], [
      'Mirror decal',
      'Decal angle',
      'Mirror & fixture',
      'Reception zone',
    ]);
    expect(repository.addPhotos).toHaveBeenCalledWith(
      'ord_1',
      'CONDITION',
      [
        { url: 'a.jpg', label: 'Mirror decal' },
        { url: 'b.jpg', label: 'Decal angle' },
        { url: 'c.jpg', label: 'Mirror & fixture' },
        { url: 'd.jpg', label: 'Reception zone' },
      ],
      null
    );
  });

  it('still fills the two columns the admin console reads', async () => {
    await agentCaptureCondition('ord_1', AGENT, ['a.jpg', 'b.jpg', 'c.jpg']);
    expect(repository.upsertVerification).toHaveBeenCalledWith('ord_1', {
      wideAngleUrl: 'a.jpg',
      closeUpUrl: 'b.jpg',
    });
  });

  /* It used to arrive as `_photoUrl` and go nowhere. */
  it('keeps the material pickup photograph', async () => {
    repository.findById.mockResolvedValue(order({ status: 'SLOT_CONFIRMED' }));
    await agentCollectPrints('ord_1', AGENT, 'pickup.jpg');
    expect(repository.addPhotos).toHaveBeenCalledWith('ord_1', 'PICKUP', [
      { url: 'pickup.jpg', label: 'Material collected' },
    ]);
  });

  /* A9: the scanned package code has to be this order's. */
  it('accepts the pickup with the package code, and refuses another order\u2019s code', async () => {
    repository.findById.mockResolvedValue(order({ status: 'SLOT_CONFIRMED' }));
    qr.assertQrForRef.mockResolvedValue(undefined);
    await agentCollectPrints('ord_1', AGENT, undefined, 'qr_pick');
    expect(qr.assertQrForRef).toHaveBeenCalledWith('qr_pick', 'ORDER', 'ord_1');
    expect(repository.update).toHaveBeenCalledWith('ord_1', { status: 'IN_PROGRESS' });

    qr.assertQrForRef.mockRejectedValue(new Error('QR_MISMATCH'));
    await expect(agentCollectPrints('ord_1', AGENT, undefined, 'qr_other')).rejects.toThrow('PICKUP_CODE_MISMATCH');
  });

  it('keeps the installation photograph', async () => {
    await agentCaptureInstallation('ord_1', AGENT, 'after.jpg');
    expect(repository.addPhotos).toHaveBeenCalledWith('ord_1', 'INSTALLATION', [
      { url: 'after.jpg', label: 'Advertisement in place' },
    ]);
  });

  /* A refusal used to reach ADX with no reason and no photograph, and the next
     agent inherited the same surprise. */
  it('keeps both the reason and the photographs when an agent refuses a site', async () => {
    await agentRejectCondition('ord_1', AGENT, 'Wall is under repair', ['x.jpg', 'y.jpg']);
    expect(repository.addPhotos).toHaveBeenCalledWith('ord_1', 'REJECTION', [
      { url: 'x.jpg', label: 'Why the site was refused' },
      { url: 'y.jpg', label: 'Why the site was refused' },
    ]);
    expect(repository.upsertVerification).toHaveBeenCalledWith('ord_1', {
      notes: 'Wall is under repair',
    });
  });
});

describe('the submit gate reports what is left', () => {
  it('counts requirements met against the total', async () => {
    const evidence = await fulfilmentEvidence('ord_1');
    expect(evidence.total).toBe(3);
    expect(evidence.met).toBe(3);
    expect(evidence.canSubmit).toBe(true);
  });

  it('names the requirement that is missing rather than only refusing', async () => {
    repository.countPhotos.mockResolvedValue([{ kind: 'CONDITION', count: 1 }]);
    const evidence = await fulfilmentEvidence('ord_1');
    expect(evidence.canSubmit).toBe(false);
    expect(evidence.requirements.find((r) => r.key === 'INSTALLATION')?.met).toBe(false);
    expect(evidence.requirements.find((r) => r.key === 'CONDITION')?.met).toBe(true);
  });

  /*
   * A publisher installing their own spot never scans a code, so the flag the
   * gate read stayed false — and Proof of Work told them for ever that nobody
   * had turned up to the site they were standing in.
   */
  it('counts the publisher’s own check-in, not only the agent’s scan', async () => {
    repository.findWithVerification.mockResolvedValue({
      id: 'ord_1',
      status: 'SELF_INSTALL',
      selfInstallCheckedInAt: new Date(),
      verification: null,
    });
    const evidence = await fulfilmentEvidence('ord_1');
    expect(evidence.requirements.find((r) => r.key === 'CHECK_IN')?.met).toBe(true);
    expect(evidence.canSubmit).toBe(true);
  });

  /* Lot G (Q126/Q141): the requirements are the ladder's proofs. */
  it('reads the requirements off the code ladder when flows.agent-job is absent, with its wording', async () => {
    const evidence = await fulfilmentEvidence('ord_1');
    expect(appConfig.getFlow).toHaveBeenCalledWith('agent-job');
    expect(evidence.ladder).toEqual({ version: 1, source: 'code' });
    expect(evidence.requirements.map((r) => [r.key, r.step, r.label])).toEqual([
      ['CHECK_IN', 'CHECK_IN', 'Checked in at the site'],
      ['CONDITION', 'BEFORE', 'Site photographed before install'],
      ['INSTALLATION', 'AFTER', 'Advertisement photographed in place'],
    ]);
  });

  it('reads them off a stored ladder that fits the vocabulary — a pickup photograph becomes a requirement when the console asks for one', async () => {
    appConfig.getFlow.mockResolvedValue({
      version: 4,
      steps: [
        { key: 'pickup', number: 2, title: 'Pickup', proofs: [{ key: 'PICKUP', label: 'Material photographed at the counter' }] },
        { key: 'scan', number: 4, title: 'Scan', proofs: [{ key: 'CHECK_IN', label: 'Scanned the spot' }] },
        { key: 'before', number: 5, title: 'Before', proofs: [{ key: 'CONDITION', label: 'Before shots' }] },
        { key: 'after', number: 7, title: 'After', proofs: [{ key: 'INSTALLATION', label: 'After shots' }] },
      ],
    });
    const evidence = await fulfilmentEvidence('ord_1');
    expect(evidence.ladder).toEqual({ version: 4, source: 'config' });
    expect(evidence.total).toBe(4);
    expect(evidence.requirements.find((r) => r.key === 'PICKUP')).toMatchObject({ met: false, label: 'Material photographed at the counter', step: 'pickup' });
    expect(evidence.canSubmit).toBe(false);
    await expect(agentSubmitInstallation('ord_1', AGENT, { attested: true })).rejects.toThrow('EVIDENCE_INCOMPLETE');
  });

  it('falls back to the code ladder when the stored one does not fit, or cannot be read', async () => {
    appConfig.getFlow.mockResolvedValue({ version: 2, steps: [{ key: 'only', number: 1, title: 'Only', proofs: [] }] }); // drops every required proof
    let evidence = await fulfilmentEvidence('ord_1');
    expect(evidence.ladder.source).toBe('code');
    expect(evidence.total).toBe(3);

    appConfig.getFlow.mockRejectedValue(new Error('connection refused'));
    evidence = await fulfilmentEvidence('ord_1');
    expect(evidence.ladder.source).toBe('code');
    expect(evidence.canSubmit).toBe(true);
  });
});

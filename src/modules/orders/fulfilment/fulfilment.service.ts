import { logger } from '../../../shared/logging';
import { Decimal } from '../../../shared/money';
import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { notifyAdmins, notifyUser, shortId } from '../orders.notify';
import { autoAssignAgent } from '../assignment/assignment.service';
import { creativeGatePort } from '../creative-gate.port';
import { printJobPort, type PickupPoint } from '../print-job.port';
import { PICKUP_PURPOSE, assertQrForRef, deactivateQrsFor, findActiveQrFor, generateQr } from '../../qr';
import { jobLadder, ladderProofs } from './job-ladder';

/** Loads an order and checks it is assigned to this agent. */
async function requireAgentOrder(orderId: string, agentProfileId: string) {
  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  return order;
}

/**
 * P2 — who puts the advertisement up.
 *
 * Asked once per booking, after the publisher has accepted and before ADX has
 * printed anything. Per booking rather than per listing because that is the
 * question the frame asks and the honest one: a publisher may put up the decal
 * in their own reception this month and want an agent for the hoarding on the
 * roof next month.
 *
 * The choice is only a choice while `PENDING_PRINT`. Once ADX marks the prints
 * ready the fork has been taken — an agent has been offered the job, or the
 * publisher has been told to collect — and silently re-forking it would strand
 * whoever was already acting on the first answer. So it locks, and says so.
 */
export async function publisherChooseFulfilment(
  orderId: string,
  publisherUserId: string,
  installBy: 'PUBLISHER' | 'ADX',
) {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.listing.publisher?.userId !== publisherUserId) throw new Error('NOT_YOUR_ORDER');

  // Answering again with the same answer is the app retrying, not a conflict.
  if (order.installBy === installBy) return order;
  if (order.status !== 'PENDING_PRINT') {
    // A booking that has moved on is locked; one that has not got here yet is
    // simply being asked out of order.
    throw new Error(order.printReadyAt ? 'FULFILMENT_LOCKED' : 'WRONG_STATUS');
  }

  const updated = await repository.update(orderId, { installBy });

  notifyAdmins(
    installBy === 'PUBLISHER' ? 'Publisher will install' : 'ADX installation requested',
    installBy === 'PUBLISHER'
      ? `The publisher will install order ${shortId(orderId)} themselves. Print and hand over.`
      : `The publisher asked ADX to install order ${shortId(orderId)}. An agent is needed.`,
    orderId,
  ).catch(() => {});

  return updated;
}

/**
 * Admin marks prints ready, which forks the flow.
 *
 * The fork reads `Order.installBy` — the publisher's own answer to P2. It used
 * to read `Listing.agentCanInstall`, a per-listing boolean that defaults to
 * true and that nothing in the codebase ever wrote, so the condition was
 * constant and the whole self-install branch below was unreachable.
 *
 * Null means the publisher was never asked — an order placed before P2 existed,
 * or one ADX pushed through quickly — and falls to ADX, which is what happened
 * to every order under the old boolean. The safe default is the one where
 * somebody is dispatched rather than the one where a publisher is waiting on a
 * message they never agreed to receive.
 */
export async function markPrintReady(orderId: string, options: { agentFee?: string | null } = {}) {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_PRINT') throw new Error('WRONG_STATUS');

  // Lot D (Q120): the hard gate. Nothing prints — no pickup code, neither
  // fork — until every creative on this order's spot is APPROVED. Asked
  // through the port because `campaigns` owns the artwork and raises orders.
  const artwork = await creativeGatePort().artworkApprovedFor(orderId);
  if (!artwork.approved) {
    logger.info('Print refused: artwork not approved', { orderId, reason: artwork.reason });
    throw new Error('CREATIVE_NOT_APPROVED');
  }

  // Lot B (Q102): the per-order installation figure, when ops typed one here.
  // Written on both forks — a self-install pays no agent, but the figure is
  // what was typed and the resolver reads it only when an agent is offered.
  const fee =
    options.agentFee !== undefined && options.agentFee !== null
      ? { agentFeeAmount: new Decimal(options.agentFee) }
      : {};

  if (order.installBy === 'PUBLISHER') {
    const updated = await repository.update(orderId, {
      status: 'SELF_INSTALL',
      printReadyAt: new Date(),
      ...fee,
    });
    if (order.listing.publisher?.userId) {
      notifyUser(
        order.listing.publisher.userId,
        'Prints ready — please install',
        `Prints for order ${shortId(orderId)} are ready. Please collect and install them yourself.`,
        orderId,
      ).catch(() => {});
    }
    return updated;
  }

  const updated = await repository.update(orderId, {
    status: 'PENDING_AGENT',
    printReadyAt: new Date(),
    ...fee,
  });
  // A9: the code the print shop puts on the package. One live code per order;
  // marking ready twice replaces it rather than leaving two in the wild.
  // Lot B (B4b): when a print partner is printing this order, its address
  // rides on the code's metadata so the agent's collect-prints step can print
  // the pickup point without a second lookup.
  await deactivateQrsFor('ORDER', orderId);
  const pickup = await pickupPointFor(orderId);
  await generateQr('ORDER', orderId, ['AGENT_PUBLISHER'], {
    purpose: PICKUP_PURPOSE,
    ...(pickup ? { pickup } : {}),
  });
  autoAssignAgent(orderId).catch((err) => logger.error('autoAssignAgent failed', { orderId, err }));
  return updated;
}

/** The print partner's address for an order, or null — through the port, and never a reason to fail the step. */
async function pickupPointFor(orderId: string): Promise<PickupPoint | null> {
  try {
    const job = await printJobPort().printJobFor(orderId);
    return job?.pickup ?? null;
  } catch (err) {
    logger.warn('Could not read the print job for the pickup point', { orderId, err });
    return null;
  }
}

/**
 * The pickup code for an order, for whoever prints it or scans it.
 *
 * Null when none is live — the order never reached an agent, or the code was
 * replaced. The image is `GET /qr/:id/image.png`; the client builds that URL.
 * Lot B (B4b): `pickup` is the print partner's address when one is printing
 * the order — the code's own stamp, or the job as it stands today.
 */
export async function pickupCode(orderId: string): Promise<{ qrId: string; pickup?: PickupPoint } | null> {
  const live = await findActiveQrFor('ORDER', orderId);
  if (!live) return null;
  const metadata = live.metadata as { purpose?: unknown; pickup?: PickupPoint } | null;
  if (metadata?.purpose !== PICKUP_PURPOSE) return null;
  const pickup = metadata.pickup ?? (await pickupPointFor(orderId));
  return { qrId: live.id, ...(pickup ? { pickup } : {}) };
}

/**
 * Collecting prints starts the installation.
 *
 * Re-collecting once already IN_PROGRESS is a no-op rather than an error: the
 * agent app retries this step on a flaky connection.
 *
 * The pickup photograph is kept now. It used to arrive as `_photoUrl` and go
 * nowhere, so an agent was told their evidence had been filed when nothing had
 * been written — which is worse than not asking for it.
 */
export async function agentCollectPrints(
  orderId: string,
  agentProfileId: string,
  photoUrl?: string,
  qrId?: string,
) {
  const order = await requireAgentOrder(orderId, agentProfileId);
  // A9: when the agent scanned the package, the code has to be this order's.
  // Optional, because a build without a camera still has to be able to
  // collect — the checklist is the gate; the scan is the proof.
  if (qrId) {
    try {
      await assertQrForRef(qrId, 'ORDER', orderId);
    } catch {
      throw new Error('PICKUP_CODE_MISMATCH');
    }
  }
  if (photoUrl) {
    await repository.addPhotos(orderId, 'PICKUP', [{ url: photoUrl, label: 'Material collected' }]);
  }
  if (order.status === 'IN_PROGRESS') return order;
  if (order.status !== 'SLOT_CONFIRMED') throw new Error('WRONG_STATUS');
  const updated = await repository.update(orderId, { status: 'IN_PROGRESS' });
  // Lot B (B4b): the material has left the print shop. The job records the
  // collection; a job that cannot be marked must not undo the agent's step.
  await printJobPort()
    .markCollected(orderId, new Date())
    .catch((err) => logger.warn('Could not mark the print job collected', { orderId, err }));
  return updated;
}

/**
 * Site-condition photos.
 *
 * Accepted after the fact too — once the order has moved to OTP, approval or
 * completion the photos are still stored, they just no longer advance anything.
 * That lets an agent correct evidence without reopening the order.
 */
export async function agentCaptureCondition(
  orderId: string,
  agentProfileId: string,
  photoUrls: string[],
  labels: (string | null)[] = [],
) {
  const order = await requireAgentOrder(orderId, agentProfileId);

  /*
   * Every photo is kept. This used to be
   * `{ wideAngleUrl: photoUrls[0], closeUpUrl: photoUrls[1] }`, which silently
   * dropped the third and fourth of the four proofs the frames name — and both
   * apps let the agent queue as many as they liked.
   *
   * The two columns on SiteVerification are still written, because the admin
   * console reads them; they are now the first two of a list rather than the
   * whole of it.
   */
  await repository.addPhotos(
    orderId,
    'CONDITION',
    photoUrls.map((url, i) => ({ url, label: labels[i] ?? null })),
    null
  );
  const patch = { wideAngleUrl: photoUrls[0], closeUpUrl: photoUrls[1] };

  const pastStatuses = ['PENDING_OTP', 'PENDING_APPROVAL', 'COMPLETED'];
  if (pastStatuses.includes(order.status)) {
    await repository.upsertVerification(orderId, patch);
    return order;
  }

  if (order.status !== 'IN_PROGRESS') throw new Error('WRONG_STATUS');
  await repository.upsertVerification(orderId, patch);
  return order;
}

/**
 * The agent refuses the site. The order goes back to PENDING_AGENT, the agent
 * is detached, and reassignment starts — the rejection also counts toward the
 * three-strike escalation.
 */
export async function agentRejectCondition(
  orderId: string,
  agentProfileId: string,
  reason: string,
  photoUrls: string[],
) {
  const order = await requireAgentOrder(orderId, agentProfileId);
  if (order.status !== 'IN_PROGRESS') throw new Error('WRONG_STATUS');

  // Both used to be discarded, so a refusal arrived at ADX with no reason and
  // no photograph — and the next agent inherited the same surprise.
  if (photoUrls.length > 0) {
    await repository.addPhotos(
      orderId,
      'REJECTION',
      photoUrls.map((url) => ({ url, label: 'Why the site was refused' }))
    );
  }
  await repository.upsertVerification(orderId, { notes: reason });

  await repository.update(orderId, {
    status: 'PENDING_AGENT',
    agentId: null,
    agentRejectionCount: { increment: 1 },
  });

  autoAssignAgent(orderId).catch((err) =>
    logger.error('autoAssignAgent R3 re-assign failed', { orderId, err }),
  );

  return repository.findById(orderId);
}

/** Installation photo. Late submissions are stored, same as condition photos. */
export async function agentCaptureInstallation(
  orderId: string,
  agentProfileId: string,
  photoUrl: string,
  label?: string | null,
) {
  const order = await requireAgentOrder(orderId, agentProfileId);
  await repository.addPhotos(orderId, 'INSTALLATION', [
    { url: photoUrl, label: label ?? 'Advertisement in place' },
  ]);

  if (order.status === 'PENDING_OTP' || order.status === 'PENDING_APPROVAL') {
    await repository.upsertVerification(orderId, { landmarkUrl: photoUrl });
    return order;
  }

  if (order.status !== 'IN_PROGRESS') throw new Error('WRONG_STATUS');
  await repository.upsertVerification(orderId, { landmarkUrl: photoUrl });
  return order;
}

/**
 * What the job has on file, and what the submit gate is still waiting for.
 *
 * Lot G (Q126/Q141): the requirements are the proofs the job ladder collects
 * — `flows.agent-job` when the console has stored one, the code ladder
 * otherwise — so the gate and the phone's checklist read the same list.
 * What each proof means is fixed here; the ladder only says which ones a
 * job waits for and what to print while one is missing.
 */
export async function fulfilmentEvidence(orderId: string) {
  const [counts, photos, order, ladder] = await Promise.all([
    repository.countPhotos(orderId),
    repository.listPhotos(orderId),
    repository.findWithVerification(orderId),
    jobLadder(),
  ]);
  const by = Object.fromEntries(counts.map((row) => [row.kind, row.count]));
  /*
   * Either lane's check-in counts.
   *
   * `qrScanned` is the agent's scan of the spot's own code. A publisher
   * installing their own spot never scans anything — they stamp
   * `selfInstallCheckedInAt` — and reading only the flag told every
   * self-installed booking, for ever, that nobody had turned up to it.
   */
  const checkedIn = Boolean(order?.verification?.qrScanned || order?.selfInstallCheckedInAt);
  const met: Record<string, boolean> = {
    PICKUP: (by['PICKUP'] ?? 0) > 0,
    CHECK_IN: checkedIn,
    CONDITION: (by['CONDITION'] ?? 0) > 0,
    INSTALLATION: (by['INSTALLATION'] ?? 0) > 0,
  };

  const requirements = ladderProofs(ladder).map((proof) => ({ key: proof.key, label: proof.label, step: proof.step, met: met[proof.key] ?? false }));

  return {
    photos,
    counts: by,
    requirements,
    met: requirements.filter((r) => r.met).length,
    total: requirements.length,
    /** What SUBMIT INSTALLATION needs before it will do anything. */
    canSubmit: requirements.every((r) => r.met),
    /** Q141: which ladder the requirements came from, so the phone can say. */
    ladder: { version: ladder.version ?? 1, source: ladder.source },
  };
}

/**
 * The step the flow was missing.
 *
 * From IN_PROGRESS the agent had four actions and none of them advanced the
 * order; the only forward transition lived inside a branch that only that
 * transition could produce. So an agent could install an advertisement,
 * photograph it, and watch the job sit in progress for ever.
 *
 * This is the frame's own gate made real: the requirements are checked, the
 * agent attests that what they filed is accurate, and only then does the order
 * move on to the completion code.
 */
export async function agentSubmitInstallation(
  orderId: string,
  agentProfileId: string,
  input: { attested: boolean },
) {
  const order = await requireAgentOrder(orderId, agentProfileId);
  if (order.status === 'PENDING_OTP' || order.status === 'PENDING_APPROVAL') return order;
  if (order.status !== 'IN_PROGRESS') throw new Error('WRONG_STATUS');
  if (!input.attested) throw new Error('ATTESTATION_REQUIRED');

  const evidence = await fulfilmentEvidence(orderId);
  if (!evidence.canSubmit) throw new Error('EVIDENCE_INCOMPLETE');

  await repository.upsertVerification(orderId, { checklistPassed: true, verifiedAt: new Date() });
  return repository.update(orderId, { status: 'PENDING_OTP' });
}

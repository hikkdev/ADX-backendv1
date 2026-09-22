import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { prismaAgreementsRepository as agreements } from '../prisma-agreements.repository';
import { esignPolicy } from './esign.ports';
import { prismaEsignRepository as repository } from './prisma-esign.repository';
import { openSigningRequest, signingRequired, signingStanding, signingView, type SigningContext, type SigningStanding, type SigningView } from './esign.service';

/**
 * DS-3 (Digio eSign, 22 Sep 2026): the two documents the apps sign mid-flow
 * — the publisher's master licence and the advertiser's insertion order —
 * and the slice every party read carries so the apps draw one signing door.
 */

/* ------------------------------------------------------------------ */
/* The slice                                                           */
/* ------------------------------------------------------------------ */

/** What a party's own read says about a signed document: the app's door. */
export type SigningSlice = {
  required: boolean;
  satisfied: boolean;
  status: string | null;
  requestId: string | null;
  /** The gateway page — only while the request is open. */
  signingUrl: string | null;
  mock: boolean;
  expiresAt: Date | null;
  completedAt: Date | null;
  signedFileId: string | null;
  label: string | null;
};

export function signingSlice(standing: SigningStanding | null): SigningSlice {
  const request = standing?.request ?? null;
  const open = Boolean(request && ['REQUESTED', 'PARTIALLY_SIGNED'].includes(request.status));
  return {
    required: standing?.required ?? false,
    satisfied: standing?.satisfied ?? true,
    status: standing?.status ?? null,
    requestId: request?.id ?? null,
    signingUrl: open ? (request?.signingUrl ?? null) : null,
    mock: request?.mock ?? false,
    expiresAt: request?.expiresAt ?? null,
    completedAt: request?.completedAt ?? null,
    signedFileId: request?.files.signed ?? null,
    label: request?.label ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* The publisher's licence                                             */
/* ------------------------------------------------------------------ */

const LICENCE = 'PUBLISHER_LICENCE' as const;

export async function publisherLicenceStanding(publisherId: string): Promise<SigningStanding> {
  return signingStanding('PUBLISHER', publisherId, LICENCE);
}

/** The publisher's own read: the door on the home's set-up card. Null-safe on a rail that did not answer. */
export async function publisherLicenceFor(publisherId: string): Promise<SigningSlice> {
  return signingSlice(await publisherLicenceStanding(publisherId).catch(() => null));
}

/**
 * The trigger: decision 6 — the licence is asked for at the first approved
 * listing (the default) or at the first submission; `at` says which moment
 * this call is. Idempotent (a second approved listing finds the request),
 * never throws — a rail that cannot answer is logged and the next gated act
 * asks again.
 */
export async function requestPublisherLicence(publisherId: string, at: 'FIRST_APPROVED_LISTING' | 'FIRST_SUBMISSION', byUserId: string | null = null): Promise<{ opened: boolean; requestId: string | null }> {
  const policy = await esignPolicy();
  if (policy.publisherLicenceAt !== at) return { opened: false, requestId: null };
  try {
    const { request, created } = await openSigningRequest({ kind: LICENCE, partyType: 'PUBLISHER', partyId: publisherId, requestedById: byUserId });
    return { opened: created, requestId: request.id };
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'SIGNING_NOT_OPEN') return { opened: false, requestId: null };
    logger.error('Publisher licence: could not open the signing request', { publisherId, at, err: cause });
    return { opened: false, requestId: null };
  }
}

/**
 * The gate on publishing: once the licence has been asked for and is not
 * signed, the next attempt's listing agreement is refused 403
 * SIGNATURE_REQUIRED with the request. A publisher never asked yet (their
 * first listing, under FIRST_APPROVED_LISTING) passes — the licence opens
 * when that listing is approved.
 */
export async function assertPublisherLicenceSigned(publisherId: string): Promise<void> {
  const standing = await publisherLicenceStanding(publisherId);
  if (standing.satisfied || !standing.request) return;
  throw new ApiError(403, 'SIGNATURE_REQUIRED', 'Sign your licence to display before the next listing goes live — the document is in the app under Agreements', { signing: standing.request, kind: LICENCE });
}

/* ------------------------------------------------------------------ */
/* The insertion order                                                 */
/* ------------------------------------------------------------------ */

const IO = 'INSERTION_ORDER' as const;

/**
 * What the threshold and the band are read from: the campaign's media value
 * (the spots' line totals, as the insertion order itself enumerates them)
 * and the advertiser's band. One read for the checkout review and the
 * accept route, so both answer the same.
 */
export async function insertionOrderSigningContext(campaignId: string): Promise<SigningContext & { advertiserId: string } | null> {
  const campaign = await agreements.campaignForInsertionOrder(campaignId);
  if (!campaign) return null;
  const signer = await repository.partySigner('ADVERTISER', campaign.advertiserId);
  const total = campaign.spots.reduce((sum, spot) => sum + Number(spot.lineTotal || 0), 0);
  return { advertiserId: campaign.advertiserId, campaignTotal: total, band: signer?.band ?? null };
}

export type InsertionOrderSigning = { required: boolean; satisfied: boolean; request: SigningView | null };

/** Where the campaign's insertion order stands as a signature — the checkout review's slice and the authorise gate's question. */
export async function insertionOrderSigning(campaignId: string): Promise<InsertionOrderSigning> {
  const context = await insertionOrderSigningContext(campaignId);
  if (!context) return { required: false, satisfied: true, request: null };
  const standing = await signingStanding('ADVERTISER', context.advertiserId, IO, { campaignId }, context);
  return { required: standing.required, satisfied: standing.satisfied, request: standing.request };
}

/**
 * The accept route's fork: when the policy asks for a signature on this
 * campaign, the click is not recorded — the request is opened (or found)
 * and handed back for the app's signing screen. Null when a click is what
 * is wanted.
 */
export async function openInsertionOrderSigning(campaignId: string, advertiserId: string, byUserId: string): Promise<SigningView | null> {
  const context = await insertionOrderSigningContext(campaignId);
  if (!context || context.advertiserId !== advertiserId) return null;
  if (!(await signingRequired(IO, context))) return null;
  const { request } = await openSigningRequest({ kind: IO, partyType: 'ADVERTISER', partyId: advertiserId, requestedById: byUserId, anchor: { campaignId }, context });
  return signingView(request);
}

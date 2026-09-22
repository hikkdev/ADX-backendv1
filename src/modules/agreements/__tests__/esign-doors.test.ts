import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DS-3 (Digio eSign, 22 Sep 2026): the two documents the apps sign mid-flow.
 *
 * What is pinned: the publisher's licence is asked for at the moment the
 * policy names (first approved listing by default, or first submission)
 * and never at the other; once asked for and unsigned it holds the next
 * attempt, while a publisher never asked yet passes; the insertion order is
 * signed when the campaign's media value reaches the threshold or the band
 * is listed, and the accept route then hands back the request instead of
 * recording a click; the slice every party read carries opens the link
 * only while the request is open.
 */

const { service, ports, repos } = vi.hoisted(() => ({
  service: { openSigningRequest: vi.fn(), signingStanding: vi.fn(), signingRequired: vi.fn(), signingView: vi.fn((row: unknown) => row) },
  ports: { esignPolicy: vi.fn() },
  repos: {
    campaignForInsertionOrder: vi.fn(),
    partySigner: vi.fn(),
  },
}));

vi.mock('../esign/esign.service', () => service);
vi.mock('../esign/esign.ports', () => ports);
vi.mock('../prisma-agreements.repository', () => ({ prismaAgreementsRepository: { campaignForInsertionOrder: repos.campaignForInsertionOrder } }));
vi.mock('../esign/prisma-esign.repository', () => ({ prismaEsignRepository: { partySigner: repos.partySigner } }));

import { assertPublisherLicenceSigned, insertionOrderSigning, insertionOrderSigningContext, openInsertionOrderSigning, requestPublisherLicence, signingSlice } from '../esign/esign.doors';
import { ApiError } from '../../../shared/errors';

const request = (status: string) => ({ id: 'sig_1', status, signingUrl: 'https://gateway.test/#/x', mock: false, expiresAt: new Date('2026-10-07'), completedAt: null, files: { document: 'f1', signed: null, certificate: null }, label: 'Licence' });

beforeEach(() => {
  vi.clearAllMocks();
  ports.esignPolicy.mockResolvedValue({ enabled: true, publisherLicenceAt: 'FIRST_APPROVED_LISTING' });
  repos.campaignForInsertionOrder.mockResolvedValue({ id: 'cmp_1', advertiserId: 'adv_1', spots: [{ lineTotal: '60000' }, { lineTotal: '45000.50' }] });
  repos.partySigner.mockResolvedValue({ band: 'SMALL_AGENCY' });
});

describe('the publisher licence', () => {
  it('is asked for at the moment the policy names, and never at the other', async () => {
    service.openSigningRequest.mockResolvedValue({ request: { id: 'sig_1' }, created: true });
    expect(await requestPublisherLicence('pub_1', 'FIRST_SUBMISSION', 'usr_1')).toEqual({ opened: false, requestId: null });
    expect(service.openSigningRequest).not.toHaveBeenCalled();
    expect(await requestPublisherLicence('pub_1', 'FIRST_APPROVED_LISTING')).toEqual({ opened: true, requestId: 'sig_1' });
    expect(service.openSigningRequest).toHaveBeenCalledWith({ kind: 'PUBLISHER_LICENCE', partyType: 'PUBLISHER', partyId: 'pub_1', requestedById: null });
  });

  it('never throws: the policy not asking and a rail that cannot answer both read as "not opened"', async () => {
    service.openSigningRequest.mockRejectedValueOnce(new ApiError(409, 'SIGNING_NOT_OPEN', 'off'));
    expect(await requestPublisherLicence('pub_1', 'FIRST_APPROVED_LISTING')).toEqual({ opened: false, requestId: null });
    service.openSigningRequest.mockRejectedValueOnce(new Error('down'));
    expect(await requestPublisherLicence('pub_1', 'FIRST_APPROVED_LISTING')).toEqual({ opened: false, requestId: null });
  });

  it('holds the next attempt once asked for and unsigned; a publisher never asked passes', async () => {
    service.signingStanding.mockResolvedValueOnce({ required: true, satisfied: false, status: null, request: null });
    await expect(assertPublisherLicenceSigned('pub_1')).resolves.toBeUndefined();
    service.signingStanding.mockResolvedValueOnce({ required: true, satisfied: false, status: 'REQUESTED', request: request('REQUESTED') });
    await expect(assertPublisherLicenceSigned('pub_1')).rejects.toMatchObject({ statusCode: 403, code: 'SIGNATURE_REQUIRED', details: { signing: expect.objectContaining({ id: 'sig_1' }), kind: 'PUBLISHER_LICENCE' } });
    service.signingStanding.mockResolvedValueOnce({ required: true, satisfied: true, status: 'COMPLETED', request: request('COMPLETED') });
    await expect(assertPublisherLicenceSigned('pub_1')).resolves.toBeUndefined();
  });
});

describe('the insertion order', () => {
  it('reads the threshold off the media value and the band off the advertiser', async () => {
    expect(await insertionOrderSigningContext('cmp_1')).toEqual({ advertiserId: 'adv_1', campaignTotal: 105000.5, band: 'SMALL_AGENCY' });
    repos.campaignForInsertionOrder.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await insertionOrderSigningContext('cmp_none')).toBeNull();
    expect(await insertionOrderSigning('cmp_none')).toEqual({ required: false, satisfied: true, request: null });
  });

  it('asks the standing with the campaign as the anchor and the context', async () => {
    service.signingStanding.mockResolvedValueOnce({ required: true, satisfied: false, status: 'REQUESTED', request: request('REQUESTED') });
    expect(await insertionOrderSigning('cmp_1')).toEqual({ required: true, satisfied: false, request: request('REQUESTED') });
    expect(service.signingStanding).toHaveBeenCalledWith('ADVERTISER', 'adv_1', 'INSERTION_ORDER', { campaignId: 'cmp_1' }, { advertiserId: 'adv_1', campaignTotal: 105000.5, band: 'SMALL_AGENCY' });
  });

  it('the accept route forks to a signature when the policy asks, and to nothing when it does not or the campaign is not theirs', async () => {
    service.signingRequired.mockResolvedValueOnce(false);
    expect(await openInsertionOrderSigning('cmp_1', 'adv_1', 'usr_1')).toBeNull();
    expect(await openInsertionOrderSigning('cmp_1', 'adv_other', 'usr_1')).toBeNull();
    service.signingRequired.mockResolvedValueOnce(true);
    service.openSigningRequest.mockResolvedValueOnce({ request: request('REQUESTED'), created: true });
    expect(await openInsertionOrderSigning('cmp_1', 'adv_1', 'usr_1')).toMatchObject({ id: 'sig_1' });
    expect(service.openSigningRequest).toHaveBeenCalledWith({ kind: 'INSERTION_ORDER', partyType: 'ADVERTISER', partyId: 'adv_1', requestedById: 'usr_1', anchor: { campaignId: 'cmp_1' }, context: { advertiserId: 'adv_1', campaignTotal: 105000.5, band: 'SMALL_AGENCY' } });
  });
});

describe('the slice', () => {
  it('opens the link only while the request is open, and reads nothing as nothing', () => {
    expect(signingSlice({ kind: 'PUBLISHER_LICENCE', required: true, satisfied: false, status: 'REQUESTED', currentVersion: 1, request: request('REQUESTED') } as never)).toMatchObject({ required: true, satisfied: false, requestId: 'sig_1', signingUrl: 'https://gateway.test/#/x', label: 'Licence' });
    expect(signingSlice({ kind: 'PUBLISHER_LICENCE', required: true, satisfied: false, status: 'EXPIRED', currentVersion: 1, request: request('EXPIRED') } as never)).toMatchObject({ signingUrl: null, status: 'EXPIRED' });
    expect(signingSlice(null)).toMatchObject({ required: false, satisfied: true, requestId: null, signingUrl: null });
  });
});

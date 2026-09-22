import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DS-1 (Digio eSign, 22 Sep 2026): the signing rail beside the click.
 *
 * What is held onto: the policy decides whether a document is signed at
 * all (off by default — nothing changes), and for an insertion order the
 * threshold and the band decide; opening a request renders the live
 * template with the party's fields, keeps the PDF, hands the provider the
 * signer sequence and records the gateway page; a second open returns the
 * open request, and a completed one stands until the policy demands a
 * re-sign on a new version; the provider's word moves the request, and
 * completion stores the signed copy, writes the DIGIO acceptance for the
 * parties that have one, runs the owning module's hook and tells the
 * signer; the mock door signs only a mock; a gate's refusal carries the
 * request.
 */

const { state, esignRepo, agreementsRepo, adapter, uploads, ports } = vi.hoisted(() => {
  type Row = Record<string, any>;
  const state = {
    requests: [] as Row[],
    templates: [] as Row[],
    acceptances: [] as Row[],
    files: [] as Row[],
    messages: [] as Row[],
    seq: 0,
    policy: {} as Row,
    signer: null as Row | null,
    providerDoc: null as Row | null,
    reset() {
      this.requests = [];
      this.templates = [];
      this.acceptances = [];
      this.files = [];
      this.messages = [];
      this.seq = 0;
      this.signer = null;
      this.providerDoc = null;
      this.policy = {
        enabled: true,
        signMethod: 'AADHAAR',
        expireInDays: 15,
        countersign: false,
        notifyThroughDigio: true,
        documents: { AGENT_ENGAGEMENT: true, EMPLOYEE_APPOINTMENT: true, PRINT_PARTNER_SERVICE: true, PUBLISHER_LICENCE: true, INSERTION_ORDER: true },
        insertionOrder: { valueThreshold: 100000, bands: ['LARGE_AGENCY'] },
        publisherLicenceAt: 'FIRST_APPROVED_LISTING',
        resignOnNewVersion: false,
        stampDuty: [],
      };
    },
  };
  const withTemplate = (row: Row) => ({ ...row, template: { title: state.templates.find((t) => t.id === row.templateId)?.title ?? 'T', version: row.templateVersion } });
  const esignRepo = {
    create: vi.fn(async (data: Row) => {
      const row = { id: `sig_${++state.seq}`, requestedAt: new Date(), completedAt: null, cancelledAt: null, cancelReason: null, failureReason: null, lastReminderAt: null, signedFileId: null, certificateFileId: null, acceptanceId: null, ...data };
      state.requests.push(row);
      return withTemplate(row);
    }),
    patch: vi.fn(async (id: string, patch: Row) => {
      const row = state.requests.find((r) => r.id === id)!;
      Object.assign(row, patch);
      return withTemplate(row);
    }),
    find: vi.fn(async (id: string) => {
      const row = state.requests.find((r) => r.id === id);
      return row ? withTemplate(row) : null;
    }),
    findByProviderRef: vi.fn(async (ref: string) => {
      const row = state.requests.find((r) => r.providerRef === ref);
      return row ? withTemplate(row) : null;
    }),
    latestFor: vi.fn(async (partyType: string, partyId: string, kind: string, anchor?: Row) => {
      const rows = state.requests.filter((r) => r.partyType === partyType && r.partyId === partyId && r.kind === kind && (!anchor?.campaignId || r.campaignId === anchor.campaignId));
      const row = rows[rows.length - 1];
      return row ? withTemplate(row) : null;
    }),
    list: vi.fn(async () => ({ rows: state.requests.map(withTemplate), nextCursor: null })),
    listForUser: vi.fn(async (userId: string) => state.requests.filter((r) => r.signerUserId === userId).map(withTemplate)),
    expiredOpen: vi.fn(async (now: Date) => state.requests.filter((r) => ['REQUESTED', 'PARTIALLY_SIGNED'].includes(r.status) && r.expiresAt < now).map(withTemplate)),
    partySigner: vi.fn(async () => state.signer),
    partiesOfUser: vi.fn(async (userId: string) => (state.signer?.signerUserId === userId ? [{ partyType: state.signer.partyType, partyId: state.signer.partyId }] : [])),
    publisherListings: vi.fn(async () => [{ reference: 'LST-1', title: 'MG Road wall', city: 'Bengaluru' }]),
  };
  const agreementsRepo = {
    activeTemplate: vi.fn(async (kind: string) => state.templates.find((t) => t.kind === kind && t.isActive) ?? null),
    findPlatformAcceptance: vi.fn(async (kind: string, party: Row) => state.acceptances.find((a) => a.templateKind === kind && Object.entries(party).every(([k, v]) => a[k] === v) && !a.campaignId) ?? null),
    findAnchoredAcceptance: vi.fn(async (kind: string, anchor: Row) => state.acceptances.find((a) => a.templateKind === kind && a.campaignId === anchor.campaignId) ?? null),
    createAcceptance: vi.fn(async (data: Row) => {
      const row = { id: `acc_${++state.seq}`, ...data };
      state.acceptances.push(row);
      return row;
    }),
    markAcceptanceSigned: vi.fn(async (id: string, ref: string) => {
      const row = state.acceptances.find((a) => a.id === id)!;
      Object.assign(row, { signatureProvider: 'DIGIO', signatureRef: ref });
      return row;
    }),
    campaignForInsertionOrder: vi.fn(async (id: string) => ({
      id,
      reference: 'CMP-2209-2601',
      name: 'Autumn launch',
      advertiserId: 'adv_1',
      advertiserName: 'Bright Dental',
      startDate: new Date('2026-10-01'),
      endDate: new Date('2026-10-30'),
      spots: [{ id: 's1', title: 'MG Road wall', city: 'Bengaluru', ratePerDay: '5000', days: 30, quantity: 1, lineTotal: '150000' }],
    })),
  };
  const adapter = {
    createEsignRequest: vi.fn(async (input: Row) => ({
      id: state.providerDoc?.id ?? `DID_${input.referenceId}`,
      status: 'requested',
      signers: input.signers.map((s: Row) => ({ identifier: s.identifier, name: s.name, status: 'requested', signedAt: null, signType: s.signType })),
      signingUrls: Object.fromEntries(input.signers.map((s: Row) => [s.identifier, `https://gateway.test/#/login/${s.identifier}`])),
      stampRef: null,
      mock: Boolean(state.providerDoc?.mock),
      raw: { from: 'adapter' },
    })),
    fetchEsignDocument: vi.fn(async () => state.providerDoc),
    downloadSignedPdf: vi.fn(async () => Buffer.from('%PDF-signed')),
    downloadAuditCertificate: vi.fn(async () => null),
    cancelEsignRequest: vi.fn(async () => undefined),
    remindEsignSigners: vi.fn(async () => undefined),
    parseEsignWebhook: vi.fn((body: Row) => (body?.payload?.document ? { event: body.event ?? null, document: body.payload.document } : null)),
  };
  const uploads = {
    storeGeneratedFile: vi.fn(async (_userId: string, input: Row) => {
      const row = { id: `file_${++state.seq}`, purpose: input.purpose, filename: input.filename, size: input.content.length };
      state.files.push(row);
      return row;
    }),
  };
  const ports = {
    policy: vi.fn(async () => state.policy),
    send: vi.fn(async (message: Row) => {
      state.messages.push(message);
    }),
    wire: vi.fn(async () => ({ clientId: 'x', clientSecret: 'y', apiUrl: 'https://api.test', gatewayUrl: 'https://gateway.test', adxSignerName: 'ADX', adxSignerIdentifier: 'legal@adx.in' })),
  };
  return { state, esignRepo, agreementsRepo, adapter, uploads, ports };
});

vi.mock('../esign/prisma-esign.repository', () => ({ prismaEsignRepository: esignRepo }));
vi.mock('../prisma-agreements.repository', () => ({ prismaAgreementsRepository: agreementsRepo }));
vi.mock('../../../shared/integrations/digio-esign', () => adapter);
vi.mock('../../../shared/integrations/integration-config', () => ({ getEffectiveEsignConfig: ports.wire }));
vi.mock('../../uploads', () => uploads);
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn(async () => undefined) }));

import { onSigningCompleted, registerEsignNotifyPort, registerEsignPolicyPort, resetSigningHooks } from '../esign/esign.ports';
import { applyProviderDocument, assertSigned, expireSigningRequests, handleEsignWebhook, mockSign, openSigningRequest, refreshSigningRequest, signingRequired, signingStanding, voidSigning } from '../esign/esign.service';
import { mergeFields, renderAgreementPdf, renderListingSchedule } from '../esign/esign.render';

const template = (kind: string, over: Record<string, unknown> = {}) => ({
  id: `tpl_${kind}`,
  kind,
  version: 2,
  title: `${kind} terms`,
  body: `# ${kind}\n\nBetween ADX and {{party.name}} ({{party.displayId}}), signed on {{date}}.\n\n- Grade: {{agent.grade}}\n- Reference {{reference}}\n\n{{listings}}\n\n{{spots}}`,
  isActive: true,
  requiresReacceptance: false,
  ...over,
});

const agentSigner = () => ({
  partyType: 'AGENT',
  partyId: 'agt_1',
  displayId: 'AGT-2209-2601',
  partyName: 'Rahul Menon',
  signerName: 'Rahul Menon',
  signerUserId: 'usr_agent',
  email: 'Rahul@Example.in',
  mobile: '+919000000301',
  state: 'Karnataka',
  city: 'Bengaluru',
  band: null,
  fields: { 'agent.grade': 'Grade 2 — Senior field', 'agent.side': 'Field agent' },
});

beforeEach(() => {
  vi.clearAllMocks();
  state.reset();
  resetSigningHooks();
  registerEsignPolicyPort({ current: ports.policy as never });
  registerEsignNotifyPort({ send: ports.send });
  state.templates = [template('AGENT_PUBLISHER_PLATFORM'), template('INSERTION_ORDER'), template('PUBLISHER_LICENCE')];
  state.signer = agentSigner();
});

describe('the policy', () => {
  it('asks for nothing while switched off, and only for the documents switched on', async () => {
    state.policy.enabled = false;
    expect(await signingRequired('AGENT_PUBLISHER_PLATFORM')).toBe(false);
    state.policy.enabled = true;
    expect(await signingRequired('AGENT_PUBLISHER_PLATFORM')).toBe(true);
    state.policy.documents.AGENT_ENGAGEMENT = false;
    expect(await signingRequired('AGENT_PUBLISHER_PLATFORM')).toBe(false);
    // A kind that is never signed.
    expect(await signingRequired('JOB_TERMS')).toBe(false);
  });

  it('signs an insertion order above the threshold or for a listed band, and clicks the rest', async () => {
    expect(await signingRequired('INSERTION_ORDER', { campaignTotal: '99999.99', band: 'INDIVIDUAL' })).toBe(false);
    expect(await signingRequired('INSERTION_ORDER', { campaignTotal: 100000, band: 'INDIVIDUAL' })).toBe(true);
    expect(await signingRequired('INSERTION_ORDER', { campaignTotal: 5000, band: 'LARGE_AGENCY' })).toBe(true);
  });

  it('refuses to open what the policy does not ask for, unless the desk forces it', async () => {
    state.policy.enabled = false;
    await expect(openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1' })).rejects.toMatchObject({ code: 'SIGNING_NOT_OPEN' });
    const { created } = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin', force: true });
    expect(created).toBe(true);
  });
});

describe('opening a request', () => {
  it('renders the live template with the party in it, keeps the PDF, hands the provider the signer and records the gateway page', async () => {
    const { request, created } = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    expect(created).toBe(true);
    expect(request.status).toBe('REQUESTED');
    expect(request.templateVersion).toBe(2);
    expect(request.signerIdentifier).toBe('rahul@example.in');
    expect(request.renderedDocument).toContain('Between ADX and Rahul Menon (AGT-2209-2601)');
    expect(request.renderedDocument).toContain('Grade: Grade 2 — Senior field');
    expect(request.renderedDocument).not.toContain('{{');
    expect(request.signingUrl).toBe('https://gateway.test/#/login/rahul@example.in');
    expect(request.documentFileId).toBe(state.files[0]!.id);
    expect(state.files[0]).toMatchObject({ purpose: 'SIGNED_AGREEMENT' });
    expect(adapter.createEsignRequest).toHaveBeenCalledWith(expect.objectContaining({ signers: [expect.objectContaining({ identifier: 'rahul@example.in', signType: 'aadhaar' })], expireInDays: 15, sequential: false }));
    expect(state.messages).toEqual([expect.objectContaining({ event: 'AGREEMENT_SIGNATURE_REQUESTED', deepLink: `adx://sign/${request.id}` })]);
  });

  it('is idempotent on an open request, and a completed one stands until a new version demands a re-sign', async () => {
    const first = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    const again = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    expect(again.created).toBe(false);
    expect(again.request.id).toBe(first.request.id);
    expect(adapter.createEsignRequest).toHaveBeenCalledTimes(1);

    await mockSignAs(first.request.id);
    // A new version live, re-signing not enforced: the signed one stands.
    state.templates = [template('AGENT_PUBLISHER_PLATFORM', { id: 'tpl_v3', version: 3 })];
    const standing = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    expect(standing.created).toBe(false);
    expect(standing.request.status).toBe('COMPLETED');
    // Enforced: a fresh request on version 3.
    state.policy.resignOnNewVersion = true;
    const fresh = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    expect(fresh.created).toBe(true);
    expect(fresh.request.templateVersion).toBe(3);
  });

  it('is 503 with no live template, and refuses a party the kind does not bind', async () => {
    state.templates = [];
    await expect(openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' })).rejects.toMatchObject({ statusCode: 503, code: 'NO_ACTIVE_TEMPLATE' });
    await expect(openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'PUBLISHER', partyId: 'pub_1', requestedById: 'usr_admin' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('enumerates the insertion order per campaign and the licence schedule, and adds ADX as the countersigner when the policy says so', async () => {
    state.signer = { ...agentSigner(), partyType: 'ADVERTISER', partyId: 'adv_1', partyName: 'Bright Dental', band: 'LARGE_AGENCY', email: null };
    state.policy.countersign = true;
    const { request } = await openSigningRequest({ kind: 'INSERTION_ORDER', partyType: 'ADVERTISER', partyId: 'adv_1', requestedById: 'usr_admin', anchor: { campaignId: 'cmp_1' }, context: { band: 'LARGE_AGENCY' } });
    expect(request.signerIdentifier).toBe('9000000301');
    expect(request.campaignId).toBe('cmp_1');
    expect(request.renderedDocument).toContain('Campaign CMP-2209-2601 — Autumn launch');
    expect(request.renderedDocument).toContain('MG Road wall, Bengaluru — ₹5000/day × 30 days × 1 = ₹150000');
    expect(request.countersign).toBe(true);
    expect(request.signers).toEqual([expect.objectContaining({ role: 'PARTY', identifier: '9000000301' }), expect.objectContaining({ role: 'ADX', identifier: 'legal@adx.in' })]);
    expect(adapter.createEsignRequest).toHaveBeenCalledWith(expect.objectContaining({ sequential: true, signers: [expect.objectContaining({ signType: 'aadhaar' }), expect.objectContaining({ signType: 'dsc' })] }));

    state.signer = { ...agentSigner(), partyType: 'PUBLISHER', partyId: 'pub_1', partyName: 'Skyline Outdoor Media' };
    const licence = await openSigningRequest({ kind: 'PUBLISHER_LICENCE', partyType: 'PUBLISHER', partyId: 'pub_1', requestedById: 'usr_admin' });
    expect(licence.request.renderedDocument).toContain('Schedule A — the spaces licensed');
    expect(licence.request.renderedDocument).toContain('1. LST-1 — MG Road wall, Bengaluru');
  });

  it('buys the e-stamp the table names for the party’s state', async () => {
    state.policy.stampDuty = [{ document: 'AGENT_ENGAGEMENT', state: 'KA', amount: 100 }];
    const { request } = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    expect(request.stampState).toBe('KA');
    expect(request.stampAmount).toBe('100');
    expect(adapter.createEsignRequest).toHaveBeenCalledWith(expect.objectContaining({ stamp: expect.objectContaining({ state: 'KA', amount: 100, secondParty: 'Rahul Menon' }) }));
  });
});

async function mockSignAs(id: string) {
  const row = state.requests.find((r) => r.id === id)!;
  row.mock = true;
  return mockSign(id, 'usr_agent');
}

describe('the provider’s word', () => {
  it('completion stores the signed copy, writes the DIGIO acceptance, runs the hook and tells the signer', async () => {
    const hook = vi.fn(async () => undefined);
    onSigningCompleted('AGENT_PUBLISHER_PLATFORM', hook);
    const { request } = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    state.messages = [];

    const done = await applyProviderDocument(request, { id: request.providerRef!, status: 'completed', signers: [{ identifier: 'rahul@example.in', name: 'Rahul Menon', status: 'signed', signedAt: '2026-09-22T10:00:00.000Z', signType: 'aadhaar' }], signingUrls: {}, stampRef: null, mock: false, raw: { agreement_status: 'completed' } }, 'webhook');
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).toBeInstanceOf(Date);
    expect(done.signedFileId).toBe(state.files[1]!.id);
    expect(state.files[1]).toMatchObject({ filename: `${request.providerRef}-signed.pdf` });
    expect(done.signers).toEqual([expect.objectContaining({ role: 'PARTY', status: 'signed', signedAt: '2026-09-22T10:00:00.000Z' })]);
    expect(state.acceptances).toEqual([expect.objectContaining({ templateKind: 'AGENT_PUBLISHER_PLATFORM', agentId: 'agt_1', acceptedByUserId: 'usr_agent', signatureProvider: 'DIGIO', signatureRef: request.id, templateVersion: 2 })]);
    expect(done.acceptanceId).toBe(state.acceptances[0]!.id);
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ id: request.id, status: 'COMPLETED' }));
    expect(state.messages).toEqual([expect.objectContaining({ event: 'AGREEMENT_SIGNED' })]);
  });

  it('upgrades the click on the same version to the signature rather than writing a second row', async () => {
    state.acceptances.push({ id: 'acc_click', templateKind: 'AGENT_PUBLISHER_PLATFORM', templateId: 'tpl_AGENT_PUBLISHER_PLATFORM', agentId: 'agt_1', templateVersion: 2, signatureProvider: 'NONE' });
    const { request } = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    await applyProviderDocument(request, { id: request.providerRef!, status: 'completed', signers: [], signingUrls: {}, stampRef: null, mock: false, raw: {} }, 'refresh');
    expect(state.acceptances).toHaveLength(1);
    expect(state.acceptances[0]).toMatchObject({ signatureProvider: 'DIGIO', signatureRef: request.id });
  });

  it('an expiry closes the request and tells the signer; a closed request is left alone', async () => {
    const { request } = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    state.messages = [];
    const expired = await applyProviderDocument(request, { id: request.providerRef!, status: 'expired', signers: [], signingUrls: {}, stampRef: null, mock: false, raw: {} }, 'webhook');
    expect(expired.status).toBe('EXPIRED');
    expect(state.messages).toEqual([expect.objectContaining({ event: 'AGREEMENT_SIGNATURE_EXPIRED' })]);
    const again = await applyProviderDocument(expired, { id: request.providerRef!, status: 'completed', signers: [], signingUrls: {}, stampRef: null, mock: false, raw: {} }, 'webhook');
    expect(again.status).toBe('EXPIRED');
    expect(state.acceptances).toHaveLength(0);
  });

  it('the webhook routes by document id, and an unknown one is not an error', async () => {
    const { request } = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    expect(await handleEsignWebhook({ event: 'doc.signed', payload: { document: { id: 'DID_nobody', status: 'completed', signers: [], signingUrls: {}, stampRef: null, mock: false, raw: {} } } })).toEqual({ matched: false });
    expect(await handleEsignWebhook({ nothing: true })).toEqual({ matched: false });
    expect(await handleEsignWebhook({ event: 'doc.signed', payload: { document: { id: request.providerRef, status: 'completed', signers: [], signingUrls: {}, stampRef: null, mock: false, raw: {} } } })).toEqual({ matched: true });
    expect(state.requests[0]!.status).toBe('COMPLETED');
  });

  it('a refresh asks the provider, and a mock answers itself', async () => {
    const { request } = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    state.providerDoc = { id: request.providerRef, status: 'partially_signed', signers: [], signingUrls: {}, stampRef: null, mock: false, raw: {} };
    const refreshed = await refreshSigningRequest(request.id);
    expect(refreshed.status).toBe('PARTIALLY_SIGNED');
    expect(adapter.fetchEsignDocument).toHaveBeenCalledWith(request.providerRef);
    state.requests[0]!.mock = true;
    await refreshSigningRequest(request.id);
    expect(adapter.fetchEsignDocument).toHaveBeenCalledTimes(1);
  });

  it('the sweep expires what is past its date', async () => {
    const { request } = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    expect(await expireSigningRequests(new Date())).toEqual({ expired: 0 });
    expect(await expireSigningRequests(new Date(Date.now() + 16 * 24 * 60 * 60 * 1000))).toEqual({ expired: 1 });
    expect(state.requests.find((r) => r.id === request.id)!.status).toBe('EXPIRED');
  });
});

describe('the doors', () => {
  it('the mock door signs a mock and refuses a real request', async () => {
    const { request } = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    await expect(mockSign(request.id, 'usr_agent')).rejects.toMatchObject({ code: 'SIGNING_NOT_OPEN' });
    const signed = await mockSignAs(request.id);
    expect(signed.status).toBe('COMPLETED');
    // A mock has no signed copy from the provider: the rendered document stands.
    expect(signed.signedFileId).toBe(request.documentFileId);
    expect(adapter.downloadSignedPdf).not.toHaveBeenCalled();
  });

  it('a void cancels at the provider and closes the request; a second void is refused', async () => {
    const { request } = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    const voided = await voidSigning(request.id, 'Wrong grade on the letter', 'usr_admin');
    expect(voided.status).toBe('CANCELLED');
    expect(voided.cancelReason).toBe('Wrong grade on the letter');
    expect(adapter.cancelEsignRequest).toHaveBeenCalledWith(request.providerRef, 'Wrong grade on the letter');
    await expect(voidSigning(request.id, 'again', 'usr_admin')).rejects.toMatchObject({ code: 'SIGNING_NOT_OPEN' });
  });

  it('a gate reads the standing, and its refusal carries the open request', async () => {
    const before = await signingStanding('AGENT', 'agt_1', 'AGENT_PUBLISHER_PLATFORM');
    expect(before).toMatchObject({ required: true, satisfied: false, status: null, request: null, currentVersion: 2 });
    expect(() => assertSigned(before, 'Working')).toThrow(expect.objectContaining({ statusCode: 403, code: 'SIGNATURE_REQUIRED' }));

    const { request } = await openSigningRequest({ kind: 'AGENT_PUBLISHER_PLATFORM', partyType: 'AGENT', partyId: 'agt_1', requestedById: 'usr_admin' });
    const open = await signingStanding('AGENT', 'agt_1', 'AGENT_PUBLISHER_PLATFORM');
    expect(open).toMatchObject({ satisfied: false, status: 'REQUESTED', request: expect.objectContaining({ id: request.id, signingUrl: request.signingUrl }) });
    try {
      assertSigned(open);
    } catch (cause) {
      expect((cause as { details: { signing: { id: string } } }).details.signing.id).toBe(request.id);
    }

    await mockSignAs(request.id);
    const after = await signingStanding('AGENT', 'agt_1', 'AGENT_PUBLISHER_PLATFORM');
    expect(after).toMatchObject({ satisfied: true, status: 'COMPLETED' });
    expect(() => assertSigned(after)).not.toThrow();

    state.policy.enabled = false;
    expect((await signingStanding('AGENT', 'agt_1', 'AGENT_PUBLISHER_PLATFORM')).required).toBe(false);
  });
});

describe('the paper', () => {
  it('merges fields, prints a dash for one the record lacks, and lays out the schedule', () => {
    expect(mergeFields('Hello {{party.name}}, {{ party.city }} — {{missing}}', { 'party.name': 'Asha', 'party.city': 'Pune' })).toBe('Hello Asha, Pune — —');
    expect(renderListingSchedule([])).toContain('no listings are on the platform yet');
    expect(renderListingSchedule([{ reference: null, title: 'Gate hoarding', city: null }])).toContain('1. Gate hoarding');
  });

  it('renders a PDF with the header, the body and a signature page', async () => {
    const pdf = await renderAgreementPdf(
      { title: 'Field agent engagement terms', kindLabel: 'Field agent engagement terms', version: 2, reference: 'ADX-SIGN-AGF-1', partyName: 'Rahul Menon', partyDisplayId: 'AGT-1', date: '22 Sep 2026', subtitle: null },
      '# Terms\n\nA paragraph with **bold** words.\n\n- one\n- two\n\n1. first\n2. second\n\n---\n\nThe end.',
      [{ role: 'PARTY', name: 'Rahul Menon' }, { role: 'ADX', name: 'ADX' }],
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1500);
  });
});

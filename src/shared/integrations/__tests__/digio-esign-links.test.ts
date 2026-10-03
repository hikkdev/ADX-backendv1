import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 30 Sep 2026, Digio's onboarding recording: asked with
 * `include_authentication_url`, each signing party on the upload's answer
 * carries its own `authentication_url` (`<host>/#/s/<code>`) — the link Digio
 * emails out. ADX hands that out; the self-built gateway page is the fallback.
 */
const { env, esignConfig } = vi.hoisted(() => ({
  env: { NODE_ENV: 'production', BASE_URL: 'https://adx-backendv1.onrender.com' } as Record<string, string>,
  esignConfig: { clientId: 'client', clientSecret: 'secret', apiUrl: 'https://api.digio.in', gatewayUrl: 'https://app.digio.in', adxSignerName: 'ADX', adxSignerIdentifier: '' },
}));
vi.mock('../../../config/env', () => ({ env }));
vi.mock('../integration-config', () => ({ getEffectiveEsignConfig: vi.fn(async () => esignConfig) }));

import { createEsignRequest, signingLinks, type DigioDocument } from '../digio-esign';

const upload = {
  referenceId: 'SIGN_ref_1',
  fileName: 'publisher-licence.pdf',
  pdf: Buffer.from('%PDF-1.4 test'),
  signers: [
    { identifier: 'Rahul@Example.in', name: 'Rahul Menon', reason: 'Publisher licence', signType: 'aadhaar' as const },
    { identifier: 'legal@adx.in', name: 'ADX', reason: 'Countersign', signType: 'aadhaar' as const },
  ],
  expireInDays: 15,
  sequential: true,
  notifySigners: true,
  displayOnPage: 'last' as const,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({
        id: 'DID2609301200',
        agreement_status: 'requested',
        access_token: { id: 'GWT_doc_1' },
        signing_parties: [
          { identifier: 'rahul@example.in', name: 'Rahul Menon', status: 'requested', signature_type: 'aadhaar', authentication_url: 'https://app.digio.in/#/s/DG0260930120001' },
          { identifier: 'legal@adx.in', name: 'ADX', status: 'requested', signature_type: 'aadhaar' },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a document sent to Digio for signing', () => {
  it("asks Digio for each signer's own link, on the multipart upload", async () => {
    await createEsignRequest(upload);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.digio.in/v2/client/document/upload');
    const form = init.body as FormData;
    const request = JSON.parse(String(form.get('request'))) as Record<string, unknown>;
    expect(request).toMatchObject({ include_authentication_url: true, generate_access_token: true, expire_in_days: 15, sequential: true, notify_signers: true, send_sign_link: true, reference_id: 'SIGN_ref_1' });
    expect(request.signers).toEqual([
      { identifier: 'Rahul@Example.in', name: 'Rahul Menon', reason: 'Publisher licence', sign_type: 'aadhaar' },
      { identifier: 'legal@adx.in', name: 'ADX', reason: 'Countersign', sign_type: 'aadhaar' },
    ]);
  });

  it("hands out Digio's own link where it gave one, matched without regard to case, and the gateway page otherwise", async () => {
    const doc = await createEsignRequest(upload);
    expect(doc.signingUrls['Rahul@Example.in']).toBe('https://app.digio.in/#/s/DG0260930120001');
    expect(doc.signingUrls['legal@adx.in']).toMatch(/^https:\/\/app\.digio\.in\/#\/gateway\/login\/DID2609301200\/[a-z0-9]+\/legal%40adx\.in\?token_id=GWT_doc_1$/);
  });
});

describe('signingLinks', () => {
  it('builds the gateway page without a token when Digio gave none', () => {
    const doc: DigioDocument = { id: 'DID1', signing_parties: [] };
    expect(signingLinks({ gatewayUrl: 'https://ext-gateway.digio.in/' }, doc, ['9000000001'])['9000000001']).toMatch(/^https:\/\/ext-gateway\.digio\.in\/#\/gateway\/login\/DID1\/[a-z0-9]+\/9000000001$/);
  });
});

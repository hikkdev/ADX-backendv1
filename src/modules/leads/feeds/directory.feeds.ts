import { ApiError } from '../../../shared/errors';
import { getEffectiveLeadFeedsConfig, type LeadFeedCredential } from '../../../shared/integrations';
import { logger } from '../../../shared/logging';
import type { FeedCandidate, FeedSearch, LeadFeed } from './feed.port';

/**
 * LH3 (D4): JustDial, IndiaMART, MCA, GST and RERA as adapters behind the
 * same port. None of these has a public area-search API a platform can
 * call without a contract: JustDial and IndiaMART sell data through
 * partner endpoints, MCA and GST directories are reached through licensed
 * data vendors, RERA is state portals. So each adapter is a credential
 * card (an endpoint, a key, the header it travels in) and answers
 * NOT_CONFIGURED until ops fills it and confirms the terms on the source.
 *
 * Once configured, every one of them speaks the same wire — a POST of
 * `{ category, city, side, limit, bbox? }` answered by `{ results: [{ id,
 * name, phone?, email?, address?, locality?, city?, lat?, lng? }] }` —
 * which is the shape ADX asks its data partner to serve (the README says
 * so, so the partner's integrator has the contract in one place). IndiaMART
 * is the exception: its seller CRM API is documented, and the adapter
 * reads it natively (buy leads are advertiser-side candidates).
 */

type DirectoryResult = { id?: string | number; name?: string; phone?: string; mobile?: string; email?: string; address?: string; locality?: string; city?: string; lat?: number; lng?: number; latitude?: number; longitude?: number; contact?: string };

function normalise(key: string, result: DirectoryResult, category: string): FeedCandidate | null {
  const id = result.id !== undefined ? String(result.id) : null;
  const name = result.name?.trim();
  if (!id || !name) return null;
  return {
    externalKey: `${key}:${id}`,
    businessName: name,
    category,
    contactName: result.contact ?? null,
    phone: result.phone ?? result.mobile ?? null,
    email: result.email ?? null,
    address: result.address ?? null,
    locality: result.locality ?? null,
    city: result.city ?? null,
    latitude: result.lat ?? result.latitude ?? null,
    longitude: result.lng ?? result.longitude ?? null,
  };
}

async function callPartner(key: string, label: string, credential: LeadFeedCredential, input: FeedSearch): Promise<FeedCandidate[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (credential.apiKey) headers[credential.headerName || 'X-Api-Key'] = credential.apiKey;
  let response: Response;
  try {
    response = await fetch(credential.endpoint!, {
      method: 'POST',
      headers,
      body: JSON.stringify({ category: input.category, city: input.city ?? null, side: input.side, limit: input.limit, polygon: input.polygon ?? null }),
    });
  } catch (cause) {
    logger.error(`${label} unreachable`, { err: cause });
    throw new ApiError(502, 'INTERNAL_ERROR', `${label} could not be reached.`);
  }
  if (response.status === 401 || response.status === 403) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', `${label} refused the credentials.`);
  if (response.status === 429) throw new ApiError(429, 'TOO_MANY_REQUESTS', `${label} quota exhausted for now.`);
  if (!response.ok) throw new ApiError(502, 'INTERNAL_ERROR', `${label} answered HTTP ${response.status}.`);
  const payload = (await response.json()) as { results?: DirectoryResult[] };
  return (payload.results ?? [])
    .map((row) => normalise(key, row, input.category))
    .filter((row): row is FeedCandidate => row !== null)
    .slice(0, input.limit);
}

function partnerFeed(key: 'justdial' | 'mca' | 'gst' | 'rera', label: string, needs: string): LeadFeed {
  return {
    key,
    label,
    needs,
    async configured() {
      const credential = (await getEffectiveLeadFeedsConfig())[key];
      if (!credential?.endpoint) return { ok: false, reason: `${label} is not configured: no partner endpoint is set.` };
      return { ok: true };
    },
    async search(input) {
      const credential = (await getEffectiveLeadFeedsConfig())[key];
      if (!credential?.endpoint) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', `${label} is not configured: no partner endpoint is set.`);
      return callPartner(key, label, credential, input);
    },
  };
}

export const justdialFeed = partnerFeed('justdial', 'JustDial', 'A JustDial data-partner endpoint and API key (JustDial sells business data through partners; scraping its site is against its terms).');
export const mcaFeed = partnerFeed('mca', 'MCA company directory', 'A licensed MCA data vendor endpoint and key (the ministry publishes no search API).');
export const gstFeed = partnerFeed('gst', 'GST directory', 'A GSP / GST data vendor endpoint and key (GSTN search needs a GSP contract).');
export const reraFeed = partnerFeed('rera', 'RERA projects', 'A RERA data vendor endpoint and key (state portals carry no API; projects are advertiser-side leads).');

/**
 * IndiaMART's seller CRM listing API — the buy leads the ADX seller
 * account received, each an advertiser-side prospect. Documented at
 * https://seller.indiamart.com (CRM key from the seller dashboard).
 */
const INDIAMART_URL = 'https://mapi.indiamart.com/wservce/crm/crmListing/v2/';

type IndiamartLead = { UNIQUE_QUERY_ID?: string; SENDER_NAME?: string; SENDER_MOBILE?: string; SENDER_EMAIL?: string; SENDER_COMPANY?: string; SENDER_ADDRESS?: string; SENDER_CITY?: string; SENDER_STATE?: string; QUERY_PRODUCT_NAME?: string; QUERY_MESSAGE?: string; QUERY_TIME?: string };

export const indiamartFeed: LeadFeed = {
  key: 'indiamart',
  label: 'IndiaMART',
  needs: 'The CRM key of the ADX seller account (Seller dashboard › Lead Manager › CRM API).',
  async configured() {
    const credential = (await getEffectiveLeadFeedsConfig()).indiamart;
    return credential?.apiKey ? { ok: true } : { ok: false, reason: 'IndiaMART is not configured: no CRM key is set.' };
  },
  async search(input) {
    const credential = (await getEffectiveLeadFeedsConfig()).indiamart;
    if (!credential?.apiKey) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'IndiaMART is not configured: no CRM key is set.');
    const url = new URL(credential.endpoint || INDIAMART_URL);
    url.searchParams.set('glusr_crm_key', credential.apiKey);
    // The last seven days of enquiries; IndiaMART's own window cap.
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const stamp = (d: Date) => `${String(d.getDate()).padStart(2, '0')}-${d.toLocaleString('en-GB', { month: 'short' })}-${d.getFullYear()}`;
    url.searchParams.set('start_time', stamp(start));
    url.searchParams.set('end_time', stamp(end));
    let response: Response;
    try {
      response = await fetch(url.toString());
    } catch (cause) {
      logger.error('IndiaMART unreachable', { err: cause });
      throw new ApiError(502, 'INTERNAL_ERROR', 'IndiaMART could not be reached.');
    }
    if (response.status === 401 || response.status === 403) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'IndiaMART refused the CRM key.');
    if (response.status === 429) throw new ApiError(429, 'TOO_MANY_REQUESTS', 'IndiaMART quota exhausted for now.');
    if (!response.ok) throw new ApiError(502, 'INTERNAL_ERROR', `IndiaMART answered HTTP ${response.status}.`);
    const payload = (await response.json()) as { RESPONSE?: IndiamartLead[]; CODE?: number; MESSAGE?: string };
    if (payload.CODE && payload.CODE !== 200) throw new ApiError(502, 'INTERNAL_ERROR', `IndiaMART: ${payload.MESSAGE ?? `code ${payload.CODE}`}`);
    const wanted = input.city?.trim().toLowerCase();
    return (payload.RESPONSE ?? [])
      .filter((row) => !wanted || (row.SENDER_CITY ?? '').toLowerCase().includes(wanted))
      .slice(0, input.limit)
      .map<FeedCandidate>((row) => ({
        externalKey: `indiamart:${row.UNIQUE_QUERY_ID ?? `${row.SENDER_MOBILE}-${row.QUERY_TIME}`}`,
        businessName: row.SENDER_COMPANY?.trim() || row.SENDER_NAME?.trim() || 'IndiaMART enquiry',
        category: input.category,
        contactName: row.SENDER_NAME ?? null,
        phone: row.SENDER_MOBILE ?? null,
        email: row.SENDER_EMAIL ?? null,
        address: row.SENDER_ADDRESS ?? null,
        city: row.SENDER_CITY ?? null,
        extra: { product: row.QUERY_PRODUCT_NAME ?? null, message: row.QUERY_MESSAGE ?? null, state: row.SENDER_STATE ?? null },
      }));
  },
};

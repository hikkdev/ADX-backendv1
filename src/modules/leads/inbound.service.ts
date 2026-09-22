import { createHmac, timingSafeEqual } from 'crypto';
import { ApiError } from '../../shared/errors';
import { getEffectiveLeadFormsConfig } from '../../shared/integrations';
import { logger } from '../../shared/logging';
import { allocateIdentifier } from '../identifiers';
import { withCityKey } from '../pricing';
import { getQrById } from '../qr';
import { prismaLeadsRepository as repository } from './prisma-leads.repository';
import { getLead, resolveSource } from './leads.service';
import { normalisePhone } from './leads.phone';
import { isLeadChannel, recordInbound } from './conversations.service';
import { recomputeLead } from './scoring.service';
import { routeLead } from './routing.service';
import { advanceStage, stampMoment } from './stages.service';

/**
 * LH3: the inbound doors — a business coming to ADX on its own. The
 * website form, the SITE QR poster's one-field form, the agent's referral
 * card, a referral link, and the lead-form ad webhooks (Meta, Google Ads,
 * LinkedIn). Every one of them starts warm (the score's INBOUND signal),
 * is routed to the nearest agent of the side with room, and answers the
 * lead it already has for a repeat number rather than a second row.
 *
 * The public doors are unauthenticated writes, so they are narrow: a
 * side, a business, a phone, a city, a sentence. The webhooks are signed
 * by their providers and idempotent by the provider's own lead id.
 */

export type InboundInput = {
  side: 'PUBLISHER' | 'ADVERTISER';
  businessName: string;
  contactName?: string | undefined;
  phone: string;
  email?: string | undefined;
  city?: string | undefined;
  locality?: string | undefined;
  address?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  category?: string | undefined;
  message?: string | undefined;
  /** D14: the channel the door is — WEB is a LINK-ish door, a poster IN_PERSON, an ad the provider's name. */
  channel: string;
};

export type InboundAnswer = { leadId: string; displayId: string | null; created: boolean; assignedAgentId: string | null };

const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/**
 * The one create every door uses. A number already on a lead answers that
 * lead with the ask noted on its thread; a number on a publisher or
 * advertiser account is not a prospect and is refused with a sentence the
 * page can print ("You already have an ADX account — sign in").
 */
/** LH6: the door's channel as a thread channel — an ad form, the website, a poster; the enum value when the door names one. */
function threadChannelOf(channel: string): 'SMS' | 'EMAIL' | 'WHATSAPP' | 'INSTAGRAM' | 'MESSENGER' | 'GOOGLE_BUSINESS' | 'CALL' | 'LINKEDIN' | 'IN_PERSON' | 'OTHER' {
  return isLeadChannel(channel) ? channel : channel === 'META_ADS' || channel === 'META' ? 'MESSENGER' : channel === 'LINKEDIN_ADS' ? 'LINKEDIN' : 'OTHER';
}

export async function inboundLead(
  input: InboundInput,
  door: { sourceKey: string; sourceKind: 'INBOUND' | 'QR' | 'ADS' | 'REFERRAL'; externalKey?: string | null; assignedAgentId?: string | null; note?: string | null },
): Promise<InboundAnswer> {
  const phoneNormalised = normalisePhone(input.phone);
  if (!phoneNormalised) throw new ApiError(400, 'VALIDATION_ERROR', 'That does not look like a phone number', { phone: input.phone });
  if (door.externalKey) {
    const held = await repository.findByExternalKeys([door.externalKey]);
    if (held[0]) {
      const lead = await repository.findById(held[0].id);
      return { leadId: held[0].id, displayId: lead?.displayId ?? null, created: false, assignedAgentId: lead?.assignedAgentId ?? null };
    }
  }
  const [leads, accounts] = await Promise.all([repository.findByPhones([phoneNormalised]), repository.findAccountsByPhones([phoneNormalised])]);
  if (accounts[0]) {
    throw new ApiError(409, 'CONFLICT', 'That number already has an ADX account — sign in to the app instead', { reason: 'EXISTING_ACCOUNT', kind: accounts[0].kind });
  }
  const existing = leads[0];
  if (existing) {
    await repository.logActivity({ leadId: existing.id, actorUserId: null, kind: 'NOTE', note: `Came in again through ${door.sourceKey}${input.message ? `: ${input.message}` : ''}` });
    // LH6: what they asked lands on the thread, so the hub's conversation shows it.
    await recordInbound({ id: existing.id, phoneNormalised: existing.phoneNormalised, phone: input.phone, email: input.email ?? null }, { channel: threadChannelOf(input.channel), providerMessageId: door.externalKey ? `form:${door.externalKey}` : null, body: input.message?.trim() || `Came in again through ${door.sourceKey}`, at: new Date(), source: 'FORM' }).catch((err) => logger.warn('Form message not threaded', { leadId: existing.id, err }));
    await stampMoment(existing.id, 'engaged', input.channel);
    await advanceStage(existing.id, 'ENGAGED', { actorUserId: null, channel: input.channel, note: `asked again through ${door.sourceKey}` });
    const lead = await repository.findById(existing.id);
    return { leadId: existing.id, displayId: existing.displayId, created: false, assignedAgentId: lead?.assignedAgentId ?? null };
  }
  const sourceId = await resolveSource(door.sourceKey, door.sourceKind);
  const displayId = await allocateIdentifier('LEAD');
  let created;
  try {
    created = await repository.create(
      await withCityKey({
        side: input.side,
        businessName: input.businessName.trim().slice(0, 160),
        displayId,
        contactName: input.contactName?.trim().slice(0, 120) ?? null,
        phone: input.phone.trim(),
        phoneNormalised,
        email: input.email?.trim().slice(0, 160) ?? null,
        address: input.address?.trim().slice(0, 300) ?? null,
        locality: input.locality?.trim().slice(0, 120) ?? null,
        city: input.city?.trim().slice(0, 80) ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        category: input.category?.trim().slice(0, 60) ?? null,
        interest: input.message?.trim().slice(0, 200) ?? null,
        source: door.sourceKey,
        sourceId,
        externalKey: door.externalKey ?? null,
        assignedAgentId: door.assignedAgentId ?? null,
        lastTouchedAt: new Date(),
        temperature: 'WARM',
        createdByUserId: null,
      }),
    );
  } catch (error) {
    // Two taps racing on one number or one provider id: the unique refuses the second, the first row answers.
    if (isUniqueViolation(error)) {
      const raced = (await repository.findByPhones([phoneNormalised]))[0] ?? (door.externalKey ? (await repository.findByExternalKeys([door.externalKey]))[0] : undefined);
      if (raced) {
        const lead = await repository.findById(raced.id);
        return { leadId: raced.id, displayId: lead?.displayId ?? null, created: false, assignedAgentId: lead?.assignedAgentId ?? null };
      }
    }
    throw error;
  }
  await repository.logActivity({ leadId: created.id, actorUserId: null, kind: 'IMPORTED', note: door.note ?? `Came in through ${door.sourceKey}${input.message ? `: ${input.message}` : ''}` });
  // LH6: the form's message is the first line of the lead's thread.
  if (input.message?.trim()) {
    await recordInbound(created, { channel: threadChannelOf(input.channel), providerMessageId: door.externalKey ? `form:${door.externalKey}` : null, body: input.message.trim(), at: new Date(), source: 'FORM' }).catch((err) => logger.warn('Form message not threaded', { leadId: created.id, err }));
  }
  await stampMoment(created.id, 'firstContact', input.channel);
  await recomputeLead(created.id).catch((err) => logger.warn('Inbound lead not scored', { leadId: created.id, err }));
  if (door.assignedAgentId) {
    await advanceStage(created.id, 'CLAIMED', { actorUserId: null, note: `attributed to the agent at ${door.sourceKey}` });
  } else {
    await routeLead(created.id).catch((err) => logger.warn('Inbound lead not routed', { leadId: created.id, err }));
  }
  const lead = await repository.findById(created.id);
  return { leadId: created.id, displayId, created: true, assignedAgentId: lead?.assignedAgentId ?? null };
}

/* ── the doors ──────────────────────────────────────────────────────────── */

/** The website's contact form (`POST /leads/inbound/web`, captcha where configured). */
export function webInbound(input: Omit<InboundInput, 'channel'>) {
  return inboundLead({ ...input, channel: 'LINK' }, { sourceKey: 'web', sourceKind: 'INBOUND' });
}

/**
 * The SITE QR poster on a live spot — "Own this wall? Earn from it." /
 * "Want to advertise here?" — a phone and a side; the locality is the
 * spot's own.
 */
export async function siteQrInbound(qrId: string, input: { side: 'PUBLISHER' | 'ADVERTISER'; phone: string; name?: string | undefined; businessName?: string | undefined; message?: string | undefined }) {
  const qr = await getQrById(qrId);
  if (!qr || !qr.isActive || qr.type !== 'SITE') throw new ApiError(404, 'NOT_FOUND', 'That poster is not in use');
  const listing = await repository.findListingPoint(qr.refId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'That spot is no longer listed');
  return inboundLead(
    {
      side: input.side,
      businessName: input.businessName?.trim() || input.name?.trim() || `Scanned at ${listing.title}`,
      contactName: input.name,
      phone: input.phone,
      locality: listing.locality ?? undefined,
      city: listing.city ?? undefined,
      latitude: listing.latitude ?? undefined,
      longitude: listing.longitude ?? undefined,
      message: input.message ?? (input.side === 'PUBLISHER' ? `Owns a surface near ${listing.title}` : `Wants to advertise near ${listing.title}`),
      channel: 'IN_PERSON',
    },
    { sourceKey: 'site-qr', sourceKind: 'QR', note: `Scanned the poster at ${listing.title} (${qr.id})` },
  );
}

/** The agent's referral card — a scan by somebody with no account yet lands as the agent's own lead. */
export async function agentQrInbound(qrId: string, input: { side?: 'PUBLISHER' | 'ADVERTISER' | undefined; phone: string; name?: string | undefined; businessName?: string | undefined; city?: string | undefined; message?: string | undefined }) {
  const qr = await getQrById(qrId);
  if (!qr || !qr.isActive || qr.type !== 'AGENT') throw new ApiError(404, 'NOT_FOUND', 'That card is not in use');
  const agent = await repository.findAgentBrief(qr.refId);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'That agent is no longer with ADX');
  const side = input.side ?? (agent.sides[0] as 'PUBLISHER' | 'ADVERTISER' | undefined) ?? 'PUBLISHER';
  return inboundLead(
    {
      side,
      businessName: input.businessName?.trim() || input.name?.trim() || 'Scanned an agent card',
      contactName: input.name,
      phone: input.phone,
      city: input.city ?? agent.city ?? undefined,
      message: input.message,
      channel: 'IN_PERSON',
    },
    { sourceKey: 'agent-qr', sourceKind: 'QR', assignedAgentId: agent.id, note: `Scanned the agent's card (${qr.id})` },
  );
}

/* ── the lead-form ad webhooks ──────────────────────────────────────────── */

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Meta's `X-Hub-Signature-256` over the raw body with the app secret. */
export function verifyMetaSignature(rawBody: Buffer | undefined, header: string | undefined, appSecret: string | undefined): boolean {
  if (!rawBody || !header || !appSecret) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(expected, header.trim().replace(/^sha256=/i, '').toLowerCase());
}

/** LinkedIn's `X-LI-Signature` — HMAC-SHA256 of the raw body with the client secret, base64. */
export function verifyLinkedInSignature(rawBody: Buffer | undefined, header: string | undefined, clientSecret: string | undefined): boolean {
  if (!rawBody || !header || !clientSecret) return false;
  const expected = createHmac('sha256', clientSecret).update(rawBody).digest('base64');
  return safeEqual(expected, header.trim());
}

type FormField = { name?: string; values?: unknown[]; value?: unknown; key?: string; string_value?: string };

/** The answers of a lead form as the columns a lead takes: the first phone / email / name / company / city fields it finds, the rest as the message. */
export function fieldsOf(fields: FormField[]): { phone: string | null; email: string | null; name: string | null; businessName: string | null; city: string | null; message: string | null } {
  const out = { phone: null as string | null, email: null as string | null, name: null as string | null, businessName: null as string | null, city: null as string | null, message: null as string | null };
  const rest: string[] = [];
  for (const field of fields) {
    const key = (field.name ?? field.key ?? '').toLowerCase();
    const raw = field.values?.[0] ?? field.value ?? field.string_value ?? null;
    const value = raw === null || raw === undefined ? null : String(raw).trim();
    if (!value) continue;
    if (!out.phone && /phone|mobile|contact_number|whatsapp/.test(key)) out.phone = value;
    else if (!out.email && /email/.test(key)) out.email = value;
    else if (!out.businessName && /company|business|organisation|organization|brand|shop/.test(key)) out.businessName = value;
    else if (!out.name && /full_name|first_name|^name$|your_name|last_name/.test(key)) out.name = out.name ? `${out.name} ${value}` : value;
    else if (!out.city && /city|town|location/.test(key)) out.city = value;
    else rest.push(`${key}: ${value}`);
  }
  out.message = rest.length ? rest.join(' · ').slice(0, 200) : null;
  return out;
}

/**
 * Meta Lead Ads: the webhook names a `leadgen_id`; the answers are fetched
 * from the Graph API with the page token (the webhook body carries none).
 * Without a page token the lead is still created with what the webhook
 * said, as a placeholder the desk completes.
 */
export async function metaLeadInbound(entry: { leadgen_id?: string; page_id?: string; form_id?: string; ad_id?: string; created_time?: number }, options: { side: 'PUBLISHER' | 'ADVERTISER' }): Promise<InboundAnswer | null> {
  if (!entry.leadgen_id) return null;
  const externalKey = `meta:${entry.leadgen_id}`;
  const held = await repository.findByExternalKeys([externalKey]);
  if (held[0]) return { leadId: held[0].id, displayId: null, created: false, assignedAgentId: null };
  const { meta } = await getEffectiveLeadFormsConfig();
  let fields: FormField[] = [];
  if (meta?.pageAccessToken) {
    try {
      const response = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(entry.leadgen_id)}?access_token=${encodeURIComponent(meta.pageAccessToken)}`);
      if (response.ok) fields = ((await response.json()) as { field_data?: FormField[] }).field_data ?? [];
      else logger.warn('Meta lead fetch refused', { status: response.status });
    } catch (err) {
      logger.warn('Meta lead fetch failed', { err });
    }
  }
  const got = fieldsOf(fields);
  if (!got.phone) {
    // Nothing to reach them on: recorded on the log, not as a lead — a lead with no number is nobody's work.
    logger.warn('Meta lead without a phone', { leadgenId: entry.leadgen_id, hadToken: Boolean(meta?.pageAccessToken) });
    return null;
  }
  return inboundLead(
    { side: options.side, businessName: got.businessName ?? got.name ?? `Meta lead ${entry.leadgen_id}`, contactName: got.name ?? undefined, phone: got.phone, email: got.email ?? undefined, city: got.city ?? undefined, message: got.message ?? undefined, channel: 'INSTAGRAM' },
    { sourceKey: 'meta-lead-ads', sourceKind: 'ADS', externalKey, note: `Meta lead form ${entry.form_id ?? ''} (ad ${entry.ad_id ?? '?'})` },
  );
}

/** Google Ads lead form extensions: one POST per lead, `lead_id`, `user_column_data[]`, a `google_key` the account set. */
export async function googleLeadInbound(payload: { lead_id?: string; google_key?: string; user_column_data?: { column_id?: string; string_value?: string; column_name?: string }[]; campaign_id?: string | number; form_id?: string | number }, options: { side: 'PUBLISHER' | 'ADVERTISER' }): Promise<InboundAnswer | null> {
  const { google } = await getEffectiveLeadFormsConfig();
  if (!google?.key) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'Google lead forms are not configured: no key is set.');
  if (!payload.google_key || !safeEqual(payload.google_key, google.key)) throw new ApiError(401, 'UNAUTHORIZED', 'Bad lead form key');
  if (!payload.lead_id) return null;
  const got = fieldsOf((payload.user_column_data ?? []).map((column) => ({ name: column.column_id ?? column.column_name ?? '', value: column.string_value })));
  if (!got.phone) {
    logger.warn('Google lead without a phone', { leadId: payload.lead_id });
    return null;
  }
  return inboundLead(
    { side: options.side, businessName: got.businessName ?? got.name ?? `Google lead ${payload.lead_id}`, contactName: got.name ?? undefined, phone: got.phone, email: got.email ?? undefined, city: got.city ?? undefined, message: got.message ?? undefined, channel: 'LINK' },
    { sourceKey: 'google-lead-forms', sourceKind: 'ADS', externalKey: `google:${payload.lead_id}`, note: `Google Ads lead form ${payload.form_id ?? ''} (campaign ${payload.campaign_id ?? '?'})` },
  );
}

/** LinkedIn Lead Gen Forms: the notification names the lead; the answers ride in `formResponse.answers` when the app subscribed with them. */
export async function linkedinLeadInbound(payload: { leadGenFormResponse?: string; id?: string; formResponse?: { answers?: { questionId?: string; answerDetails?: { textQuestionAnswer?: { answer?: string } } }[] }; answers?: { question?: string; answer?: string }[] }, options: { side: 'PUBLISHER' | 'ADVERTISER' }): Promise<InboundAnswer | null> {
  const id = payload.leadGenFormResponse ?? payload.id;
  if (!id) return null;
  const fields: FormField[] = [
    ...(payload.answers ?? []).map((row) => ({ name: row.question ?? '', value: row.answer })),
    ...(payload.formResponse?.answers ?? []).map((row) => ({ name: row.questionId ?? '', value: row.answerDetails?.textQuestionAnswer?.answer })),
  ];
  const got = fieldsOf(fields);
  if (!got.phone) {
    logger.warn('LinkedIn lead without a phone', { id });
    return null;
  }
  return inboundLead(
    { side: options.side, businessName: got.businessName ?? got.name ?? `LinkedIn lead ${id}`, contactName: got.name ?? undefined, phone: got.phone, email: got.email ?? undefined, city: got.city ?? undefined, message: got.message ?? undefined, channel: 'LINKEDIN' },
    { sourceKey: 'linkedin-lead-gen', sourceKind: 'ADS', externalKey: `linkedin:${id}`, note: 'LinkedIn Lead Gen form' },
  );
}

export { getLead };

/**
 * LH6 (the Lead Hunt, 22 Sep 2026): the outreach adapters — one per provider,
 * each NOT_CONFIGURED until its card under Settings › Integrations › Channels
 * is filled. The hub in `modules/leads` wraps them per channel; `notifications`
 * reaches the WhatsApp one for its own WHATSAPP channel.
 */
export * from './types';
export { GRAPH_BASE, metaHandshake, metaSignature, verifyMetaWebhook } from './meta';
export { createWhatsAppAdapter, describeWhatsApp, orderedValues, waNumber, whatsappAdapter, GUPSHUP_BASE, INTERAKT_BASE } from './whatsapp';
export type { WhatsAppAdapter } from './whatsapp';
export { createMetaDmAdapter, describeMetaDm, metaDmAdapter, COMMENT_REPLY_WINDOW_MS, DM_WINDOW_MS } from './meta-dm';
export type { DmChannel, MetaDmAdapter } from './meta-dm';
export { createGoogleBusinessAdapter, describeGoogleBusiness, gbmSignature, googleBusinessAdapter, serviceAccountJwt, GBM_API_BASE } from './google-business';
export type { GoogleBusinessAdapter } from './google-business';
export { answerTwiml, createTelephonyAdapter, describeTelephony, e164, ivrTwiml, outcomeOf, telephonyAdapter, twilioVoiceSignature } from './telephony';
export type { TelephonyAdapter } from './telephony';

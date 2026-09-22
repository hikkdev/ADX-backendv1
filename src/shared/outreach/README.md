# shared/outreach — the channel adapters (LH6)

One adapter per provider, none of them knowing what a lead is. Each answers
`describe()` — is its card under **Settings › Integrations › Channels**
filled, and if not which fields are missing — sends what it is handed, and
reads its own webhook into the two events every channel shares: a message
that came in (`InboundEvent`) and a status on one that went out
(`StatusEvent`). Reachability, the 24-hour window, quiet hours, sequences
and attribution are the hub's (`modules/leads/outreach.service.ts`).

| Adapter | Providers | Configured when | Webhook trust |
|---|---|---|---|
| `whatsapp.ts` | Gupshup, Interakt, Meta Cloud API (`bsp` on the card) | Gupshup: `apiKey` + `appName` + `sourceNumber`; Interakt: `apiKey`; Meta: `phoneNumberId` + `accessToken` | Meta: `X-Hub-Signature-256` on `appSecret`; the BSPs sign nothing — the hub's URL token |
| `meta-dm.ts` | Instagram DM, Messenger (Graph `/me/messages`) | `pageId` + `accessToken` per card | `X-Hub-Signature-256` on either card's `appSecret`; handshake on `verifyToken` |
| `google-business.ts` | Business Messages (service-account JWT → bearer) | `agentId` + `serviceAccountJson` + `partnerKey` | `X-Goog-Signature` HMAC-SHA512 on `partnerKey`; `{clientToken, secret}` handshake |
| `telephony.ts` | Exotel, Knowlarity, Twilio Voice (`provider` on the card) | Exotel: `accountSid` + `apiKey` + `apiToken` + `subdomain`; Knowlarity: `apiKey` + `apiToken` + `subdomain` (the k-number); Twilio: `accountSid` + `apiToken` | Twilio: `X-Twilio-Signature`; the others: `?token=` = the card's `webhookSecret` |

Every send answers a `SendOutcome` — `{ ok: true, providerId }` or
`{ ok: false, code: 'NOT_CONFIGURED' | 'NO_TEMPLATE' | 'PROVIDER_ERROR' }` —
never throws for a provider's no. A webhook that cannot be trusted throws
`OutreachWebhookRejected`, which the route answers with 401.

Telephony's click-to-call rings the agent first and the lead second; the
lead sees one of the card's `callerIds` (the masked numbers), never the
agent's own. `answerTwiml` is Twilio's answer (the consent line, then the
dial, recorded only when `record` is true); `ivrTwiml` the IVR number's
greeting and two prompts. Exotel and Knowlarity play their own flows and
post to the same hooks. `fetchRecording` pulls the operator's recording
with its auth so the hub can keep it as a private file.

Google retired Business Messages for new agents in July 2024; the adapter
stays for a partner endpoint and is NOT_CONFIGURED until one is on the card.

Tests: `__tests__/outreach-adapters.test.ts` — every NOT_CONFIGURED path,
each provider's send shape through a fake fetch, each webhook parser on a
fixture, the signatures, the TwiML, the outcome mapping.

# shared/sms

The one door an SMS leaves by — Lot E (decisions 128 and 147).

## Why kinds, not bodies

TRAI's DLT rules mean an Indian operator passes a message only when its text
matches a template registered against ADX's entity id. The old sender put the
whole message in MSG91's `var1`, which the operator rejects the moment the text
stops matching. So a caller never hands over a body: it names a **kind** —
`LOGIN_OTP`, `TWO_FACTOR`, `ORDER_OTP`, `PACKAGE_LINK`, `VISIT_OFFER`,
`KYC_DECISION`, `KYC_REQUESTED` (Lot N — the desk asked for the party's KYC),
`PAYOUT_PAID`, `ANNOUNCEMENT_CRITICAL`, `INVITE`,
`CHANGE_MOBILE` (E9 — the old number is told the sign-in number moved)
(`kinds.ts`) — plus the variables, and the rail renders it from its own
registration. `__tests__/sms-call-sites.test.ts` fails on any `sendSms(` call
in `src/` that does not name a kind literally; the one exception is the
dispatcher, whose kind is the template's own.

## Files

| File | What |
| --- | --- |
| `kinds.ts` | `SMS_KINDS`, `SMS_RAIL_NAMES`, `SmsKindRegistration` — imports nothing, so `shared/integrations` can type the credentials row with it. |
| `rail.ts` | The `SmsRail` port: `describe()` → `{ configured }`, `send(request)` → `{ providerMessageId }`, `parseDeliveryWebhook(input)` → reports; `WebhookRejected`; `toE164`, `renderSmsBody`, `pickVars`. |
| `rails/msg91.ts` | Flow API: the kind's flow id and the named variables; MSG91 renders. Delivery reports are the JSON array it posts, matched on the request id. No signature — a forged report can only move a row whose id we issued. |
| `rails/twilio.ts` | Messages API: the rendered registered text (`registration.body`) with `DltEntityId` / `DltTemplateId` in the form, From = the DLT header or the Twilio number. Status callbacks are verified against `X-Twilio-Signature` and **fail closed** without an auth token on file. |
| `rails/third.ts` | The seam for the next operator: `configured: false`, sends nothing. |
| `sms.ts` | `sendSms({ to, kind, vars, body? })`: dev short-circuit (`SMS_LIVE_IN_DEV`), the routing order from the credentials row, fallback down the list, `{ skipped: true, reason }` for an unregistered kind or no configured rail; `isSmsKindRegistered(kind)`; `parseSmsDeliveryWebhook(rail, input)`. |

## Configuration

Read from the `sms` section of the integrations row through
`getEffectiveSmsConfig()`: `primaryRail`, `fallbackRails[]`, `dltEntityId`,
`senderId`, `templates[rail][kind] = { templateId, vars?, body? }`. Twilio's
keys are the `twilio` section; MSG91's key is `sms.authKey`. See
`modules/integrations/README.md`.

## Where the log is

Not here. `shared/` sends and answers; the masked, hashed delivery log and the
retry are the dispatcher's, in `modules/notifications` (`dispatch.service.ts`),
which is also where a rail's delivery report lands (`/webhooks/msg91`,
`/webhooks/twilio`).

## Tests

```bash
npx vitest run src/shared/sms
```

import type { NotificationChannel } from '../../shared/database';
import type { SmsKind } from '../../shared/sms';

/**
 * The outbound copy ADX ships with — Lot E (Q87).
 *
 * One row per message that already left the platform before the dispatcher
 * existed, so the day it boots nothing goes silent. `ensureTemplates()` writes
 * each of these once, by key, and never again: an edited row is ops' and the
 * seed must not undo it. In-app copy is not here on purpose — it stays in the
 * code that raises the notification, beside the event it describes.
 *
 * Email bodies are HTML with `{{name}}` placeholders; the renderer escapes
 * every value, so a person's name cannot become markup. SMS bodies are the
 * DLT-registered text for the kind, kept here so the log can show what went
 * out; the rail in use renders from its own registration of the same text.
 */

export interface TemplateSeed {
  key: string;
  event: string;
  channels: NotificationChannel[];
  subject?: string;
  emailBody?: string;
  smsKind?: SmsKind;
  smsBody?: string;
  isSensitive?: boolean;
  /**
   * Lot G (Q117): false for copy the quiet hours and the weekly cap govern.
   * Omitted means true — an OTP, a decision, a payment, a service notice is
   * about the person's own account and leaves whenever it is raised.
   */
  transactional?: boolean;
  /** G10 (Q103): push copy of its own; omitted, the push shows `subject` / `smsBody`. */
  pushTitle?: string;
  pushBody?: string;
}

export const DEFAULT_TEMPLATES: readonly TemplateSeed[] = [
  {
    key: 'login-otp',
    event: 'LOGIN_OTP',
    channels: ['SMS'],
    smsKind: 'LOGIN_OTP',
    smsBody: 'Your ADX OTP is {{code}}. Valid for {{minutes}} minutes. Do not share this with anyone.',
    isSensitive: true,
  },
  {
    key: 'login-otp-email',
    event: 'LOGIN_OTP_EMAIL',
    channels: ['EMAIL'],
    subject: 'Your ADX Admin login code',
    emailBody: '<p>Your ADX login code is <strong>{{code}}</strong>. Valid for {{minutes}} minutes. Do not share this with anyone.</p>',
    isSensitive: true,
  },
  {
    key: 'two-factor-sms',
    event: 'TWO_FACTOR_SMS',
    channels: ['SMS'],
    smsKind: 'TWO_FACTOR',
    smsBody: 'Your ADX OTP is {{code}}. Valid for {{minutes}} minutes. Do not share this with anyone.',
    isSensitive: true,
  },
  {
    key: 'two-factor-email',
    event: 'TWO_FACTOR_EMAIL',
    channels: ['EMAIL'],
    subject: 'Your ADX admin sign-in code',
    emailBody:
      '<p>Your ADX admin sign-in code is <strong>{{code}}</strong>.</p>' +
      '<p>It is valid for {{minutes}} minutes and can be typed in any case. Do not share it with anyone.</p>' +
      '<p>You have used the email backup {{used}} of {{limit}} times in the last {{days}} days. After that, only your phone will do.</p>',
    isSensitive: true,
  },
  {
    key: 'admin-invite',
    event: 'ADMIN_INVITE',
    channels: ['EMAIL'],
    subject: 'You have been invited to the ADX console',
    emailBody:
      '<p>You have been invited to the ADX admin console.</p>' +
      '<p><a href="{{url}}">Accept the invitation</a>. The link expires in {{days}} days.</p>' +
      '<p>{{how}} You will also confirm a mobile number — it is where your sign-in codes will go.</p>' +
      '<p>If you were not expecting this, ignore this email and tell whoever runs ADX.</p>',
    isSensitive: true,
  },
  {
    key: 'package-link',
    event: 'PACKAGE_LINK',
    channels: ['EMAIL', 'SMS'],
    subject: 'Your ADX {{packageName}} plan — ₹{{amount}}',
    emailBody:
      '<p>Hello {{name}},</p>' +
      '<p>Your {{packageName}} plan on ADX comes to <strong>₹{{amount}}</strong>, including GST.</p>' +
      '<p><a href="{{url}}">Review and pay</a></p>' +
      '<p>Reference {{reference}}.</p>',
    smsKind: 'PACKAGE_LINK',
    smsBody: 'ADX: your {{packageName}} plan is ready — ₹{{amount}} incl. GST. Pay: {{url}} ({{reference}})',
    isSensitive: true,
  },
  {
    key: 'kyc-decision',
    event: 'KYC_DECISION',
    channels: ['EMAIL', 'SMS'],
    subject: 'Your ADX verification: {{decision}}',
    emailBody: '<p>Hello {{partyName}},</p><p>Your ADX verification is <strong>{{decision}}</strong>.</p><p>{{reason}}</p>',
    smsKind: 'KYC_DECISION',
    smsBody: 'ADX: your verification is {{decision}}. {{reason}}',
  },
  {
    // Lot N: the desk asked the party for their KYC — on Digio (the link
    // reaches them as the integration sends it) or by hand. Email, SMS and
    // a push that opens the party's KYC screen (`deepLink` rides the push
    // data). Transactional: it is about the person's own account.
    key: 'kyc-requested',
    event: 'KYC_REQUESTED',
    channels: ['EMAIL', 'SMS', 'PUSH'],
    subject: 'ADX needs your identity verification',
    emailBody:
      '<p>Hello {{partyName}},</p>' +
      '<p>ADX has asked you to complete your identity verification ({{channel}}). {{note}}</p>' +
      '<p>Open the ADX app and go to Verify identity to finish it.</p>',
    smsKind: 'KYC_REQUESTED',
    smsBody: 'ADX: please complete your identity verification ({{channel}}) in the ADX app. {{note}}',
    pushTitle: 'Complete your verification',
    pushBody: 'ADX has asked you to verify your identity ({{channel}}). {{note}}',
  },
  {
    // AG-1: the applicant pressed Submit — a receipt, and the same event
    // tells every admin in-app (channels: [] on that send).
    key: 'agent-application-received',
    event: 'AGENT_APPLICATION_RECEIVED',
    channels: ['EMAIL', 'SMS', 'PUSH'],
    subject: 'ADX has your application',
    emailBody:
      '<p>Hello {{partyName}},</p>' +
      '<p>ADX has your application to work as a {{side}}. We check the papers and get back to you within three working days.</p>' +
      '<p>You can follow it in the ADX Agent app.</p>',
    smsKind: 'AGENT_APPLICATION_RECEIVED',
    smsBody: 'ADX: we have your {{side}} application. We check the papers and reply within three working days.',
    pushTitle: 'Application received',
    pushBody: 'ADX has your {{side}} application. We reply within three working days.',
  },
  {
    // DS-1 (Digio eSign): a document is waiting for the person's signature.
    // Digio sends its own link too when the policy says so; this is ADX's
    // word, with the same link and a push that opens the app's signing
    // screen (`deepLink` rides the push data). Transactional.
    key: 'agreement-signature-requested',
    event: 'AGREEMENT_SIGNATURE_REQUESTED',
    channels: ['EMAIL', 'SMS', 'PUSH'],
    subject: 'Please sign: {{document}}',
    emailBody:
      '<p>Hello {{partyName}},</p>' +
      '<p>ADX has sent you the <strong>{{document}}</strong> to sign electronically. It takes a minute with Aadhaar OTP.</p>' +
      '<p><a href="{{url}}">Open and sign</a> — the link is good until {{expires}}.</p>',
    smsKind: 'AGREEMENT_SIGNATURE_REQUESTED',
    smsBody: 'ADX: please sign the {{document}}: {{url}} (valid till {{expires}}).',
    pushTitle: 'A document to sign',
    pushBody: 'ADX has sent you the {{document}} to sign. It takes a minute.',
  },
  {
    // DS-1: everyone has signed; the copy is in the app.
    key: 'agreement-signed',
    event: 'AGREEMENT_SIGNED',
    channels: ['EMAIL', 'PUSH'],
    subject: 'Signed: {{document}}',
    emailBody: '<p>Hello {{partyName}},</p><p>The <strong>{{document}}</strong> is signed by every party. Your copy is in the ADX app under Agreements.</p>',
    smsKind: 'AGREEMENT_SIGNED',
    smsBody: 'ADX: the {{document}} is signed. Your copy is in the ADX app.',
    pushTitle: 'Signed',
    pushBody: 'The {{document}} is signed by every party.',
  },
  {
    // DS-1: the link ran out; the desk (or the flow) opens a fresh one.
    key: 'agreement-signature-expired',
    event: 'AGREEMENT_SIGNATURE_EXPIRED',
    channels: ['EMAIL', 'PUSH'],
    subject: 'The signing link for {{document}} has expired',
    emailBody: '<p>Hello {{partyName}},</p><p>The link to sign the <strong>{{document}}</strong> has expired. Open the ADX app to ask for a fresh one, or ADX will send it again.</p>',
    smsKind: 'AGREEMENT_SIGNATURE_EXPIRED',
    smsBody: 'ADX: the link to sign the {{document}} has expired. Open the ADX app for a fresh one.',
    pushTitle: 'Signing link expired',
    pushBody: 'The link to sign the {{document}} has expired. Ask for a fresh one in the app.',
  },
  {
    // AG-1: the desk decided — accepted (with the grade), on hold, not accepted, or back under review.
    key: 'agent-application-decision',
    event: 'AGENT_APPLICATION_DECISION',
    channels: ['EMAIL', 'SMS', 'PUSH'],
    subject: 'Your ADX application: {{decision}}',
    emailBody: '<p>Hello {{partyName}},</p><p>Your ADX agent application is <strong>{{decision}}</strong>.</p><p>{{reason}}</p>',
    smsKind: 'AGENT_APPLICATION_DECISION',
    smsBody: 'ADX: your agent application is {{decision}}. {{reason}}',
    pushTitle: 'Your ADX application',
    pushBody: 'Your application is {{decision}}. {{reason}}',
  },
  {
    // AG-1: the desk flagged a paper or asked for it again.
    key: 'agent-document-returned',
    event: 'AGENT_DOCUMENT_RETURNED',
    channels: ['PUSH', 'SMS'],
    subject: 'ADX needs your {{document}} again',
    emailBody: '<p>Hello {{partyName}},</p><p>ADX could not accept your {{document}}: {{note}}</p><p>Please upload it again in the ADX Agent app.</p>',
    smsKind: 'AGENT_DOCUMENT_RETURNED',
    smsBody: 'ADX: please upload your {{document}} again in the ADX Agent app. {{note}}',
    pushTitle: '{{document}}: upload it again',
    pushBody: '{{note}}',
  },
  {
    // AG-4: the desk booked an interview.
    key: 'agent-interview-scheduled',
    event: 'AGENT_INTERVIEW_SCHEDULED',
    channels: ['PUSH', 'SMS', 'EMAIL'],
    subject: 'Your ADX interview',
    emailBody: '<p>Hello {{partyName}},</p><p>Your ADX interview (round {{round}}) is on <strong>{{when}}</strong>, {{where}}.</p><p>Bring your original papers.</p>',
    smsKind: 'AGENT_INTERVIEW_SCHEDULED',
    smsBody: 'ADX: your interview is on {{when}}, {{where}}. Bring your original papers.',
    pushTitle: 'Your ADX interview',
    pushBody: '{{when}}, {{where}}.',
  },
  {
    // AG-4: a paper with a date is about to run out.
    key: 'agent-document-expiring',
    event: 'AGENT_DOCUMENT_EXPIRING',
    channels: ['PUSH', 'SMS'],
    subject: 'Your {{document}} runs out in {{days}} days',
    emailBody: '<p>Hello {{partyName}},</p><p>Your {{document}} expires on {{date}}. Upload the renewed one in the ADX Agent app before then and nothing stops.</p>',
    smsKind: 'AGENT_DOCUMENT_EXPIRING',
    smsBody: 'ADX: your {{document}} expires on {{date}}. Upload the renewed one in the ADX Agent app.',
    pushTitle: '{{document}}: {{days}} days left',
    pushBody: 'Expires {{date}}. Upload the renewed one.',
  },
  {
    // AG-4: a paper's date has passed.
    key: 'agent-document-expired',
    event: 'AGENT_DOCUMENT_EXPIRED',
    channels: ['PUSH', 'SMS'],
    subject: 'Your {{document}} has expired',
    emailBody: '<p>Hello {{partyName}},</p><p>Your {{document}} expired on {{date}}. Upload the renewed one in the ADX Agent app; ADX approves it and work goes on.</p>',
    smsKind: 'AGENT_DOCUMENT_EXPIRED',
    smsBody: 'ADX: your {{document}} expired on {{date}}. Upload the renewed one in the ADX Agent app.',
    pushTitle: '{{document}} has expired',
    pushBody: 'Upload the renewed one.',
  },
  {
    key: 'payout-paid',
    event: 'PAYOUT_PAID',
    channels: ['EMAIL', 'SMS'],
    subject: 'ADX payout of ₹{{amount}} sent',
    emailBody: '<p>Your ADX payout of <strong>₹{{amount}}</strong> was sent to {{method}}.</p><p>Reference {{reference}}.</p>',
    smsKind: 'PAYOUT_PAID',
    smsBody: 'ADX: your payout of ₹{{amount}} was sent to {{method}}. Ref {{reference}}.',
  },
  {
    key: 'visit-offer',
    event: 'VISIT_OFFER',
    channels: ['SMS'],
    smsKind: 'VISIT_OFFER',
    smsBody: 'ADX: {{agentName}} would like to visit {{address}} on {{when}}. Reply in the ADX app.',
  },
  {
    // Lot F (E7-1): the monthly payment advice is ready — email only; the
    // in-app row is raised by `invoices.runMonthlyStatements` beside it.
    key: 'statement-ready',
    event: 'STATEMENT_READY',
    channels: ['EMAIL'],
    transactional: false,
    subject: 'Your ADX payment advice for {{month}}',
    emailBody:
      '<p>Hello {{partyName}},</p>' +
      '<p>Your ADX payment advice for <strong>{{month}}</strong> is ready. Net paid into your wallet: <strong>₹{{net}}</strong>.</p>' +
      '<p><a href="{{url}}">Open the statement</a> (reference {{reference}}).</p>',
  },
  {
    // E9: the OLD number is told the sign-in number moved — SMS only, to the
    // number the account had, which is where a person who did not do this
    // finds out. `newMasked` is `+91 XXXXX ***NN`; never the whole number.
    key: 'mobile-changed',
    event: 'MOBILE_CHANGED',
    channels: ['SMS'],
    smsKind: 'CHANGE_MOBILE',
    smsBody: 'Your ADX number changed to {{newMasked}} on {{date}}. Not you? Call ADX.',
  },
  {
    key: 'announcement',
    event: 'ANNOUNCEMENT',
    // G10: PUSH beside email and SMS — the desk may send an announcement to the phones.
    channels: ['EMAIL', 'SMS', 'PUSH'],
    transactional: false,
    subject: '{{title}}',
    pushTitle: '{{title}}',
    pushBody: '{{body}}',
    emailBody:
      '<h2>{{title}}</h2><p>{{body}}</p>' +
      '<p style="font-size:12px;color:#666">You are receiving this because you have an ADX account. ' +
      '<a href="{{unsubscribeUrl}}">Unsubscribe from announcement emails</a>.</p>',
    smsKind: 'ANNOUNCEMENT_CRITICAL',
    smsBody: 'ADX notice: {{title}}. {{body}}',
  },
  {
    // G6 (Q104): the person's own data export is ready — email with the
    // deep link into the app (it opens the file behind /files/:id to the
    // owner only) and a push beside it: `subject` is the push title and
    // `smsBody` its body; there is no SMS channel on this template.
    key: 'data-export-ready',
    event: 'DATA_EXPORT_READY',
    channels: ['EMAIL', 'PUSH'],
    subject: 'Your ADX data export is ready',
    emailBody:
      '<p>Hello {{name}},</p>' +
      '<p>The copy of your ADX data you asked for is ready.</p>' +
      '<p><a href="{{url}}">Download your data</a>. The file is available until {{expiresAt}}, after which it is deleted.</p>' +
      '<p>If you did not ask for this, sign in and review your sessions.</p>',
    smsBody: 'Your ADX data export is ready to download until {{expiresAt}}.',
  },
  {
    // Lot G (Q129/Q143): a scheduled report has rendered — email only, to
    // the schedule's recipients, with a link that stops working when the
    // run expires (thirty days).
    key: 'report-ready',
    event: 'REPORT_READY',
    channels: ['EMAIL'],
    subject: 'ADX report: {{reportName}} ({{window}})',
    emailBody:
      '<p>Hello,</p>' +
      '<p>The scheduled report <strong>{{reportName}}</strong> for <strong>{{window}}</strong> is ready ({{rowCount}} rows, {{format}}).</p>' +
      '<p><a href="{{url}}">Download the report</a>. The link works until {{expiresAt}}.</p>',
  },
  {
    // Lot G (Q130): the status page's Subscribe — the address is confirmed
    // before it hears anything, so nobody can be signed up by a stranger.
    key: 'status-subscribe-confirm',
    event: 'STATUS_SUBSCRIBE_CONFIRM',
    channels: ['EMAIL'],
    subject: 'Confirm your ADX status updates subscription',
    emailBody:
      '<p>Somebody asked for ADX status updates to be sent to this address.</p>' +
      '<p><a href="{{confirmUrl}}">Confirm the subscription</a>. If this was not you, ignore this email and nothing will be sent.</p>',
  },
  {
    // Lot G (Q130): an incident opened, updated or resolved — to every
    // confirmed status subscriber, with the unsubscribe link in the footer.
    key: 'incident-update',
    event: 'INCIDENT_UPDATE',
    channels: ['EMAIL'],
    subject: 'ADX status — {{status}}: {{title}}',
    emailBody:
      '<h2>{{title}}</h2>' +
      '<p><strong>{{status}}</strong> · severity {{severity}} · affects {{services}}</p>' +
      '<p>{{body}}</p>' +
      '<p style="font-size:12px;color:#666">You are receiving this because you subscribed to ADX status updates. ' +
      '<a href="{{unsubscribeUrl}}">Unsubscribe</a>.</p>',
  },
  {
    // Lot H (Q147): ops activated the print partner's account — the SMS
    // that tells the shop it can sign in to the ADX app with this number.
    // Rides the INVITE DLT kind: an invitation to sign in is what it is.
    key: 'partner-activated',
    event: 'PARTNER_ACTIVATED',
    channels: ['SMS'],
    smsKind: 'INVITE',
    smsBody: 'ADX: {{name}}, your print partner account is active. Sign in to the ADX app with this mobile number to receive print jobs.',
  },
  {
    // Lot H: a quote request reached the partner — push, beside the in-app
    // row. No SMS kind is registered for print events yet (owner's later round).
    key: 'print-quote-requested',
    event: 'PRINT_QUOTE_REQUESTED',
    channels: ['PUSH'],
    pushTitle: 'Quote requested · order {{orderRef}}',
    pushBody: '{{summary}} Quote by {{deadline}} in the ADX app.',
  },
  {
    key: 'print-job-assigned',
    event: 'PRINT_JOB_ASSIGNED',
    channels: ['PUSH'],
    pushTitle: 'Print job assigned · order {{orderRef}}',
    pushBody: 'Your quote of ₹{{amount}} was accepted. Accept the job in the ADX app.',
  },
  {
    key: 'print-quote-rejected',
    event: 'PRINT_QUOTE_REJECTED',
    channels: ['PUSH'],
    pushTitle: 'Quote not selected · order {{orderRef}}',
    pushBody: 'Another partner was awarded the print for order {{orderRef}}.',
  },
  {
    key: 'print-quote-request-reopened',
    event: 'PRINT_QUOTE_REQUEST_REOPENED',
    channels: ['PUSH'],
    pushTitle: 'Quote still wanted · order {{orderRef}}',
    pushBody: 'The print for order {{orderRef}} is open for quotes again until {{deadline}}.',
  },
  {
    // G13-B: ops cancelled the request — every invited partner hears, with the reason.
    key: 'print-quote-request-cancelled',
    event: 'PRINT_QUOTE_REQUEST_CANCELLED',
    channels: ['PUSH'],
    pushTitle: 'Quote request cancelled · order {{orderRef}}',
    pushBody: 'ADX withdrew the request for quotes on order {{orderRef}}: {{reason}}',
  },
  {
    key: 'print-job-ready',
    event: 'PRINT_JOB_READY',
    channels: ['PUSH'],
    pushTitle: 'Prints ready · order {{orderRef}}',
    pushBody: '{{partnerName}} has the material ready for pickup at {{address}}.',
  },
  // Lot I: support and live chat. All transactional — a reply on the
  // person's own thread leaves whenever it is written, quiet hours or not.
  {
    key: 'support-reply',
    event: 'SUPPORT_REPLY',
    channels: ['PUSH'],
    pushTitle: 'ADX Support replied · {{ticketRef}}',
    pushBody: '{{preview}}',
  },
  {
    key: 'support-message-from-requester',
    event: 'SUPPORT_MESSAGE_FROM_REQUESTER',
    channels: ['PUSH'],
    pushTitle: '{{requesterName}} · {{ticketRef}}',
    pushBody: '{{preview}}',
  },
  {
    key: 'live-chat-assigned',
    event: 'LIVE_CHAT_ASSIGNED',
    channels: ['PUSH'],
    pushTitle: 'New live chat · {{ticketRef}}',
    pushBody: '{{requesterName}}: {{preview}}',
  },
  {
    key: 'live-chat-breach',
    event: 'LIVE_CHAT_BREACH',
    channels: ['PUSH'],
    pushTitle: 'Live chat waiting · {{ticketRef}}',
    pushBody: '{{requesterName}} has waited {{waitedSec}} s with no reply.',
  },
  {
    key: 'live-chat-converted',
    event: 'LIVE_CHAT_CONVERTED',
    channels: ['PUSH'],
    pushTitle: 'Your chat is now a ticket · {{ticketRef}}',
    pushBody: '{{reason}} We will reply on the ticket thread.',
  },
  {
    // Lot J (B1): the publisher's plan is paid for. Transactional — about their own account.
    key: 'subscription-activated',
    event: 'SUBSCRIPTION_ACTIVATED',
    channels: ['EMAIL', 'PUSH'],
    subject: 'Your ADX {{planName}} plan is active',
    emailBody:
      '<p>Your <strong>{{planName}}</strong> plan runs from {{startsAt}} to {{endsAt}}.</p><p>Reference {{reference}}. Your bookings carry the plan\'s rate from the day it starts.</p>',
    pushTitle: '{{planName}} plan active',
    pushBody: 'Runs {{startsAt}} to {{endsAt}}. Ref {{reference}}.',
  },
  {
    // Lot J2: `{{renewal}}` is the sentence the sweep writes — the plain
    // "renew in the app" line, or, with auto-renew on for them and the
    // policy, what the wallet will be charged and when.
    key: 'subscription-expiring',
    event: 'SUBSCRIPTION_EXPIRING',
    channels: ['EMAIL', 'PUSH'],
    subject: 'Your ADX {{planName}} plan ends in {{days}} days',
    emailBody: '<p>Your <strong>{{planName}}</strong> plan ends on {{endsAt}}.</p><p>{{renewal}}</p>',
    pushTitle: '{{planName}} plan ends in {{days}} days',
    pushBody: '{{renewal}}',
  },
  {
    key: 'subscription-ended',
    event: 'SUBSCRIPTION_ENDED',
    channels: ['EMAIL', 'PUSH'],
    subject: 'Your ADX {{planName}} plan has ended',
    emailBody:
      '<p>Your <strong>{{planName}}</strong> plan ended on {{endedAt}}.</p><p>Bookings now carry the standard rate. Buy a plan in the ADX app to lower it again.</p>',
    pushTitle: '{{planName}} plan ended',
    pushBody: 'Ended {{endedAt}}. Buy a plan in the app to lower your rate again.',
  },
  {
    // Lot J2 (6): the daily sweep bought the next term from the wallet —
    // a publisher's plan (revenue) or an advertiser's package (packages).
    // Transactional: about their own money.
    key: 'subscription-renewed',
    event: 'SUBSCRIPTION_RENEWED',
    channels: ['EMAIL', 'PUSH'],
    subject: 'Your ADX {{planName}} plan has renewed',
    emailBody:
      '<p>Your <strong>{{planName}}</strong> plan renewed from your ADX wallet for ₹{{total}} and runs from {{startsAt}} to {{endsAt}}.</p><p>Reference {{reference}}. Switch auto-renew off in the app any time before the next term.</p>',
    pushTitle: '{{planName}} plan renewed',
    pushBody: '₹{{total}} from your wallet. Runs {{startsAt}} to {{endsAt}}. Ref {{reference}}.',
  },
  {
    // Lot J2 (6): the wallet could not cover the renewal (or another gate was
    // shut). Once per term; auto-renew stays on and the term lapses into grace.
    key: 'subscription-renewal-failed',
    event: 'SUBSCRIPTION_RENEWAL_FAILED',
    channels: ['EMAIL', 'PUSH'],
    subject: 'Your ADX {{planName}} plan could not renew',
    emailBody:
      '<p>Your <strong>{{planName}}</strong> plan ended on {{endedAt}} and could not renew from your ADX wallet: {{reason}}</p><p>The renewal costs ₹{{total}}; you are ₹{{shortfall}} short. Top up in the app and buy the plan to keep it.</p>',
    pushTitle: '{{planName}} plan could not renew',
    pushBody: '₹{{shortfall}} short of the ₹{{total}} renewal. Top up in the app to keep your plan.',
  },
  {
    // Lot V (the owner, 15 Sep 2026): ops pulled ADX out of a city. The
    // hourly wind-down tells each publisher whose live listings came off the
    // market, and each agent working the city, once. `{{detail}}` is the
    // sentence the wind-down writes for that person — how many listings, or
    // that no new work will be offered there. Transactional: about their
    // own account.
    key: 'city-withdrawn',
    event: 'CITY_WITHDRAWN',
    channels: ['EMAIL', 'PUSH'],
    subject: 'ADX has closed in {{city}}',
    emailBody:
      '<p>ADX has withdrawn from <strong>{{city}}</strong> and is no longer trading there.</p><p>{{detail}}</p><p>Running campaigns complete as booked and are paid out as usual. If ADX returns to {{city}}, we will let you know.</p>',
    pushTitle: 'ADX has closed in {{city}}',
    pushBody: '{{detail}}',
  },
  // Lot AA: the work desk's six notices, push only — the in-app row is the
  // record and the phone is how a person learns of it; ops can add email.
  // Transactional: each is about the person's own task.
  { key: 'work-assigned', event: 'WORK_ASSIGNED', channels: ['PUSH'], pushTitle: 'A task was assigned to you', pushBody: '{{task}} — due {{due}}, by {{by}}.' },
  { key: 'work-review-requested', event: 'WORK_REVIEW_REQUESTED', channels: ['PUSH'], pushTitle: 'A task awaits your review', pushBody: '{{task}}' },
  { key: 'work-rejected', event: 'WORK_REJECTED', channels: ['PUSH'], pushTitle: 'A task was sent back', pushBody: '{{task}}: {{note}}' },
  { key: 'work-due', event: 'WORK_DUE', channels: ['PUSH'], pushTitle: 'Due tomorrow', pushBody: '{{task}} — due {{due}}.' },
  { key: 'work-overdue', event: 'WORK_OVERDUE', channels: ['PUSH'], pushTitle: 'A task is overdue', pushBody: '{{task}} was due {{due}}.' },
  { key: 'work-comment', event: 'WORK_COMMENT', channels: ['PUSH'], pushTitle: '{{author}} commented', pushBody: '{{task}}: {{preview}}' },
  // LH5 (the Lead Hunt): the hunting map's three pushes. Not transactional
  // — an offer, a nudge, a signal — so quiet hours and the weekly cap hold.
  { key: 'lead-nearby-hot', event: 'LEAD_NEARBY_HOT', channels: ['PUSH'], transactional: false, pushTitle: 'A hot lead near you', pushBody: '{{businessName}} is {{metres}} m away and nobody holds it yet.' },
  { key: 'lead-claim-lapsing', event: 'LEAD_CLAIM_LAPSING', channels: ['PUSH'], transactional: false, pushTitle: 'Your claim lapses soon', pushBody: '{{businessName}} goes back to the pool in {{minutes}} min — log a contact to keep it.' },
  { key: 'lead-link-opened', event: 'LEAD_LINK_OPENED', channels: ['PUSH'], transactional: false, pushTitle: 'They opened your link', pushBody: '{{businessName}} just opened the link you sent — a good time to call.' },
  // LH6 (the Lead Hunt): the outreach hub. `lead-outreach` is the one door
  // the hub's SMS and email leave by — `{{body}}` is the copy the hub
  // rendered (typed by the agent, or a step template below), so the DLT
  // registration is one template with one variable. Transactional on
  // purpose: the hub rules quiet hours and the weekly cap per lead before
  // any adapter, and the dispatcher must not rule a second time.
  { key: 'lead-outreach', event: 'LEAD_OUTREACH', channels: ['SMS', 'EMAIL'], smsKind: 'LEAD_OUTREACH', smsBody: '{{body}}', subject: '{{subject}}', emailBody: '<p style="white-space:pre-line">{{body}}</p><p>{{agentName}}, ADX{{agentPhoneLine}}</p>' },
  // The step templates the default sequences name — copy only, read by the
  // hub (`smsBody` for a short channel, `subject` + `emailBody` for email, an
  // approved WhatsApp template of the same key outside the window). The
  // desk edits them under Comms › Templates like any other.
  { key: 'lead-seq-publisher-intro', event: 'LEAD_SEQUENCE', channels: ['SMS', 'EMAIL', 'WHATSAPP'], smsKind: 'LEAD_OUTREACH', transactional: false, subject: 'Earn from your space at {{businessName}}', smsBody: 'Hi {{contactName}}, {{agentName}} from ADX. Brands pay to advertise on walls, shutters and screens like the one at {{businessName}}. A 10-minute look is all it takes — reply YES and I will call. {{link}}', emailBody: '<p>Hi {{contactName}},</p><p>{{agentName}} here from ADX. Brands pay monthly to advertise on walls, shutters and screens like the one at {{businessName}} — we handle the campaign, you collect the rent.</p><p>A 10-minute look is all it takes. Reply to this email or open your link: {{link}}</p><p>{{agentName}}, ADX{{agentPhoneLine}}</p>' },
  { key: 'lead-seq-publisher-nudge', event: 'LEAD_SEQUENCE', channels: ['SMS', 'EMAIL', 'WHATSAPP'], smsKind: 'LEAD_OUTREACH', transactional: false, subject: 'Your estimate for {{businessName}}', smsBody: 'Hi {{contactName}}, {{agentName}} from ADX again. Spaces near {{businessName}} are earning from ads this month. Want your estimate? Reply YES. {{link}}', emailBody: '<p>Hi {{contactName}},</p><p>Spaces near {{businessName}} are earning from ads this month. Want yours priced? It takes one reply.</p><p>{{link}}</p><p>{{agentName}}, ADX{{agentPhoneLine}}</p>' },
  { key: 'lead-seq-advertiser-intro', event: 'LEAD_SEQUENCE', channels: ['SMS', 'EMAIL', 'WHATSAPP'], smsKind: 'LEAD_OUTREACH', transactional: false, subject: 'Reach your customers near {{businessName}}', smsBody: 'Hi {{contactName}}, {{agentName}} from ADX. Walls, shutters and screens around {{businessName}} can carry your name for less than a newspaper ad. Reply YES for a plan. {{link}}', emailBody: '<p>Hi {{contactName}},</p><p>{{agentName}} here from ADX. Walls, shutters and screens around {{businessName}} can carry your name for less than one newspaper ad — and you pick the streets.</p><p>Reply YES for a plan, or open your link: {{link}}</p><p>{{agentName}}, ADX{{agentPhoneLine}}</p>' },
  { key: 'lead-seq-advertiser-nudge', event: 'LEAD_SEQUENCE', channels: ['SMS', 'EMAIL', 'WHATSAPP'], smsKind: 'LEAD_OUTREACH', transactional: false, subject: 'A campaign plan for {{businessName}}', smsBody: 'Hi {{contactName}}, {{agentName}} from ADX. I have a street-level plan for {{businessName}} ready to share — a reply is all it takes. {{link}}', emailBody: '<p>Hi {{contactName}},</p><p>I have a street-level plan for {{businessName}} ready to share. Reply and I will send it over.</p><p>{{link}}</p><p>{{agentName}}, ADX{{agentPhoneLine}}</p>' },
  { key: 'lead-seq-last-call', event: 'LEAD_SEQUENCE', channels: ['SMS', 'EMAIL', 'WHATSAPP'], smsKind: 'LEAD_OUTREACH', transactional: false, subject: 'Last note from ADX', smsBody: 'Hi {{contactName}}, last note from {{agentName}} at ADX — if the timing is wrong, no problem. Reply LATER and I will check back in a couple of months. {{link}}', emailBody: '<p>Hi {{contactName}},</p><p>Last note from me. If the timing is wrong, no problem at all — reply LATER and I will check back in a couple of months.</p><p>{{agentName}}, ADX{{agentPhoneLine}}</p>' },
  // The hub's own notices to the agent: a reply came in, a callback was asked for.
  { key: 'lead-reply-received', event: 'LEAD_REPLY_RECEIVED', channels: ['PUSH'], pushTitle: '{{businessName}} replied', pushBody: '{{channel}}: {{preview}}' },
  { key: 'lead-callback-requested', event: 'LEAD_CALLBACK_REQUESTED', channels: ['PUSH'], pushTitle: 'Callback asked for', pushBody: '{{businessName}} wants a call back{{when}} — it is on your day.' },
  // LH7: the landing's Accept on a proposal.
  { key: 'lead-proposal-accepted', event: 'LEAD_PROPOSAL_ACCEPTED', channels: ['PUSH'], pushTitle: '{{businessName}} accepted', pushBody: '{{proposal}} — time to close it.' },
  // LH10: the clawback — the catch that did not last. Worded as what happened, with the reason.
  { key: 'incentive-reversed', event: 'INCENTIVE_REVERSED', channels: ['PUSH'], pushTitle: 'A reward came back', pushBody: '₹{{amount}} for {{businessName}} was reversed — {{reason}}.' },
];

/* ── the events catalogue (E10-2) ────────────────────────────────── */

/**
 * One event the platform raises, and the variables the raising code hands
 * `notify()` — the contract a template author writes against. The console
 * reads it at `GET /comms/events` so a template cannot name a variable the
 * code never supplies, and the test beside this file fails when a module
 * starts raising an event that is not listed here.
 *
 * `raisedBy` names the modules whose code calls `notify(event, …)`;
 * `via: 'sendSms'` marks the one message that leaves by the rail directly
 * (the ordinary login OTP) — it has a seeded template so the log can show
 * the copy, but the dispatcher is not on its path.
 */
export interface EventRegistryEntry {
  event: string;
  /** Every variable the raising code supplies, in the order it is typed. */
  variables: readonly string[];
  raisedBy: readonly string[];
  via: 'notify' | 'sendSms';
  /** A credential travels in the variables: never resent, purged in a week. */
  sensitive?: boolean;
  note?: string;
}

export const EVENT_REGISTRY: readonly EventRegistryEntry[] = [
  { event: 'LOGIN_OTP', variables: ['code', 'minutes'], raisedBy: ['auth'], via: 'sendSms', sensitive: true, note: 'The ordinary sign-in OTP — a direct send by kind, not through the dispatcher.' },
  { event: 'LOGIN_OTP_EMAIL', variables: ['code', 'minutes'], raisedBy: ['auth'], via: 'notify', sensitive: true },
  { event: 'TWO_FACTOR_SMS', variables: ['code', 'minutes'], raisedBy: ['auth'], via: 'notify', sensitive: true },
  { event: 'TWO_FACTOR_EMAIL', variables: ['code', 'minutes', 'used', 'limit', 'days'], raisedBy: ['auth'], via: 'notify', sensitive: true },
  { event: 'ADMIN_INVITE', variables: ['url', 'days', 'how'], raisedBy: ['auth'], via: 'notify', sensitive: true },
  { event: 'MOBILE_CHANGED', variables: ['newMasked', 'date'], raisedBy: ['auth'], via: 'notify', note: 'Sent to the OLD number after the swap.' },
  { event: 'PACKAGE_LINK', variables: ['name', 'packageName', 'amount', 'url', 'reference'], raisedBy: ['packages'], via: 'notify', sensitive: true },
  { event: 'KYC_DECISION', variables: ['partyName', 'decision', 'reason'], raisedBy: ['kyc', 'publishers', 'print-partners'], via: 'notify' },
  { event: 'KYC_REQUESTED', variables: ['partyName', 'channel', 'note', 'deepLink'], raisedBy: ['kyc', 'publishers', 'print-partners'], via: 'notify', note: "Lot N: the desk asked the party for their KYC (DIGIO or MANUAL); `deepLink` rides the push data and opens the party's KYC screen." },
  { event: 'PAYOUT_PAID', variables: ['amount', 'method', 'reference', 'utr'], raisedBy: ['payouts'], via: 'notify' },
  { event: 'AGENT_APPLICATION_RECEIVED', variables: ['partyName', 'side'], raisedBy: ['agents'], via: 'notify', note: 'AG-1: the applicant\'s receipt; the same event, in-app only, tells every admin.' },
  { event: 'AGENT_APPLICATION_DECISION', variables: ['partyName', 'decision', 'reason'], raisedBy: ['agents'], via: 'notify', note: 'AG-1: accepted (with the grade), on hold, not accepted, or back under review.' },
  { event: 'AGREEMENT_SIGNATURE_REQUESTED', variables: ['partyName', 'document', 'url', 'expires', 'deepLink'], raisedBy: ['agreements'], via: 'notify', sensitive: true, note: 'DS-1 (Digio eSign): a document waits for the signature; `url` is the signing page, `deepLink` opens the app\'s signing screen.' },
  { event: 'AGREEMENT_SIGNED', variables: ['partyName', 'document'], raisedBy: ['agreements'], via: 'notify', note: 'DS-1: every party has signed.' },
  { event: 'AGREEMENT_SIGNATURE_EXPIRED', variables: ['partyName', 'document'], raisedBy: ['agreements'], via: 'notify', note: 'DS-1: the signing link ran out.' },
  { event: 'AGENT_DOCUMENT_RETURNED', variables: ['partyName', 'document', 'note'], raisedBy: ['agents'], via: 'notify', note: 'AG-1: the desk flagged a paper or asked for it again.' },
  { event: 'AGENT_INTERVIEW_SCHEDULED', variables: ['partyName', 'when', 'where', 'round'], raisedBy: ['agents'], via: 'notify', note: 'AG-4: the desk booked an interview.' },
  { event: 'AGENT_DOCUMENT_EXPIRING', variables: ['partyName', 'document', 'days', 'date'], raisedBy: ['agents'], via: 'notify', note: 'AG-4: the expiry sweep, thirty and seven days out.' },
  { event: 'AGENT_DOCUMENT_EXPIRED', variables: ['partyName', 'document', 'date'], raisedBy: ['agents'], via: 'notify', note: 'AG-4: the expiry sweep on the day; a working agent is put on hold.' },
  { event: 'VISIT_OFFER', variables: ['agentName', 'address', 'when', 'minutes'], raisedBy: ['visits'], via: 'notify' },
  { event: 'STATEMENT_READY', variables: ['month', 'net', 'url', 'partyName', 'reference'], raisedBy: ['invoices'], via: 'notify' },
  { event: 'ANNOUNCEMENT', variables: ['title', 'body', 'unsubscribeUrl'], raisedBy: ['announcements'], via: 'notify' },
  { event: 'DATA_EXPORT_READY', variables: ['name', 'url', 'expiresAt'], raisedBy: ['account-lifecycle'], via: 'notify', note: "G6 (Q104): the person's data export is ready; the link is the app deep link to the private file, seven days." },
  { event: 'REPORT_READY', variables: ['reportName', 'window', 'rowCount', 'format', 'url', 'expiresAt'], raisedBy: ['reports'], via: 'notify', note: 'Lot G (Q129): a scheduled report rendered; the link is signed and expires with the run.' },
  { event: 'STATUS_SUBSCRIBE_CONFIRM', variables: ['confirmUrl'], raisedBy: ['ops'], via: 'notify', sensitive: true, note: 'Lot G (Q130): the status page subscription, confirmed by link.' },
  { event: 'INCIDENT_UPDATE', variables: ['title', 'status', 'severity', 'services', 'body', 'unsubscribeUrl'], raisedBy: ['ops'], via: 'notify', note: 'Lot G (Q130): to every confirmed status subscriber on every incident change.' },
  // Lot H (Q147): the print partner floor.
  { event: 'PARTNER_ACTIVATED', variables: ['name', 'mobile'], raisedBy: ['print-partners'], via: 'notify', note: 'Lot H: ops activated the partner account; the SMS goes to the partner mobile (INVITE kind).' },
  { event: 'PRINT_QUOTE_REQUESTED', variables: ['orderRef', 'summary', 'deadline', 'city'], raisedBy: ['print-partners'], via: 'notify', note: 'Lot H: to every partner invited to quote on an order print.' },
  { event: 'PRINT_QUOTE_REQUEST_REOPENED', variables: ['orderRef', 'deadline'], raisedBy: ['print-partners'], via: 'notify', note: 'Lot H: the nightly re-invite, and a decline that reopens the request.' },
  { event: 'PRINT_QUOTE_REQUEST_CANCELLED', variables: ['orderRef', 'reason'], raisedBy: ['print-partners'], via: 'notify', note: 'G13-B: ops cancelled an open request; every invited partner is told why.' },
  { event: 'PRINT_JOB_ASSIGNED', variables: ['orderRef', 'amount', 'partnerName'], raisedBy: ['print-partners'], via: 'notify', note: 'Lot H: the winning partner, at award or at a hand-opened job.' },
  { event: 'PRINT_QUOTE_REJECTED', variables: ['orderRef'], raisedBy: ['print-partners'], via: 'notify', note: 'Lot H: the partners whose quote was not awarded.' },
  { event: 'PRINT_JOB_READY', variables: ['orderRef', 'partnerName', 'address'], raisedBy: ['print-partners'], via: 'notify', note: 'Lot H: the agent who collects, when the partner marks the job ready.' },
  // Lot I: support and live chat for paid subscribers.
  { event: 'SUPPORT_REPLY', variables: ['ticketRef', 'preview', 'author'], raisedBy: ['support'], via: 'notify', note: "Lot I: ADX replied on the requester's thread — ticket or live chat; the in-app MESSAGE row rides beside it." },
  { event: 'SUPPORT_MESSAGE_FROM_REQUESTER', variables: ['ticketRef', 'requesterName', 'preview'], raisedBy: ['support'], via: 'notify', note: 'Lot I: the requester wrote on a thread an operator owns; to that operator.' },
  { event: 'LIVE_CHAT_ASSIGNED', variables: ['ticketRef', 'requesterName', 'preview'], raisedBy: ['support'], via: 'notify', note: 'Lot I: a live chat was put on an operator — auto-assigned at start, or reassigned by ops.' },
  { event: 'LIVE_CHAT_BREACH', variables: ['ticketRef', 'requesterName', 'waitedSec'], raisedBy: ['support'], via: 'notify', note: 'Lot I: a live chat past the first-response target with no reply; to every online operator, once per chat.' },
  { event: 'LIVE_CHAT_CONVERTED', variables: ['ticketRef', 'reason'], raisedBy: ['support'], via: 'notify', note: "Lot I: the requester's live chat continues as a ticket — ops converted it, or it sat idle with no operator." },
  // Lot J (B1): publisher subscription plans bought on the phone.
  { event: 'SUBSCRIPTION_ACTIVATED', variables: ['planName', 'startsAt', 'endsAt', 'reference'], raisedBy: ['revenue'], via: 'notify', note: 'Lot J: a paid order became a subscription — starting now, or queued after the current term.' },
  { event: 'SUBSCRIPTION_EXPIRING', variables: ['planName', 'endsAt', 'days', 'renewal'], raisedBy: ['revenue'], via: 'notify', note: 'Lot J: reminderLeadDays before a subscription ends, once per subscription, from the daily sweep. Lot J2: `renewal` is the plain renew line, or the wallet charge and its date when auto-renew is on.' },
  { event: 'SUBSCRIPTION_ENDED', variables: ['planName', 'endedAt'], raisedBy: ['revenue'], via: 'notify', note: 'Lot J: the day a subscription lapses with nothing queued after it, from the daily sweep.' },
  // Lot J2 (6): auto-renew from the wallet, for both audiences.
  { event: 'SUBSCRIPTION_RENEWED', variables: ['planName', 'startsAt', 'endsAt', 'total', 'reference'], raisedBy: ['revenue', 'packages'], via: 'notify', note: "Lot J2: the daily sweep bought the next term from the party's wallet — a publisher plan (revenue) or an advertiser package (packages)." },
  { event: 'SUBSCRIPTION_RENEWAL_FAILED', variables: ['planName', 'total', 'shortfall', 'reason', 'endedAt'], raisedBy: ['revenue', 'packages'], via: 'notify', note: 'Lot J2: the wallet was short of the renewal (or another gate was shut); once per term, the flag stays on, the term lapses into grace.' },
  // Lot V: the city wind-down.
  { event: 'CITY_WITHDRAWN', variables: ['city', 'detail'], raisedBy: ['geo'], via: 'notify', note: "Lot V: ops set a city WITHDRAWN; the hourly wind-down tells each publisher whose live listings it took down and each agent in the city, once. `detail` is that person's sentence." },
  // Lot AA: the work desk. `task` is "TSK-… · title", `due` the deadline's day or "no deadline".
  { event: 'WORK_ASSIGNED', variables: ['task', 'due', 'by'], raisedBy: ['work'], via: 'notify', note: 'Lot AA: to each person put on a task — at create, on a change of assignees, and on a recurrence spawn.' },
  { event: 'WORK_REVIEW_REQUESTED', variables: ['task'], raisedBy: ['work'], via: 'notify', note: 'Lot AA: to every reviewer when a task reaches PENDING_REVIEW, and to a reviewer added while it is there.' },
  { event: 'WORK_REJECTED', variables: ['task', 'note'], raisedBy: ['work'], via: 'notify', note: "Lot AA: to the assignees when a reviewer sends the task back; `note` is the reviewer's, also filed as a comment." },
  { event: 'WORK_DUE', variables: ['task', 'due'], raisedBy: ['work'], via: 'notify', note: 'Lot AA: the 08:00 IST sweep — to the assignees of a task due tomorrow, once per task per day.' },
  { event: 'WORK_OVERDUE', variables: ['task', 'due'], raisedBy: ['work'], via: 'notify', note: 'Lot AA: the 08:00 IST sweep — to the assignees of an overdue task, once per task per day.' },
  { event: 'WORK_COMMENT', variables: ['task', 'author', 'preview'], raisedBy: ['work'], via: 'notify', note: "Lot AA: to the task's assignees, reviewers and creator, minus the author." },
  // LH5: the hunting map. `deepLink` opens the lead in the agent app.
  { event: 'LEAD_NEARBY_HOT', variables: ['businessName', 'metres', 'deepLink'], raisedBy: ['leads'], via: 'notify', note: 'LH5: a lead turned HOT within a kilometre of an agent of its side with a fix today, unclaimed — once per lead per agent per week.' },
  { event: 'LEAD_CLAIM_LAPSING', variables: ['businessName', 'minutes', 'deepLink'], raisedBy: ['leads'], via: 'notify', note: 'LH5 (D3): the hourly sweep, an hour before an unworked claim lapses — once per claim.' },
  { event: 'LEAD_LINK_OPENED', variables: ['businessName', 'deepLink'], raisedBy: ['leads'], via: 'notify', note: 'LH5 / LH7: the lead opened the link the agent sent — to the holder, at most once an hour per lead.' },
  // LH6: the outreach hub.
  { event: 'LEAD_OUTREACH', variables: ['body', 'subject', 'contactName', 'businessName', 'agentName', 'agentPhoneLine', 'link'], raisedBy: ['leads'], via: 'notify', note: 'LH6 (D5): the one door the hub\'s SMS and email leave by — `body` is the copy already rendered; the recipient is the lead, not a user.' },
  { event: 'LEAD_SEQUENCE', variables: ['contactName', 'businessName', 'agentName', 'agentPhoneLine', 'link', 'city'], raisedBy: ['leads'], via: 'notify', note: 'LH6: the step templates a sequence names — copy only; the hub renders them and sends through LEAD_OUTREACH (or the WhatsApp adapter), never by this event.' },
  { event: 'LEAD_REPLY_RECEIVED', variables: ['businessName', 'channel', 'preview', 'deepLink'], raisedBy: ['leads'], via: 'notify', note: 'LH6: any inbound on any channel — to the agent holding the lead, once per message.' },
  { event: 'LEAD_CALLBACK_REQUESTED', variables: ['businessName', 'when', 'deepLink'], raisedBy: ['leads'], via: 'notify', note: 'LH6: a callback asked for by a missed call, the IVR or a reply — to the agent the task landed on.' },
  { event: 'LEAD_PROPOSAL_ACCEPTED', variables: ['businessName', 'proposal', 'deepLink'], raisedBy: ['leads'], via: 'notify', note: 'LH7: the person tapped Accept on a proposal on the invite landing — to the holder.' },
  { event: 'INCENTIVE_REVERSED', variables: ['businessName', 'amount', 'reason'], raisedBy: ['leads'], via: 'notify', note: 'LH10: the activation reward clawed back — the account closed or its business came down inside thirty days.' },
];

export const isRegisteredEvent = (event: string): boolean => EVENT_REGISTRY.some((entry) => entry.event === event);

/** Every variable the templates above name, for the editor's hints. */
export function variablesOf(...bodies: (string | null | undefined)[]): string[] {
  const names = new Set<string>();
  for (const body of bodies) {
    for (const match of (body ?? '').matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) names.add(match[1]!);
  }
  return [...names];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export type TemplateVars = Record<string, string | number | boolean | null | undefined>;

export function stringifyVars(vars: TemplateVars): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * `{{name}}` → the value, HTML-escaped: the body is markup, the variables
 * never are. Lot F: a newline inside a value becomes `<br>` — an
 * announcement body typed as paragraphs reads as paragraphs in the email
 * rather than as one run-on line — after escaping, so the value itself can
 * still not carry markup.
 */
export function renderHtml(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, name: string) => escapeHtml(vars[name] ?? '').replace(/\r?\n/g, '<br>'));
}

/** A subject line or an SMS: plain text, nothing escaped. */
export function renderText(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, name: string) => vars[name] ?? '');
}

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  // FL-1 (27 Sep 2026): PATCH /config/flows/:key for a key the code does not
  // define. A flow exists only when the code defines it — that is deliberate —
  // so the console names it apart from a body that fails the vocabulary.
  | 'UNKNOWN_FLOW'
  | 'TOO_MANY_REQUESTS'
  | 'NOT_IMPLEMENTED'
  // An integration this endpoint needs has no working credentials — a 503 for
  // ops to fix on /settings/integrations, not a client mistake. Maps is the
  // first; the payment rails will be next.
  | 'INTEGRATION_NOT_CONFIGURED'
  | 'INTERNAL_ERROR'
  | 'EVIDENCE_INCOMPLETE'
  | 'MILESTONES_INCOMPLETE'
  | 'INVALID_QR'
  // Field: an offer answered after its 25-minute window. The agent app drops
  // the sheet on this rather than showing a retry, so it is not a plain 400.
  | 'OFFER_EXPIRED'
  // Supply: the app routes the publisher to the platform agreement on this one,
  // so it has to be distinguishable from an ordinary conflict.
  /// No version of a read document (a policy, the contact block) is published yet.
  | 'NO_ACTIVE_DOCUMENT'
  | 'PLATFORM_AGREEMENT_REQUIRED'
  // Supply: no agreement version is published. A configuration problem for ops,
  // not something the publisher did.
  | 'NO_ACTIVE_TEMPLATE'
  // Demand: the app sends the advertiser to KYC on this one, so like
  // PLATFORM_AGREEMENT_REQUIRED it has to be more than a 403.
  | 'KYC_REQUIRED'
  // AGE-1 (the owner, 29 Sep 2026): anyone may use ADX; placing an order
  // needs the account holder's date of birth on file and them 18 or over.
  // 403, `details: { reason: 'MISSING' | 'UNDER_18', self }` — the app
  // offers its "Add your date of birth" field on MISSING when `self`.
  | 'AGE_REQUIRED'
  // Supply (QR-3): a publisher may not start a listing until their name,
  // email and address are in. The app opens the setup ladder on it.
  | 'PROFILE_INCOMPLETE'
  // QR-7: a profile picture that is not an image, or too big to take in.
  | 'INVALID_IMAGE'
  | 'FILE_TOO_LARGE'
  // ST-1 (28 Sep 2026): an SVG outside the brand files and the media library,
  // and one that carries script, an event handler or an outside link (400).
  | 'UNSUPPORTED_TYPE'
  | 'UNSAFE_SVG'
  // QR-11: Publish on Settings › Brand & theme when the draft is what is live already. Paired with 409.
  | 'NOTHING_TO_PUBLISH'
  // Demand: opens top-up rather than reporting a failure. Paired with 402.
  | 'INSUFFICIENT_FUNDS'
  // Revenue (Lot J-B1): the publisher is on this tier open-ended, so there is
  // nothing to renew and nothing to replace. The phone shows "already on this
  // plan" rather than a failed purchase. Paired with 409.
  | 'ALREADY_ON_PLAN'
  // Subscriptions (Lot J2): the purchase rules are configuration. A cycle the
  // policy does not offer (400, the sentence names the offered ones); a rail
  // the policy has closed — the wallet (403) or a gateway (400); a trial the
  // tier does not offer, or one the party has already spent (409); the
  // auto-renew switch while the policy does not offer it (409). Each is its
  // own code because the phone draws a different screen for each.
  | 'CYCLE_NOT_OFFERED'
  | 'PAYMENT_METHOD_NOT_OFFERED'
  | 'TRIAL_NOT_OFFERED'
  | 'TRIAL_ALREADY_USED'
  | 'AUTO_RENEW_NOT_OFFERED'
  // AI: the description field still holds text. The app clears it and retries
  // only on the publisher's say-so, so this cannot be a plain conflict.
  | 'FIELD_NOT_EMPTY'
  // AI: this description's drafts are spent. Free tier sees an upgrade path,
  // paid tier does not, so the app needs to tell the two apart.
  | 'QUOTA_EXHAUSTED'
  // AI: no provider configured, or the feature is switched off. An operator
  // fixes this in a minute; it is not a failed request.
  | 'AI_UNAVAILABLE'
  // AI: the vendor answered badly. Somebody else's outage.
  | 'AI_FAILED'
  | 'NO_FILE'
  | 'ANALYSIS_UNSUPPORTED'
  | 'FILE_UNREADABLE'
  | 'READING_UNSUPPORTED'
  // Rate cards: the listing is priced under the approved floor. The app offers
  // to ask for a sign-off on this one, so it cannot be a plain conflict.
  | 'BELOW_RATE_CARD_FLOOR'
  // Console access (Lot A). A role write naming an id the catalogue does not
  // have; `details.unknown` lists them.
  | 'UNKNOWN_PERMISSION'
  // AN-1: Analytics refuses a metric, a grain or a cut by name. The registry
  // declares what each metric supports, and asking for anything else is a
  // client mistake worth saying out loud rather than an empty series.
  | 'UNKNOWN_METRIC'
  | 'UNSUPPORTED_GRAIN'
  | 'UNSUPPORTED_DIMENSION'
  // A role with members cannot be deleted — reassign them first.
  | 'ROLE_HAS_MEMBERS'
  // An admin's own number is changed from their own device (change-mobile),
  // never from the desk.
  | 'USE_SELF_SERVICE_FLOW'
  // 2FA: the email fallback is spent for this account; only SMS is offered.
  | 'MOBILE_VERIFICATION_REQUIRED'
  // A token issued for impersonation can only read.
  | 'IMPERSONATION_READ_ONLY'
  // Suspension (Lot A): the party's BLOCK_NEW scope refuses the booking or the
  // dispatch. Distinct codes so the apps can say who is suspended rather than
  // reporting a generic conflict.
  | 'ADVERTISER_SUSPENDED'
  | 'AGENT_SUSPENDED'
  // AG-1: the agent application — the ladder is not through, or the desk's move is not open from this stage.
  | 'AGENT_NOT_ACTIVE'
  | 'APPLICATION_CLOSED'
  | 'APPLICATION_INCOMPLETE'
  | 'DOCUMENT_HELD_ELSEWHERE'
  | 'DECISION_NOT_ALLOWED'
  | 'IDENTITY_UNVERIFIED'
  // AG-4: the screen and the certificate gate activation; a Cashfree check that could not run.
  | 'SCREENING_INCOMPLETE'
  | 'TRAINING_INCOMPLETE'
  | 'VERIFICATION_UNAVAILABLE'
  // Suspension: FREEZE_WALLET — money may land but may not leave.
  | 'WALLET_FROZEN'
  // Users: the account has money, orders, listings, agreements or KYC behind
  // it; it is closed through the closure case, never deleted.
  | 'USER_HAS_HISTORY'
  // Account lifecycle (2 Oct 2026): a closed account is never reactivated,
  // reinstated, signed in to or asked for KYC; a party suspended from new
  // work is not asked for KYC until it is reinstated.
  | 'ACCOUNT_CLOSED'
  | 'ACCOUNT_SUSPENDED'
  // Account lifecycle: an HR record with KYC or activity behind it is
  // deactivated, never removed; a decided KYC case is kept, never deleted.
  | 'EMPLOYEE_HAS_HISTORY'
  | 'KYC_DECIDED'
  // Closure (Lot A, Q21): money is still in flight or work is still running,
  // so the account cannot be closed yet. `details.blockers` names each one with
  // its count, which is the list the console draws.
  | 'CLOSURE_BLOCKED'
  // Erasure (Lot A, Q60): the request cannot move to where it was asked to go
  // — an approval before the account is closed, an execution before approval.
  | 'ERASURE_NOT_ALLOWED'
  // Geography: the city named has a row and ops have switched it off. Distinct
  // from a city ADX has never heard of, which is allowed — free text stays
  // free, and only a deliberate closure refuses.
  | 'CITY_NOT_SUPPORTED'
  // Geography (Lot V, the owner 15 Sep 2026): the city named is in the
  // catalogue and its rollout stage has the function asked for switched off
  // — supply intake, publishing, demand, agent onboarding, print partners or
  // lead feeds. `details` carries `{ stage, function, city }`. A name the
  // catalogue does not know is still allowed: free text stays free.
  | 'CITY_NOT_OPEN'
  // Geography (W-B): the coming-soon waitlist was tapped for a city that is
  // already LAUNCHED — there is nothing to wait for; the app should send the
  // caller to the city itself. 409, `details` carries `{ city, stage }`.
  | 'ALREADY_LIVE'
  // Refunds (Lot B, Q41): a refund to the original payment method needs the
  // payment gateway, which arrives with Lot C. A 409 rather than a 503: the
  // request is wrong for now, not the platform broken — use a bank transfer.
  | 'GATEWAY_NOT_CONFIGURED'
  // Payout methods (Lot B, Q11): the IFSC directory answered and does not know
  // the code. Distinct from the directory being down, which lets the typed
  // bank stand.
  | 'IFSC_UNKNOWN'
  // Payout batches (Lot B, Q140): the admin approving a batch is the one who
  // built it. The database CHECK backs the same rule; this names it. E6: the
  // campaign-refund desk answers the same code for the same rule.
  | 'FOUR_EYES'
  // E6: the desk asked for a password-reset link to an account with no email.
  | 'NO_EMAIL'
  // Commission (Lot B, B1): no active platform-default CommissionRate row —
  // category null, mediaTypeId null. A quote refuses rather than guesses:
  // a rate nobody set is not a rate, and the seed puts the row back.
  | 'COMMISSION_DEFAULT_MISSING'
  // Lot D: the marketplace models. A second review of the same spot or the
  // same agent by the same publisher (Q104/Q112) — one each, ever.
  | 'REVIEW_EXISTS'
  // Lot D: a switch ops have not thrown — instant booking, a second market
  // (Q105/Q107). 409 rather than 404 because the feature exists; it is off.
  | 'FEATURE_OFF'
  // Lot D (Q105): instant booking needs somewhere to send the agent, and the
  // publisher has no address on file to be that place.
  | 'NO_MEETING_PLACE'
  // KYC (Lot D, Q129): the Digio provider is DEGRADED (the probe failed) or
  // MANUAL (ops switched it off). A 503 with `details.retryAfter`; the app
  // offers the manual upload branch instead.
  | 'KYC_PROVIDER_UNAVAILABLE'
  // KYC (Phase D, 1 Oct 2026): Digio answered a KYC request with a refusal
  // other than an outage — a workflow template it does not know, a bad
  // credential (502, `details { status, code }` — Digio's own code, never the
  // body). An outage (timeout, 5xx, 429) stays 503 KYC_PROVIDER_UNAVAILABLE
  // with `details.reason: 'PROVIDER_ERROR'`.
  | 'KYC_PROVIDER_REFUSED'
  // KYC (Phase D): the Digio start needs the party's legal form and none is
  // known — 409, `details { party, options: [{ value, label }] }`; the client
  // asks and sends again with `entityType`. Nothing was stamped or sent.
  | 'ENTITY_TYPE_REQUIRED'
  // KYC (Phase D): an edit would change a verified party's legal form other
  // than an individual registering a business (409).
  | 'KYC_LOCKED'
  // KYC (Lot D, Q131): a manual-path review cannot verify a party who has not
  // recorded the liveness video. The desk asks for it rather than deciding.
  | 'LIVENESS_REQUIRED'
  // KYC (Lot N): the desk asked a party for KYC — a request, a record on
  // their behalf — whose record is already VERIFIED. 409; nothing to ask for.
  | 'KYC_ALREADY_VERIFIED'
  // Agreements (Lot D, Q123): a transaction needs its own acceptance on the
  // version live now — the insertion order, the package terms. The app sends
  // the party to the agreement screen on it, so it is more than a 403.
  | 'AGREEMENT_REQUIRED'
  // DS-1 (Digio eSign): the document must be e-signed, not clicked — the
  // gate carries the open signing request (`details.signing`) so the app
  // sends the party to the signing screen (403). ESIGN_UNAVAILABLE is a
  // production server with no rail configured (503); ESIGN_PROVIDER_ERROR
  // is Digio answering badly (502); SIGNING_NOT_OPEN is an act on a request
  // that is not REQUESTED any more (409).
  | 'SIGNATURE_REQUIRED'
  | 'ESIGN_UNAVAILABLE'
  | 'ESIGN_PROVIDER_ERROR'
  | 'SIGNING_NOT_OPEN'
  // Campaigns (Lot D, Q120): the print step or the launch is held because
  // artwork with a file is short of APPROVED. 409, named so ops' console
  // can route to the review queue.
  | 'CREATIVE_NOT_APPROVED'
  // Payments (Lot C, Q110): the gateway answered badly or not at all — a 502,
  // somebody else's outage, and the Payment row records it.
  | 'GATEWAY_FAILED'
  // Payments: the client-side confirmation's signature does not match what
  // the gateway would have signed. Nothing is captured on it.
  | 'PAYMENT_SIGNATURE_INVALID'
  // Payments (E7-2): the checkout page's one-time token is spent, expired or
  // minted for another payment. 401; the app starts a fresh intent.
  | 'CHECKOUT_TOKEN_INVALID'
  // Pricing (Lot E, Q125): a BINDING factor would move a rate by more than
  // `maxBindingChangePct`. 409; a price case was raised for a person to decide.
  | 'BINDING_CHANGE_TOO_LARGE'
  // Rate cards (Lot E, Q97): a CARD_REVISION case cannot be rejected while
  // the grace the publisher was promised is still running. 409.
  | 'GRACE_PERIOD_RUNNING'
  // KYC (E9, the E7 verifier): a resubmission while the case is NEEDS_INFO
  // that names no document field attaches nothing and would bounce the
  // case back to PENDING with the same files. 400; the desk's flags stand.
  | 'EMPTY_RESUBMISSION'
  // Users (E11-1): the person asked for ADX's email again while nothing had
  // stopped it — `User.emailUnsubscribedAt` was already null. 409.
  | 'NOT_UNSUBSCRIBED'
  // Reports (Lot G, Q129/Q143): the run is still rendering (409), has
  // passed its thirty days (410), or could not be rendered at all (500 —
  // the run row carries the reason); STORAGE_UNAVAILABLE is a 502 when the
  // stored bytes could not be read back.
  | 'REPORT_NOT_READY'
  | 'REPORT_EXPIRED'
  | 'REPORT_FAILED'
  | 'STORAGE_UNAVAILABLE'
  // PP-1: the sign-up chose "I print and install" on a server where the
  // print-partner application port is not wired (503).
  | 'PARTY_UNAVAILABLE'
  // Print partners (Lot H, Q147): an AUTO invite found no active partner
  // accepting requests in the order's city or within reach of the site (409;
  // invite by id); a quote after the request's deadline (409); an award with
  // no quote to take (409); an award of a quote that is not the lowest with
  // no note saying why (400); the partner's handover scan was not this
  // order's live pickup code (409).
  | 'NO_PARTNERS_IN_REACH'
  | 'DEADLINE_PASSED'
  | 'NO_QUOTES'
  | 'NOTE_REQUIRED'
  | 'PICKUP_CODE_MISMATCH'
  // Live chat (Lot I): the caller is not on a paid plan, or their plan does
  // not carry live chat. 403 with the reason and the upsell in `details`, so
  // the app draws the subscription screen rather than an error.
  | 'NOT_ENTITLED'
  // Users (K-B1): a mobile or an email is already an account's sign-in
  // identity or a contact row somewhere (409, `details.which`); a contact
  // is already verified (409); the person tried to promote a contact that
  // has not been proved (409 — the desk may, with a reason).
  | 'CONTACT_TAKEN'
  | 'ALREADY_VERIFIED'
  | 'CONTACT_NOT_VERIFIED'
  // Access control (K-B1): the last member of the super-admin role cannot
  // be moved off it (409); only a super admin grants that role (403).
  | 'LAST_SUPER_ADMIN'
  | 'SUPER_ADMIN_ONLY'
  /** RP-1: an ADMIN with no console role on an admin route. */
  | 'ROLE_REQUIRED'
  // BD-1: a publisher's blocked dates.
  | 'DATES_REVERSED'
  | 'DATES_PAST'
  | 'DATES_TOO_LONG'
  | 'DATES_BLOCKED'
  | 'DATES_BOOKED'
  // PC-1: promo codes on a campaign.
  | 'PROMO_NOT_FOUND'
  | 'PROMO_NOT_APPLICABLE'
  // FB-1: a Facebook account that shares no email.
  | 'FACEBOOK_EMAIL_REQUIRED'
  // A door whose provider is not set up yet (503).
  | 'SERVICE_UNAVAILABLE'
  // RF-1: the checkout is under the threshold, or the policy is off.
  | 'RESERVATION_NOT_OFFERED'
  // RF-1: the hour to pay the fee has passed.
  | 'RESERVATION_FEE_LAPSED'
  // The authenticator app (Lot K2): a second enrolment while one stands
  // (409, disable first); a code path that needs an enrolment the account
  // does not have (409); a session that must set the app up before it may do
  // anything else (403, the policy's `authenticatorRequired`); an admin
  // trying to prove their own contact from the desk (403 — their own settings
  // are the place).
  | 'TOTP_ALREADY_ENROLLED'
  | 'TOTP_NOT_ENROLLED'
  | 'TOTP_ENROLMENT_REQUIRED'
  | 'USE_YOUR_OWN_SETTINGS'
  // M-B: an ADMIN at a one-factor door — the email OTP login, the publisher
  // app's OTP, a mobile OTP nothing can second — is sent to the console login
  // (403); the tokens come only from /auth/2fa/verify.
  | 'ADMIN_SIGN_IN_REQUIRED'
  // LM-1 (promotions): an ad slot or a sponsored placement already at its
  // limit on some of the chosen days (409, the full days in `details`), and
  // an ad submitted before its artwork was uploaded (409).
  | 'SLOT_FULL'
  | 'PLACEMENT_FULL'
  | 'ARTWORK_REQUIRED'
  // LM-1 (media, 28 Sep 2026): an advertiser's ad artwork cannot be archived
  // while a booking that shows it is still open (409, `details.bookings`).
  | 'AD_ARTWORK_IN_USE'
  // FM-1 (forms): a field whose id or label asks for Aadhaar. Aadhaar is
  // never a field kind, never stored, never a label — refused before any
  // other check, so the builder shows the one sentence (400).
  | 'FORBIDDEN_FIELD'
  // Cashfree Phase 1 (1 Oct 2026). A production server with no
  // INTEGRATIONS_ENCRYPTION_KEY was asked to store a credential (503 — it
  // will not write one in the clear).
  | 'ENCRYPTION_KEY_MISSING'
  // Payout methods: a penny drop on a UPI method while no UPI check is
  // chosen (`verificationRouting.upiCheck: 'NONE'`). 409 — it used to mark
  // the method verified without checking anything.
  | 'UPI_CHECK_NOT_CONFIGURED'
  // The Cashfree verification session (Digio's backup): the session is over
  // — verified, failed or expired (409); the step asked for is not one this
  // session has, or an earlier step is still open (409); the selfie arrived
  // after the DigiLocker consent ran out, so DigiLocker is asked again (409);
  // the desk asked for the backup while it is switched off or has no keys (409).
  | 'VERIFICATION_SESSION_CLOSED'
  | 'VERIFICATION_STEP_NOT_OPEN'
  | 'DIGILOCKER_CONSENT_REQUIRED'
  | 'BACKUP_NOT_AVAILABLE'
  // HC-1 (1 Oct 2026): "Sync now" on the Holidays page while the holiday
  // calendar is switched off (409), while a sync is already running (409),
  // and when the calendar cannot be fetched or read — nothing was written (502).
  | 'HOLIDAY_CALENDAR_OFF'
  | 'HOLIDAY_SYNC_RUNNING'
  | 'HOLIDAY_CALENDAR_UNAVAILABLE'
  // Order fraud screening (2 Oct 2026): a held order's dispatching or
  // money-moving step (409 — release or clear it first; a party meets the
  // neutral "being reviewed" line); and cancel-as-fraud on an order whose
  // advertisement is already up (409 — that is a dispute's to unwind).
  | 'ORDER_ON_HOLD'
  | 'ORDER_LIVE';

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: ApiErrorCode;
  public readonly details?: unknown;

  constructor(statusCode: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
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
  // Rate cards: the listing is priced under the approved floor. The app offers
  // to ask for a sign-off on this one, so it cannot be a plain conflict.
  | 'BELOW_RATE_CARD_FLOOR'
  // Console access (Lot A). A role write naming an id the catalogue does not
  // have; `details.unknown` lists them.
  | 'UNKNOWN_PERMISSION'
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
  // Suspension: FREEZE_WALLET — money may land but may not leave.
  | 'WALLET_FROZEN'
  // Users: the account has money, orders, listings, agreements or KYC behind
  // it; it is closed through the closure case, never deleted.
  | 'USER_HAS_HISTORY'
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
  | 'ADMIN_SIGN_IN_REQUIRED';

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

import rateLimit from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { redis } from '../cache/redis';
import { RedisUnavailableError, redisKnownDown } from '../cache/redis-outage';

// Counters live in Redis (keyed by IP, namespaced per prefix) rather than
// in-process memory, so limits hold across instances instead of resetting
// per-process or being divided by however many instances are running.
//
// 28 Sep 2026 (Docker was not running; every public read waited ~34 s and
// answered 500): while the connection is known to be down the store fails at
// once instead of queuing behind ioredis's retries. The store reloads its
// script on the next request, so it recovers the moment Redis is back. What
// happens then is each limiter's choice — `failOpen` below.
function redisStore(prefix: string): RedisStore {
  return new RedisStore({
    prefix,
    sendCommand: (...args: string[]) =>
      redisKnownDown(redis.status)
        ? Promise.reject(new RedisUnavailableError())
        : (redis.call(...(args as [string, ...string[]])) as Promise<RedisReply>),
  });
}

/**
 * For limiters that cap load rather than guard a secret: with Redis down the
 * request goes through unlimited (logged by the library) instead of failing.
 * The sign-in, OTP, email and form limiters do NOT take this — they refuse
 * with a 503 "try again in a minute" (the error handler) while Redis is down.
 */
const failOpen = { passOnStoreError: true } as const;

/**
 * The platform's error envelope for a refusal — `{ success: false, error: { code, message } }`, the
 * shape every client reads (29 Sep 2026: these sent `error` as a bare string, which the website, the
 * apps and the console could not read, so a person who hit a limit was told "Something went wrong.").
 */
const refusal = (message: string) => ({ success: false, error: { code: 'RATE_LIMITED', message } }) as const;


// Password-based login is brute-forceable (unlike OTP, which requires an SMS
// to be sent per attempt), so throttle it per-IP.
export const passwordAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many attempts. Please try again later.'),
  store: redisStore('rl:password-auth:'),
});

// Google sign-in is not brute-forceable — an ID token is RSA-signed by Google,
// so there is nothing to guess. This limiter exists for the other cost: every
// unverifiable token can force a JWKS refetch against Google, and each accepted
// one writes a refresh-token row. Its own budget, rather than sharing the
// password limiter's, so a burst of Google attempts cannot lock a legitimate
// user out of password login.
export const googleAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many attempts. Please try again later.'),
  store: redisStore('rl:google-auth:'),
});

// Guards against SMS/email-bombing a number via repeated send-OTP calls from
// one IP. A per-account limit in otp.service.ts backs this up against the
// same abuse spread across many IPs.
export const otpRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many OTP requests. Please try again later.'),
  store: redisStore('rl:otp-request:'),
});

// Looser than the send limiter — each OTP already caps wrong guesses at 5
// attempts (otp.service.ts), this just stops rapid-fire automation across
// many codes/mobiles from a single IP.
export const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many attempts. Please try again later.'),
  store: redisStore('rl:otp-verify:'),
});

// Refresh tokens are 256-bit random values, so brute force isn't realistic —
// this is just cheap insurance against abuse/DoS on the token endpoints.
export const refreshLimiter = rateLimit({
  ...failOpen,
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many requests. Please try again later.'),
  store: redisStore('rl:refresh:'),
});

/**
 * Selling a package and resending its link — both send an SMS and an email.
 *
 * The per-sale ceiling in packages.service.ts stops one sale being sent over
 * and over; this stops the same abuse spread across many sales, which is the
 * cheaper attack: sell, cancel, sell again, and every cycle puts another
 * message on the advertiser's handset at ADX's expense.
 *
 * Keyed by user rather than IP. Every caller here is authenticated, so the
 * budget belongs to the account, and an IP key would let one office NAT
 * exhaust it for every agent behind it. Admins are not skipped: an admin
 * sending a hundred links is the same SMS bill as anybody else.
 */
export const packageLinkLimiter = rateLimit({
  ...failOpen,
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many payment links sent. Please wait before sending another.'),
  keyGenerator: (req) => req.user?.sub ?? req.ip ?? 'unknown',
  store: redisStore('rl:package-link:'),
});

/**
 * Probing the price surface: POST /pricing/evaluate and /comparables/summary.
 *
 * Not brute-force protection — these need a token, so the caller is already
 * known. The cost being capped is *sweeping*. Both endpoints answer questions
 * about a point the caller chooses, and `contributorCount` steps down exactly
 * at the comparable radius from each spot, so a caller who can ask freely can
 * binary-search that boundary and locate a competitor's site. Coordinates are
 * snapped to a grid to blunt that; this bounds how many probes buy.
 *
 * Keyed by user rather than by IP. Every caller here is authenticated, and an
 * IP key would both let one attacker spread across addresses and let one office
 * NAT exhaust the budget for everyone behind it.
 *
 * The budget is generous on purpose: a publisher pricing a spot might evaluate
 * a dozen times while they think, and a legitimate session must never hit this.
 */
export const marketProbeLimiter = rateLimit({
  ...failOpen,
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many pricing lookups. Please wait a few minutes and try again.'),
  // `req.user` is set by authenticate(), which runs before this on the pricing
  // router. The IP fallback covers the impossible case rather than trusting it.
  keyGenerator: (req) => req.user?.sub ?? req.ip ?? 'unknown',
  // Ops legitimately sweeps while investigating a publisher's complaint.
  skip: (req) => (req.user?.roles ?? []).includes('ADMIN'),
  store: redisStore('rl:market-probe:'),
});

/**
 * Lot D (Q7): interactions on the landing page — `POST /t/:code/e`.
 *
 * Public, like the scan redirect it follows, and written by a browser rather
 * than a person with a token, so it is keyed by IP. The cost being capped is
 * a script inflating an advertiser's own numbers: a person on a page presses
 * a handful of things, never sixty a minute.
 */
export const trackingInteractionLimiter = rateLimit({
  ...failOpen,
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many events. Please slow down.'),
  store: redisStore('rl:tracking-interaction:'),
});

/**
 * E11-2: the public spot page — `GET /s/:displayId`.
 *
 * Public, opened from a shared link by somebody with no token, so keyed by
 * IP. The cost being capped is enumeration: display ids are sequential
 * (`ADX-LST-24018`), and a page per id is the whole live marketplace to a
 * scraper. A person opens a handful of shared links, never two a second.
 */
export const spotPageLimiter = rateLimit({
  ...failOpen,
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests. Please slow down.',
  store: redisStore('rl:spot-page:'),
});

/**
 * LD-1 (3 Oct 2026): `POST /listings/:displayIdOrId/view` — the spot-page
 * view count. Public, so keyed by the signed-in user or else the address.
 * A person opens a few spots a minute; the cap is a script inflating a
 * spot's numbers (which the per-visitor de-duplication already blunts).
 */
export const spotViewLimiter = rateLimit({
  ...failOpen,
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many requests. Please slow down.'),
  keyGenerator: (req) => req.user?.sub ?? req.ip ?? 'unknown',
  store: redisStore('rl:spot-view:'),
});

/**
 * Lot G (Q130): the public status page — `GET /status` and the confirm and
 * unsubscribe links. Read by anyone, so keyed by IP; a person refreshes a
 * status page a few times during an outage, never sixty times a minute.
 */
export const statusPageLimiter = rateLimit({
  ...failOpen,
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many requests. Please slow down.'),
  store: redisStore('rl:status-page:'),
});

/**
 * Lot G (Q130): `POST /status/subscribe` sends a confirmation email to any
 * address typed in, so it is the one public route that costs a message per
 * call. Five an hour per IP is a person with a typo, not a script.
 */
export const statusSubscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many subscription requests. Please try again later.'),
  store: redisStore('rl:status-subscribe:'),
});

/**
 * 26 Sep 2026: the website's signed-out reads beyond browse — the geography
 * catalogue and the city resolver (`/app/geo/cities`, `/app/geo/resolve`),
 * a publisher's public card (`/publishers/:id/public`) and the live text of
 * a platform agreement (`/legal/agreements/:kind`). Public data only, keyed
 * by IP like the spot page: a visitor reads a handful, a scraper thousands.
 * A signed-in caller is keyed by their user, so one office NAT does not
 * spend a colleague's budget.
 */
export const publicReadLimiter = rateLimit({
  ...failOpen,
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many requests. Please slow down.'),
  keyGenerator: (req) => req.user?.sub ?? req.ip ?? 'unknown',
  store: redisStore('rl:public-read:'),
});

/**
 * FM-1 (27 Sep 2026): an answer to a PUBLIC form — `POST
 * /app/forms/:key/submissions`. Written by anyone with no token, behind the
 * captcha where one is configured, so keyed by IP. The cost being capped is
 * a script filling a form that makes leads or raises tickets: a person
 * answers a form once or twice, never ten times in ten minutes. A SIGNED_IN
 * form does not pass here — its guard is the token.
 */
export const formSubmitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: refusal('Too many answers from this connection. Please try again later.'),
  store: redisStore('rl:form-submit:'),
});

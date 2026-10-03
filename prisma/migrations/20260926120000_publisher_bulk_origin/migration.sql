-- 26 Sep 2026: a publisher's own bulk listing upload records its own origin
-- (it was recorded as AGENT). Additive; no existing row changes.
ALTER TYPE "ListingAttemptOrigin" ADD VALUE IF NOT EXISTS 'PUBLISHER_BULK';

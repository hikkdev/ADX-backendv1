-- QR-27 (21 Sep 2026): the account's own code is durable and means what the
-- scanner and the owner make of it. A scan after onboarding carries the
-- agent's ask (scope, reason, duration) for the owner to approve. Written by
-- hand like AG-1.

ALTER TABLE "QrScan" ADD COLUMN "ask" JSONB;

-- 28 Sep 2026 (the owner's production test): a website sign-up proves its
-- email before it chooses a side, and `POST /users/me/party` opened the
-- publisher / advertiser row without it — so the publisher's readiness card
-- (and the web billing and verification forms) asked for an address the
-- account had already proved. The party door now carries the account's
-- email onto the row it opens; this fills the rows opened before that.
-- Only a proven address, only a row with none. Idempotent.
UPDATE "Publisher" p
SET "email" = u."email"
FROM "User" u
WHERE p."userId" = u."id"
  AND p."email" IS NULL
  AND u."email" IS NOT NULL
  AND u."emailVerifiedAt" IS NOT NULL;

UPDATE "Advertiser" a
SET "email" = u."email"
FROM "User" u
WHERE a."userId" = u."id"
  AND a."email" IS NULL
  AND u."email" IS NOT NULL
  AND u."emailVerifiedAt" IS NOT NULL;

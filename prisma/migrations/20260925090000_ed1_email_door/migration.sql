-- ED-1 (25 Sep 2026): the email door — both the phone and the email are verified on every account.
-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

-- Backfill: an address that ever answered a code on its own account was proved before the column existed.
UPDATE "User" u
SET "emailVerifiedAt" = proof."verifiedAt"
FROM (
  SELECT o."userId", o."email", MIN(o."verifiedAt") AS "verifiedAt"
  FROM "Otp" o
  WHERE o."email" IS NOT NULL AND o."verifiedAt" IS NOT NULL
  GROUP BY o."userId", o."email"
) proof
WHERE proof."userId" = u."id" AND u."email" IS NOT NULL AND lower(u."email") = lower(proof."email") AND u."emailVerifiedAt" IS NULL;

-- CreateTable
CREATE TABLE "EmailSignup" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSignup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailSignup_email_key" ON "EmailSignup"("email");

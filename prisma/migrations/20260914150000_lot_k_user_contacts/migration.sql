-- Lot K: extra emails and phone numbers on an account.
CREATE TYPE "ContactKind" AS ENUM ('EMAIL', 'PHONE');
CREATE TABLE "UserContact" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" "ContactKind" NOT NULL,
  "value" TEXT NOT NULL,
  "label" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "addedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserContact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserContact_kind_value_key" ON "UserContact"("kind", "value");
CREATE INDEX "UserContact_userId_idx" ON "UserContact"("userId");
ALTER TABLE "UserContact" ADD CONSTRAINT "UserContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

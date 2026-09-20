-- QR-24 (20 Sep 2026): the right to sell a space and when it runs out.
-- OWNED has no term; a lease, a licence or a permit ends on `rightsValidUntil`
-- and is renewed by a fresh document. A lapsed spot takes no new booking.

CREATE TYPE "RightsBasis" AS ENUM ('OWNED', 'LEASED', 'LICENSED', 'PERMIT');

ALTER TABLE "Listing"
  ADD COLUMN "rightsBasis" "RightsBasis" NOT NULL DEFAULT 'OWNED',
  ADD COLUMN "rightsValidUntil" TIMESTAMP(3),
  ADD COLUMN "rightsLapsedAt" TIMESTAMP(3),
  ADD COLUMN "rightsRemindedAt" TIMESTAMP(3);

CREATE INDEX "Listing_rightsValidUntil_idx" ON "Listing"("rightsValidUntil");

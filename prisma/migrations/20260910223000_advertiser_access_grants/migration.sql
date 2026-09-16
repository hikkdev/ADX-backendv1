-- The demand side gets the same door-to-door code, so the same authority: a
-- DelegatedAccessGrant may now open an advertiser's account instead of a
-- publisher's. Exactly one of the two ids is set; every row that exists is a
-- publisher's.

-- AlterTable
ALTER TABLE "DelegatedAccessGrant" ALTER COLUMN "publisherId" DROP NOT NULL;
ALTER TABLE "DelegatedAccessGrant" ADD COLUMN "advertiserId" TEXT;

-- AddForeignKey
ALTER TABLE "DelegatedAccessGrant"
  ADD CONSTRAINT "DelegatedAccessGrant_advertiserId_fkey"
  FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "DelegatedAccessGrant_advertiserId_status_idx" ON "DelegatedAccessGrant"("advertiserId", "status");

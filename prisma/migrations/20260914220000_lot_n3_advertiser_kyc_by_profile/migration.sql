-- Lot N3: the advertiser KYC record keyed by the Advertiser profile; the user key becomes optional.
ALTER TABLE "AdvertiserKyc" ALTER COLUMN "advertiserId" DROP NOT NULL;
ALTER TABLE "AdvertiserKyc" ADD COLUMN "advertiserProfileId" TEXT;
CREATE UNIQUE INDEX "AdvertiserKyc_advertiserProfileId_key" ON "AdvertiserKyc"("advertiserProfileId");
ALTER TABLE "AdvertiserKyc" ADD CONSTRAINT "AdvertiserKyc_advertiserProfileId_fkey" FOREIGN KEY ("advertiserProfileId") REFERENCES "Advertiser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Backfill: every record that has a user link gets its profile.
UPDATE "AdvertiserKyc" k SET "advertiserProfileId" = a."id" FROM "Advertiser" a WHERE a."userId" = k."advertiserId" AND k."advertiserProfileId" IS NULL;
-- Agents and employees: the Digio path and the desk's request.
ALTER TABLE "AgentKyc" ADD COLUMN "method" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "AgentKyc" ADD COLUMN "digioRequestId" TEXT;
ALTER TABLE "AgentKyc" ADD COLUMN "digioReferenceId" TEXT;
ALTER TABLE "AgentKyc" ADD COLUMN "digioStatus" TEXT;
ALTER TABLE "AgentKyc" ADD COLUMN "digioVerifiedAt" TIMESTAMP(3);
ALTER TABLE "AgentKyc" ADD COLUMN "digioPayload" JSONB;
ALTER TABLE "AgentKyc" ADD COLUMN "requestedAt" TIMESTAMP(3);
ALTER TABLE "AgentKyc" ADD COLUMN "requestedById" TEXT;
ALTER TABLE "AgentKyc" ADD COLUMN "requestedChannel" TEXT;
ALTER TABLE "AgentKyc" ADD COLUMN "recordedVia" TEXT;
CREATE INDEX "AgentKyc_digioRequestId_idx" ON "AgentKyc"("digioRequestId");
ALTER TABLE "EmployeeKyc" ADD COLUMN "method" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "EmployeeKyc" ADD COLUMN "digioRequestId" TEXT;
ALTER TABLE "EmployeeKyc" ADD COLUMN "digioReferenceId" TEXT;
ALTER TABLE "EmployeeKyc" ADD COLUMN "digioStatus" TEXT;
ALTER TABLE "EmployeeKyc" ADD COLUMN "digioVerifiedAt" TIMESTAMP(3);
ALTER TABLE "EmployeeKyc" ADD COLUMN "digioPayload" JSONB;
ALTER TABLE "EmployeeKyc" ADD COLUMN "requestedAt" TIMESTAMP(3);
ALTER TABLE "EmployeeKyc" ADD COLUMN "requestedById" TEXT;
ALTER TABLE "EmployeeKyc" ADD COLUMN "requestedChannel" TEXT;
ALTER TABLE "EmployeeKyc" ADD COLUMN "recordedVia" TEXT;
CREATE INDEX "EmployeeKyc_digioRequestId_idx" ON "EmployeeKyc"("digioRequestId");

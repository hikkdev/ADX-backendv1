-- U7, demand side: Digio on the advertiser's own KYC row, mirroring PublisherKyc.
ALTER TABLE "AdvertiserKyc"
  ADD COLUMN "method" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "digioRequestId" TEXT,
  ADD COLUMN "digioReferenceId" TEXT,
  ADD COLUMN "digioStatus" TEXT,
  ADD COLUMN "digioVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "digioPayload" JSONB;

CREATE INDEX "AdvertiserKyc_digioRequestId_idx" ON "AdvertiserKyc"("digioRequestId");

-- Lot H: the print partner floor (answer 147 on the owner's 6 Sep mechanics).
ALTER TABLE "PrintPartner" ADD COLUMN "activatedAt" TIMESTAMP(3);
ALTER TABLE "PrintPartner" ADD COLUMN "activatedById" TEXT;
ALTER TABLE "PrintPartner" ADD COLUMN "rateCardFileId" TEXT;
ALTER TABLE "PrintPartner" ADD COLUMN "rateCardUpdatedAt" TIMESTAMP(3);
ALTER TABLE "PrintPartner" ADD COLUMN "rateCardRows" JSONB;
ALTER TABLE "PrintPartner" ADD COLUMN "acceptsQuoteRequests" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PrintPartner" ADD COLUMN "invoiceUploadFileId" TEXT;

CREATE TYPE "PrintQuoteRequestStatus" AS ENUM ('OPEN', 'AWARDED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "PrintQuoteStatus" AS ENUM ('SUBMITTED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

CREATE TABLE "PrintQuoteRequest" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "specs" JSONB NOT NULL,
  "city" TEXT,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "status" "PrintQuoteRequestStatus" NOT NULL DEFAULT 'OPEN',
  "awardedQuoteId" TEXT,
  "awardNote" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrintQuoteRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrintQuoteRequest_awardedQuoteId_key" ON "PrintQuoteRequest"("awardedQuoteId");
CREATE INDEX "PrintQuoteRequest_orderId_idx" ON "PrintQuoteRequest"("orderId");
CREATE INDEX "PrintQuoteRequest_status_deadlineAt_idx" ON "PrintQuoteRequest"("status", "deadlineAt");

CREATE TABLE "PrintQuote" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "printPartnerId" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "turnaroundDays" INTEGER NOT NULL,
  "note" TEXT,
  "status" "PrintQuoteStatus" NOT NULL DEFAULT 'SUBMITTED',
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrintQuote_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrintQuote_requestId_printPartnerId_key" ON "PrintQuote"("requestId", "printPartnerId");
CREATE INDEX "PrintQuote_printPartnerId_status_idx" ON "PrintQuote"("printPartnerId", "status");
ALTER TABLE "PrintQuote" ADD CONSTRAINT "PrintQuote_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PrintQuoteRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PrintQuote" ADD CONSTRAINT "PrintQuote_printPartnerId_fkey" FOREIGN KEY ("printPartnerId") REFERENCES "PrintPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrintQuoteRequest" ADD CONSTRAINT "PrintQuoteRequest_awardedQuoteId_fkey" FOREIGN KEY ("awardedQuoteId") REFERENCES "PrintQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PrintJob" ADD COLUMN "partnerAcceptedAt" TIMESTAMP(3);
ALTER TABLE "PrintJob" ADD COLUMN "partnerDeclinedAt" TIMESTAMP(3);
ALTER TABLE "PrintJob" ADD COLUMN "declineReason" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "awardedQuoteId" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "handoverConfirmedAt" TIMESTAMP(3);
ALTER TABLE "PrintJob" ADD COLUMN "handoverQrId" TEXT;
CREATE UNIQUE INDEX "PrintJob_awardedQuoteId_key" ON "PrintJob"("awardedQuoteId");
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_awardedQuoteId_fkey" FOREIGN KEY ("awardedQuoteId") REFERENCES "PrintQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

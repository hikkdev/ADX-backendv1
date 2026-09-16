-- Lot B (Q13/Q34): ADX is the supplier on every tax invoice. One series,
-- consecutive per financial year; PROFORMA until the entity card carries a
-- GSTIN; the gateway payment or the bank UTR hangs off the invoice.
CREATE TABLE "LegalEntitySettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "legalName" TEXT,
  "tradeName" TEXT,
  "gstin" TEXT,
  "pan" TEXT,
  "tan" TEXT,
  "cin" TEXT,
  "registeredAddress" TEXT,
  "city" TEXT,
  "stateCode" TEXT,
  "stateName" TEXT,
  "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
  "financialYearStartMonth" INTEGER NOT NULL DEFAULT 4,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LegalEntitySettings_pkey" PRIMARY KEY ("id")
);
INSERT INTO "LegalEntitySettings" ("id", "updatedAt") VALUES ('default', CURRENT_TIMESTAMP);

CREATE TYPE "InvoiceKind" AS ENUM ('TAX_INVOICE', 'PROFORMA', 'CREDIT_NOTE');
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'VOID');
CREATE TYPE "InvoiceLineKind" AS ENUM ('MEDIA', 'PLATFORM', 'INSTALLATION', 'PRINTING', 'DESIGN', 'DISCOUNT', 'PACKAGE', 'OTHER');

CREATE TABLE "Invoice" (
  "id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "kind" "InvoiceKind" NOT NULL,
  "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
  "advertiserId" TEXT NOT NULL,
  "campaignId" TEXT,
  "packageSaleId" TEXT,
  "paymentId" TEXT,
  "topUpId" TEXT,
  "voidsInvoiceId" TEXT,
  "issuedAt" TIMESTAMP(3),
  "dueAt" TIMESTAMP(3),
  "supplierName" TEXT,
  "supplierGstin" TEXT,
  "supplierStateCode" TEXT,
  "recipientName" TEXT NOT NULL,
  "recipientGstin" TEXT,
  "recipientStateCode" TEXT,
  "recipientAddress" TEXT,
  "placeOfSupply" TEXT,
  "taxableValue" DECIMAL(14,2) NOT NULL,
  "cgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "sgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "igst" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "roundOff" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "total" DECIMAL(14,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "pdfFileId" TEXT,
  "ledgerTransactionId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");
CREATE INDEX "Invoice_advertiserId_issuedAt_idx" ON "Invoice"("advertiserId", "issuedAt");
CREATE INDEX "Invoice_campaignId_idx" ON "Invoice"("campaignId");
CREATE INDEX "Invoice_packageSaleId_idx" ON "Invoice"("packageSaleId");
CREATE INDEX "Invoice_status_issuedAt_idx" ON "Invoice"("status", "issuedAt");
-- One live tax invoice or proforma per sale; credit notes may repeat.
CREATE UNIQUE INDEX "Invoice_one_per_campaign" ON "Invoice"("campaignId") WHERE "kind" <> 'CREDIT_NOTE' AND "status" <> 'VOID' AND "campaignId" IS NOT NULL;
CREATE UNIQUE INDEX "Invoice_one_per_package_sale" ON "Invoice"("packageSaleId") WHERE "kind" <> 'CREDIT_NOTE' AND "status" <> 'VOID' AND "packageSaleId" IS NOT NULL;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_issued_is_dated"
  CHECK ("status" = 'DRAFT' OR "issuedAt" IS NOT NULL);
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_gst_split"
  CHECK (("cgst" = 0 AND "sgst" = 0) OR "igst" = 0);

CREATE TABLE "InvoiceLine" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "kind" "InvoiceLineKind" NOT NULL,
  "description" TEXT NOT NULL,
  "sacCode" TEXT,
  "quantity" DECIMAL(14,4) NOT NULL DEFAULT 1,
  "unitRate" DECIMAL(14,2) NOT NULL,
  "taxableValue" DECIMAL(14,2) NOT NULL,
  "gstPct" DECIMAL(5,4) NOT NULL,
  "gstAmount" DECIMAL(14,2) NOT NULL,
  "campaignSpotId" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InvoiceLine_invoiceId_sortOrder_idx" ON "InvoiceLine"("invoiceId", "sortOrder");
ALTER TABLE "InvoiceLine"
  ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InvoiceSequence" (
  "series" TEXT NOT NULL,
  "next" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "InvoiceSequence_pkey" PRIMARY KEY ("series")
);

CREATE TYPE "PublisherInvoiceStatus" AS ENUM ('UPLOADED', 'MATCHED', 'REJECTED');
CREATE TABLE "PublisherInvoice" (
  "id" TEXT NOT NULL,
  "publisherId" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "fileId" TEXT,
  "fileUrl" TEXT,
  "gstin" TEXT,
  "amount" DECIMAL(14,2) NOT NULL,
  "status" "PublisherInvoiceStatus" NOT NULL DEFAULT 'UPLOADED',
  "note" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublisherInvoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PublisherInvoice_publisherId_period_key" ON "PublisherInvoice"("publisherId", "period");
CREATE INDEX "PublisherInvoice_status_createdAt_idx" ON "PublisherInvoice"("status", "createdAt");

ALTER TABLE "FeeSchedule" ADD COLUMN "sacCode" TEXT;
ALTER TABLE "TaxSettings" ADD COLUMN "mediaSacCode" TEXT;

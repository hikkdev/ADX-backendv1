-- DR 07 wave 4: the read documents, and safety alerts.
ALTER TYPE "PartyType" ADD VALUE 'SAFETY';

CREATE TYPE "LegalDocumentKind" AS ENUM ('PRIVACY_POLICY', 'TERMS_OF_SERVICE', 'REFUND_POLICY', 'CONTENT_POLICY', 'COMMUNITY_GUIDELINES', 'COMMISSION_STRUCTURE', 'CODE_OF_CONDUCT', 'LEGAL_DISCLAIMER', 'CONTACT_INFO', 'ABOUT', 'FAQ', 'SAFETY_GUIDELINES', 'OPEN_SOURCE_LICENSES');
CREATE TYPE "SafetyAlertKind" AS ENUM ('UNSAFE_SITE', 'HARASSMENT', 'ACCIDENT', 'LOCATION_SHARE', 'OTHER');
CREATE TYPE "SafetyAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'CLOSED');

CREATE TABLE "LegalDocument" (
    "id" TEXT NOT NULL,
    "kind" "LegalDocumentKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "meta" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SafetyAlert" (
    "id" TEXT NOT NULL,
    "displayId" TEXT NOT NULL,
    "raisedByUserId" TEXT NOT NULL,
    "kind" "SafetyAlertKind" NOT NULL,
    "orderId" TEXT,
    "milestoneId" TEXT,
    "note" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "blockedOrder" BOOLEAN NOT NULL DEFAULT false,
    "status" "SafetyAlertStatus" NOT NULL DEFAULT 'OPEN',
    "opsNote" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SafetyAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LegalDocument_kind_version_key" ON "LegalDocument"("kind", "version");
CREATE INDEX "LegalDocument_kind_isActive_idx" ON "LegalDocument"("kind", "isActive");
CREATE UNIQUE INDEX "SafetyAlert_displayId_key" ON "SafetyAlert"("displayId");
CREATE INDEX "SafetyAlert_status_createdAt_idx" ON "SafetyAlert"("status", "createdAt");
CREATE INDEX "SafetyAlert_raisedByUserId_createdAt_idx" ON "SafetyAlert"("raisedByUserId", "createdAt");
CREATE INDEX "SafetyAlert_orderId_idx" ON "SafetyAlert"("orderId");

ALTER TABLE "SafetyAlert" ADD CONSTRAINT "SafetyAlert_raisedByUserId_fkey" FOREIGN KEY ("raisedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SafetyAlert" ADD CONSTRAINT "SafetyAlert_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The manual pricing model: dimensions, category rules and the rule builder,
-- plus the quotes they exist to produce.

CREATE TYPE "CategoryRuleEffect" AS ENUM ('MULTIPLIER', 'BLOCKED', 'LEGAL_APPROVAL');
CREATE TYPE "PriceRuleAdjustment" AS ENUM ('MULTIPLIER', 'BASE_ADJUST');
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'EXPIRED', 'WITHDRAWN');

CREATE TABLE "PriceDimension" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceDimension_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PriceDimension_slug_key" ON "PriceDimension"("slug");
CREATE INDEX "PriceDimension_isActive_sortOrder_idx" ON "PriceDimension"("isActive", "sortOrder");

CREATE TABLE "PriceDimensionValue" (
    "id" TEXT NOT NULL,
    "dimensionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "multiplier" DECIMAL(6,4) NOT NULL,
    "minAreaSqFt" DECIMAL(12,2),
    "maxAreaSqFt" DECIMAL(12,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PriceDimensionValue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PriceDimensionValue_dimensionId_label_key"
    ON "PriceDimensionValue"("dimensionId", "label");
CREATE INDEX "PriceDimensionValue_dimensionId_sortOrder_idx"
    ON "PriceDimensionValue"("dimensionId", "sortOrder");

ALTER TABLE "PriceDimensionValue" ADD CONSTRAINT "PriceDimensionValue_dimensionId_fkey"
    FOREIGN KEY ("dimensionId") REFERENCES "PriceDimension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PricingCategoryRule" (
    "id" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "mediaTypeId" TEXT,
    "effect" "CategoryRuleEffect" NOT NULL,
    "multiplier" DECIMAL(6,4),
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingCategoryRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PricingCategoryRule_isActive_idx" ON "PricingCategoryRule"("isActive");
CREATE INDEX "PricingCategoryRule_sector_idx" ON "PricingCategoryRule"("sector");

ALTER TABLE "PricingCategoryRule" ADD CONSTRAINT "PricingCategoryRule_mediaTypeId_fkey"
    FOREIGN KEY ("mediaTypeId") REFERENCES "MediaType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PriceRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "adjustment" "PriceRuleAdjustment" NOT NULL,
    "value" DECIMAL(14,4) NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PriceRule_isActive_priority_idx" ON "PriceRule"("isActive", "priority");

CREATE TABLE "PriceRuleCondition" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "PriceRuleCondition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PriceRuleCondition_ruleId_idx" ON "PriceRuleCondition"("ruleId");

ALTER TABLE "PriceRuleCondition" ADD CONSTRAINT "PriceRuleCondition_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "PriceRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "advertiserId" TEXT,
    "sector" TEXT,
    "notes" TEXT,
    "discountPct" DECIMAL(5,4),
    "subtotalPerDay" DECIMAL(14,2) NOT NULL,
    "totalPerDay" DECIMAL(14,2) NOT NULL,
    "grandTotal" DECIMAL(14,2) NOT NULL,
    "belowFloor" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Quote_reference_key" ON "Quote"("reference");
CREATE INDEX "Quote_status_createdAt_idx" ON "Quote"("status", "createdAt");
CREATE INDEX "Quote_advertiserId_idx" ON "Quote"("advertiserId");

ALTER TABLE "Quote" ADD CONSTRAINT "Quote_advertiserId_fkey"
    FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "QuoteLine" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "listingId" TEXT,
    "mediaTypeId" TEXT NOT NULL,
    "grade" "RateGrade" NOT NULL,
    "cityId" TEXT,
    "label" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "days" INTEGER NOT NULL DEFAULT 1,
    "rateCardId" TEXT,
    "cardRatePerDay" DECIMAL(14,2),
    "floorPerDay" DECIMAL(14,2),
    "ratePerDay" DECIMAL(14,2) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "trace" JSONB NOT NULL,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QuoteLine_quoteId_idx" ON "QuoteLine"("quoteId");
CREATE INDEX "QuoteLine_listingId_idx" ON "QuoteLine"("listingId");

ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quoteId_fkey"
    FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_mediaTypeId_fkey"
    FOREIGN KEY ("mediaTypeId") REFERENCES "MediaType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_rateCardId_fkey"
    FOREIGN KEY ("rateCardId") REFERENCES "RateCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

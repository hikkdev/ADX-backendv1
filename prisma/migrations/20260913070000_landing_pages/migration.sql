-- Lot E (Q7/Q106): the page a printed QR leads to when no destination is given.
CREATE TYPE "LandingPageStatus" AS ENUM ('DRAFT', 'PUBLISHED');

CREATE TABLE "LandingPage" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "blocks" JSONB NOT NULL,
  "theme" JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "LandingPageStatus" NOT NULL DEFAULT 'DRAFT',
  "generatedByAi" BOOLEAN NOT NULL DEFAULT false,
  "publishedAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LandingPage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LandingPage_campaignId_key" ON "LandingPage"("campaignId");
CREATE UNIQUE INDEX "LandingPage_slug_key" ON "LandingPage"("slug");

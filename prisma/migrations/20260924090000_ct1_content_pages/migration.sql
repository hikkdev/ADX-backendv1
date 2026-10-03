-- CT-1 (24 Sep 2026): the pages ADX writes itself — versioned by slug, published like a legal document.
-- CreateEnum
CREATE TYPE "ContentPageCategory" AS ENUM ('PAGE', 'HELP', 'GUIDE', 'POLICY', 'NEWS');

-- CreateTable
CREATE TABLE "ContentPage" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "category" "ContentPageCategory" NOT NULL DEFAULT 'PAGE',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "surfaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentPage_slug_isActive_idx" ON "ContentPage"("slug", "isActive");

-- CreateIndex
CREATE INDEX "ContentPage_category_isActive_idx" ON "ContentPage"("category", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPage_slug_version_key" ON "ContentPage"("slug", "version");

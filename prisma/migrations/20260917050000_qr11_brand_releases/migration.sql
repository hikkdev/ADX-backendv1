-- QR-11 (17 Sep 2026): the published brand, one row per release.
CREATE TABLE "BrandRelease" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "version" TEXT NOT NULL,
    "note" TEXT,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BrandRelease_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BrandRelease_number_key" ON "BrandRelease"("number");
CREATE INDEX "BrandRelease_publishedAt_idx" ON "BrandRelease"("publishedAt");

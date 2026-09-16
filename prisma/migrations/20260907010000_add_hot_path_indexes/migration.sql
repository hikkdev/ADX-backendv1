-- Access-path indexes for the two hottest tables.
--
-- Listing had none at all, so every supply query — the verification sweep,
-- attempt progress, the funnel's per-status counts — was a sequential scan.
-- Order had none either, against 33 routes.
--
-- Targeted rather than blanket: each index below is a where-clause that runs
-- in code today. Indexes are not free on write.

-- CreateIndex
CREATE INDEX "Order_advertiserId_createdAt_idx" ON "Order"("advertiserId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_agentId_status_idx" ON "Order"("agentId", "status");

-- CreateIndex
CREATE INDEX "Order_listingId_idx" ON "Order"("listingId");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Listing_publisherId_createdAt_idx" ON "Listing"("publisherId", "createdAt");

-- CreateIndex
CREATE INDEX "Listing_agentId_idx" ON "Listing"("agentId");

-- CreateIndex
CREATE INDEX "Listing_attemptId_idx" ON "Listing"("attemptId");

-- CreateIndex
CREATE INDEX "Listing_status_verificationExpiresAt_idx" ON "Listing"("status", "verificationExpiresAt");

-- CreateIndex
CREATE INDEX "Listing_city_category_status_idx" ON "Listing"("city", "category", "status");


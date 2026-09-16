-- Lot A (Q28/Q66): an audit row now says what it was done to, which module
-- did it and which request carried it; the named money and status models also
-- keep the values before and after. Nothing here changes the 59 call sites
-- that already write "fields touched" into metadata.
ALTER TABLE "ActivityLog"
  ADD COLUMN "targetType" TEXT,
  ADD COLUMN "targetId" TEXT,
  ADD COLUMN "module" TEXT,
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "diff" JSONB;

CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");
CREATE INDEX "ActivityLog_action_createdAt_idx" ON "ActivityLog"("action", "createdAt");
CREATE INDEX "ActivityLog_targetType_targetId_idx" ON "ActivityLog"("targetType", "targetId");

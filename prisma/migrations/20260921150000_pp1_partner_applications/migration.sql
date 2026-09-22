-- PP-1 (21 Sep 2026): a print shop can apply from the app; the desk reviews
-- and activates, as it does for agents. Written by hand like AG-1.

ALTER TABLE "PrintPartner" ADD COLUMN "appliedAt" TIMESTAMP(3);
CREATE INDEX "PrintPartner_appliedAt_idx" ON "PrintPartner"("appliedAt");
